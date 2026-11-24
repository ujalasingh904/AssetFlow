from alembic import op


revision = "0001"
down_revision = None


def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")
    op.execute("""
        CREATE TABLE members (
            uid text PRIMARY KEY,
            email text NOT NULL,
            name text NOT NULL,
            role text NOT NULL DEFAULT 'borrower' CHECK (role IN ('borrower', 'staff', 'admin'))
        )
    """)
    op.execute("""
        CREATE TABLE assets (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tag text NOT NULL UNIQUE,
            name text NOT NULL,
            category text NOT NULL,
            location text NOT NULL,
            description text NOT NULL DEFAULT '',
            published boolean NOT NULL DEFAULT false,
            maintenance boolean NOT NULL DEFAULT false,
            condition text NOT NULL DEFAULT 'Good'
        )
    """)
    op.execute("""
        CREATE TABLE photos (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            asset_id bigint NOT NULL REFERENCES assets(id),
            public_id text NOT NULL UNIQUE,
            url text NOT NULL,
            position integer NOT NULL DEFAULT 0
        )
    """)
    op.execute("CREATE INDEX photos_order ON photos (asset_id, position, id)")
    op.execute("""
        CREATE TABLE loans (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            asset_id bigint NOT NULL REFERENCES assets(id),
            borrower_uid text NOT NULL REFERENCES members(uid),
            starts date NOT NULL,
            ends date NOT NULL CHECK (ends >= starts),
            purpose text NOT NULL,
            status text NOT NULL DEFAULT 'pending' CHECK (
                status IN ('pending', 'approved', 'rejected', 'checked_out', 'returned', 'cancelled')
            ),
            decision_note text,
            return_note text,
            created_at timestamptz NOT NULL DEFAULT now(),
            checked_out_at timestamptz,
            returned_at timestamptz,
            CONSTRAINT loans_no_overlap EXCLUDE USING gist (
                asset_id WITH =, daterange(starts, ends, '[]') WITH &&
            ) WHERE (status IN ('approved', 'checked_out'))
        )
    """)
    op.execute("""
        CREATE UNIQUE INDEX one_checkout_per_asset ON loans (asset_id) WHERE status = 'checked_out'
    """)
    op.execute("CREATE INDEX loans_borrower ON loans (borrower_uid, id DESC)")
    op.execute("""
        CREATE TABLE events (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            actor_uid text NOT NULL REFERENCES members(uid),
            asset_id bigint REFERENCES assets(id),
            loan_id bigint REFERENCES loans(id),
            action text NOT NULL,
            detail text NOT NULL DEFAULT '',
            created_at timestamptz NOT NULL DEFAULT now()
        )
    """)
    op.execute("""
        CREATE TABLE ai_usage (
            day date NOT NULL,
            bucket text NOT NULL,
            calls int NOT NULL,
            PRIMARY KEY (day, bucket)
        )
    """)
    op.execute("""
        CREATE TABLE photo_cleanup (
            public_id text PRIMARY KEY
        )
    """)


def downgrade():
    for table in ("photo_cleanup", "ai_usage", "events", "loans", "photos", "assets", "members"):
        op.execute(f"DROP TABLE {table}")
