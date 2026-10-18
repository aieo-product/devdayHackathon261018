from support import Clock, snapshot

from reachy_focus.config import Settings
from reachy_focus.session import Session


def running():
    s = Session(Settings(), Clock())
    s.begin()
    s.state = "running"
    s.session_id = "session-1"
    return s


def test_server_notify_is_the_only_trigger_and_is_consumed_once():
    s = running()
    g = s.generation
    # A high probability, a hold above five seconds, or elapsed local time cannot notify.
    assert (
        s.apply(
            snapshot(phone_probability=1, continuous_hold_ms=9000), g, from_frame=True
        )
        is None
    )
    s.clock.now += 20
    assert s.apply(snapshot(), g, from_frame=True) is None
    event = snapshot(notify=True, notification_id="notice-1", continuous_hold_ms=5000)
    assert s.apply(event, g, from_frame=True) == "notice-1"
    assert s.apply(event, g, from_frame=True) is None
    assert s.notification_count == 1
    assert not s.snapshot()["server"]["notify"]


def test_control_snapshot_and_old_generation_cannot_notify():
    s = running()
    g = s.generation
    event = snapshot(notify=True, notification_id="notice-1")
    assert s.apply(event, g) is None
    s.stop_local("paused", "session_paused")
    assert s.apply(event, g, from_frame=True) is None
    assert s.notification_count == 0


def test_paused_deadline_and_confirmed_progress_do_not_advance_locally():
    s = running()
    s.apply(snapshot(continuous_hold_ms=1000), s.generation)
    s.clock.now += 2
    assert s.snapshot()["server"]["continuous_hold_ms"] == 1000
    s.stop_local("paused", "session_paused")
    s.clock.now += 1500
    assert s.tick() and s.state == "completed"


def test_put_down_requires_visible_positive_then_confident_negative_fresh_frame():
    s = running()
    g = s.generation
    positive = snapshot(phone_probability=1, observable_probability=1)
    negative = snapshot(
        phone_probability=0,
        observable_probability=1,
        reason="phone_use_not_detected",
    )
    s.apply(negative, g, from_frame=True)
    assert not s.phone_put_down

    s.apply(positive, g, from_frame=True)
    s.apply(negative, g)  # GET/control data cannot celebrate.
    assert not s.phone_put_down
    s.apply(negative | {"observable_probability": 0.2}, g, from_frame=True)
    assert not s.phone_put_down
    s.apply(negative | {"phone_probability": 0.5}, g, from_frame=True)
    assert not s.phone_put_down
    s.apply(negative, g, from_frame=True)
    assert s.phone_put_down
    s.apply(negative, g, from_frame=True)
    assert not s.phone_put_down
    s.apply(positive, g, from_frame=True)
    s.stop_local("paused", "session_paused")
    s.apply(negative, g, from_frame=True)
    assert not s.phone_put_down


def test_focus_progress_counts_only_visible_fresh_negatives_and_resets_on_interruption():
    s = running()
    g = s.generation
    negative = snapshot(
        phone_probability=0.02,
        observable_probability=0.95,
        reason="phone_use_not_detected",
    )
    s.apply(negative, g, from_frame=True)
    for _ in range(30):
        s.clock.now += 1
        s.apply(negative, g, from_frame=True)
    assert s.focus_seconds == 30
    s.clock.now += 1
    s.apply(negative, g)  # Status/control replies never add time.
    assert s.focus_seconds == 30
    s.apply(negative | {"phone_probability": 1}, g, from_frame=True)
    assert s.focus_seconds == 0
    s.apply(negative, g, from_frame=True)
    s.clock.now += 2
    s.apply(negative, g, from_frame=True)
    assert s.focus_seconds == 2
    s.fail("connection")
    assert s.focus_seconds == 0
    s.apply(negative, g, from_frame=True)
    s.clock.now += 10
    s.tick()
    assert s.focus_seconds == 0 and s.last_focus_sample is None
    s.apply(negative, g, from_frame=True)
    s.clock.now += 1
    s.apply(negative, g, from_frame=True)
    s.apply(negative | {"observable_probability": 0.2}, g, from_frame=True)
    assert s.focus_seconds == 0
    s.stop_local("paused", "session_paused")
    s.apply(negative, g, from_frame=True)
    assert s.last_focus_sample is None
