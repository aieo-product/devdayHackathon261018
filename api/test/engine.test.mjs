import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusEngine } from '../src/engine.mjs';
import { DecisionError } from '../src/errors.mjs';

function harness({ decide, settings, deviceType = 'mac' } = {}) {
  let now = 0;
  let calls = 0;
  let result = { phoneProbability: 0.9, observableProbability: 1 };
  const provider = { name: 'mock', configured: true, async decide(args) { calls += 1; return decide ? decide(args) : result; } };
  const engine = new FocusEngine({ provider, clock: () => now, settings });
  const owner = 'owner';
  const session = engine.create({ owner, deviceType });
  const frame = (frameId, sessionId = session.session_id) => engine.frame({ owner, sessionId, frameId, bytes: Buffer.from([255, 216, 255]), contentType: 'image/jpeg' });
  return { engine, owner, session, frame, advance(ms = 1000) { now += ms; }, result(value) { result = value; }, get calls() { return calls; } };
}

test('Reachy repeats after fresh five-second holds without cooldown', async () => {
  const h = harness({ deviceType: 'reachy_mini' });
  const notifications = [];
  for (let cycle = 0; cycle < 2; cycle += 1) {
    for (let second = 0; second <= 5; second += 1) {
      const result = await h.frame(`cycle-${cycle}-${second}`);
      assert.equal(result.notify, second === 5);
      assert.equal(result.cooldown_remaining_ms, 0);
      assert.ok(result.next_capture_after_ms <= 1000);
      if (result.notify) {
        notifications.push(result.notification_id);
        assert.equal(result.state, 'observing');
        assert.equal(result.continuous_hold_ms, 5000);
        assert.equal((await h.frame(`cycle-${cycle}-${second}`)).notify, false);
      }
      h.advance();
    }
  }
  assert.equal(new Set(notifications).size, 2);
});

test('five seconds of positive samples notify once; cooldown requires a fresh five-second hold', async () => {
  const h = harness();
  assert.equal(h.session.continuous_hold_ms, 0);
  assert.equal(h.session.required_hold_ms, 5000);
  const a = await h.frame('1');
  assert.equal(a.state, 'suspected');
  assert.equal(a.consecutive_count, 1);
  assert.equal(a.continuous_hold_ms, 0);
  assert.equal(a.notify, false);
  for (let second = 1; second < 5; second += 1) {
    h.advance();
    const progress = await h.frame(`first-${second}`);
    assert.equal(progress.notify, false);
    assert.equal(progress.continuous_hold_ms, second * 1000);
  }
  h.advance();
  const notification = await h.frame('notify');
  assert.equal(notification.notify, true);
  assert.equal(notification.continuous_hold_ms, 5000);
  assert.equal(notification.state, 'cooldown');
  assert.match(notification.notification_id, /^[\da-f-]+$/);
  assert.equal(notification.next_capture_after_ms, 60000);
  assert.equal((await h.frame('notify')).notify, false);
  assert.equal((await h.frame('during-cooldown')).reason, 'cooldown_active');
  assert.equal(h.calls, 6);
  h.advance(60000);
  assert.equal((await h.frame('notify')).reason, 'duplicate_frame');
  assert.equal((await h.frame('during-cooldown')).reason, 'duplicate_frame');
  const fresh = await h.frame('after-cooldown');
  assert.equal(fresh.consecutive_count, 1);
  assert.equal(fresh.continuous_hold_ms, 0);
  for (let second = 1; second < 5; second += 1) {
    h.advance();
    assert.equal((await h.frame(`next-${second}`)).notify, false);
  }
  h.advance();
  const next = await h.frame('next-notify');
  assert.equal(next.notify, true);
  assert.notEqual(next.notification_id, notification.notification_id);
});

test('4999ms does not notify; a fresh positive at exactly 5000ms notifies without another interval', async () => {
  const h = harness();
  await h.frame('at-0');
  for (const gap of [1000, 1000, 1000, 1999]) {
    h.advance(gap);
    const result = await h.frame(`at-${h.calls}`);
    assert.equal(result.notify, false);
  }
  const before = h.engine.get({ owner: h.owner, sessionId: h.session.session_id });
  assert.equal(before.continuous_hold_ms, 4999);
  assert.equal(before.next_capture_after_ms, 1);
  h.advance(1);
  const snapshot = h.engine.get({ owner: h.owner, sessionId: h.session.session_id });
  assert.equal(snapshot.notify, false, 'elapsed wall time alone must not notify');
  assert.equal(snapshot.continuous_hold_ms, 4999, 'GET cannot add unobserved hold time');
  assert.equal((await h.frame('at-0')).notify, false, 'duplicate cannot confirm the threshold');
  const threshold = await h.frame('at-5000');
  assert.equal(threshold.continuous_hold_ms, 5000);
  assert.equal(threshold.notify, true);
});

test('slow inference consumes the sampling wait and cannot count its own latency as observed holding', async () => {
  let finish;
  const h = harness({ decide: () => new Promise((resolve) => { finish = resolve; }) });
  const first = h.frame('slow-first');
  await Promise.resolve();
  h.advance(1500);
  finish({ phoneProbability: 1, observableProbability: 1 });
  const initial = await first;
  assert.equal(initial.continuous_hold_ms, 0);
  assert.equal(initial.next_capture_after_ms, 0);
  for (let index = 0; index < 2; index += 1) {
    const pending = h.frame(`slow-${index}`);
    await Promise.resolve();
    h.advance(1500);
    finish({ phoneProbability: 1, observableProbability: 1 });
    const result = await pending;
    assert.equal(result.notify, false);
    assert.equal(result.continuous_hold_ms, (index + 1) * 1500);
    assert.equal(result.next_capture_after_ms, 0);
  }
  const near = h.frame('slow-near');
  await Promise.resolve();
  h.advance(500);
  finish({ phoneProbability: 1, observableProbability: 1 });
  const progress = await near;
  assert.equal(progress.continuous_hold_ms, 4500);
  assert.equal(progress.next_capture_after_ms, 0, 'remaining threshold overrides a full capture interval');
  const threshold = h.frame('slow-threshold');
  await Promise.resolve();
  finish({ phoneProbability: 1, observableProbability: 1 });
  assert.equal((await threshold).notify, true);
});

test('bad visibility, negative activity, or a long sample gap resets positive streak', async () => {
  const h = harness();
  await h.frame('1'); h.advance();
  h.result({ phoneProbability: 0.99, observableProbability: 0.2 });
  const unknown = await h.frame('2');
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.reason, 'insufficient_visibility');
  assert.equal(unknown.consecutive_count, 0);
  assert.equal(unknown.continuous_hold_ms, 0);
  h.result({ phoneProbability: 0.99, observableProbability: 1 }); h.advance();
  assert.equal((await h.frame('3')).consecutive_count, 1);
  h.advance(2501);
  const afterGap = await h.frame('4');
  assert.equal(afterGap.consecutive_count, 1);
  assert.equal(afterGap.continuous_hold_ms, 0);
  h.result({ phoneProbability: 0.2, observableProbability: 1 }); h.advance();
  const negative = await h.frame('5');
  assert.equal(negative.state, 'observing');
  assert.equal(negative.continuous_hold_ms, 0);
});

test('2500ms sample gaps preserve holding; larger gaps and provider failures restart its duration', async () => {
  const h = harness();
  await h.frame('start');
  h.advance(2500);
  assert.equal((await h.frame('boundary-gap')).continuous_hold_ms, 2500);
  h.advance(2501);
  const restarted = await h.frame('long-gap');
  assert.equal(restarted.notify, false);
  assert.equal(restarted.continuous_hold_ms, 0);
  h.advance();
  assert.equal((await h.frame('before-error')).continuous_hold_ms, 1000);
  h.result({ phoneProbability: NaN, observableProbability: 1 });
  h.advance();
  const failed = await h.frame('error');
  assert.equal(failed.reason, 'invalid_decision');
  assert.equal(failed.continuous_hold_ms, 0);
  h.result({ phoneProbability: 1, observableProbability: 1 });
  h.advance();
  assert.equal((await h.frame('after-error')).continuous_hold_ms, 0);
});

test('a negative or unobservable fresh result at the threshold never confirms an earlier positive', async () => {
  for (const result of [
    { phoneProbability: 0, observableProbability: 1 },
    { phoneProbability: 1, observableProbability: 0 },
  ]) {
    const h = harness();
    await h.frame('start');
    h.advance(2500);
    await h.frame('middle');
    h.advance(2500);
    h.result(result);
    const threshold = await h.frame('threshold');
    assert.equal(threshold.notify, false);
    assert.equal(threshold.continuous_hold_ms, 0);
  }
});

test('sessions isolate state, ownership, and duplicate frame IDs', async () => {
  const h = harness();
  const other = h.engine.create({ owner: h.owner, deviceType: 'cores3' });
  await h.frame('shared-id');
  const result = await h.frame('shared-id', other.session_id);
  assert.equal(result.consecutive_count, 1);
  assert.equal(h.calls, 2);
  assert.throws(() => h.engine.get({ owner: 'someone-else', sessionId: other.session_id }), { status: 404 });
  h.advance();
  assert.equal((await h.frame('shared-id')).reason, 'duplicate_frame');
  assert.equal(h.calls, 2);
});

test('capture interval is enforced; skipped frame IDs cannot later trigger an old-image inference', async () => {
  const h = harness();
  await h.frame('1');
  assert.equal((await h.frame('early')).reason, 'capture_too_soon');
  h.advance();
  assert.equal((await h.frame('early')).reason, 'duplicate_frame');
  assert.equal(h.calls, 1);
});

test('pause and resume reset the positive streak without bypassing the capture interval', async () => {
  const h = harness();
  await h.frame('first');
  h.advance();
  assert.equal((await h.frame('held-before-pause')).continuous_hold_ms, 1000);
  for (let index = 0; index < 5; index += 1) {
    h.engine.control({ owner: h.owner, sessionId: h.session.session_id, action: 'pause' });
    const resumed = h.engine.control({ owner: h.owner, sessionId: h.session.session_id, action: 'resume' });
    assert.equal(resumed.next_capture_after_ms, 1000);
    assert.equal(resumed.consecutive_count, 0);
    assert.equal(resumed.continuous_hold_ms, 0);
    const early = await h.frame(`after-resume-${index}`);
    assert.equal(early.reason, 'capture_too_soon');
    assert.equal(early.notify, false);
  }
  assert.equal(h.calls, 2);
  h.advance();
  assert.equal((await h.frame('after-interval')).consecutive_count, 1);
  assert.equal(h.calls, 3);
});

test('pause or end cancels an in-flight result; resuming does not revive old work', async () => {
  for (const action of ['pause', 'end']) {
    let finish;
    const h = harness({ decide: () => new Promise((resolve) => { finish = resolve; }), settings: { requiredHoldMs: 0 } });
    const pending = h.frame('pending');
    await Promise.resolve();
    assert.equal((await h.frame('pending')).reason, 'duplicate_frame');
    await assert.rejects(h.frame('different'), { status: 409 });
    const controlled = h.engine.control({ owner: h.owner, sessionId: h.session.session_id, action });
    assert.equal(controlled.state, action === 'pause' ? 'paused' : 'ended');
    if (action === 'pause') h.engine.control({ owner: h.owner, sessionId: h.session.session_id, action: 'resume' });
    const discarded = await pending;
    assert.equal(discarded.notify, false);
    assert.equal(discarded.reason, 'session_changed');
    finish({ phoneProbability: 1, observableProbability: 1 });
    await Promise.resolve();
    assert.equal(h.engine.get({ owner: h.owner, sessionId: h.session.session_id }).notify, false);
  }
});

test('session expiry while inference runs discards a positive result', async () => {
  let finish;
  const h = harness({ decide: () => new Promise((resolve) => { finish = resolve; }), settings: { requiredHoldMs: 0 } });
  const short = h.engine.create({ owner: h.owner, deviceType: 'mac', durationSeconds: 1 });
  const pending = h.frame('expire', short.session_id);
  await Promise.resolve(); h.advance(1001);
  finish({ phoneProbability: 1, observableProbability: 1 });
  const result = await pending;
  assert.equal(result.state, 'ended');
  assert.equal(result.notify, false);
});

test('timeout and stale results become unknown without a notification or automatic retry', async () => {
  const timed = harness({ decide: () => new Promise(() => {}), settings: { decisionTimeoutMs: 10 } });
  const result = await timed.frame('timeout');
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'decision_timeout');
  assert.equal(result.notify, false);
  assert.equal(timed.calls, 1);
  let late;
  const stale = harness({ decide: () => new Promise((resolve) => { late = resolve; }) });
  const pending = stale.frame('late');
  await Promise.resolve(); stale.advance(11000);
  late({ phoneProbability: 1, observableProbability: 1 });
  assert.equal((await pending).reason, 'stale_result');
});

test('malicious provider values, refusals and failures never become positive detections or leak errors', async () => {
  for (const value of [NaN, Infinity, -0.1, 1.1, '1', null, undefined]) {
    const h = harness({ decide: async () => ({ phoneProbability: value, observableProbability: 1 }) });
    const result = await h.frame('invalid');
    assert.equal(result.state, 'unknown');
    assert.equal(result.reason, 'invalid_decision');
    assert.equal(result.notify, false);
  }
  for (const error of [new DecisionError('decision_refused'), new Error('secret-api-key image-data')]) {
    const h = harness({ decide: async () => { throw error; } });
    const result = await h.frame('error');
    assert.equal(result.state, 'unknown');
    assert.equal(result.consecutive_count, 0);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('bounded session/frame storage fails closed and expired sessions are reclaimed', async () => {
  const h = harness({ settings: { maxSessions: 1, maxFramesPerSession: 1, retentionMs: 10 } });
  assert.throws(() => h.engine.create({ owner: h.owner, deviceType: 'mac' }), { status: 429 });
  await h.frame('1'); h.advance();
  await assert.rejects(h.frame('2'), { status: 429 });
  h.engine.control({ owner: h.owner, sessionId: h.session.session_id, action: 'end' });
  h.advance(11);
  const next = h.engine.create({ owner: h.owner, deviceType: 'mac' });
  assert.equal(next.state, 'observing');
  assert.equal(h.engine.sessions.size, 1);
});
