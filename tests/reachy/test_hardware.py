import io
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from reachy_focus.config import Settings
from reachy_focus.hardware import ReachyHardware


def test_camera_preserves_aspect_ratio_and_bgr_channels():
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    frame[:, :, 2] = 255
    mini = SimpleNamespace(media=SimpleNamespace(get_frame=lambda: frame))
    image = Image.open(io.BytesIO(ReachyHardware(mini).capture()))
    assert image.size == (640, 360)
    r, g, b = image.getpixel((10, 10))
    assert r > 240 and g < 10 and b < 10


def test_bundled_reminder_has_real_audio():
    path = Path(__file__).parents[2] / "src/reachy_focus/assets/reminder.wav"
    with wave.open(str(path)) as wav:
        assert 0.5 < wav.getnframes() / wav.getframerate() < 10
        samples = wav.readframes(wav.getnframes())
        assert len(set(samples)) > 10
        levels = np.frombuffer(samples, dtype="<i2").astype(float) / 32768
        assert 0.15 < np.sqrt(np.mean(levels**2)) < 0.3
        assert 0.85 < np.max(np.abs(levels)) < 0.99


def test_failed_motor_cancel_still_stops_audio():
    stopped = []

    def broken_target(**kwargs):
        raise RuntimeError("motor disconnected")

    mini = SimpleNamespace(
        media=SimpleNamespace(stop_playing=lambda: stopped.append(True)),
        set_target=broken_target,
    )
    hardware = ReachyHardware(mini)
    hardware.motion = (0, [0, 0])
    hardware.audio_until = 10
    with pytest.raises(RuntimeError):
        hardware.cancel()
    assert stopped == [True]


def test_recorded_ogg_uses_preset_duration_without_wav_decoding():
    played = []
    stopped = []
    now = [0.0]
    mini = SimpleNamespace(
        media=SimpleNamespace(
            audio=object(),
            play_sound=played.append,
            stop_playing=lambda: stopped.append(True),
        )
    )
    hardware = ReachyHardware(mini, clock=lambda: now[0])
    hardware._play_sound("fear1.ogg", duration=3.48)
    assert played == ["fear1.ogg"]
    now[0] = 3.7
    hardware.step()
    assert stopped == [True]


def test_fear_keeps_preset_audio_then_speaks_and_cancel_discards_queued_speech():
    played = []
    now = [0.0]
    mini = SimpleNamespace(
        media=SimpleNamespace(
            audio=object(), play_sound=played.append, stop_playing=lambda: None
        ),
        get_current_head_pose=lambda: np.eye(4),
        get_present_antenna_joint_positions=lambda: [0, 0],
        set_target=lambda **kw: None,
    )

    class Fear:
        duration = 3.48
        timestamps = [0, 3.48]
        sound_path = "fear1.ogg"

        def evaluate(self, t):
            return np.eye(4), np.zeros(2), 0

    hardware = ReachyHardware(mini, clock=lambda: now[0])
    hardware._idle_baseline()
    hardware.fear = Fear()
    hardware.notify(Settings())
    now[0] = 0.81
    hardware.step()
    assert played == ["fear1.ogg"]
    now[0] = 4.5
    hardware.step()
    assert Path(played[-1]).name == "reminder.wav"
    assert len(played) == 2
    hardware.notify(Settings())
    now[0] = 5.4
    hardware.step()
    assert hardware.queued_speech is not None
    hardware.cancel()
    now[0] = 10
    hardware.step()
    assert len(played) == 3


def test_idle_default_and_fear_preset_are_exclusive_and_shutdown_stops():
    now = [0.0]
    targets = []
    mini = SimpleNamespace(
        media=SimpleNamespace(audio=None, camera=object()),
        get_current_head_pose=lambda: np.eye(4),
        get_present_antenna_joint_positions=lambda: [0, 0],
        set_target=lambda **kw: targets.append(kw),
    )
    hardware = ReachyHardware(mini, clock=lambda: now[0])
    hardware._idle_baseline()
    hardware.configure(Settings())
    assert hardware.idle_enabled
    now[0] = 1
    hardware.step()
    assert abs(targets[-1]["antennas"][0]) <= 0.065

    class Fear:
        duration = 2.0
        timestamps = [0, 2]
        sound_path = None

        def evaluate(self, t):
            return np.eye(4), np.array([0.2, -0.2]), 0.1

    hardware.fear = Fear()
    assert hardware.notify(Settings(audio_enabled=False))[0]["action"] == "fear1"
    now[0] += 1
    hardware.step()
    assert list(targets[-1]["antennas"]) == [0.2, -0.2]
    assert targets[-1]["body_yaw"] == 0.1
    hardware.happy = Fear()
    assert hardware.celebrate(Settings(audio_enabled=False)) == [
        {"action": "cheerful1", "status": "started"}
    ]
    assert hardware.emotion["move"] is hardware.happy
    hardware.cancel()
    assert hardware.emotion is None
    hardware.shutdown()
    count = len(targets)
    now[0] += 2
    hardware.step()
    assert len(targets) == count


def test_focus_motion_grows_smoothly_with_bounded_head_and_antenna_travel():
    now = [0.0]
    targets = []
    mini = SimpleNamespace(
        media=SimpleNamespace(),
        get_current_head_pose=lambda: np.eye(4),
        get_present_antenna_joint_positions=lambda: [0, 0],
        set_target=lambda **kw: targets.append(kw),
    )
    h = ReachyHardware(mini, clock=lambda: now[0])
    h._idle_baseline()
    h.configure(Settings())
    for seconds, energy in [
        (0, 0),
        (9.9, 0),
        (10, 1 / 3),
        (20, 2 / 3),
        (30, 1),
        (120, 1),
    ]:
        h.set_focus_progress(seconds)
        assert h.target_energy == pytest.approx(energy)
    for _ in range(400):
        now[0] += 0.05
        h.step()
    assert h.focus_energy == 1
    assert max(abs(t["antennas"][0]) for t in targets) > 0.15
    assert all(abs(t["antennas"][0]) <= 0.195 + 1e-9 for t in targets)
    assert all(abs(t["head"][2, 3]) <= 0.003 for t in targets)
    h.set_focus_progress(0)
    now[0] += 0.05
    h.step()
    assert 0.9 < h.focus_energy < 1  # Return gradually, rather than jumping.
    for _ in range(50):
        now[0] += 0.05
        h.step()
    assert h.focus_energy == 0


def test_interrupted_emotion_never_replaces_camera_reference_and_returns_to_it():
    from reachy_mini.utils import create_head_pose

    now = [0.0]
    current = [np.eye(4)]
    targets = []
    mini = SimpleNamespace(
        media=SimpleNamespace(),
        get_current_head_pose=lambda: current[0],
        get_present_antenna_joint_positions=lambda: [0.1, -0.1],
        set_target=lambda **kw: targets.append(kw),
    )
    h = ReachyHardware(mini, clock=lambda: now[0])
    h._idle_baseline()
    baseline = h.idle_head.copy()
    current[0] = create_head_pose(pitch=-25, degrees=True)
    h.emotion = {"started": 0}  # A cancellation while fear is looking upwards.
    h.cancel()
    np.testing.assert_allclose(h.idle_head, baseline)
    now[0] = 0.5
    h.step()
    assert not np.allclose(targets[-1]["head"], baseline)
    now[0] = 1.0
    h.step()
    np.testing.assert_allclose(targets[-1]["head"], baseline, atol=1e-9)
    assert h.returning is None

    class Happy:
        duration = 1
        timestamps = [0, 1]
        sound_path = None

        def evaluate(self, t):
            return current[0], np.zeros(2), 0

    h.happy = Happy()
    h.emotion = {"started": 0}
    h.celebrate(Settings(audio_enabled=False))
    np.testing.assert_allclose(h.idle_head, baseline)
    now[0] = 4
    h.step()
    np.testing.assert_allclose(targets[-1]["head"], baseline, atol=1e-9)
