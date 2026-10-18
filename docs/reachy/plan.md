# Reachy Focus — current implementation scope

2026-10-18の追加指示で、直接Decisions接続から共通API接続へ変更した。
以前の3回連続モードは廃止。判定・保持時間・クールダウンは共通APIだけが管理する。現在の統合済みAPI既定値は保持2秒・クールダウン0秒。Reachyは固定時間を持たず、応答の`required_hold_ms`と`next_capture_after_ms`に従う。

- Shared API: https://focus-shared-api-20261018.take-otani.workers.dev
- Credentials: user-supplied FOCUS_API_TOKEN on the robot only; never commit it.
- On-robot Python app, no persistent Mac/browser required.
- Runtime: one frame in flight, consume next_capture_after_ms and fresh notify IDs.
- Local stop/deadline precedes network control; stale replies never execute actions.
- Raise the head smoothly at startup; always-on small idle motions while the app runs.
- Play the official 😨 fear1 preset on a new server notification; suppress idle while playing it.
- No motion checkbox. Closing the app stops idle motion too.
- Source: src/reachy_focus; tests: tests/reachy; docs: docs/reachy.
- Root packaging files remain in place for pushing the identical repository to HF.
- Preserve other devices and shared API source. The API owner handles server-side cooldown settings.

Issue: https://github.com/aieo-product/devdayHackathon261018/issues/2
Real recognition/motion/audio results must be recorded separately from mocks.

- Smartphone put-down triggers cheerful1 once from a fresh, visible negative result.
- Preserve preset sound and then play the bundled Japanese reminder.
- Increase idle rhythm at 10, 20 and 30 seconds of visible non-holding results, with smooth transitions.
- Keep the camera reference pose fixed through interrupted emotions; return smoothly on cancellation.
