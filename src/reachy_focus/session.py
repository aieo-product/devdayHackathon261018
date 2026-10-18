"""Local safety/timer state; all phone-holding policy belongs to the server."""

import time
import uuid
from collections import deque


class Session:
    def __init__(self, settings, clock=time.monotonic):
        self.settings = settings
        self.clock = clock
        self.state = "idle"
        self.generation = 0
        self.session_id = None
        self.deadline = 0.0
        self.remote = None
        self.error = None
        self.notification_count = 0
        self.events = deque(maxlen=500)
        self.seen = set()
        self.phone_in_use = False
        self.phone_put_down = False
        self.focus_seconds = 0.0
        self.last_focus_sample = None

    def reset_focus(self):
        self.focus_seconds = 0.0
        self.last_focus_sample = None

    def log(self, event, **values):
        self.events.append(
            {
                "id": str(uuid.uuid4()),
                "time": time.time(),
                "device": "reachy_mini",
                "event": event,
                **values,
            }
        )

    def invalidate(self):
        self.generation += 1
        self.reset_focus()
        self.phone_in_use = False
        self.phone_put_down = False
        if self.remote:
            self.remote = self.remote | {
                "notify": False,
                "notification_id": None,
                "continuous_hold_ms": 0,
                "consecutive_count": 0,
            }

    def begin(self):
        if self.state in ("starting", "running", "paused", "resuming"):
            raise ValueError("進行中のセッションを終了してください。")
        self.invalidate()
        self.state = "starting"
        self.session_id = None
        self.remote = None
        self.error = None
        self.deadline = self.clock() + self.settings.duration_minutes * 60
        self.notification_count = 0
        self.events.clear()
        self.seen.clear()
        return self.generation

    def stop_local(self, state, event):
        self.invalidate()
        self.state = state
        self.log(event)

    def tick(self):
        if (
            self.last_focus_sample is not None
            and self.clock() - self.last_focus_sample >= 10
        ):
            self.reset_focus()
        if (
            self.state in ("starting", "running", "paused", "resuming")
            and self.clock() >= self.deadline
        ):
            self.stop_local("completed", "session_completed")
            return True
        return False

    def apply(self, snapshot, generation, from_frame=False):
        self.phone_put_down = False
        self.tick()
        if generation != self.generation:
            return None
        if from_frame and self.state != "running":
            return None
        self.error = None
        self.remote = snapshot | {"notify": False, "notification_id": None}
        if snapshot["state"] == "ended":
            self.stop_local(
                "completed" if snapshot["reason"] == "session_expired" else "ended",
                "session_completed"
                if snapshot["reason"] == "session_expired"
                else "session_ended",
            )
            return None
        if snapshot["state"] == "paused":
            self.state = "paused"
            return None
        if from_frame:
            observable = snapshot["observable_probability"]
            phone = snapshot["phone_probability"]
            if (
                snapshot["reason"] == "phone_use_not_detected"
                and observable is not None
                and observable >= 0.7
                and phone is not None
                and phone <= 0.2
            ):
                now = self.clock()
                if self.last_focus_sample is not None:
                    self.focus_seconds += now - self.last_focus_sample
                self.last_focus_sample = now
            else:
                self.reset_focus()
            if observable is not None and observable >= 0.7 and phone is not None:
                if phone >= 0.8:
                    self.phone_in_use = True
                elif phone <= 0.2 and snapshot["reason"] == "phone_use_not_detected":
                    self.phone_put_down = self.phone_in_use
                    self.phone_in_use = False
        nid = snapshot.get("notification_id")
        if from_frame and snapshot["notify"] and nid and nid not in self.seen:
            self.seen.add(nid)
            self.notification_count += 1
            self.log("phone_detected", notification_id=nid)
            return nid
        return None

    def fail(self, reason):
        self.reset_focus()
        self.error = reason
        if self.remote:
            self.remote = self.remote | {
                "notify": False,
                "notification_id": None,
                "state": "unknown",
                "reason": reason,
                "continuous_hold_ms": 0,
                "consecutive_count": 0,
            }
        self.log("api_failed", reason=reason)

    def snapshot(self):
        return {
            "state": self.state,
            "session_id": self.session_id,
            "remaining_seconds": max(0, self.deadline - self.clock())
            if self.state in ("starting", "running", "paused", "resuming")
            else 0,
            "notification_count": self.notification_count,
            "focus_seconds": self.focus_seconds,
            "server": self.remote,
            "error": self.error,
            "events": list(self.events),
        }
