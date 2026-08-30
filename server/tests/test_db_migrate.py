from sqlalchemy import text
from sqlmodel import SQLModel, create_engine
from studio.db import init_db


def test_missing_column_added(tmp_path):
    db = tmp_path / "m.db"
    eng = create_engine(f"sqlite:///{db}")
    # 先用「舊」schema 建 companies 表（缺 created_at 之外的任意欄位模擬）
    with eng.begin() as c:
        c.execute(text("CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL)"))
    init_db(eng)
    cols = {r[1] for r in eng.connect().execute(text("PRAGMA table_info(companies)")).fetchall()}
    assert cols >= {c.name for c in SQLModel.metadata.tables["companies"].columns}
