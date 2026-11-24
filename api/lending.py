import csv
import io
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import Field
from sqlalchemy.exc import IntegrityError

from db import engine, event, one, query, rows
from identity import require_role
from inventory import User, lock_asset
from settings import Input, missing, today


router = APIRouter(prefix="/loans", tags=["Lending"])

LOAN_LIST = """
SELECT l.*, a.name AS asset_name, a.tag, m.name AS borrower_name,
       (l.status='checked_out' AND l.ends < :today) AS overdue
FROM loans l JOIN assets a ON a.id=l.asset_id JOIN members m ON m.uid=l.borrower_uid
WHERE (:staff OR l.borrower_uid=:uid)
"""


class RequestLoan(Input):
    asset_id: int = Field(gt=0)
    starts: date
    ends: date
    purpose: str = Field(min_length=3, max_length=500)


class LoanAction(Input):
    action: Literal["approve", "reject", "cancel", "checkout", "return"]
    note: str = Field(default="", max_length=1500)
    damaged: bool = False


@router.get("")
def list_loans(user: User, offset: int = Query(0, ge=0), status: str = Query("", max_length=20)):
    with engine().connect() as db:
        items = rows(db, "WITH visible AS (" + LOAN_LIST + """)
            SELECT * FROM visible
            WHERE :status='' OR status=:status OR (:status='overdue' AND overdue)
            ORDER BY id DESC LIMIT 51 OFFSET :offset
        """, staff=user["role"] != "borrower", uid=user["uid"], today=today(), offset=offset, status=status)
    return {"items": items[:50], "more": len(items) > 50}


def csv_cell(value):
    if isinstance(value, str) and (value.lstrip().startswith(("=", "+", "-", "@"))
                                   or value.startswith(("\t", "\r", "\n"))):
        return "'" + value
    return value


@router.get("/export")
def export_loans(user: User):
    require_role(user, "staff", "admin")
    fields = ["id", "tag", "asset_name", "borrower_name", "starts", "ends", "status", "overdue"]
    with engine().connect() as db:
        items = rows(db, LOAN_LIST + " ORDER BY l.id DESC LIMIT 10001",
                     staff=True, uid=user["uid"], today=today())
    if len(items) > 10000:
        raise HTTPException(409, "The report exceeds 10,000 rows. Use a date-filtered database report.")
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(fields)
    writer.writerows([csv_cell(item[name]) for name in fields] for item in items)
    return Response(output.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="assetflow-loans.csv"'})


@router.post("", status_code=201)
def request_loan(data: RequestLoan, user: User):
    now = today()
    if not (now <= data.starts <= data.ends <= now + timedelta(days=180)) or (data.ends - data.starts).days >= 30:
        raise HTTPException(422, "Choose up to 30 calendar days within the next 180 days.")
    with engine().begin() as db:
        asset = lock_asset(db, data.asset_id)
        if not asset["published"]:
            missing("Equipment")
        if asset["maintenance"]:
            raise HTTPException(409, "This equipment is undergoing maintenance.")
        if one(db, """
            SELECT id FROM loans WHERE asset_id=:asset AND status IN ('approved', 'checked_out')
            AND daterange(starts, ends, '[]') && daterange(:starts, :ends, '[]') LIMIT 1
        """, asset=data.asset_id, starts=data.starts, ends=data.ends):
            raise HTTPException(409, "This equipment is already reserved for those dates.")
        if one(db, """
            SELECT id FROM loans WHERE asset_id=:asset AND borrower_uid=:uid AND status='pending'
            AND daterange(starts, ends, '[]') && daterange(:starts, :ends, '[]') LIMIT 1
        """, asset=data.asset_id, uid=user["uid"], starts=data.starts, ends=data.ends):
            raise HTTPException(409, "You already have a pending request for these dates.")
        loan = one(db, """
            INSERT INTO loans (asset_id, borrower_uid, starts, ends, purpose)
            VALUES (:asset_id, :uid, :starts, :ends, :purpose) RETURNING *
        """, uid=user["uid"], **data.model_dump())
        event(db, user, "request_submitted", asset=data.asset_id, loan=loan["id"])
        return loan


def transition(db, loan, asset, data, user):
    action = data.action
    staff = user["role"] in {"staff", "admin"}
    if action != "cancel":
        require_role(user, "staff", "admin")
    elif not staff and loan["borrower_uid"] != user["uid"]:
        missing("Request")

    allowed = {
        "approve": {"pending"}, "reject": {"pending"}, "cancel": {"pending", "approved"},
        "checkout": {"approved"}, "return": {"checked_out"},
    }
    if loan["status"] not in allowed[action]:
        raise HTTPException(409, "This request has already changed. Refresh and try again.")
    if action in {"approve", "checkout"} and (asset["maintenance"] or not asset["published"]):
        raise HTTPException(409, "Equipment is currently unavailable.")
    now = today()
    if action == "approve" and loan["ends"] < now:
        raise HTTPException(409, "The requested dates have already passed.")
    if action == "checkout" and not loan["starts"] <= now <= loan["ends"]:
        raise HTTPException(409, "Checkout is only allowed during the approved dates.")
    if action in {"reject", "return"} and not data.note:
        raise HTTPException(422, "A note is required for this action.")

    if action == "return":
        query(db, """
            UPDATE loans SET status='returned', returned_at=now(), return_note=:note WHERE id=:id
        """, id=loan["id"], note=data.note)
        query(db, "UPDATE assets SET maintenance=:flag, condition=:condition WHERE id=:id",
              id=asset["id"], flag=data.damaged, condition="Needs maintenance" if data.damaged else "Good")
    elif action == "checkout":
        query(db, "UPDATE loans SET status='checked_out', checked_out_at=now() WHERE id=:id", id=loan["id"])
    else:
        status = {"approve": "approved", "reject": "rejected", "cancel": "cancelled"}[action]
        query(db, "UPDATE loans SET status=:status, decision_note=:note WHERE id=:id",
              status=status, note=data.note, id=loan["id"])
    event(db, user, "damaged_return" if action == "return" and data.damaged else action,
          asset=asset["id"], loan=loan["id"], detail=data.note)


@router.post("/{loan_id}/actions")
def act_on_loan(loan_id: int, data: LoanAction, user: User):
    try:
        with engine().begin() as db:
            target = one(db, "SELECT asset_id, borrower_uid FROM loans WHERE id=:id", id=loan_id)
            if not target or (user["role"] == "borrower" and target["borrower_uid"] != user["uid"]):
                missing("Request")
            asset = lock_asset(db, target["asset_id"])
            loan = one(db, "SELECT * FROM loans WHERE id=:id FOR UPDATE", id=loan_id)
            transition(db, loan, asset, data, user)
    except IntegrityError as exc:
        code = getattr(exc.orig, "sqlstate", "")
        if code == "23P01":
            raise HTTPException(409, "An approved reservation overlaps these dates.") from None
        if code == "23505":
            raise HTTPException(409, "This equipment still has an open checkout.") from None
        raise
    return {"ok": True}
