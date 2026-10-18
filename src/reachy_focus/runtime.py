"""One capture/inference worker; controls and the timer stay responsive."""

import threading
from concurrent.futures import ThreadPoolExecutor

from .config import SettingsStore
from .decisions import DecisionError
from .session import Session


class Runtime:
    def __init__(self, hardware, evaluator, store=None, clock=None):
        self.hardware = hardware
        self.evaluator = evaluator
        self.store = store or SettingsStore()
        self.session = Session(self.store.load(), **({"clock": clock} if clock else {}))
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="focus-decision"
        )
        self.pending = None
        self.pending_generation = None
        self.next_capture = 0.0
        self.closed = False
        self.actions_seen = set()

    def snapshot(self):
        with self.lock:
            self._tick()
            return self.session.snapshot() | {
                "settings": self.session.settings.public(),
                "capabilities": self.hardware.capabilities(),
                "busy": self.pending is not None,
            }

    def _cancel_actions(self):
        try:
            self.hardware.cancel()
        except Exception:
            self.session.log("action_cancel_failed")

    def _tick(self):
        if self.session.tick():
            self._cancel_actions()

    def control(self, action, consent=False):
        with self.lock:
            if self.closed:
                raise ValueError("アプリは停止しています。")
            self._tick()
            if action == "start":
                if not consent:
                    raise ValueError("OpenAIへの画像送信に同意してください。")
                if not self.session.settings.api_key:
                    raise ValueError("OpenAI APIキーを設定してください。")
                if not self.hardware.capabilities()["camera"]:
                    raise ValueError("カメラが利用できません。")
                self._cancel_actions()
                self.session.start()
                self.actions_seen.clear()
                self.next_capture = 0
            elif action == "pause":
                self.session.pause()
                self._cancel_actions()
            elif action == "resume":
                if not self.session.settings.api_key:
                    raise ValueError("OpenAI APIキーを設定してください。")
                self.session.resume()
                self.next_capture = 0
            elif action == "end":
                self.session.end()
                self._cancel_actions()
            else:
                raise ValueError("未対応の操作です。")
            return self.snapshot()

    def configure(self, changes):
        with self.lock:
            settings = self.store.updated(self.session.settings, changes)
            self.store.save(settings)
            self.session.settings = settings
            self.session.invalidate()
            if not settings.api_key and self.session.state == "running":
                self.session.pause()
            self._cancel_actions()
            self.session.log("settings_changed")
            return self.snapshot()

    def preview(self):
        # An explicit local one-frame preview; never sent to the evaluator.
        with self.lock:
            if self.closed:
                raise ValueError("アプリは停止しています。")
            self._tick()
            if self.session.state == "running":
                raise ValueError("カメラ確認は一時停止してから行ってください。")
            if self.pending is not None:
                raise ValueError("処理中です。少し待って再試行してください。")
            return self.hardware.capture()

    def test_notification(self):
        with self.lock:
            if self.closed:
                raise ValueError("アプリは停止しています。")
            self._tick()
            if self.session.state == "running":
                raise ValueError("通知テストは一時停止してから行ってください。")
            self._cancel_actions()
            result = self.hardware.notify(self.session.settings)
            self.session.log("notification_test", actions=result)
            return self.snapshot()

    def _observe(self, generation, settings):
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
            # This request is admitted; controls invalidate its eventual result.
        return self.evaluator.evaluate(jpeg, settings)

    def step(self):
        with self.lock:
            if self.closed:
                return
            self._tick()
            try:
                self.hardware.step()
            except Exception:
                self._cancel_actions()
                self.session.log("action_failed")
            now = self.session.clock()
            if self.pending is not None and self.pending.done():
                future, generation = self.pending, self.pending_generation
                self.pending = None
                self.next_capture = now + self.session.settings.interval_seconds
                try:
                    observation = future.result()
                    if observation is not None:
                        event_id = self.session.accept(generation, observation)
                        if event_id and event_id not in self.actions_seen:
                            self.actions_seen.add(event_id)
                            result = self.hardware.notify(self.session.settings)
                            self.session.log(
                                "action_executed",
                                notification_id=event_id,
                                actions=result,
                            )
                except Exception as exc:
                    if (
                        generation == self.session.generation
                        and self.session.state == "running"
                    ):
                        reason = (
                            str(exc)
                            if isinstance(exc, DecisionError)
                            else "capture_or_action_failed"
                        )
                        self.session.fail(reason)
                        self.session.log("observation_failed", reason=reason)
            if (
                self.session.state == "running"
                and self.pending is None
                and now >= self.next_capture
            ):
                self.pending_generation = self.session.generation
                self.pending = self.pool.submit(
                    self._observe, self.pending_generation, self.session.settings
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
            self.session.end()
            self._cancel_actions()
        self.pool.shutdown(wait=True, cancel_futures=True)
