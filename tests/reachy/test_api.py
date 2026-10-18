import json

import httpx
import pytest
from support import snapshot

from reachy_focus.api import ApiError, FocusApi, parse_snapshot
from reachy_focus.config import Settings, SettingsStore


def test_raw_image_and_control_contract():
    requests = []

    def handle(r):
        requests.append(r)
        assert r.headers["authorization"] == "Bearer test-secret"
        if r.url.path.endswith("/frames"):
            assert r.content == b"jpeg"
            assert r.headers["content-type"] == "image/jpeg"
            assert r.headers["x-frame-id"] == "reachy-1"
            return httpx.Response(
                200,
                json=snapshot(
                    notify=True,
                    notification_id="notification-1",
                    continuous_hold_ms=5000,
                ),
            )
        if r.url.path.endswith("/control"):
            assert json.loads(r.content) == {"action": "pause"}
            return httpx.Response(
                200,
                json=snapshot(
                    state="paused", notify=True, notification_id="must-ignore"
                ),
            )
        assert json.loads(r.content) == {
            "device_type": "reachy_mini",
            "duration_seconds": 1500,
        }
        return httpx.Response(201, json=snapshot())

    api = FocusApi(httpx.MockTransport(handle))
    settings = Settings(api_token="test-secret")
    assert not api.start(settings)["notify"]
    assert api.frame(settings, "session-1", "reachy-1", b"jpeg")["notify"]
    assert not api.control(settings, "session-1", "pause")["notify"]
    assert len(requests) == 3


@pytest.mark.parametrize(
    "changes",
    [
        {"notify": "true"},
        {"next_capture_after_ms": float("nan")},
        {"state": "invalid"},
        {"phone_probability": 2},
        {"notification_id": None, "notify": True},
        {"provider": "other"},
    ],
)
def test_invalid_snapshots_fail_closed(changes):
    with pytest.raises(ApiError):
        parse_snapshot(snapshot(**changes), allow_notify=True)


def test_wrong_session_is_rejected_and_get_cannot_notify():
    with pytest.raises(ApiError):
        parse_snapshot(snapshot(), expected_id="another")
    assert not parse_snapshot(snapshot(notify=True, notification_id="notification-1"))[
        "notify"
    ]


@pytest.mark.parametrize(
    "status,code",
    [(401, "unauthorized"), (503, "service_not_configured"), (429, "frame_limit")],
)
def test_error_never_echoes_upstream_secret(status, code):
    api = FocusApi(
        httpx.MockTransport(
            lambda _: httpx.Response(status, text="private-token-and-image")
        )
    )
    with pytest.raises(ApiError) as err:
        api.start(Settings(api_token="private"))
    assert str(err.value) == code


def test_oversize_image_never_sent():
    api = FocusApi(httpx.MockTransport(lambda _: pytest.fail("must not send")))
    with pytest.raises(ApiError):
        api.frame(Settings(), "session-1", "frame-1", b"x" * 1048577)


def test_settings_migrate_without_forwarding_openai_key(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "api_key": "old-openai-key",
                "model": "old",
                "threshold": 0.8,
                "duration_minutes": 5,
            }
        )
    )
    s = SettingsStore(path).load()
    assert s.api_token == "" and s.duration_minutes == 5
    assert "old-openai-key" not in str(s.public())
    with pytest.raises(ValueError):
        SettingsStore.updated(s, {"api_url": "http://external.example"})
