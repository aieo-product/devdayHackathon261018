import io
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

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
