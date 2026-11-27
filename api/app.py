import logging
import os
from datetime import date

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import Field
from sqlalchemy.exc import OperationalError

from assistant import router as assistant_router
from db import engine, event, one, query, rows
from identity import require_role
from inventory import User, router as inventory_router
from lending import router as lending_router
from settings import Input, missing, today


app = FastAPI(title="AssetFlow API", version="1.0.0")
origins = os.getenv("FRONTEND_ORIGINS", "http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip().rstrip("/") for origin in origins if origin.strip()],
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def protect_responses(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.exception_handler(OperationalError)
def database_unavailable(request, exc):
    logging.getLogger(__name__).error("Database connection unavailable")
    return JSONResponse({"detail": "The database is temporarily unavailable."}, status_code=503)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/me")
def profile(user: User):
    return {**user, "today": today(), "ai_enabled": bool(os.getenv("GEMINI_API_KEY") and os.getenv("GEMINI_MODEL"))}


class MemberRole(Input):
    role: str = Field(pattern=r"^(staff|borrower)$")


@app.get("/members")
def members(user: User, offset: int = Query(0, ge=0), search: str = Query("", max_length=100)):
    require_role(user, "admin")
    with engine().connect() as db:
        people = rows(db, """
            SELECT * FROM members WHERE email ILIKE :search OR name ILIKE :search
            ORDER BY email, uid LIMIT 51 OFFSET :offset
        """, offset=offset, search=f"%{search.strip()}%")
    return {"items": people[:50], "more": len(people) > 50}


@app.patch("/members/{uid}/role")
def update_role(uid: str, data: MemberRole, user: User):
    require_role(user, "admin")
    with engine().begin() as db:
        person = one(db, "SELECT * FROM members WHERE uid=:uid FOR UPDATE", uid=uid)
        if not person:
            missing("Member")
        if person["role"] == "admin":
            raise HTTPException(409, "Admin roles are managed by the database operator.")
        query(db, "UPDATE members SET role=:role WHERE uid=:uid", role=data.role, uid=uid)
        event(db, user, "role_updated", detail=f"{uid}: {data.role}")
    return {"ok": True}


@app.get("/activity")
def activity(user: User, offset: int = Query(0, ge=0), date_from: date | None = None,
             date_to: date | None = None, member: str = Query("", max_length=100),
             equipment: str = Query("", max_length=100), action: str = Query("", max_length=40),
             loan_id: int | None = Query(None, gt=0)):
    if date_from and date_to and date_from > date_to:
        raise HTTPException(422, "The end date must be on or after the start date.")
    sql = """
        SELECT e.id, e.action, e.detail, e.created_at, e.loan_id, a.name AS asset_name, m.name AS actor
        FROM events e JOIN members m ON m.uid=e.actor_uid
        LEFT JOIN assets a ON a.id=e.asset_id LEFT JOIN loans l ON l.id=e.loan_id
        WHERE (:admin OR (:staff AND e.action <> 'role_updated') OR l.borrower_uid=:uid)
    """
    params = dict(admin=user["role"] == "admin", staff=user["role"] == "staff", uid=user["uid"], offset=offset)
    if date_from:
        sql += " AND e.created_at >= (CAST(:date_from AS date)::timestamp AT TIME ZONE 'UTC')"
        params["date_from"] = date_from
    if date_to:
        sql += " AND e.created_at < ((CAST(:date_to AS date) + 1)::timestamp AT TIME ZONE 'UTC')"
        params["date_to"] = date_to
    if member.strip():
        require_role(user, "staff", "admin")
        sql += " AND (strpos(lower(m.name), lower(:member)) > 0 OR strpos(lower(m.email), lower(:member)) > 0)"
        params["member"] = member.strip()
    if equipment.strip():
        sql += " AND (strpos(lower(a.name), lower(:equipment)) > 0 OR strpos(lower(a.tag), lower(:equipment)) > 0)"
        params["equipment"] = equipment.strip()
    if action:
        sql += " AND e.action=:action"
        params["action"] = action
    if loan_id:
        sql += " AND e.loan_id=:loan_id"
        params["loan_id"] = loan_id
    with engine().connect() as db:
        items = rows(db, sql + " ORDER BY e.id DESC LIMIT 51 OFFSET :offset", **params)
    return {"items": items[:50], "more": len(items) > 50}


app.include_router(inventory_router)
app.include_router(lending_router)
app.include_router(assistant_router)
