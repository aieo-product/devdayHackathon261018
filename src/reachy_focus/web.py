"""Same-origin LAN controls, without key echoes or persistent camera images."""

from urllib.parse import urlsplit

from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response


def attach_routes(app, get_runtime):
    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        return JSONResponse(
            {"detail": "リクエスト形式を確認してください。"}, status_code=422
        )

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            if request.method == "POST":
                origin = request.headers.get("origin")
                if (
                    request.headers.get("x-focus-control") != "1"
                    or request.headers.get("content-type", "").split(";")[0]
                    != "application/json"
                    or (
                        origin
                        and urlsplit(origin).netloc != request.headers.get("host")
                    )
                ):
                    return JSONResponse(
                        {"detail": "同じ操作画面から実行してください。"},
                        status_code=403,
                    )
                try:
                    too_large = int(request.headers.get("content-length", "0")) > 8192
                except ValueError:
                    too_large = True
                if too_large:
                    return JSONResponse(
                        {"detail": "設定が大きすぎます。"}, status_code=413
                    )
            try:
                response = await call_next(request)
            except Exception:
                return JSONResponse({"detail": "処理に失敗しました。"}, status_code=500)
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response
        return await call_next(request)

    def runtime():
        value = get_runtime()
        if value is None:
            raise HTTPException(503, "本体への接続を準備しています。")
        return value

    def invoke(fn):
        try:
            return fn()
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
        except OSError:
            raise HTTPException(
                500, "設定の保存または本体操作に失敗しました。"
            ) from None

    @app.get("/api/status")
    def status():
        return runtime().snapshot()

    @app.post("/api/settings")
    def settings(changes: dict):
        return invoke(lambda: runtime().configure(changes))

    @app.post("/api/session/{action}")
    def control(action: str, body: dict):
        return invoke(
            lambda: runtime().control(action, consent=body.get("consent") is True)
        )

    @app.post("/api/preview")
    def preview():
        jpeg = invoke(lambda: runtime().preview())
        return Response(jpeg, media_type="image/jpeg")

    @app.post("/api/test-notification")
    def test_notification():
        return invoke(lambda: runtime().test_notification())
