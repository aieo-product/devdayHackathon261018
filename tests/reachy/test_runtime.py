import threading
from concurrent.futures import Future

import pytest
from test_session import Clock

from reachy_focus.config import Settings, SettingsStore
from reachy_focus.decisions import DecisionError, Observation
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

    def cancel(self):
        self.cancels += 1

    def step(self):
        pass


class Evaluator:
    def evaluate(self, image, settings):
        return Observation(True, 1, "evaluated")


@pytest.fixture
def runtime(tmp_path):
    store = SettingsStore(tmp_path / "settings.json")
    store.save(Settings(api_key="test-secret"))
    r = Runtime(Hardware(), Evaluator(), store, Clock())
    yield r
    r.close()


def test_controls_require_consent_and_key(runtime):
    with pytest.raises(ValueError):
        runtime.control("start")
    runtime.configure({"api_key": ""})
    with pytest.raises(ValueError):
        runtime.control("start", consent=True)


@pytest.mark.parametrize(
    "change", ["pause", "end", "settings", "new_session", "deadline"]
)
def test_stale_inference_never_notifies(runtime, change):
    r = runtime
    r.control("start", consent=True)
    r.session.streak = 2
    future = Future()
    r.pending, r.pending_generation = future, r.session.generation
    if change == "settings":
        r.configure({"motion_enabled": True})
    elif change == "new_session":
        r.control("end")
        r.control("start", consent=True)
    elif change == "deadline":
        r.session.clock.now += 1500
    else:
        r.control(change)
    future.set_result(Observation(True, 1, "evaluated"))
    r.step()
    assert r.hardware.notifications == 0
    if change in ("pause", "end", "deadline"):
        assert r.hardware.captures == 0


def test_single_inflight_request_and_responsive_stop(runtime):
    r = runtime
    entered, release = threading.Event(), threading.Event()

    class Blocking:
        def evaluate(self, image, settings):
            entered.set()
            assert release.wait(2)
            return Observation(True, 1, "evaluated")

    r.evaluator = Blocking()
    r.control("start", consent=True)
    r.step()
    assert entered.wait(2)
    for _ in range(10):
        r.session.clock.now += 3
        r.step()
    assert r.hardware.captures == 1
    r.control("pause")
    release.set()
    r.pending.result(timeout=2)
    r.step()
    assert r.hardware.notifications == 0
    assert r.hardware.captures == 1


def test_configuration_is_owner_only_and_never_echoes_key(runtime):
    r = runtime
    r.configure({"motion_enabled": True})
    assert r.store.load().api_key == "test-secret"
    assert r.store.path.stat().st_mode & 0o777 == 0o600
    assert "test-secret" not in str(r.snapshot())
    assert "test-secret" not in repr(r.session.settings)


def test_preview_does_not_evaluate_and_active_preview_rejected(runtime):
    assert runtime.preview() == b"jpeg"
    assert runtime.hardware.captures == 1
    runtime.control("start", consent=True)
    with pytest.raises(ValueError):
        runtime.preview()


def test_key_removal_pauses(runtime):
    runtime.control("start", consent=True)
    runtime.configure({"api_key": ""})
    assert runtime.session.state == "paused"
    with pytest.raises(ValueError):
        runtime.control("resume")


def test_notification_runs_once_after_three_results(runtime):
    r = runtime
    r.control("start", consent=True)
    for _ in range(3):
        future = Future()
        future.set_result(Observation(True, 0.95, "evaluated"))
        r.pending, r.pending_generation = future, r.session.generation
        r.step()
        r.session.clock.now += 3
    assert r.hardware.notifications == 1
    for _ in range(5):
        r.step()
    assert r.hardware.notifications == 1


def test_worker_failure_resets_streak_without_notification(runtime):
    r = runtime
    r.control("start", consent=True)
    r.session.streak = 2
    future = Future()
    future.set_exception(DecisionError("timeout"))
    r.pending, r.pending_generation = future, r.session.generation
    r.step()
    assert r.session.streak == 0
    assert r.session.last_observation["reason"] == "timeout"
    assert r.hardware.notifications == 0


def test_timer_expires_without_a_completed_observation(runtime):
    r = runtime
    r.control("start", consent=True)
    r.pending, r.pending_generation = Future(), r.session.generation
    r.session.clock.now += 1500
    r.step()
    assert r.session.state == "completed"
    assert r.hardware.captures == r.hardware.notifications == 0


def test_queued_worker_cannot_capture_after_stop(runtime):
    r = runtime
    r.control("start", consent=True)
    generation, settings = r.session.generation, r.session.settings
    r.control("end")
    assert r._observe(generation, settings) is None
    assert r.hardware.captures == 0
