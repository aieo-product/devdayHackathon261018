"""On-robot capture/actions and fail-closed shared API session controls."""

import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

from .api import ApiError
from .config import SettingsStore
from .session import Session


class Runtime:
    def __init__(self, hardware, api, store=None, clock=None):
        self.hardware = hardware
        self.api = api
        self.store = store or SettingsStore()
        self.session = Session(self.store.load(), **({"clock": clock} if clock else {}))
        self.lock = threading.RLock()
        self.command_lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="focus-frame")
        self.cleanup_pool = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="focus-control"
        )
        self.pending = None
        self.pending_generation = None
        self.next_capture = 0.0
        self.closed = False
        if hasattr(self.hardware, "configure"):
            self.hardware.configure(self.session.settings)

    def _cancel_actions(self):
        try:
            self.hardware.cancel()
        except Exception:
            self.session.log("action_cancel_failed")

    def _end_remote(self, settings, sid):
        try:
            with self.command_lock:
                self.api.control(settings, sid, "end")
        except Exception:
            with self.lock:
                self.session.log("remote_end_failed")

    def _queue_end(self, settings, sid):
        if sid:
            self.cleanup_pool.submit(self._end_remote, settings, sid)

    def _tick(self):
        if self.session.tick():
            self._cancel_actions()
            self._queue_end(self.session.settings, self.session.session_id)

    def snapshot(self):
        with self.lock:
            self._tick()
            return self.session.snapshot() | {
                "settings": self.session.settings.public(),
                "capabilities": self.hardware.capabilities(),
                "busy": self.pending is not None,
            }

    def control(self, action, consent=False):
        with self.lock:
            self._tick()
            s = self.session
            if self.closed:
                raise ValueError("アプリは停止しています。")
            settings = s.settings
            sid = s.session_id
            if action == "start":
                if not consent:
                    raise ValueError("共通APIとOpenAIへの画像送信に同意してください。")
                if not settings.api_token:
                    raise ValueError("共通APIのアプリトークンを設定してください。")
                if not self.hardware.capabilities()["camera"]:
                    raise ValueError("カメラが利用できません。")
                generation = s.begin()
            elif action == "resume":
                if s.state != "paused" or not sid or not settings.api_token:
                    raise ValueError("有効なセッションの一時停止中のみ再開できます。")
                s.invalidate()
                s.state = "resuming"
                generation = s.generation
            elif action in ("pause", "end"):
                if action == "pause" and s.state not in (
                    "running",
                    "starting",
                    "resuming",
                ):
                    raise ValueError("集中中のみ一時停止できます。")
                # Stop now, BEFORE waiting for any network operation or command lock.
                s.stop_local(
                    "paused" if action == "pause" else "ended",
                    "session_paused" if action == "pause" else "session_ended",
                )
                generation = s.generation
                self._cancel_actions()
            else:
                raise ValueError("未対応の操作です。")
        result = None
        try:
            with self.command_lock:
                if action == "start":
                    result = self.api.start(settings)
                elif sid:
                    result = self.api.control(settings, sid, action)
        except Exception as exc:
            reason = str(exc) if isinstance(exc, ApiError) else "connection"
            with self.lock:
                if generation == s.generation:
                    if action in ("start", "resume"):
                        s.state = "ended" if action == "start" else "paused"
                        s.invalidate()
                    s.fail(reason)
            raise ValueError("共通API: " + reason) from None
        with self.lock:
            self._tick()
            if result is not None:
                if generation != s.generation or self.closed:
                    # Stop during a slow start must also close the newly created remote session.
                    if action == "start":
                        self._queue_end(settings, result["session_id"])
                else:
                    if action == "start":
                        s.session_id = result["session_id"]
                        s.state = "running"
                        s.log("session_started")
                    elif action == "resume":
                        s.state = "running"
                        s.log("session_resumed")
                    s.apply(result, generation)
                    self.next_capture = (
                        s.clock() + result["next_capture_after_ms"] / 1000
                    )
                    if s.state in ("paused", "ended", "completed"):
                        self._cancel_actions()
            return self.snapshot()

    def configure(self, changes):
        with self.lock:
            self._tick()
            s = self.session
            settings = self.store.updated(s.settings, changes)
            self.store.save(settings)
            old_settings, sid = s.settings, s.session_id
            if s.state in ("running", "starting", "resuming", "paused"):
                s.stop_local("ended", "session_ended")
                self._queue_end(old_settings, sid)
            else:
                s.invalidate()
            s.settings = settings
            if hasattr(self.hardware, "configure"):
                self.hardware.configure(settings)
            self._cancel_actions()
            s.log("settings_changed")
            return self.snapshot()

    def preview(self):
        with self.lock:
            self._tick()
            if self.closed or self.session.state in ("starting", "running", "resuming"):
                raise ValueError("カメラ確認は一時停止してから行ってください。")
            if self.pending is not None:
                raise ValueError("処理中です。少し待って再試行してください。")
            return self.hardware.capture()

    def test_notification(self):
        with self.lock:
            self._tick()
            if self.closed or self.session.state in ("starting", "running", "resuming"):
                raise ValueError("通知テストは一時停止してから行ってください。")
            self._cancel_actions()
            result = self.hardware.notify(self.session.settings)
            self.session.log("notification_test", actions=result)
            return self.snapshot()

    def _observe(self, generation, settings, sid):
        with self.lock:
            self._tick()
            if (
                self.closed
                or generation != self.session.generation
                or self.session.state != "running"
            ):
                return None
            jpeg = self.hardware.capture()
        with self.lock:
            self._tick()
            if (
                self.closed
                or generation != self.session.generation
                or self.session.state != "running"
            ):
                return None
        return self.api.frame(settings, sid, "reachy-" + uuid.uuid4().hex, jpeg)

    def step(self):
        with self.lock:
            if self.closed:
                return
            self._tick()
            if hasattr(self.hardware, "set_focus_progress"):
                self.hardware.set_focus_progress(
                    self.session.focus_seconds if self.session.state == "running" else 0
                )
            try:
                self.hardware.step()
            except Exception as exc:
                self._cancel_actions()
                self.session.log("action_failed", reason=type(exc).__name__)
            s = self.session
            if self.pending is not None and self.pending.done():
                future, generation = self.pending, self.pending_generation
                self.pending = None
                try:
                    result = future.result()
                    if (
                        result is not None
                        and generation == s.generation
                        and s.state == "running"
                    ):
                        nid = s.apply(result, generation, from_frame=True)
                        # No extra local fixed interval: consume the server's requested delay.
                        self.next_capture = (
                            s.clock() + result["next_capture_after_ms"] / 1000
                        )
                        if nid:
                            actions = self.hardware.notify(s.settings)
                            s.log(
                                "action_executed", notification_id=nid, actions=actions
                            )
                        if s.phone_put_down:
                            actions = self.hardware.celebrate(s.settings)
                            s.log("phone_put_down", actions=actions)
                        if s.state in ("ended", "completed", "paused"):
                            self._cancel_actions()
                except Exception as exc:
                    if generation == s.generation and s.state == "running":
                        reason = (
                            str(exc)
                            if isinstance(exc, ApiError)
                            else "capture_or_action_failed"
                        )
                        s.fail(reason)
                        self.next_capture = s.clock() + 1
                        if reason in (
                            "unauthorized",
                            "session_not_found",
                            "frame_limit",
                            "service_not_configured",
                        ):
                            s.stop_local("paused", "session_paused")
                            self._cancel_actions()
            if (
                s.state == "running"
                and self.pending is None
                and s.clock() >= self.next_capture
            ):
                self.pending_generation = s.generation
                self.pending = self.pool.submit(
                    self._observe, s.generation, s.settings, s.session_id
                )

    def run(self, stop_event):
        try:
            while not stop_event.is_set():
                self.step()
                stop_event.wait(0.05)
        finally:
            self.close()

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.session.stop_local("ended", "session_ended")
            self._cancel_actions()
            if hasattr(self.hardware, "shutdown"):
                self.hardware.shutdown()
            self._queue_end(self.session.settings, self.session.session_id)
        self.pool.shutdown(wait=True, cancel_futures=True)
        self.cleanup_pool.shutdown(wait=True)
