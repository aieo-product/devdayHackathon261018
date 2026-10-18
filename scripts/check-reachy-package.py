"""Check the actual wheel and sdist for isolation and required runtime assets."""
import tarfile
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
required = {'reachy_focus/main.py', 'reachy_focus/static/index.html', 'reachy_focus/static/main.js', 'reachy_focus/assets/reminder-1.wav', 'reachy_focus/assets/reminder-2.wav'}
for path in [*sorted((root / 'dist').glob('*.whl')), *sorted((root / 'dist').glob('*.tar.gz'))]:
    if path.suffix == '.whl':
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
        assert all(n.startswith('reachy_focus/') or '.dist-info/' in n for n in names), names
    else:
        with tarfile.open(path) as archive:
            names = [n.split('/', 1)[1].removeprefix('src/') for n in archive.getnames() if '/' in n]
        assert not any(n.split('/')[0] in {'api','apps','clients','devices','docs','tests','scripts','.venv'} for n in names)
    assert required <= set(names), required - set(names)
    assert not any('__pycache__' in n or n.endswith(('.pyc','.env','settings.json')) for n in names)
    print(f'OK: {path.name} — Reachy-only package with UI and audio')
assert list((root / 'dist').glob('*.whl')) and list((root / 'dist').glob('*.tar.gz')), 'Build first: python -m build'
