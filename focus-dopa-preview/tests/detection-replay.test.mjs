import test from 'node:test';
import assert from 'node:assert/strict';
import { DetectionReplay } from '../detection-replay.js';

function fixture(options = {}) {
  let now = 0;
  const replay = new DetectionReplay({ now: () => now, ...options });
  const view = {
    context: 'session-one', enabled: true, status: 'running',
    visible: true, focused: true,
  };
  return {
    replay,
    remember: (notification, overrides = {}) => replay.remember(notification, {
      context: view.context, unseen: true, ...overrides,
    }),
    take: (overrides = {}) => replay.take({ ...view, ...overrides }),
    advance: (milliseconds) => { now += milliseconds; },
  };
}

test('hidden tabs and visible but unfocused PiP owners retain the unseen cue', () => {
  const { remember, take } = fixture();
  const notification = { kind: 'detect', message: 'Back to your task.' };
  remember(notification);
  assert.equal(take({ visible: false, focused: false }), null);
  assert.equal(take({ visible: false, focused: true }), null);
  assert.equal(take({ visible: true, focused: false }), null);
  assert.equal(take(), notification);
});

test('successive focus and visibility events consume the cue only once', () => {
  const { remember, take } = fixture();
  const notification = { kind: 'detect' };
  remember(notification);
  assert.equal(take(), notification);
  assert.equal(take(), null);
});

test('the newest unseen notification replaces the older one', () => {
  const { remember, take } = fixture();
  const latest = { kind: 'detect', message: 'Latest message' };
  remember({ kind: 'detect', message: 'Old message' });
  remember(latest);
  assert.equal(take(), latest);
});

test('a notification already seen in the main page clears any older pending cue', () => {
  const { remember, take } = fixture();
  remember({ kind: 'detect', message: 'Old message' });
  remember({ kind: 'detect', message: 'Seen now' }, { unseen: false });
  assert.equal(take(), null);
});

test('cues expire exactly at the default one minute limit and stay discarded', () => {
  const { remember, take, advance } = fixture();
  remember({ kind: 'detect' });
  advance(59999);
  assert.equal(take({ focused: false }), null);
  advance(1);
  assert.equal(take(), null);
  assert.equal(take(), null);
});

test('a fresh cue just inside a configured lifetime can still be replayed', () => {
  const { remember, take, advance } = fixture({ maxAgeMs: 100 });
  const notification = { kind: 'detect' };
  remember(notification);
  advance(99);
  assert.equal(take(), notification);
});

test('pausing, ending, completion, unknown state, and ready state invalidate real detections', () => {
  for (const status of ['paused', 'break', 'ended', 'completed', 'unknown', 'ready']) {
    const { remember, take } = fixture();
    remember({ kind: 'detect' });
    assert.equal(take({ status, visible: false, focused: false }), null, status);
    assert.equal(take(), null, `${status} must not reappear after resuming`);
  }
});

test('changing the session context permanently discards the previous cue', () => {
  const { remember, take } = fixture();
  remember({ kind: 'detect' });
  assert.equal(take({ context: 'session-two', focused: false }), null);
  assert.equal(take(), null);
});

test('disabling notifications discards a pending cue even while hidden', () => {
  const { remember, take } = fixture();
  remember({ kind: 'detect' });
  assert.equal(take({ enabled: false, visible: false }), null);
  assert.equal(take(), null);
});

test('display tests can replay before a session starts or after it ends', () => {
  for (const status of ['ready', 'ended']) {
    const { remember, take } = fixture();
    const notification = { kind: 'test', message: 'Display test' };
    remember(notification);
    assert.equal(take({ status, focused: false }), null);
    assert.equal(take({ status }), notification);
    assert.equal(take({ status }), null);
  }
});

test('display tests still respect notification permission, context and expiry', () => {
  for (const invalid of [{ enabled: false }, { context: 'session-two' }]) {
    const { remember, take } = fixture();
    remember({ kind: 'test' });
    assert.equal(take({ status: 'ready', ...invalid }), null);
    assert.equal(take({ status: 'ready' }), null);
  }
  const { remember, take, advance } = fixture();
  remember({ kind: 'test' });
  advance(60000);
  assert.equal(take({ status: 'ready' }), null);
});

test('explicit clear removes a pending cue', () => {
  const { replay, remember, take } = fixture();
  remember({ kind: 'detect' });
  replay.clear();
  assert.equal(take(), null);
});
