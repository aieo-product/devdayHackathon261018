from fastapi import FastAPI
from fastapi.testclient import TestClient

from reachy_focus.web import attach_routes


def test_lan_control_contract(runtime):
    app = FastAPI()
    attach_routes(app, lambda: runtime)
    with TestClient(app) as client:
        assert client.get("/api/status").headers["cache-control"] == "no-store"
        assert (
            client.post("/api/session/start", json={"consent": True}).status_code == 403
        )
        headers = {"X-Focus-Control": "1"}
        assert (
            client.post(
                "/api/session/start", headers=headers, json={"consent": False}
            ).status_code
            == 400
        )
        assert (
            client.post(
                "/api/session/start", headers=headers, json={"consent": True}
            ).json()["state"]
            == "running"
        )
        assert (
            client.post("/api/session/pause", headers=headers, json={}).json()["state"]
            == "paused"
        )
        assert (
            client.post(
                "/api/settings", headers=headers, json={"api_token": "another-secret"}
            ).status_code
            == 200
        )
        assert "another-secret" not in client.get("/api/status").text
        bad_origin = headers | {"Origin": "https://evil.example"}
        assert (
            client.post("/api/session/end", headers=bad_origin, json={}).status_code
            == 403
        )
        bad = client.post("/api/settings", headers=headers, json=["private-secret"])
        assert bad.status_code == 422
        assert "private-secret" not in bad.text


def test_startup_returns_retryable_not_ready():
    app = FastAPI()
    attach_routes(app, lambda: None)
    assert TestClient(app).get("/api/status").status_code == 503
