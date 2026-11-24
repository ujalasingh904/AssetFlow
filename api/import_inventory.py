import argparse
import csv
from pathlib import Path

from fastapi import HTTPException, UploadFile

from db import engine, one
from inventory import (
    AssetInput,
    AssetState,
    change_state,
    create_asset,
    upload_photo,
)


def import_item(row, folder, admin):
    data = AssetInput(
        tag=row["Asset tag"].strip().upper(),
        name=row["Equipment name"],
        category=row["Category"],
        location=row["Location"],
        description=row["Description"],
    )

    with engine().connect() as db:
        existing = one(
            db,
            "SELECT id, published FROM assets WHERE tag = :tag",
            tag=data.tag,
        )

    if existing:
        if existing["published"]:
            print(f"SKIPPED  {data.tag} already exists and is published.")
            return
        raise ValueError(
            f"{data.tag} already exists as a draft. Open it in Equipment, "
            "check its photos, upload any missing photo, then publish it."
        )

    
    photos = [
        folder / row["Cover photo"],
        folder / row["Second photo"],
    ]
    for path in photos:
        if not path.is_file():
            raise ValueError(f"Missing photo: {path}")

    asset_id = create_asset(data, admin)["id"]

     
    for path in photos:
        with path.open("rb") as image:
            upload_photo(
                asset_id=asset_id,
                user=admin,
                file=UploadFile(file=image, filename=path.name),
            )

    change_state(asset_id, AssetState(action="publish"), admin)
    print(f"ADDED    {data.tag} | {data.name} | 2 photos | Published")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("csv_file", type=Path)
    parser.add_argument("admin_uid")
    args = parser.parse_args()

    with engine().connect() as db:
        admin = one(
            db,
            "SELECT * FROM members WHERE uid = :uid AND role = 'admin'",
            uid=args.admin_uid,
        )
    if not admin:
        raise SystemExit("This UID must already be an AssetFlow admin in this database.")

    failures = 0
    with args.csv_file.open(encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            try:
                import_item(row, args.csv_file.parent, admin)
            except (HTTPException, ValueError, OSError) as error:
                failures += 1
                detail = error.detail if isinstance(error, HTTPException) else str(error)
                print(f"CHECK    {row['Asset tag']} | {detail}")

    if failures:
        raise SystemExit(f"{failures} item(s) need attention. See CHECK lines above.")


if __name__ == "__main__":
    main()