import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionShowcase } from '../action-showcase.js';

const steps = [
  { kind: 'start', label: 'Start', duration: 1200 },
  { kind: 'detect', label: 'Alert', duration: 2400 },
];

function fixture(callbacks = {}) {
  const timers = [];
  const seen = [];
  let finishes = 0;
  const showcase = new ActionShowcase({
    onStep: (step, index, total) => seen.push({ step, index, total }),
    onFinish: () => { finishes += 1; },
    setTimer: (callback, duration) => {
      timers.push({ callback, duration, canceled: false });
      return timers.length - 1;
    },
    clearTimer: (id) => { timers[id].canceled = true; },
    ...callbacks,
  });
  return { showcase, timers, seen, finishes: () => finishes };
}

test('plays immediately, honors each duration and finishes exactly once', () => {
  const f = fixture();
  f.showcase.play(steps);
  assert.equal(f.showcase.active, true);
  assert.deepEqual(f.seen, [{ step: steps[0], index: 0, total: 2 }]);
  assert.equal(f.timers[0].duration, 1200);
  f.timers[0].callback();
  assert.deepEqual(f.seen[1], { step: steps[1], index: 1, total: 2 });
  assert.equal(f.timers[1].duration, 2400);
  f.timers[0].callback();
  assert.equal(f.seen.length, 2, 'an already consumed callback stays stale');
  f.timers[1].callback();
  f.timers[1].callback();
  assert.equal(f.finishes(), 1);
  assert.equal(f.showcase.active, false);
});

test('stop cancels timer zero and ignores a queued callback without finishing', () => {
  const f = fixture();
  f.showcase.play(steps);
  f.showcase.stop();
  assert.equal(f.timers[0].canceled, true);
  f.timers[0].callback();
  assert.equal(f.seen.length, 1);
  assert.equal(f.finishes(), 0);
  assert.equal(f.showcase.active, false);
});

test('replaying replaces the sequence and ignores callbacks from the old play', () => {
  const f = fixture();
  f.showcase.play(steps);
  f.showcase.play([steps[1]]);
  assert.equal(f.timers[0].canceled, true);
  f.timers[0].callback();
  assert.equal(f.seen.length, 2);
  assert.equal(f.showcase.active, true);
  f.timers[1].callback();
  assert.equal(f.finishes(), 1);
});

test('stopping synchronously inside onStep does not schedule remaining work', () => {
  const f = fixture({ onStep: () => f.showcase.stop() });
  f.showcase.play(steps);
  assert.equal(f.timers.length, 0);
  assert.equal(f.showcase.active, false);
  assert.equal(f.finishes(), 0);
});

test('replaying inside onStep leaves only the replacement timer running', () => {
  const f = fixture({
    onStep: (step) => {
      f.seen.push(step.kind);
      if (step.kind === 'start') f.showcase.play([steps[1]]);
    },
  });
  f.showcase.play(steps);
  assert.deepEqual(f.seen, ['start', 'detect']);
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].duration, 2400);
  f.timers[0].callback();
  assert.equal(f.finishes(), 1);
});

test('onFinish can start another tour without old completion changing it', () => {
  let finishes = 0;
  const f = fixture({
    onFinish: () => {
      finishes += 1;
      if (finishes === 1) f.showcase.play([steps[1]]);
      else f.showcase.stop();
    },
  });
  f.showcase.play([steps[0]]);
  f.timers[0].callback();
  assert.equal(f.showcase.active, true);
  f.timers[0].callback();
  assert.equal(finishes, 1);
  f.timers[1].callback();
  assert.equal(finishes, 2);
  assert.equal(f.showcase.active, false);
});

test('an empty tour completes immediately without a timer or cue', () => {
  const f = fixture();
  f.showcase.play([]);
  assert.equal(f.finishes(), 1);
  assert.equal(f.showcase.active, false);
  assert.equal(f.timers.length, 0);
  assert.equal(f.seen.length, 0);
});

test('default browser timers preserve the global receiver and complete the demo sequence', t => {
  const timers = []; let completed = 0;
  t.mock.method(globalThis, 'setTimeout', function (callback, delay) {
    assert.equal(this, globalThis);
    timers.push({ callback, delay, cancelled: false });
    return timers.length - 1;
  });
  t.mock.method(globalThis, 'clearTimeout', function (id) {
    assert.equal(this, globalThis);
    timers[id].cancelled = true;
  });
  const showcase = new ActionShowcase({ onFinish: () => { completed++; } });
  showcase.play(steps);
  timers[0].callback();
  timers[1].callback();
  assert.equal(completed, 1);
  assert.equal(showcase.active, false);
  showcase.play(steps);
  showcase.stop();
  assert.equal(timers[2].cancelled, true);
});
