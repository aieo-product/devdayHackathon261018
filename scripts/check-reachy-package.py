"""Check the actual wheel and sdist for isolation and required runtime assets."""
import tarfile
import struct
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
required = {'reachy_focus/main.py', 'reachy_focus/static/index.html', 'reachy_focus/static/main.js', 'reachy_focus/assets/reminder-1.wav', 'reachy_focus/assets/reminder-2.wav'}

def check_wav(data, name):
    fmt = data.index(b'fmt ') + 8
    encoding, channels, rate, byte_rate, alignment, bits = struct.unpack_from('<HHIIHH', data, fmt)
    assert encoding == 1 and alignment == channels * bits // 8, name
    assert byte_rate == rate * alignment, f'{name}: invalid WAV byte rate'

for path in [*sorted((root / 'dist').glob('*.whl')), *sorted((root / 'dist').glob('*.tar.gz'))]:
    if path.suffix == '.whl':
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            for name in names:
                if name.endswith('.wav'):
                    check_wav(archive.read(name), name)
        assert all(n.startswith('reachy_focus/') or '.dist-info/' in n for n in names), names
    else:
        with tarfile.open(path) as archive:
            names = [n.split('/', 1)[1].removeprefix('src/') for n in archive.getnames() if '/' in n]
            for member in archive.getmembers():
                if member.isfile() and member.name.endswith('.wav'):
                    check_wav(archive.extractfile(member).read(), member.name)
        assert not any(n.split('/')[0] in {'api','apps','clients','devices','docs','tests','scripts','.venv'} for n in names)
    assert required <= set(names), required - set(names)
    assert not any('__pycache__' in n or n.endswith(('.pyc','.env','settings.json')) for n in names)
    print(f'OK: {path.name} — Reachy-only package with UI and audio')
assert list((root / 'dist').glob('*.whl')) and list((root / 'dist').glob('*.tar.gz')), 'Build first: python -m build'
