def test_health_public(client):
    assert client.get("/health").json() == {"ok": True}


def test_bootstrap_admin_and_login(client):
    r = client.post("/auth/login", json={"username": "admin", "password": "admin"})
    assert r.status_code == 200
    body = r.json()
    assert body["member"]["username"] == "admin" and body["member"]["role"] == "owner"
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200 and me.json()["id"] == body["member"]["id"]


def test_bad_password_and_missing_token(client):
    r = client.post("/auth/login", json={"username": "admin", "password": "nope"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_credentials"
    r = client.get("/auth/me")
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorized"
    r = client.get("/auth/me", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401


def test_members_crud_and_roles(client, auth):
    assert client.get("/companies/current", headers=auth).json()["name"] == "預設公司"
    r = client.post("/members", json={"username": "bob", "password": "bobpass", "role": "member"}, headers=auth)
    assert r.status_code == 201, r.text
    bob_id = r.json()["id"]
    assert len(client.get("/members", headers=auth).json()) == 2
    # duplicate
    assert client.post("/members", json={"username": "bob", "password": "x1234", "role": "member"}, headers=auth).status_code == 409
    # bob cannot create members
    bob_tok = client.post("/auth/login", json={"username": "bob", "password": "bobpass"}).json()["token"]
    bob_auth = {"Authorization": f"Bearer {bob_tok}"}
    assert client.post("/members", json={"username": "c", "password": "cpass1", "role": "member"}, headers=bob_auth).status_code == 403
    # bob can change own password, not own role
    assert client.patch(f"/members/{bob_id}", json={"password": "newpass"}, headers=bob_auth).status_code == 200
    assert client.patch(f"/members/{bob_id}", json={"role": "owner"}, headers=bob_auth).status_code == 403
    assert client.post("/auth/login", json={"username": "bob", "password": "newpass"}).status_code == 200
    # admin promotes then deletes
    assert client.patch(f"/members/{bob_id}", json={"role": "admin"}, headers=auth).json()["role"] == "admin"
    assert client.delete(f"/members/{bob_id}", headers=auth).json()["ok"] is True
    assert client.get("/auth/me", headers=bob_auth).status_code == 401


def test_login_lockout_after_five_failures_and_clear(client, app):
    """同帳號連續 5 次失敗 → 423＋retry_after；正確密碼也擋；清鎖後可登入；成功登入會歸零計數。"""
    from sqlmodel import Session
    from studio.api.auth_api import clear_locks
    from studio.models import LoginLock

    for i in range(4):
        r = client.post("/auth/login", json={"username": "admin", "password": f"bad{i}"})
        assert r.status_code == 401, (i, r.text)
    r = client.post("/auth/login", json={"username": "admin", "password": "bad4"})
    assert r.status_code == 423 and r.json()["error"]["code"] == "locked"
    assert 0 < r.json()["error"]["retry_after"] <= 15 * 60 and r.headers["retry-after"]
    # 鎖住期間連正確密碼都 423
    r = client.post("/auth/login", json={"username": "admin", "password": "admin"})
    assert r.status_code == 423 and "秒後再試" in r.json()["error"]["message"]
    # 同 IP 換帳號也鎖（IP 計數）
    assert client.post("/auth/login", json={"username": "someone", "password": "x"}).status_code == 423
    with Session(app.state.engine) as db:
        keys = {row.key for row in db.exec(__import__("sqlmodel").select(LoginLock)).all()}
        assert "u:admin" in keys and any(k.startswith("ip:") for k in keys)
        assert clear_locks(db) >= 2
    r = client.post("/auth/login", json={"username": "admin", "password": "admin"})
    assert r.status_code == 200
    # 成功登入後計數歸零：再錯 4 次仍是 401 不是 423
    for i in range(4):
        assert client.post("/auth/login", json={"username": "admin", "password": "nope"}).status_code == 401
    assert client.post("/auth/login", json={"username": "admin", "password": "admin"}).status_code == 200


def test_login_lock_expires(client, app):
    """鎖到期自動解除並重新計數。"""
    from datetime import timedelta
    from sqlmodel import Session, select
    from studio.models import LoginLock, now

    for _ in range(5):
        client.post("/auth/login", json={"username": "admin", "password": "bad"})
    assert client.post("/auth/login", json={"username": "admin", "password": "admin"}).status_code == 423
    with Session(app.state.engine) as db:
        for lock in db.exec(select(LoginLock)).all():
            lock.locked_until = now() - timedelta(seconds=1)
            db.add(lock)
        db.commit()
    assert client.post("/auth/login", json={"username": "admin", "password": "admin"}).status_code == 200
