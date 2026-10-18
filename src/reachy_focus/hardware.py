"""SDK adapter; camera frames are BGR, JPEG encoding stays in memory."""

import io
import math
import threading
import time
import wave
from pathlib import Path

from PIL import Image


class ReachyHardware:
    def __init__(self, mini):
        self.mini = mini
        self.camera_lock = threading.Lock()
        self.motion = None
        self.audio_until = 0.0

    def capabilities(self):
        return {
            "camera": self.mini.media.camera is not None,
            "actions": (["reminder"] if self.mini.media.audio is not None else [])
            + ["antenna_wiggle"],
        }

    def capture(self):
        with self.camera_lock:
            frame = self.mini.media.get_frame()
        if frame is None:
            raise RuntimeError("camera_unavailable")
        image = Image.fromarray(frame[:, :, ::-1])
        image.thumbnail((640, 640))
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=75)
        return output.getvalue()

    def notify(self, settings):
        results = []
        if settings.audio_enabled:
            try:
                if self.mini.media.audio is None:
                    raise RuntimeError("audio_unavailable")
                sound = Path(__file__).parent / "assets" / "reminder.wav"
                with wave.open(str(sound)) as wav:
                    duration = wav.getnframes() / wav.getframerate()
                self.mini.media.play_sound(str(sound))
                self.audio_until = time.monotonic() + duration + 0.2
                results.append({"action": "reminder", "status": "started"})
            except Exception:
                results.append({"action": "reminder", "status": "failed"})
        if settings.motion_enabled:
            try:
                baseline = list(self.mini.get_present_antenna_joint_positions())
                if len(baseline) != 2 or any(
                    not math.isfinite(v) or abs(v) > 1.4 for v in baseline
                ):
                    raise RuntimeError("motion_unavailable")
                self.motion = (time.monotonic(), baseline)
                results.append({"action": "antenna_wiggle", "status": "started"})
            except Exception:
                results.append({"action": "antenna_wiggle", "status": "failed"})
        return results

    def step(self):
        if self.motion:
            started, baseline = self.motion
            elapsed = time.monotonic() - started
            offset = 0.07 * math.sin(min(elapsed, 1.2) / 1.2 * 2 * math.pi)
            self.mini.set_target(antennas=[baseline[0] + offset, baseline[1] - offset])
            if elapsed >= 1.2:
                self.motion = None
        if self.audio_until and time.monotonic() >= self.audio_until:
            self.mini.media.stop_playing()
            self.audio_until = 0

    def cancel(self):
        try:
            if self.motion:
                _, baseline = self.motion
                self.motion = None
                self.mini.set_target(antennas=baseline)
        finally:
            if self.audio_until:
                self.audio_until = 0
                self.mini.media.stop_playing()
