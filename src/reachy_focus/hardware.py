"""Camera, quiet idle motion and the official 😨 fear1 recorded emotion."""

import io
import math
import threading
import time
import wave
from pathlib import Path

from PIL import Image

EMOTIONS_DATASET = "pollen-robotics/reachy-mini-emotions-library"
FEAR_MOVE = "fear1"
HAPPY_MOVE = "cheerful1"


class ReachyHardware:
    def __init__(self, mini, clock=time.monotonic):
        self.mini = mini
        self.clock = clock
        self.camera_lock = threading.Lock()
        self.fear = None
        self.happy = None
        self.emotion = None
        self.returning = None
        self.motion = None
        self.audio_until = 0.0
        self.queued_speech = None
        self.idle_enabled = False
        self.idle_head = None
        self.idle_antennas = None
        self.idle_since = self.clock()
        self.focus_energy = 0.0
        self.target_energy = 0.0
        self.idle_phase = 0.0
        self.last_step = self.clock()

    def capabilities(self):
        actions = (["reminder"] if self.mini.media.audio is not None else []) + [
            "antenna_wiggle",
            "idle_motion",
        ]
        if self.fear is not None:
            actions.append("fear1")
        if self.happy is not None:
            actions.append(HAPPY_MOVE)
        return {"camera": self.mini.media.camera is not None, "actions": actions}

    def _idle_baseline(self):
        self.idle_head = self.mini.get_current_head_pose().copy()
        self.idle_antennas = list(self.mini.get_present_antenna_joint_positions())
        self.idle_since = self.clock()

    def prepare_camera(self):
        from reachy_mini.motion.recorded_move import RecordedMoves
        from reachy_mini.reachy_mini import (
            INIT_ANTENNAS_JOINT_POSITIONS,
            INIT_HEAD_POSE,
        )

        self.mini.enable_motors()
        self.mini.goto_target(
            head=INIT_HEAD_POSE, antennas=INIT_ANTENNAS_JOINT_POSITIONS, duration=2.0
        )
        self._idle_baseline()
        # Keep the camera's reference independent of servo settling or an interrupted emotion.
        self.idle_head = INIT_HEAD_POSE.copy()
        self.idle_antennas = list(INIT_ANTENNAS_JOINT_POSITIONS)
        try:
            # The daemon preloads this official library. Playback uses its actual trajectory.
            moves = RecordedMoves(EMOTIONS_DATASET, token=False)
            self.fear = moves.get(FEAR_MOVE)
            self.happy = moves.get(HAPPY_MOVE)
        except Exception:
            self.fear = (
                None  # Capability explicitly reports that the preset is unavailable.
            )

    def configure(self, settings):
        self.idle_enabled = settings.motion_enabled

    def set_focus_progress(self, seconds):
        # Grow continuously over two minutes; no additional sounds or camera-obscuring poses.
        self.target_energy = min(1.0, max(0.0, seconds / 120))

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

    def _play_sound(self, sound, duration=None):
        if self.mini.media.audio is None:
            raise RuntimeError("audio_unavailable")
        if duration is None:
            with wave.open(str(sound)) as wav:
                duration = wav.getnframes() / wav.getframerate()
        self.mini.media.play_sound(str(sound))
        self.audio_until = self.clock() + duration + 0.2

    def notify(self, settings):
        self.cancel()
        results = []
        if settings.motion_enabled and self.fear is not None:
            self.returning = None
            self.emotion = {
                "move": self.fear,
                "started": self.clock(),
                "head": self.mini.get_current_head_pose().copy(),
                "antennas": list(self.mini.get_present_antenna_joint_positions()),
                "sound_started": False,
                "audio": settings.audio_enabled,
                "speech": True,
            }
            results.append({"action": FEAR_MOVE, "status": "started"})
        elif settings.motion_enabled:
            results.append({"action": FEAR_MOVE, "status": "unavailable"})
        # Fear keeps its original sound and queues the Japanese reminder after it.
        if settings.audio_enabled and self.emotion is None:
            try:
                self._play_sound(Path(__file__).parent / "assets" / "reminder.wav")
                results.append({"action": "reminder", "status": "started"})
            except Exception:
                results.append({"action": "reminder", "status": "failed"})
        return results

    def celebrate(self, settings):
        if self.happy is None:
            return [{"action": HAPPY_MOVE, "status": "unavailable"}]
        self.cancel()
        self.returning = None
        self.emotion = {
            "move": self.happy,
            "started": self.clock(),
            "head": self.mini.get_current_head_pose().copy(),
            "antennas": list(self.mini.get_present_antenna_joint_positions()),
            "sound_started": False,
            "audio": settings.audio_enabled,
        }
        return [{"action": HAPPY_MOVE, "status": "started"}]

    def _emotion_step(self):
        import numpy as np
        from reachy_mini.utils.interpolation import linear_pose_interpolation

        e = self.emotion
        move = e["move"]
        t = self.clock() - e["started"]
        transition = 0.8
        first_head, first_antennas, first_body = move.evaluate(0)
        if t < transition:
            alpha = (1 - math.cos(math.pi * t / transition)) / 2
            head = linear_pose_interpolation(e["head"], first_head, alpha)
            antennas = np.array(e["antennas"]) * (1 - alpha) + first_antennas * alpha
            body = first_body * alpha
        elif t < transition + move.duration:
            if not e["sound_started"]:
                e["sound_started"] = True
                if e["audio"]:
                    if move.sound_path:
                        # Official presets may use OGG, not the bundled PCM WAV format.
                        self._play_sound(move.sound_path, duration=move.duration)
                        if e.get("speech"):
                            self.queued_speech = self.audio_until
                    elif e.get("speech"):
                        self._play_sound(
                            Path(__file__).parent / "assets" / "reminder.wav"
                        )
            head, antennas, body = move.evaluate(
                min(t - transition, move.timestamps[-1] - 1e-6)
            )
        else:
            last_head, last_antennas, last_body = move.evaluate(
                move.timestamps[-1] - 1e-6
            )
            alpha = min(1, (t - transition - move.duration) / 1.0)
            alpha = (1 - math.cos(math.pi * alpha)) / 2
            head = linear_pose_interpolation(last_head, self.idle_head, alpha)
            antennas = (
                last_antennas * (1 - alpha) + np.array(self.idle_antennas) * alpha
            )
            body = last_body * (1 - alpha)
            if alpha >= 1:
                self.emotion = None
                self.idle_since = self.clock()
        self.mini.set_target(head=head, antennas=antennas, body_yaw=body)

    def step(self):
        now = self.clock()
        dt = min(0.1, max(0.0, now - self.last_step))
        self.last_step = now
        difference = self.target_energy - self.focus_energy
        self.focus_energy += max(-dt / 2, min(dt / 2, difference))
        if self.emotion is not None:
            self._emotion_step()
        elif self.returning is not None:
            import numpy as np
            from reachy_mini.utils.interpolation import linear_pose_interpolation

            start, head, antennas = self.returning
            alpha = min(1.0, max(0.0, now - start))
            alpha = (1 - math.cos(math.pi * alpha)) / 2
            self.mini.set_target(
                head=linear_pose_interpolation(head, self.idle_head, alpha),
                antennas=np.array(antennas) * (1 - alpha)
                + np.array(self.idle_antennas) * alpha,
                body_yaw=0,
            )
            if alpha >= 1:
                self.returning = None
                self.idle_phase = 0.0
        elif self.idle_enabled and self.idle_head is not None:
            self.idle_phase += dt * (1 + self.focus_energy)
            t = self.idle_phase
            # Build a livelier rhythm gradually, while preserving the camera's forward pose.
            head = self.idle_head.copy()
            head[2, 3] += (0.0015 + 0.0015 * self.focus_energy) * math.sin(
                2 * math.pi * t / 6
            )
            gain = 1 + 2 * self.focus_energy
            antennas = [
                self.idle_antennas[0] + 0.065 * gain * math.sin(2 * math.pi * t / 5),
                self.idle_antennas[1] + 0.055 * gain * math.sin(2 * math.pi * t / 7),
            ]
            self.mini.set_target(head=head, antennas=antennas)
        if self.audio_until and self.clock() >= self.audio_until:
            self.mini.media.stop_playing()
            self.audio_until = 0
        if self.queued_speech is not None and self.clock() >= self.queued_speech:
            self.queued_speech = None
            self._play_sound(Path(__file__).parent / "assets" / "reminder.wav")

    def cancel(self):
        self.queued_speech = None
        had_emotion = self.emotion is not None
        self.emotion = None
        try:
            # Keep cancellation compatible with any pending legacy antenna gesture.
            if self.motion:
                _, baseline = self.motion
                self.motion = None
                self.mini.set_target(antennas=baseline)
            if had_emotion and self.idle_head is not None:
                self.returning = (
                    self.clock(),
                    self.mini.get_current_head_pose().copy(),
                    list(self.mini.get_present_antenna_joint_positions()),
                )
        finally:
            if self.audio_until:
                self.audio_until = 0
                self.mini.media.stop_playing()

    def shutdown(self):
        self.idle_enabled = False
        self.cancel()
        self.returning = None
