import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteController, createSingleFlightPoll } from './public/remote-control.mjs';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
};

function command(revision, desired_state = 'on', overrides = {}) {
  return {
    revision,
    desired_state,
    online: true,
    command_issued_at: new Date(NOW).toISOString(),
    command_expires_at: new Date(NOW + 60000).toISOString(),
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = { start: 0, stop: 0, permission: 0, trackStop: 0, change: 0 };
  const stream = { getTracks: () => [
    { stop: () => { calls.trackStop += 1; } },
    { stop: () => { calls.trackStop += 1; } },
  ] };
  let currentObservation = { observed_state: 'off', session_id: null };
  let isVisible = true;
  const controller = new RemoteController({
    start: async () => { calls.start += 1; return true; },
    stop: () => { calls.stop += 1; },
    permission: async () => { calls.permission += 1; return stream; },
    visible: () => isVisible,
    observed: () => currentObservation,
    now: () => NOW,
    onChange: () => { calls.change += 1; },
    ...overrides,
  });
  return {
    controller, calls, stream,
    setVisible(value) { isVisible = value; },
    setObserved(value) { currentObservation = value; },
  };
}

test('remote access starts disabled and heartbeat reflects the actual local camera state', () => {
  const h = harness();
  assert.equal(h.controller.state.armed, false);
  assert.equal(h.controller.state.arming, false);
  assert.deepEqual(h.controller.heartbeat(), {
    observed_state: 'off', remote_enabled: false, applied_revision: 0, session_id: null,
  });
  h.setObserved({ observed_state: 'on', session_id: 'local-session' });
  assert.deepEqual(h.controller.heartbeat(), {
    observed_state: 'on', remote_enabled: false, applied_revision: 0, session_id: 'local-session',
  });
  assert.equal(h.calls.permission, 0);
  assert.equal(h.calls.start, 0);
});

test('arming requests camera permission synchronously and immediately releases every permission-check track', async () => {
  const h = harness();
  const arming = h.controller.arm();
  assert.equal(h.calls.permission, 1, 'permission request must remain in the user gesture');
  await arming;
  assert.equal(h.calls.trackStop, 2);
  assert.equal(h.controller.state.armed, true);
  assert.equal(h.controller.state.arming, false);
  assert.equal(h.calls.start, 0, 'permission alone must not begin a focus session');
});

test('commands seen while disabled are acknowledged and cannot replay after arming', async () => {
  const h = harness();
  h.controller.observe(command(7));
  assert.equal(h.controller.state.appliedRevision, 7);
  assert.equal(h.calls.start, 0);
  await h.controller.arm();
  h.controller.observe(command(7));
  h.controller.observe(command(6));
  await flush();
  assert.equal(h.calls.start, 0);
  assert.equal(h.controller.state.appliedRevision, 7);
  h.controller.observe(command(8));
  await flush();
  assert.equal(h.calls.start, 1);
});

test('arming cannot execute an unseen command that was issued before local permission completed', async () => {
  const h = harness();
  await h.controller.arm();
  h.controller.observe(command(1, 'on', { command_issued_at: new Date(NOW - 1).toISOString() }));
  await flush();
  assert.equal(h.calls.start, 0);
  assert.equal(h.controller.state.appliedRevision, 1);
  h.controller.observe(command(2));
  await flush();
  assert.equal(h.calls.start, 1);
});

test('expired, stale, future-dated, invalid-time, and offline ON commands cannot start the camera', async t => {
  const cases = [
    ['expired', { command_expires_at: new Date(NOW).toISOString() }],
    ['stale', { command_issued_at: new Date(NOW - 120001).toISOString() }],
    ['future', { command_issued_at: new Date(NOW + 5001).toISOString() }],
    ['invalid issued time', { command_issued_at: 'invalid' }],
    ['invalid expiry', { command_expires_at: 'invalid' }],
    ['offline', { online: false }],
  ];
  for (const [label, overrides] of cases) {
    await t.test(label, async () => {
      const h = harness();
      await h.controller.arm();
      h.controller.observe(command(1, 'on', overrides));
      await flush();
      assert.equal(h.calls.start, 0);
      assert.equal(h.controller.state.appliedRevision, 1, 'ignored commands still must be acknowledged');
    });
  }
});

test('ON requires a visible page and duplicate revisions never repeat a start', async () => {
  const h = harness();
  await h.controller.arm();
  h.setVisible(false);
  h.controller.observe(command(1));
  await flush();
  assert.equal(h.calls.start, 0);
  h.setVisible(true);
  h.controller.observe(command(1));
  assert.equal(h.calls.start, 0, 'visibility changes must not replay an acknowledged command');
  h.controller.observe(command(2));
  h.controller.observe(command(2));
  await flush();
  h.controller.observe(command(2));
  assert.equal(h.calls.start, 1);
});

test('OFF stops synchronously while an earlier ON is pending and its revision survives late completion', async () => {
  const started = deferred();
  let starts = 0;
  const h = harness({ start: () => { starts += 1; return started.promise; } });
  await h.controller.arm();
  h.controller.observe(command(1));
  await flush();
  assert.equal(starts, 1);
  const stopsBefore = h.calls.stop;
  h.controller.observe(command(2, 'off'));
  assert.ok(h.calls.stop > stopsBefore, 'OFF must not wait for the pending ON promise');
  assert.equal(h.controller.state.appliedRevision, 2);
  started.resolve(true);
  await flush();
  assert.equal(h.controller.state.appliedRevision, 2);
  assert.equal(h.controller.heartbeat().observed_state, 'off');
  h.controller.observe(command(1));
  assert.equal(starts, 1);
});

test('OFF remains available when remote permission is disabled or its command is expired', () => {
  const h = harness();
  h.controller.observe(command(3, 'off', {
    online: false,
    command_issued_at: new Date(NOW - 300000).toISOString(),
    command_expires_at: new Date(NOW - 1).toISOString(),
  }));
  assert.ok(h.calls.stop > 0);
  assert.equal(h.controller.state.appliedRevision, 3);
  assert.equal(h.controller.state.armed, false);
});

test('late ON rejection after OFF cannot overwrite the newer command with an error', async () => {
  const started = deferred();
  const h = harness({ start: () => started.promise });
  await h.controller.arm();
  h.controller.observe(command(1));
  await flush();
  h.controller.observe(command(2, 'off'));
  const errorAfterOff = h.controller.state.error;
  started.reject(new Error('late start failure'));
  await flush();
  assert.equal(h.controller.state.appliedRevision, 2);
  assert.equal(h.controller.state.error, errorAfterOff);
});

test('the start guard rechecks expiry, command age, visibility, and cancellation after asynchronous camera acquisition', async t => {
  const cases = [
    ['expires during acquisition', ({ setNow }) => setNow(NOW + 1000), { command_expires_at: new Date(NOW + 1000).toISOString() }],
    ['becomes too old during acquisition', ({ setNow }) => setNow(NOW + 120001), { command_expires_at: new Date(NOW + 180000).toISOString() }],
    ['page becomes hidden', ({ h }) => h.setVisible(false), {}],
    ['OFF arrives', ({ h }) => h.controller.observe(command(2, 'off')), {}],
    ['remote permission is withdrawn', ({ h }) => h.controller.unarm(), {}],
    ['controller is disposed', ({ h }) => h.controller.dispose(), {}],
  ];
  for (const [label, invalidate, overrides] of cases) {
    await t.test(label, async () => {
      let now = NOW;
      let isCurrent;
      const pending = deferred();
      const h = harness({
        now: () => now,
        start: (guard = {}) => { isCurrent = guard.isCurrent; return pending.promise; },
      });
      await h.controller.arm();
      h.controller.observe(command(1, 'on', overrides));
      await flush();
      assert.equal(typeof isCurrent, 'function');
      assert.equal(isCurrent(), true);
      invalidate({ h, setNow: value => { now = value; } });
      assert.equal(isCurrent(), false, 'late camera acquisition must not revive an invalid ON');
      pending.resolve(false);
      await flush();
    });
  }
});

test('unarming during permission acquisition cancels arming and closes late-arriving tracks', async () => {
  const permission = deferred();
  let requested = 0;
  const h = harness({ permission: () => { requested += 1; return permission.promise; } });
  const arming = h.controller.arm();
  assert.equal(requested, 1);
  h.controller.unarm();
  assert.equal(h.controller.state.armed, false);
  assert.ok(h.calls.stop > 0);
  permission.resolve(h.stream);
  await arming;
  assert.equal(h.calls.trackStop, 2);
  assert.equal(h.controller.state.armed, false);
  assert.equal(h.controller.state.arming, false);
  assert.equal(h.calls.start, 0);
});

test('OFF during permission acquisition cancels the arming latch and permits a later local retry', async () => {
  const permission = deferred();
  const h = harness({ permission: () => permission.promise });
  const arming = h.controller.arm();
  assert.equal(h.controller.state.arming, true);
  h.controller.observe(command(1, 'off'));
  assert.equal(h.controller.state.arming, false);
  permission.resolve(h.stream);
  await arming;
  assert.equal(h.controller.state.armed, false);
  assert.equal(h.calls.trackStop, 2);
  assert.equal(await h.controller.arm(), true);
});

test('local cancellation during permission acquisition does not leave arming latched', async () => {
  const permission = deferred();
  const h = harness({ permission: () => permission.promise });
  const arming = h.controller.arm();
  h.controller.localStop();
  assert.equal(h.controller.state.arming, false);
  permission.resolve(h.stream);
  await arming;
  assert.equal(h.controller.state.armed, false);
  assert.equal(h.calls.trackStop, 2);
  assert.equal(await h.controller.arm(), true);
});

test('a stale stop failure cannot overwrite a later successful ON command', async () => {
  const stopped = deferred();
  const h = harness({ stop: () => stopped.promise });
  await h.controller.arm();
  h.controller.observe(command(1, 'off'));
  h.controller.observe(command(2));
  await flush();
  const errorAfterOn = h.controller.state.error;
  stopped.reject(new Error('late stop failure'));
  await flush();
  assert.equal(h.controller.state.appliedRevision, 2);
  assert.equal(h.controller.state.error, errorAfterOn);
});

test('hiding the page unarms and stops immediately; a later command cannot restart it', async () => {
  const h = harness();
  await h.controller.arm();
  h.controller.observe(command(1));
  await flush();
  h.controller.hidden();
  assert.equal(h.controller.state.armed, false);
  assert.ok(h.calls.stop > 0);
  h.controller.observe(command(2));
  await flush();
  assert.equal(h.calls.start, 1);
  assert.equal(h.controller.heartbeat().remote_enabled, false);
  assert.equal(h.controller.heartbeat().applied_revision, 2);
});

test('local stop cancels the active command without disabling remote permission or replaying ON', async () => {
  const started = deferred();
  let starts = 0;
  const h = harness({ start: () => { starts += 1; return started.promise; } });
  await h.controller.arm();
  h.controller.observe(command(4));
  await flush();
  h.controller.localStop();
  assert.equal(h.controller.state.armed, true);
  assert.equal(h.calls.stop, 0, 'the page owns the explicit local stop action');
  h.controller.observe(command(4));
  started.resolve(true);
  await flush();
  assert.equal(starts, 1);
  assert.equal(h.controller.state.appliedRevision, 4);
  h.controller.observe(command(5));
  await flush();
  assert.equal(starts, 2, 'a newly issued command is allowed after a local stop');
});

test('disposing while permission is pending cannot re-arm the controller', async () => {
  const permission = deferred();
  const h = harness({ permission: () => permission.promise });
  const arming = h.controller.arm();
  h.controller.dispose();
  assert.equal(h.controller.state.armed, false);
  assert.ok(h.calls.stop > 0);
  permission.resolve(h.stream);
  await arming;
  assert.equal(h.calls.trackStop, 2);
  assert.equal(h.controller.state.armed, false);
});

function fakeTimers() {
  let nextId = 0;
  const scheduled = new Map();
  return {
    scheduled,
    setTimer(callback, delay) { const id = ++nextId; scheduled.set(id, { callback, delay }); return id; },
    clearTimer(id) { scheduled.delete(id); },
    fire() {
      const entry = scheduled.entries().next().value;
      assert.ok(entry, 'expected a scheduled poll');
      scheduled.delete(entry[0]);
      entry[1].callback();
    },
  };
}

test('overlapping manual polls share one task and do not create a background timer', async () => {
  const pending = deferred();
  const clock = fakeTimers();
  let calls = 0;
  const poll = createSingleFlightPoll({ task: () => { calls += 1; return pending.promise; }, ...clock });
  const first = poll.run();
  const second = poll.run();
  await flush();
  assert.equal(calls, 1);
  pending.resolve('ready');
  await Promise.all([first, second]);
  assert.equal(clock.scheduled.size, 0);
  await poll.run();
  assert.equal(calls, 2);
});

test('active polling schedules the next request only after completion and stop cancels it', async () => {
  const first = deferred();
  const second = deferred();
  const clock = fakeTimers();
  let calls = 0;
  const poll = createSingleFlightPoll({
    task: () => { calls += 1; return calls === 1 ? first.promise : second.promise; },
    ...clock, delayMs: 2000,
  });
  poll.start();
  poll.start();
  await flush();
  assert.equal(calls, 1);
  assert.equal(clock.scheduled.size, 0);
  first.resolve();
  await flush();
  assert.equal(clock.scheduled.size, 1);
  assert.equal([...clock.scheduled.values()][0].delay, 2000);
  clock.fire();
  await flush();
  assert.equal(calls, 2);
  assert.equal(clock.scheduled.size, 0);
  poll.stop();
  second.resolve();
  await flush();
  assert.equal(clock.scheduled.size, 0, 'a late completion cannot revive stopped polling');
});

test('poll failures are reported once and active polling can recover on the next tick', async () => {
  const clock = fakeTimers();
  const failure = new Error('temporary heartbeat failure');
  const errors = [];
  let calls = 0;
  const poll = createSingleFlightPoll({
    task: async () => { calls += 1; if (calls === 1) throw failure; },
    ...clock, onError: error => errors.push(error),
  });
  poll.start();
  await flush();
  assert.deepEqual(errors, [failure]);
  assert.equal(clock.scheduled.size, 1);
  clock.fire();
  await flush();
  assert.equal(calls, 2);
  assert.equal(clock.scheduled.size, 1);
  poll.stop();
  assert.equal(clock.scheduled.size, 0);
});
