import os
from functools import lru_cache

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

load_dotenv()


@lru_cache
def engine():
    url = os.environ["DATABASE_URL"].replace("postgresql://", "postgresql+psycopg://", 1)
    return create_engine(url, poolclass=NullPool, connect_args={"connect_timeout": 10})


def query(db, sql, **params):
    return db.execute(text(sql), params).mappings()


def rows(db, sql, **params):
    return [dict(row) for row in query(db, sql, **params)]


def one(db, sql, **params):
    row = query(db, sql, **params).first()
    return dict(row) if row is not None else None


def event(db, user, action, asset=None, loan=None, detail=""):
    query(db, """
        INSERT INTO events (actor_uid, action, asset_id, loan_id, detail)
        VALUES (:uid, :action, :asset, :loan, :detail)
    """, uid=user["uid"], action=action, asset=asset, loan=loan, detail=detail)
