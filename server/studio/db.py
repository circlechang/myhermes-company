"""SQLite engine + bootstrap (default company and admin/admin)."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterator

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from . import models  # noqa: F401  (register tables)
from .auth import hash_password
from .models import Company, Member

log = logging.getLogger("studio.db")


def make_engine(db_path: Path | str):
    if str(db_path) == ":memory:":
        return create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
    p = Path(db_path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    return create_engine(f"sqlite:///{p}", connect_args={"check_same_thread": False})


def _add_missing_columns(engine) -> None:
    """輕量 migration：模型有、資料表沒有的欄位用 ALTER TABLE ADD COLUMN 補上（SQLite）。"""
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    existing_tables = set(insp.get_table_names())
    with engine.begin() as conn:
        for table in SQLModel.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue
            have = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in have:
                    continue
                ddl = col.type.compile(dialect=engine.dialect)
                default = ""
                if col.default is not None and getattr(col.default, "arg", None) is not None and not callable(col.default.arg):
                    v = col.default.arg
                    default = f" DEFAULT {v!r}" if isinstance(v, str) else f" DEFAULT {int(v) if isinstance(v, bool) else v}"
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {ddl}{default}'))
                log.warning("db: added missing column %s.%s", table.name, col.name)


def init_db(engine) -> None:
    SQLModel.metadata.create_all(engine)
    _add_missing_columns(engine)
    with Session(engine) as s:
        if s.exec(select(Member)).first() is None:
            co = Company(name="預設公司")
            s.add(co)
            s.flush()
            s.add(Member(company_id=co.id, username="admin", password_hash=hash_password("admin"), role="owner"))
            s.commit()
            log.warning("已建立預設公司與帳號 admin/admin —— 請儘快修改密碼（PATCH /members/{id}）")


def session_scope(engine) -> Iterator[Session]:
    with Session(engine) as s:
        yield s
