import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session.js';

function clocked(duration = 1500) {
  let milliseconds = 0;
  return {
    session: new Session({ duration, now: () => milliseconds }),
    advance: (seconds) => { milliseconds += seconds * 1000; },
  };
}

test('remaining time retains subsecond precision and drives the countdown ratio', () => {
  const { session, advance } = clocked();
  assert.equal(session.status, 'ready');
  assert.equal(session.remaining, 1500);
  assert.equal(session.ratio, 1);
  assert.equal(session.start(), true);
  advance(270);
  assert.equal(session.elapsed, 270);
  assert.equal(session.remaining, 1230);
  assert.equal(session.ratio, 0.82);
  advance(0.125);
  assert.equal(session.elapsed, 270.125);
  assert.equal(session.remaining, 1229.875);
});

test('pause and resume exclude paused wall time and reject duplicate transitions', () => {
  const { session, advance } = clocked();
  assert.equal(session.pause(), false);
  assert.equal(session.resume(), false);
  session.start();
  advance(12.5);
  assert.equal(session.pause(), true);
  assert.equal(session.pause(), false);
  assert.equal(session.start(), false);
  advance(300);
  assert.equal(session.elapsed, 12.5);
  assert.equal(session.tick(), false);
  assert.equal(session.resume(), true);
  assert.equal(session.resume(), false);
  advance(7.5);
  assert.equal(session.elapsed, 20);
});

test('break freezes elapsed time, including when entered from pause', () => {
  const { session, advance } = clocked();
  assert.equal(session.takeBreak(), false);
  session.start();
  advance(45);
  assert.equal(session.takeBreak(), true);
  assert.equal(session.status, 'break');
  assert.equal(session.takeBreak(), false);
  advance(600);
  assert.equal(session.elapsed, 45);
  assert.equal(session.resume(), true);
  advance(5);
  session.pause();
  assert.equal(session.takeBreak(), true);
  advance(10);
  assert.equal(session.elapsed, 50);
  assert.equal(session.resume(), true);
});

test('end freezes the session and starting again is a fresh session', () => {
  const { session, advance } = clocked();
  assert.equal(session.end(), false);
  session.start();
  advance(20);
  session.receiveDetection();
  assert.equal(session.end(), true);
  assert.equal(session.status, 'ended');
  assert.equal(session.end(), false);
  assert.equal(session.resume(), false);
  advance(2000);
  assert.equal(session.elapsed, 20);
  assert.equal(session.tick(), false);
  assert.equal(session.start(), true);
  assert.equal(session.elapsed, 0);
  assert.equal(session.notificationCount, 0);
  assert.equal(session.receiveDetection(), true);
});

test('completion clamps the timer and tick emits its transition exactly once', () => {
  const { session, advance } = clocked(60);
  session.start();
  advance(59.999);
  assert.equal(session.tick(), false);
  advance(0.001);
  assert.equal(session.remaining, 0);
  assert.equal(session.tick(), true);
  assert.equal(session.status, 'completed');
  assert.equal(session.tick(), false);
  advance(500);
  assert.equal(session.remaining, 0);
  assert.equal(session.elapsed, 60);
  assert.equal(session.ratio, 0);
  assert.equal(session.pause(), false);
  assert.equal(session.resume(), false);
  assert.equal(session.start(), true);
  assert.equal(session.remaining, 60);
});

test('duration validation accepts 60–7200 seconds and refuses changes during an active session', () => {
  const { session } = clocked();
  for (const value of [0, 59, 7201, -1, NaN, Infinity, '600', null]) {
    assert.equal(session.setDuration(value), false);
    assert.equal(session.duration, 1500);
  }
  assert.equal(session.setDuration(60), true);
  assert.equal(session.setDuration(7200), true);
  session.start();
  assert.equal(session.setDuration(600), false);
  session.pause();
  assert.equal(session.setDuration(600), false);
  session.takeBreak();
  assert.equal(session.setDuration(600), false);
  session.end();
  assert.equal(session.setDuration(600), true);
  assert.equal(session.status, 'ready');
  assert.equal(session.remaining, 600);
  assert.throws(() => new Session({ duration: 59 }), RangeError);
  assert.throws(() => new Session({ duration: Infinity }), RangeError);
  assert.throws(() => new Session({ now: 123 }), TypeError);
});

test('completed-session duration settings reset time and notification history', () => {
  const { session, advance } = clocked(60);
  session.start();
  session.receiveDetection();
  advance(60);
  session.tick();
  assert.equal(session.setDuration(120), true);
  assert.equal(session.status, 'ready');
  assert.equal(session.elapsed, 0);
  assert.equal(session.notificationCount, 0);
});

test('notification gate requires running, enabled, unexpired session and strictly more than 60 seconds', () => {
  const { session, advance } = clocked();
  assert.equal(session.receiveDetection(), false);
  session.start();
  assert.equal(session.receiveDetection(), true);
  assert.equal(session.receiveDetection(), false);
  advance(60);
  assert.equal(session.receiveDetection(), false);
  advance(0.001);
  assert.equal(session.receiveDetection(), true);
  assert.equal(session.notificationCount, 2);
  session.notificationEnabled = false;
  advance(61);
  assert.equal(session.receiveDetection(), false);
  session.notificationEnabled = true;
  assert.equal(session.receiveDetection(), true);
  advance(1500);
  assert.equal(session.receiveDetection(), false, 'deadline blocks notifications before the next tick');
  session.tick();
  assert.equal(session.receiveDetection(), false);
});

test('pause, break and end block notifications and invalidate the previous cooldown', () => {
  const { session } = clocked();
  session.start();
  assert.equal(session.receiveDetection(), true);
  session.pause();
  assert.equal(session.receiveDetection(), false);
  session.resume();
  assert.equal(session.receiveDetection(), true);
  session.takeBreak();
  assert.equal(session.receiveDetection(), false);
  session.resume();
  assert.equal(session.receiveDetection(), true);
  session.end();
  assert.equal(session.receiveDetection(), false);
  assert.equal(session.notificationCount, 3);
  session.start();
  assert.equal(session.receiveDetection(), true);
  assert.equal(session.notificationCount, 1);
});

test('generation advances for each successful lifecycle change and duration reset only', () => {
  const { session, advance } = clocked(60);
  assert.equal(session.generation, 0);
  session.pause(); session.resume(); session.end(); session.tick(); session.setDuration(10);
  assert.equal(session.generation, 0, 'rejected operations do not invalidate active work');
  session.start();
  assert.equal(session.generation, 1);
  session.start(); session.setDuration(120); session.tick();
  assert.equal(session.generation, 1);
  session.pause();
  assert.equal(session.generation, 2);
  session.takeBreak();
  assert.equal(session.generation, 3);
  session.resume();
  assert.equal(session.generation, 4);
  session.end();
  assert.equal(session.generation, 5);
  session.setDuration(120);
  assert.equal(session.generation, 6);
  session.start();
  assert.equal(session.generation, 7);
  advance(120);
  assert.equal(session.tick(), true);
  assert.equal(session.generation, 8);
  assert.equal(session.tick(), false);
  assert.equal(session.generation, 8);
});

test('a detection response captured before pause or break stays stale after resume', () => {
  for (const stop of ['pause', 'takeBreak']) {
    const { session } = clocked();
    session.start();
    const generation = session.generation;
    session[stop]();
    session.resume();
    assert.equal(session.receiveDetection({ generation }), false, `${stop} invalidates captured work`);
    assert.equal(session.notificationCount, 0);
    assert.equal(session.receiveDetection({ generation: session.generation }), true,
      'stale responses neither count nor consume the new cooldown');
    assert.equal(session.notificationCount, 1);
  }
});

test('old-session detections cannot enter a restarted or newly configured session', () => {
  const { session, advance } = clocked(60);
  session.start();
  const firstGeneration = session.generation;
  session.end();
  session.start();
  assert.equal(session.receiveDetection({ generation: firstGeneration }), false);
  assert.equal(session.notificationCount, 0);
  const secondGeneration = session.generation;
  advance(60);
  session.tick();
  session.setDuration(120);
  session.start();
  assert.equal(session.receiveDetection({ generation: secondGeneration }), false);
  assert.equal(session.notificationCount, 0);
  assert.equal(session.receiveDetection(), true, 'no-argument calls retain the current-generation API');
  assert.equal(session.notificationCount, 1);
});
