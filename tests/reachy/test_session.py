import pytest

from reachy_focus.config import Settings
from reachy_focus.decisions import Observation
from reachy_focus.session import Session


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


@pytest.fixture
def session():
    s = Session(Settings(), Clock())
    s.start()
    return s


def positive(s):
    return s.accept(s.generation, Observation(True, 0.95, "evaluated"))


def test_three_consecutive_and_cooldown_requires_new_streak(session):
    s = session
    assert positive(s) is None
    s.clock.now += 3
    assert positive(s) is None
    s.clock.now += 3
    assert positive(s)
    s.clock.now += 59
    assert positive(s) is None
    s.clock.now += 1
    assert positive(s) is None
    assert positive(s) is None
    assert positive(s)
    assert s.notification_count == 2


@pytest.mark.parametrize(
    "observation",
    [Observation(True, 0.1, "evaluated"), Observation(False, None, "unobservable")],
)
def test_negative_and_unobservable_reset(session, observation):
    positive(session)
    session.accept(session.generation, observation)
    assert session.streak == 0
    assert positive(session) is None


def test_gap_at_ten_seconds_resets(session):
    positive(session)
    session.clock.now += 10
    assert positive(session) is None
    assert session.streak == 1


def test_error_resets(session):
    positive(session)
    session.fail("timeout")
    assert session.streak == 0
    assert session.last_observation["phone_probability"] is None


def test_pause_resume_and_new_session_discard_late_result(session):
    s = session
    old = s.generation
    positive(s)
    s.pause()
    s.resume()
    assert s.accept(old, Observation(True, 1, "evaluated")) is None
    assert s.streak == 0
    s.end()
    s.start()
    assert s.accept(old, Observation(True, 1, "evaluated")) is None
    assert len(s.events) == 1


def test_timer_expires_during_pause(session):
    session.pause()
    session.clock.now += 1500
    assert session.tick()
    assert session.state == "completed"
    with pytest.raises(ValueError):
        session.resume()


def test_response_at_deadline_cannot_notify(session):
    positive(session)
    positive(session)
    session.clock.now += 1500
    assert positive(session) is None
    assert session.state == "completed"
