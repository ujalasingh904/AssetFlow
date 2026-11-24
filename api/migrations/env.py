import os
from alembic import context
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool


load_dotenv()
url = os.getenv("MIGRATION_DATABASE_URL") or os.environ["DATABASE_URL"]
url = url.replace("postgresql://", "postgresql+psycopg://", 1)
if context.is_offline_mode():
    context.configure(url=url, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    with create_engine(url, poolclass=NullPool).connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()
