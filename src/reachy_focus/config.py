"""Owner settings, kept outside the checkout and never returned with a key."""

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    api_key: str = field(default="", repr=False)
    model: str = "gpt-6-luna"
    duration_minutes: int = 25
    interval_seconds: float = 3.0
    threshold: float = 0.8
    consecutive_required: int = 3
    cooldown_seconds: float = 60.0
    max_gap_seconds: float = 10.0
    audio_enabled: bool = True
    motion_enabled: bool = False

    def public(self) -> dict:
        return {k: v for k, v in asdict(self).items() if k != "api_key"} | {
            "api_key_configured": bool(self.api_key)
        }


class SettingsStore:
    def __init__(self, path: Path | None = None):
        self.path = (
            path
            or Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
            / "reachy-focus"
            / "settings.json"
        )

    def load(self) -> Settings:
        if not self.path.exists():
            return Settings()
        # Fail closed on a damaged file; never print its contents.
        try:
            return self.updated(Settings(), json.loads(self.path.read_text()))
        except (OSError, ValueError, TypeError) as exc:
            raise ValueError(
                "設定ファイルを読み込めません。権限とJSON形式を確認してください。"
            ) from exc

    @staticmethod
    def updated(current: Settings, changes: dict) -> Settings:
        allowed = set(asdict(current))
        if not isinstance(changes, dict) or changes.keys() - allowed:
            raise ValueError("未対応の設定です。")
        s = replace(current, **changes)
        if not isinstance(s.api_key, str) or len(s.api_key) > 512:
            raise ValueError("APIキーの形式を確認してください。")
        if not isinstance(s.model, str) or not s.model.strip() or len(s.model) > 100:
            raise ValueError("モデル名を確認してください。")
        for name, low, high in (
            ("duration_minutes", 1, 180),
            ("interval_seconds", 1, 60),
            ("threshold", 0.5, 1),
            ("consecutive_required", 1, 10),
            ("cooldown_seconds", 1, 600),
            ("max_gap_seconds", 1, 120),
        ):
            value = getattr(s, name)
            if type(value) not in (int, float) or not low <= value <= high:
                raise ValueError(f"{name}は{low}〜{high}で指定してください。")
        if (
            type(s.duration_minutes) is not int
            or type(s.consecutive_required) is not int
        ):
            raise ValueError("時間と連続回数は整数で指定してください。")
        if type(s.audio_enabled) is not bool or type(s.motion_enabled) is not bool:
            raise ValueError("通知設定はtrue/falseで指定してください。")
        return s

    def save(self, settings: Settings) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".settings-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as file:
                json.dump(asdict(settings), file)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)  # mkstemp gives owner-only 0600 permissions.
        finally:
            if os.path.exists(name):
                os.unlink(name)
