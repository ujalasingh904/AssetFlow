import io
import logging
import os
from typing import Annotated, Literal
from urllib.parse import unquote, urlsplit
from uuid import uuid4

import cloudinary
import cloudinary.uploader
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import Field
from sqlalchemy.exc import IntegrityError

from db import engine, event, one, query, rows
from identity import current_user, require_role
from settings import Input, missing, today


router = APIRouter(prefix="/assets", tags=["Inventory"])
User = Annotated[dict, Depends(current_user)]
MAX_UPLOAD = 3 * 1024 * 1024

ASSETS = """
SELECT a.*, COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', p.id, 'url', p.url) ORDER BY p.position, p.id)
    FROM photos p WHERE p.asset_id=a.id
), '[]'::jsonb) AS photos,
CASE WHEN NOT a.published THEN 'draft'
     WHEN a.maintenance THEN 'maintenance'
     WHEN EXISTS (SELECT 1 FROM loans l WHERE l.asset_id=a.id AND l.status='checked_out') THEN 'checked_out'
     WHEN EXISTS (SELECT 1 FROM loans l WHERE l.asset_id=a.id AND l.status='approved'
                  AND :today BETWEEN l.starts AND l.ends) THEN 'reserved'
     ELSE 'available'
END AS status
FROM assets a
"""


class AssetInput(Input):
    tag: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9-]+$")
    name: str = Field(min_length=2, max_length=100)
    category: str = Field(min_length=2, max_length=60)
    location: str = Field(min_length=2, max_length=80)
    description: str = Field(default="", max_length=1500)


class AssetState(Input):
    action: Literal["publish", "unpublish", "maintenance", "repair"]
    note: str = Field(default="", max_length=500)


def lock_asset(db, asset_id):
    asset = one(db, "SELECT * FROM assets WHERE id=:id FOR UPDATE", id=asset_id)
    if not asset:
        missing("Equipment")
    return asset


@router.get("")
def catalog(user: User, search: str = Query("", max_length=100),
            status: str = Query("", max_length=20), offset: int = Query(0, ge=0)):
    with engine().connect() as db:
        items = rows(db, "WITH states AS (" + ASSETS + """)
            SELECT * FROM states
            WHERE (published OR :staff) AND (:status='' OR status=:status)
              AND concat_ws(' ', name, category, tag, location) ILIKE :search
            ORDER BY name, id LIMIT 51 OFFSET :offset
        """, today=today(), staff=user["role"] != "borrower", search=f"%{search.strip()}%",
                     status=status, offset=offset)
    return {"items": items[:50], "more": len(items) > 50}


@router.get("/stats")
def stats(user: User):
    with engine().connect() as db:
        result = one(db, """
            WITH states AS (""" + ASSETS + """)
            SELECT count(*) FILTER (WHERE status <> 'draft') AS total,
                   count(*) FILTER (WHERE status='available') AS available,
                   count(*) FILTER (WHERE status='reserved') AS reserved,
                   count(*) FILTER (WHERE status='checked_out') AS checked_out,
                   count(*) FILTER (WHERE status='maintenance') AS maintenance
            FROM states
        """, today=today())
        result.update(one(db, """
            SELECT count(*) FILTER (WHERE status='pending') AS pending,
                   count(*) FILTER (WHERE status='checked_out' AND ends < :today) AS overdue
            FROM loans WHERE :staff OR borrower_uid=:uid
        """, today=today(), staff=user["role"] != "borrower", uid=user["uid"]))
        return result


@router.get("/{asset_id}")
def get_asset(asset_id: int, user: User):
    with engine().connect() as db:
        asset = one(db, ASSETS + " WHERE a.id=:id AND (a.published OR :staff)",
                    id=asset_id, staff=user["role"] != "borrower", today=today())
    if not asset:
        missing("Equipment")
    return asset


@router.post("", status_code=201)
def create_asset(data: AssetInput, user: User):
    require_role(user, "admin")
    try:
        with engine().begin() as db:
            asset = one(db, """
                INSERT INTO assets (tag, name, category, location, description)
                VALUES (upper(:tag), :name, :category, :location, :description) RETURNING *
            """, **data.model_dump())
            event(db, user, "equipment_created", asset=asset["id"])
            return asset
    except IntegrityError as exc:
        if getattr(exc.orig, "sqlstate", "") == "23505":
            raise HTTPException(409, "This equipment tag already exists.") from None
        raise


@router.patch("/{asset_id}")
def edit_asset(asset_id: int, data: AssetInput, user: User):
    require_role(user, "admin")
    try:
        with engine().begin() as db:
            lock_asset(db, asset_id)
            query(db, """
                UPDATE assets SET tag=upper(:tag), name=:name, category=:category,
                location=:location, description=:description WHERE id=:id
            """, id=asset_id, **data.model_dump())
            event(db, user, "equipment_updated", asset=asset_id)
    except IntegrityError as exc:
        if getattr(exc.orig, "sqlstate", "") == "23505":
            raise HTTPException(409, "This equipment tag already exists.") from None
        raise
    return {"ok": True}


@router.post("/{asset_id}/state")
def change_state(asset_id: int, data: AssetState, user: User):
    require_role(user, *("admin",) if data.action in {"publish", "unpublish"} else ("staff", "admin"))
    with engine().begin() as db:
        asset = lock_asset(db, asset_id)
        active = one(db, """
            SELECT id FROM loans WHERE asset_id=:id AND status='checked_out'
        """, id=asset_id)
        if data.action == "publish":
            if not one(db, "SELECT id FROM photos WHERE asset_id=:id LIMIT 1", id=asset_id):
                raise HTTPException(409, "Add at least one photo before publishing.")
            query(db, "UPDATE assets SET published=true WHERE id=:id", id=asset_id)
        elif data.action == "unpublish":
            pending = one(db, """
                SELECT id FROM loans WHERE asset_id=:id AND status IN ('pending', 'approved', 'checked_out')
                LIMIT 1
            """, id=asset_id)
            if pending:
                raise HTTPException(409, "Resolve open requests and loans before unpublishing.")
            query(db, "UPDATE assets SET published=false WHERE id=:id", id=asset_id)
        else:
            if not asset["published"] or active:
                raise HTTPException(409, "Maintenance actions require published equipment that is in stock.")
            if asset["maintenance"] == (data.action == "maintenance"):
                raise HTTPException(409, "The equipment is already in that state.")
            if not data.note:
                raise HTTPException(422, "Enter a maintenance or repair note.")
            query(db, "UPDATE assets SET maintenance=:flag, condition=:condition WHERE id=:id",
                  id=asset_id, flag=data.action == "maintenance",
                  condition="Needs maintenance" if data.action == "maintenance" else "Good")
        event(db, user, data.action, asset=asset_id, detail=data.note)
    return {"ok": True}


def validated_image(raw):
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, "Photos must be 3 MB or smaller.")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"} or getattr(image, "is_animated", False):
                raise ValueError("Unsupported image format")
            if image.width * image.height > 20_000_000:
                raise ValueError("Too many pixels")
            image = ImageOps.exif_transpose(image)
            image.thumbnail((1600, 1600))
            output = io.BytesIO()
            image.convert("RGB").save(output, format="WEBP", quality=85)
            output.seek(0)
            return output
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise HTTPException(422, "Use a valid JPG, PNG or WebP photo under 20 megapixels.") from None


def media_settings():
    url = os.getenv("CLOUDINARY_URL")
    if not url:
        raise HTTPException(503, "Photo storage is unavailable.")
    parts = urlsplit(url)
    if parts.scheme != "cloudinary" or not all((parts.hostname, parts.username, parts.password)):
        raise HTTPException(503, "Photo storage configuration is invalid.")
    cloudinary.config(cloud_name=parts.hostname, api_key=unquote(parts.username),
                      api_secret=unquote(parts.password), secure=True)


def delete_photo_object(public_id):
    try:
        media_settings()
        result = cloudinary.uploader.destroy(public_id, invalidate=True, timeout=10)
        if result.get("result") not in {"ok", "not found"}:
            return False
        return True
    except Exception:
        logging.getLogger(__name__).warning("Photo cleanup is pending for %s", public_id)
        return False


@router.post("/{asset_id}/photos", status_code=201)
def upload_photo(asset_id: int, user: User, file: UploadFile = File(...)):
    require_role(user, "staff", "admin")
    content = validated_image(file.file.read(MAX_UPLOAD + 1))
    with engine().connect() as db:
        if not one(db, "SELECT id FROM assets WHERE id=:id", id=asset_id):
            missing("Equipment")
    media_settings()
    public_id = f"assetflow/{asset_id}/{uuid4().hex}"
    try:
        uploaded = cloudinary.uploader.upload(
            content, public_id=public_id, overwrite=False, resource_type="image", timeout=15
        )
    except Exception:
        raise HTTPException(502, "Photo storage did not accept the upload. Try again.") from None
    try:
        with engine().begin() as db:
            lock_asset(db, asset_id)
            count = one(db, "SELECT count(*) AS total FROM photos WHERE asset_id=:id", id=asset_id)
            if count["total"] >= 6:
                raise HTTPException(409, "Each item can have up to six photos.")
            photo = one(db, """
                INSERT INTO photos (asset_id, public_id, url)
                VALUES (:id, :public_id, :url) RETURNING id, url
            """, id=asset_id, public_id=public_id, url=uploaded["secure_url"])
            event(db, user, "photo_added", asset=asset_id)
            return photo
    except Exception:
        if not delete_photo_object(public_id):
            try:
                with engine().begin() as db:
                    query(db, "INSERT INTO photo_cleanup VALUES (:id) ON CONFLICT DO NOTHING", id=public_id)
            except Exception:
                logging.getLogger(__name__).exception("Could not queue cleanup for %s", public_id)
        raise


@router.put("/{asset_id}/photos/{photo_id}/cover")
def cover_photo(asset_id: int, photo_id: int, user: User):
    require_role(user, "staff", "admin")
    with engine().begin() as db:
        lock_asset(db, asset_id)
        if not one(db, "SELECT id FROM photos WHERE asset_id=:asset AND id=:id", asset=asset_id, id=photo_id):
            missing("Photo")
        query(db, """
            UPDATE photos SET position=CASE WHEN id=:id THEN -1 ELSE 0 END WHERE asset_id=:asset
        """, asset=asset_id, id=photo_id)
        event(db, user, "cover_changed", asset=asset_id)
    return {"ok": True}


@router.delete("/{asset_id}/photos/{photo_id}")
def remove_photo(asset_id: int, photo_id: int, user: User):
    require_role(user, "staff", "admin")
    with engine().begin() as db:
        asset = lock_asset(db, asset_id)
        photo = one(db, "SELECT public_id FROM photos WHERE asset_id=:asset AND id=:id", asset=asset_id, id=photo_id)
        if photo is None:
            missing("Photo")
        count = one(db, "SELECT count(*) AS total FROM photos WHERE asset_id=:id", id=asset_id)
        if asset["published"] and count["total"] == 1:
            raise HTTPException(409, "Add a replacement before removing the last photo.")
        query(db, "DELETE FROM photos WHERE id=:id", id=photo_id)
        query(db, "INSERT INTO photo_cleanup VALUES (:id) ON CONFLICT DO NOTHING", id=photo["public_id"])
        event(db, user, "photo_removed", asset=asset_id)
    if delete_photo_object(photo["public_id"]):
        with engine().begin() as db:
            query(db, "DELETE FROM photo_cleanup WHERE public_id=:id", id=photo["public_id"])
    return {"ok": True}
