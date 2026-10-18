#!/usr/bin/env python3
"""Generate CoreS3 reminder using installed macOS Kyoko voice; never plays audio.
Requires local say, ffmpeg, and Python 3. No network/API service is used.
Usage: python3 generate_phone_reminder_audio.py [output_header]
"""
import array
import hashlib
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import wave

output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name('phone_reminder_audio.h')
with tempfile.TemporaryDirectory(prefix='cores3-reminder-') as tmp:
    aiff = Path(tmp) / 'speech.aiff'
    wav = Path(tmp) / 'speech.wav'
    subprocess.run(['say', '-v', 'Kyoko', '-r', '150', '-o', str(aiff), 'スマホを置いて、集中に戻りましょう。'], check=True)
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(aiff), '-ac', '1', '-ar', '16000', '-af', 'volume=2.5', '-c:a', 'pcm_s16le', str(wav)], check=True)
    with wave.open(str(wav), 'rb') as audio:
        assert (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 16000)
        pcm = audio.readframes(audio.getnframes())
    samples = array.array('h', pcm)
    if sys.byteorder != 'little':
        samples.byteswap()
    count = len(samples)
    peak = max(abs(v) for v in samples)
    rms = math.sqrt(sum(v*v for v in samples) / count)
    assert 0 < peak < 32767, 'Missing or clipped audio'
    assert count <= 56000, 'Audio should stay below 3.5 seconds'
    lines = ['#pragma once', '#include <stddef.h>', '#include <stdint.h>', '',
             '// "スマホを置いて、集中に戻りましょう。"',
             '// Generated locally with installed macOS say Kyoko (ja_JP), rate 150.',
             '// Mono signed 16-bit PCM; no WAV container. Stored in flash as const data.',
             '// Regenerate with generate_phone_reminder_audio.py; no network or playback.',
             '// M5.Speaker.playRaw(phone_reminder_audio::kSamples,',
             '//   phone_reminder_audio::kSampleCount, phone_reminder_audio::kSampleRate, false, 1, 0, true);',
             'namespace phone_reminder_audio {',
             'static constexpr uint32_t kSampleRate = 16000;',
             'static constexpr uint8_t kBitsPerSample = 16;',
             'static constexpr uint8_t kChannels = 1;',
             'alignas(4) static const int16_t kSamples[] = {']
    lines += ['  ' + ', '.join(str(x) for x in samples[i:i+16]) + ',' for i in range(0, count, 16)]
    lines += ['};', 'static constexpr size_t kSampleCount = sizeof(kSamples) / sizeof(kSamples[0]);',
              'static constexpr size_t kPcmBytes = sizeof(kSamples);',
              'static constexpr uint32_t kDurationMs = kSampleCount * 1000UL / kSampleRate;',
              '}  // namespace phone_reminder_audio', '']
    output.write_text('\n'.join(lines), encoding='utf-8')
    print(f'{count} samples, {len(pcm)} PCM bytes, {count/16000:.4f}s, peak={peak}, RMS={rms:.1f}, SHA256={hashlib.sha256(pcm).hexdigest()}')
