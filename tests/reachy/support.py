class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


def snapshot(sid="session-1", **changes):
    return {
        "session_id": sid,
        "state": "observing",
        "notify": False,
        "notification_id": None,
        "provider": "openai",
        "reason": "session_started",
        "phone_probability": None,
        "observable_probability": None,
        "continuous_hold_ms": 0,
        "required_hold_ms": 5000,
        "cooldown_remaining_ms": 0,
        "next_capture_after_ms": 1000,
        "consecutive_count": 0,
    } | changes
