import io
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from PIL import Image

from app import app
from db import engine, query
from identity import current_user
from settings import today


@pytest.fixture()
def api_client(monkeypatch):
    test_url = os.getenv("TEST_DATABASE_URL")
    if not test_url:
        pytest.skip("Set TEST_DATABASE_URL to a disposable PostgreSQL database.")
    monkeypatch.setenv("DATABASE_URL", test_url)
    monkeypatch.setenv("MIGRATION_DATABASE_URL", test_url)
    engine.cache_clear()
    command.upgrade(Config("alembic.ini"), "head")
    members = {
        uid: {"uid": uid, "email": f"{uid}@example.test", "name": uid, "role": role}
        for uid, role in (("admin", "admin"), ("staff", "staff"), ("alice", "borrower"), ("bob", "borrower"))
    }
    with engine().begin() as db:
        query(db, "TRUNCATE events, loans, photos, assets, members, photo_cleanup, ai_usage RESTART IDENTITY")
        for member in members.values():
            query(db, "INSERT INTO members VALUES (:uid, :email, :name, :role)", **member)

    def user_for_test(x_actor: str = "alice"):
        return members[x_actor]

    app.dependency_overrides[current_user] = user_for_test
    monkeypatch.setenv("CLOUDINARY_URL", "cloudinary://test-key:test-secret@demo")
    uploads = []

    def upload(file, public_id, **options):
        assert file.read(4) == b"RIFF"
        uploads.append(public_id)
        return {"secure_url": "https://res.cloudinary.com/demo/image/upload/" + public_id}

    monkeypatch.setattr("cloudinary.uploader.upload", upload)
    monkeypatch.setattr("cloudinary.uploader.destroy", lambda *args, **kwargs: {"result": "ok"})
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()
    engine().dispose()
    engine.cache_clear()


def as_user(uid, path):
    return f"{path}{'&' if '?' in path else '?'}x_actor={uid}"


def photo_bytes():
    output = io.BytesIO()
    Image.new("RGB", (20, 20), "#94ccba").save(output, "PNG")
    return output.getvalue()


def add_equipment(client):
    response = client.post(as_user("admin", "/assets"), json={
        "tag": "CAM-01", "name": "Camera", "category": "Photography", "location": "Studio",
    })
    assert response.status_code == 201, response.text
    return response.json()["id"]


def upload(client, asset, data=None):
    return client.post(as_user("staff", f"/assets/{asset}/photos"),
                       files={"file": ("camera.png", photo_bytes() if data is None else data, "image/png")})


def publish(client, asset):
    return client.post(as_user("admin", f"/assets/{asset}/state"), json={"action": "publish"})


def test_cover_and_permissions(api_client):
    client = api_client
    assert client.get("/health").status_code == 200
    asset = add_equipment(client)
    assert client.get(f"/assets/{asset}").status_code == 404
    assert client.get("/members").status_code == 403
    assert client.post("/assets", json={"tag": "XX", "name": "Test", "category": "Test", "location": "Test"}).status_code == 403
    assert publish(client, asset).status_code == 409
    assert upload(client, asset, b"not a photo").status_code == 422
    first = upload(client, asset)
    second = upload(client, asset)
    assert first.status_code == second.status_code == 201
    first_id, second_id = first.json()["id"], second.json()["id"]
    assert publish(client, asset).status_code == 200
    assert client.put(as_user("staff", f"/assets/{asset}/photos/{second_id}/cover")).status_code == 200
    assert client.get(f"/assets/{asset}").json()["photos"][0]["id"] == second_id
    assert client.delete(f"/assets/{asset}/photos/{first_id}").status_code == 403
    assert client.delete(as_user("staff", f"/assets/{asset}/photos/{first_id}")).status_code == 200
    assert client.delete(as_user("staff", f"/assets/{asset}/photos/{second_id}")).status_code == 409
    catalog = client.get("/assets?status=available&search=cam").json()
    assert catalog["items"][0]["id"] == asset


def test_concurrent_approval_checkout_and_damage(api_client):
    client = api_client
    asset = add_equipment(client)
    assert upload(client, asset).status_code == 201
    assert publish(client, asset).status_code == 200
    request = {"asset_id": asset, "starts": str(today()), "ends": str(today() + timedelta(days=1)), "purpose": "Photography session"}
    alice = client.post("/loans", json=request).json()["id"]
    bob = client.post(as_user("bob", "/loans"), json=request).json()["id"]

    def action(uid, loan, act, **data):
        return client.post(as_user(uid, f"/loans/{loan}/actions"), json={"action": act, **data})

    assert action("alice", bob, "cancel").status_code == 404
    assert action("alice", alice, "approve").status_code == 403
    with ThreadPoolExecutor(max_workers=2) as pool:
        result = list(pool.map(lambda loan: action("staff", loan, "approve"), [alice, bob]))
    assert sorted(response.status_code for response in result) == [200, 409]
    winner = alice if result[0].status_code == 200 else bob
    assert action("staff", winner, "checkout").status_code == 200
    assert action("staff", winner, "checkout").status_code == 409
    assert action("staff", winner, "return", damaged=True).status_code == 422
    assert action("staff", winner, "return", damaged=True, note="Cracked display.").status_code == 200
    assert client.get(f"/assets/{asset}").json()["status"] == "maintenance"
    assert client.post("/loans", json=request).status_code == 409
    assert client.get("/assets/stats").json()["maintenance"] == 1
    repair = client.post(as_user("staff", f"/assets/{asset}/state"), json={"action": "repair", "note": "New display"})
    assert repair.status_code == 200
    assert client.get(f"/assets/{asset}").json()["status"] == "available"
    assert all(loan["borrower_uid"] == "alice" for loan in client.get("/loans").json()["items"])
    assert client.get("/loans/export").status_code == 403
    assert "asset_name" in client.get(as_user("staff", "/loans/export")).text


def test_ai_drafts_validate_and_enforce_quota(api_client, monkeypatch):
    client = api_client
    monkeypatch.setenv("GEMINI_API_KEY", "local-test")
    monkeypatch.setenv("GEMINI_MODEL", "flash-test")

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": (
                '{"category":"Electrical","priority":"Normal","summary":"Charging is intermittent.",'
                '"next_step":"Inspect the cable and port."}'
            )}]}}]}

    monkeypatch.setattr("assistant.httpx.post", lambda *args, **kwargs: Response())
    data = {"symptom": "Charging stops when the cable moves."}
    path = as_user("staff", "/ai/repair-draft")
    assert client.post("/ai/repair-draft", json=data).status_code == 403
    assert client.post(path, json={"symptom": "Email sam@example.com about this"}).status_code == 422
    for _ in range(5):
        reply = client.post(path, json=data)
        assert reply.status_code == 200, reply.text
        assert reply.json()["category"] == "Electrical"
    assert client.post(path, json=data).status_code == 429


def test_unauthenticated_is_rejected():
    with TestClient(app) as client:
        assert client.get("/me").status_code == 401
