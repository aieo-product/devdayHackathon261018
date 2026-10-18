"""Deterministic on-robot session state, independent of SDK and transport."""

import time
import uuid
from collections import deque

from .config import Settings
from .decisions import Observation


class Session:
    def __init__(self, settings: Settings, clock=time.monotonic):
        self.settings = settings
        self.clock = clock
        self.state = "idle"
        self.generation = 0
        self.session_id = None
        self.deadline = 0.0
        self.streak = 0
        self.last_valid = None
        self.cooldown_until = 0.0
        self.last_observation = None
        self.notification_count = 0
        self.events = deque(maxlen=500)

    def log(self, event: str, **values) -> None:
        self.events.append(
            {
                "id": str(uuid.uuid4()),
                "time": time.time(),
                "device": "reachy",
                "event": event,
                **values,
            }
        )

    def reset_detection(self) -> None:
        self.streak = 0
        self.last_valid = None

    def invalidate(self) -> None:
        self.generation += 1
        self.reset_detection()
        self.last_observation = None

    def start(self) -> None:
        if self.state in ("running", "paused"):
            raise ValueError("進行中のセッションを終了してください。")
        self.invalidate()
        self.session_id = str(uuid.uuid4())
        self.events.clear()
        self.notification_count = 0
        self.cooldown_until = 0
        self.deadline = self.clock() + self.settings.duration_minutes * 60
        self.state = "running"
        self.log("session_started")

    def pause(self) -> None:
        self.tick()
        if self.state != "running":
            raise ValueError("集中中のみ一時停止できます。")
        self.invalidate()
        self.state = "paused"
        self.log("session_paused")

    def resume(self) -> None:
        self.tick()
        if self.state != "paused":
            raise ValueError("一時停止中のみ再開できます。")
        self.invalidate()
        self.state = "running"
        self.log("session_resumed")

    def end(self, completed=False) -> None:
        active = self.state in ("running", "paused")
        self.invalidate()
        self.state = "completed" if completed else "ended"
        if active:
            self.log("session_completed" if completed else "session_ended")

    def tick(self) -> bool:
        if self.state in ("running", "paused") and self.clock() >= self.deadline:
            self.end(completed=True)
            return True
        return False

    def fail(self, reason: str) -> None:
        self.reset_detection()
        self.last_observation = {
            "observable": False,
            "phone_probability": None,
            "reason": reason,
        }

    def accept(self, generation: int, observation: Observation) -> str | None:
        self.tick()
        if generation != self.generation or self.state != "running":
            return None
        now = self.clock()
        self.last_observation = {
            "observable": observation.observable,
            "phone_probability": observation.phone_probability,
            "reason": observation.reason,
        }
        if now < self.cooldown_until:
            self.reset_detection()
            return None
        if self.cooldown_until:
            self.cooldown_until = 0
            self.reset_detection()
        if (
            not observation.observable
            or observation.phone_probability is None
            or observation.phone_probability < self.settings.threshold
        ):
            self.reset_detection()
            return None
        if (
            self.last_valid is not None
            and now - self.last_valid >= self.settings.max_gap_seconds
        ):
            self.reset_detection()
        self.last_valid = now
        self.streak += 1
        if self.streak < self.settings.consecutive_required:
            return None
        self.reset_detection()
        self.cooldown_until = now + self.settings.cooldown_seconds
        event_id = str(uuid.uuid4())
        self.notification_count += 1
        self.log("phone_detected", notification_id=event_id)
        return event_id

    def snapshot(self) -> dict:
        self.tick()
        now = self.clock()
        return {
            "state": self.state,
            "session_id": self.session_id,
            "remaining_seconds": max(0, self.deadline - now)
            if self.state in ("running", "paused")
            else 0,
            "consecutive": self.streak,
            "cooldown_seconds": max(0, self.cooldown_until - now),
            "notification_count": self.notification_count,
            "observation": self.last_observation,
            "events": list(self.events),
        }
