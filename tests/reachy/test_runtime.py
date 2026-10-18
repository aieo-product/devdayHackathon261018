import threading
from concurrent.futures import Future

import pytest
from support import Clock, snapshot

from reachy_focus.api import ApiError
from reachy_focus.config import Settings, SettingsStore
from reachy_focus.runtime import Runtime


class Hardware:
    def __init__(self):
        self.captures = self.notifications = self.cancels = 0

    def capabilities(self):
        return {"camera": True, "actions": ["reminder", "antenna_wiggle"]}

    def capture(self):
        self.captures += 1
        return b"jpeg"

    def notify(self, settings):
        self.notifications += 1
        return [{"action": "reminder", "status": "started"}]

    def celebrate(self, settings):
        return [{"action": "cheerful1", "status": "started"}]

    def cancel(self):
        self.cancels += 1

    def step(self):
        pass


class Api:
    def __init__(self):
        self.controls = []
        self.counter = 0
        self.frames = []

    def start(self, settings):
        self.counter += 1
        return snapshot("session-" + str(self.counter), next_capture_after_ms=0)

    def control(self, settings, sid, action):
        self.controls.append((sid, action))
        return snapshot(
            sid,
            state={"pause": "paused", "resume": "observing", "end": "ended"}[action],
        )

    def frame(self, settings, sid, frame_id, jpeg):
        self.frames.append(frame_id)
        return snapshot(sid)


@pytest.fixture
def runtime(tmp_path):
    store = SettingsStore(tmp_path / "settings.json")
    store.save(Settings(api_token="test-secret"))
    r = Runtime(Hardware(), Api(), store, Clock())
    yield r
    r.close()


def test_controls_require_consent_and_token(runtime):
    with pytest.raises(ValueError):
        runtime.control("start")
    runtime.configure({"api_token": ""})
    with pytest.raises(ValueError):
        runtime.control("start", consent=True)


def test_phone_release_executes_happy_once(runtime):
    r = runtime
    r.control("start", consent=True)
    for phone in (1, 0, 0):
        f = Future()
        f.set_result(
            snapshot(
                phone_probability=phone,
                observable_probability=1,
                reason="phone_use_suspected" if phone else "phone_use_not_detected",
            )
        )
        r.pending, r.pending_generation = f, r.session.generation
        r.step()
    events = [e for e in r.session.events if e["event"] == "phone_put_down"]
    assert len(events) == 1
    assert events[0]["actions"] == [{"action": "cheerful1", "status": "started"}]


@pytest.mark.parametrize(
    "change", ["pause", "end", "settings", "new_session", "deadline"]
)
def test_old_frame_never_notifies(runtime, change):
    r = runtime
    r.control("start", consent=True)
    sid = r.session.session_id
    f = Future()
    r.pending, r.pending_generation = f, r.session.generation
    if change == "settings":
        r.configure({"motion_enabled": True})
    elif change == "new_session":
        r.control("end")
        r.control("start", consent=True)
    elif change == "deadline":
        r.session.clock.now += 1500
    else:
        r.control(change)
    f.set_result(snapshot(sid, notify=True, notification_id="notice-1"))
    r.step()
    assert r.hardware.notifications == 0


def test_server_delay_is_used_without_extra_local_interval(runtime):
    r = runtime
    r.control("start", consent=True)
    f = Future()
    f.set_result(snapshot(next_capture_after_ms=250))
    r.pending, r.pending_generation = f, r.session.generation
    r.step()
    assert r.next_capture == r.session.clock() + 0.25
    assert r.hardware.captures == 0


def test_only_one_inflight_and_stop_stays_responsive(runtime):
    r = runtime
    entered, release = threading.Event(), threading.Event()

    def frame(settings, sid, fid, jpeg):
        entered.set()
        assert release.wait(3)
        return snapshot(sid, notify=True, notification_id="late")

    r.api.frame = frame
    r.control("start", consent=True)
    r.step()
    assert entered.wait(2)
    for _ in range(10):
        r.session.clock.now += 1
        r.step()
    assert r.hardware.captures == 1
    r.control("pause")
    release.set()
    r.pending.result(timeout=2)
    r.step()
    assert r.hardware.notifications == 0 and r.hardware.captures == 1


def test_failed_pause_still_stops_capture(runtime):
    r = runtime
    r.control("start", consent=True)

    def fail(*args):
        raise ApiError("connection")

    r.api.control = fail
    with pytest.raises(ValueError):
        r.control("pause")
    r.step()
    assert r.session.state == "paused" and r.hardware.captures == 0


def test_end_during_slow_start_closes_remote_session(runtime):
    r = runtime
    entered, release = threading.Event(), threading.Event()

    def slow(settings):
        entered.set()
        assert release.wait(3)
        return snapshot()

    r.api.start = slow
    thread = threading.Thread(target=lambda: r.control("start", consent=True))
    thread.start()
    assert entered.wait(2)
    # No session id exists yet; stop locally without waiting for the pending start.
    # control/end can wait for serialized commands, so execute it on another thread.
    ended = threading.Event()
    locally_stopped = threading.Event()
    original_cancel = r.hardware.cancel

    def cancelled():
        original_cancel()
        locally_stopped.set()

    r.hardware.cancel = cancelled

    def end():
        r.control("end")
        ended.set()

    t = threading.Thread(target=end)
    t.start()
    assert locally_stopped.wait(2)
    with r.lock:
        assert r.session.state == "ended"
    release.set()
    thread.join(3)
    t.join(3)
    r.cleanup_pool.submit(lambda: None).result(timeout=3)
    assert ended.is_set() and ("session-1", "end") in r.api.controls
    assert r.hardware.captures == 0


def test_settings_owner_only_no_token_echo_and_preview_local(runtime):
    assert runtime.preview() == b"jpeg"
    runtime.configure({"motion_enabled": True})
    assert runtime.store.path.stat().st_mode & 0o777 == 0o600
    assert "test-secret" not in str(runtime.snapshot())
    assert "test-secret" not in repr(runtime.session.settings)
    runtime.control("start", consent=True)
    with pytest.raises(ValueError):
        runtime.preview()


def test_queued_capture_cancelled_and_local_timer_runs_without_frames(runtime):
    r = runtime
    r.control("start", consent=True)
    g = r.session.generation
    r.session.clock.now += 1500
    r.step()
    assert r.session.state == "completed"
    assert r._observe(g, r.session.settings, "session-1") is None
    assert r.hardware.captures == r.hardware.notifications == 0
