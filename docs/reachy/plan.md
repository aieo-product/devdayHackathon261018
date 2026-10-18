# Reachy Focus implementation plan

Approved by the user on 2026-10-18.

- Run a Python app on Reachy Mini Wireless; the browser is only a controller.
- Keep the shared repository as the HF Space root. Package only `src/reachy_focus`.
- Call Decisions directly using an owner-supplied key stored outside the checkout.
- Use a 25 minute timer, 3 second sampling, three observable >=0.8 results,
  60 second cooldown and a 10 second valid-observation gap limit.
- Pause/end/settings changes invalidate in-flight observations and pending actions.
- Ship a LAN UI, bundled Japanese reminder, optional gentle motion, session-only logs.
- Test with injected camera/clock/decision/action adapters and validate the built package.
- Preserve existing API, clients and CoreS3 code. Their five-second shared-API policy
  is independent of this explicitly approved standalone Reachy policy.

No unanswered product questions. Real hardware and API checks require a reachable
robot and an owner-configured key; do not claim these checks based on mocks.

Final organization: `src/reachy_focus/`, `tests/reachy/`, `docs/reachy/`.
Root README, pyproject, landing page and style are the distribution contract.
The remote default branch is `feat/shared-focus-api`; preserve its latest CoreS3 changes.
Issue: https://github.com/aieo-product/devdayHackathon261018/issues/2
