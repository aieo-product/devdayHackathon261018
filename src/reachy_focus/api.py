"""Common Focus API v1. Only a fresh frame response may request an action."""

import math
import re
from urllib.parse import quote

import httpx


class ApiError(Exception):
    pass


STATES = {"observing", "suspected", "cooldown", "unknown", "paused", "ended"}


def parse_snapshot(data, expected_id=None, allow_notify=False):
    try:
        sid = data["session_id"]
        if not isinstance(sid, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", sid):
            raise ValueError
        if expected_id is not None and sid != expected_id:
            raise ValueError
        if data["state"] not in STATES or type(data["notify"]) is not bool:
            raise ValueError
        if data["provider"] not in ("mock", "openai"):
            raise ValueError
        for name in ("phone_probability", "observable_probability"):
            v = data[name]
            if v is not None and (
                type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1
            ):
                raise ValueError
        for name in (
            "continuous_hold_ms",
            "required_hold_ms",
            "cooldown_remaining_ms",
            "next_capture_after_ms",
            "consecutive_count",
        ):
            v = data[name]
            if type(v) not in (int, float) or not math.isfinite(v) or v < 0:
                raise ValueError
        if not isinstance(data["reason"], str) or not re.fullmatch(
            r"[a-z_]{1,80}", data["reason"]
        ):
            raise ValueError
        notification = data.get("notification_id")
        if data["notify"] and (
            not isinstance(notification, str)
            or not re.fullmatch(r"[a-zA-Z0-9-]{1,128}", notification)
        ):
            raise ValueError
        # Do not retain arbitrary upstream fields or action text as executable commands.
        keys = (
            "session_id",
            "state",
            "provider",
            "reason",
            "phone_probability",
            "observable_probability",
            "continuous_hold_ms",
            "required_hold_ms",
            "cooldown_remaining_ms",
            "next_capture_after_ms",
            "consecutive_count",
        )
        return {k: data[k] for k in keys} | {
            "notify": data["notify"] and allow_notify,
            "notification_id": notification
            if allow_notify and data["notify"]
            else None,
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise ApiError("invalid_response") from exc


class FocusApi:
    def __init__(self, transport=None):
        self.transport = transport

    def request(self, settings, method, path, **kwargs):
        try:
            with httpx.Client(
                timeout=httpx.Timeout(15, connect=3),
                transport=self.transport,
                follow_redirects=False,
            ) as client:
                response = client.request(
                    method,
                    settings.api_url + path,
                    headers={
                        "Authorization": "Bearer " + settings.api_token,
                        **kwargs.pop("headers", {}),
                    },
                    **kwargs,
                )
                if not response.is_success:
                    codes = {
                        401: "unauthorized",
                        403: "permission",
                        404: "session_not_found",
                        409: "frame_in_progress",
                        413: "body_too_large",
                        429: "frame_limit",
                        503: "service_not_configured",
                    }
                    raise ApiError(codes.get(response.status_code, "api_error"))
                return response.json()
        except httpx.TimeoutException:
            raise ApiError("timeout") from None
        except httpx.RequestError:
            raise ApiError("connection") from None
        except ValueError:
            raise ApiError("invalid_response") from None

    def start(self, settings):
        return parse_snapshot(
            self.request(
                settings,
                "POST",
                "/v1/sessions",
                json={
                    "device_type": "reachy_mini",
                    "duration_seconds": settings.duration_minutes * 60,
                },
            )
        )

    def frame(self, settings, sid, frame_id, jpeg):
        if len(jpeg) > 1048576:
            raise ApiError("body_too_large")
        return parse_snapshot(
            self.request(
                settings,
                "POST",
                f"/v1/sessions/{quote(sid, safe='')}/frames",
                content=jpeg,
                headers={"Content-Type": "image/jpeg", "X-Frame-Id": frame_id},
            ),
            sid,
            allow_notify=True,
        )

    def control(self, settings, sid, action):
        return parse_snapshot(
            self.request(
                settings,
                "POST",
                f"/v1/sessions/{quote(sid, safe='')}/control",
                json={"action": action},
            ),
            sid,
        )

    def get(self, settings, sid):
        return parse_snapshot(
            self.request(settings, "GET", f"/v1/sessions/{quote(sid, safe='')}"), sid
        )
