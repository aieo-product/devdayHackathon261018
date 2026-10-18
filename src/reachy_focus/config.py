"""Shared API settings; credentials never enter the checkout or public state."""

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_API_URL = "https://focus-shared-api-20261018.take-otani.workers.dev"


@dataclass(frozen=True)
class Settings:
    api_url: str = DEFAULT_API_URL
    api_token: str = field(default="", repr=False)
    duration_minutes: int = 25
    audio_enabled: bool = True
    motion_enabled: bool = True

    def public(self):
        return {k: v for k, v in asdict(self).items() if k != "api_token"} | {
            "api_token_configured": bool(self.api_token)
        }


class SettingsStore:
    def __init__(self, path=None):
        self.path = (
            path
            or Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
            / "reachy-focus"
            / "settings.json"
        )

    def load(self):
        if not self.path.exists():
            return Settings()
        try:
            values = json.loads(self.path.read_text())
            # The former direct-OpenAI key must never become a shared-service token.
            obsolete = {
                "api_key",
                "model",
                "interval_seconds",
                "threshold",
                "consecutive_required",
                "cooldown_seconds",
                "max_gap_seconds",
            }
            values = {k: v for k, v in values.items() if k not in obsolete}
            values["motion_enabled"] = True
            return self.updated(Settings(), values)
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            raise ValueError(
                "設定ファイルを読み込めません。権限とJSON形式を確認してください。"
            ) from exc

    @staticmethod
    def updated(current, changes):
        if not isinstance(changes, dict) or changes.keys() - set(asdict(current)):
            raise ValueError("未対応の設定です。")
        s = replace(current, **changes)
        if (
            not isinstance(s.api_token, str)
            or len(s.api_token) > 512
            or any(c in s.api_token for c in "\r\n")
        ):
            raise ValueError("アプリトークンの形式を確認してください。")
        if not isinstance(s.api_url, str):
            raise ValueError("API URLを確認してください。")
        url = urlsplit(s.api_url)
        local = url.hostname in ("localhost", "127.0.0.1", "::1")
        if (
            not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or (url.scheme != "https" and not (url.scheme == "http" and local))
        ):
            raise ValueError(
                "APIはHTTPS URLで指定してください（HTTPはlocalhostのみ）。"
            )
        if type(s.duration_minutes) is not int or not 1 <= s.duration_minutes <= 240:
            raise ValueError("集中時間は1〜240分で指定してください。")
        if type(s.audio_enabled) is not bool or type(s.motion_enabled) is not bool:
            raise ValueError("通知設定はtrue/falseで指定してください。")
        return replace(s, api_url=s.api_url.rstrip("/"), motion_enabled=True)

    def save(self, settings):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".settings-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as file:
                json.dump(asdict(settings), file)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
