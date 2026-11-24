import argparse

from db import engine, query, rows
from inventory import delete_photo_object


def make_admin(uid):
    with engine().begin() as db:
        updated = query(db, "UPDATE members SET role='admin' WHERE uid=:uid RETURNING uid", uid=uid).first()
        if not updated:
            raise SystemExit("No matching UID. First sign in to AssetFlow with that verified Firebase user.")
    print("Admin role granted.")


def cleanup():
    with engine().connect() as db:
        pending = rows(db, "SELECT public_id FROM photo_cleanup ORDER BY public_id LIMIT 100")
    removed = 0
    for photo in pending:
        if delete_photo_object(photo["public_id"]):
            with engine().begin() as db:
                query(db, "DELETE FROM photo_cleanup WHERE public_id=:id", id=photo["public_id"])
            removed += 1
    print(f"Cleaned {removed} of {len(pending)} queued photos.")


def seed():
    equipment = [
        ("LAP-101", "Portable editing laptop", "Computers", "Media Lab", "Laptop kit with charger."),
        ("CAM-210", "Mirrorless camera kit", "Photography", "Studio A", "Camera body, battery and kit lens."),
        ("AUD-306", "Podcast microphone", "Audio", "Studio B", "USB microphone with desk stand."),
    ]
    with engine().begin() as db:
        for tag, name, category, location, description in equipment:
            query(db, """
                INSERT INTO assets (tag, name, category, location, description)
                VALUES (:tag, :name, :category, :location, :description)
                ON CONFLICT (tag) DO NOTHING
            """, tag=tag, name=name, category=category, location=location, description=description)
    print("Sample drafts are ready. Upload a photo to each draft before publishing.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    admin = commands.add_parser("admin")
    admin.add_argument("firebase_uid")
    commands.add_parser("cleanup")
    commands.add_parser("seed")
    args = parser.parse_args()
    if args.command == "admin":
        make_admin(args.firebase_uid)
    elif args.command == "cleanup":
        cleanup()
    else:
        seed()
