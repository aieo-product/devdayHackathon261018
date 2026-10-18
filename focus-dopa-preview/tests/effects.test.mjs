import test from 'node:test';
import assert from 'node:assert/strict';
import { Effects } from '../effects.js';

test('a replayed detection preserves warning particles without repeating the sound', () => {
  const env = setup();
  try {
    let sounds = 0;
    env.effects.playSound = () => { sounds++; };
    env.effects.fire('detect');
    assert.equal(sounds, 1);
    env.effects.fire('detect', { audible: false });
    assert.equal(sounds, 1);
    assert.ok(env.effects.particles.length > 0);
  } finally { env.cleanup(); }
});

function setup({ suspended = false } = {}) {
  const keys = ['window', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map();
  let id = 0, motionListener, shakeCount = 0;
  const query = {
    matches: false,
    addEventListener(_, callback) { motionListener = callback; },
    removeEventListener() { motionListener = null; },
  };
  let finishResume;
  const parameter = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  class AudioContextStub {
    state = suspended ? 'suspended' : 'running'; currentTime = 0; destination = {};
    createGain() { return { gain: parameter(), connect() {}, disconnect() {} }; }
    createOscillator() {
      return { frequency: parameter(), stopped: false, connect() {}, disconnect() {},
        start(time) { this.startsAt = time; },
        stop(time) { if (time === undefined) this.stopped = true; else this.endsAt = time; } };
    }
    resume() { return new Promise(resolve => { finishResume = () => { this.state = 'running'; resolve(); }; }); }
    async close() { this.state = 'closed'; }
  }
  globalThis.window = { innerWidth: 1440, innerHeight: 900, devicePixelRatio: 3,
    matchMedia: () => query, addEventListener() {}, removeEventListener() {}, AudioContext: AudioContextStub };
  globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = frameId => frames.delete(frameId);
  const ctx = new Proxy({}, { get(target, property) { return target[property] ?? (() => {}); } });
  const canvas = { style: {}, setAttribute() {}, getContext: () => ctx };
  const effects = new Effects({ canvas, onShake: () => shakeCount++ });
  return {
    effects, frames,
    unlock() { finishResume(); },
    get shakes() { return shakeCount; },
    motion(reduce) { motionListener({ matches: reduce }); },
    drain(seconds = 3) {
      let time = performance.now();
      for (let i = 0; i < seconds * 60 && frames.size; i++) {
        const callbacks = [...frames.values()];
        frames.clear(); time += 1000 / 60;
        callbacks.forEach(callback => callback(time));
      }
    },
    cleanup() {
      effects.destroy();
      for (const key of keys) {
        const descriptor = saved.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test('classic remains the default with its original particle count and 220-particle ceiling', () => {
  const env = setup();
  try {
    const { effects } = env;
    assert.equal(effects.theme, 'classic');
    effects.setIntensity('max');
    effects.fire('start');
    assert.equal(effects.particles.length, 97);
    assert.equal(effects.particles.some(p => p.kind === 'comet'), false);
    for (let i = 0; i < 6; i++) effects.fire('complete');
    assert.equal(effects.particles.length, 220);
    assert.equal(env.frames.size, 1);
  } finally { env.cleanup(); }
});

test('fever launches five-origin comet fireworks, bounded to 360 particles and 2.5 seconds', () => {
  const env = setup();
  try {
    const { effects } = env;
    effects.setTheme('fever');
    effects.setIntensity('max');
    effects.fire('complete');
    assert.equal(effects.particles.length, 330);
    assert.equal(new Set(effects.particles.map(p => `${p.x},${p.y}`)).size, 5);
    assert.ok(effects.particles.some(p => p.kind === 'comet'));
    assert.equal(effects.particles.filter(p => p.kind === 'ring').length, 10);
    assert.ok(effects.particles.every(p => p.duration <= 2.5));
    for (let i = 0; i < 4; i++) effects.fire('complete', { level: 3 });
    assert.equal(effects.particles.length, 360);
    assert.equal(env.frames.size, 1);
    env.drain();
    assert.equal(effects.particles.length, 0);
    assert.equal(env.frames.size, 0);
  } finally { env.cleanup(); }
});

test('fever keeps nudges gentle and cancels on break, motion preference, OFF, or theme switch', () => {
  const env = setup();
  try {
    const { effects } = env;
    effects.setTheme('fever');
    effects.setIntensity('max');
    effects.fire('start');
    effects.fire('break');
    assert.equal(effects.particles.length, 24);
    assert.equal(effects.particles.filter(p => p.kind === 'bubble').length, 22);
    assert.ok(effects.particles.every(p => ['bubble', 'ring'].includes(p.kind)));
    effects.fire('pause');
    assert.equal(effects.particles.length, 1);
    effects.clear(); effects.fire('notify');
    assert.equal(effects.particles.length, 1);
    assert.equal(effects.particles[0].kind, 'ring');
    effects.fire('complete');
    env.motion(true);
    assert.equal(effects.particles.length, 0);
    assert.equal(env.frames.size, 0);
    const shakes = env.shakes;
    effects.fire('complete');
    assert.equal(effects.particles.length, 1);
    assert.equal(effects.particles[0].static, true);
    assert.equal(env.shakes, shakes);
    effects.setIntensity('off'); effects.fire('complete');
    assert.equal(effects.particles.length, 0);
    assert.equal(env.frames.size, 0);
    env.motion(false); effects.setIntensity('max'); effects.fire('complete');
    effects.setTheme('classic');
    assert.equal(effects.particles.length, 0);
    assert.equal(env.frames.size, 0);
    assert.throws(() => effects.setTheme('unknown'), TypeError);
  } finally { env.cleanup(); }
});

test('fever taps add sparkles while audio keeps the same gain and note count', async () => {
  const env = setup();
  try {
    const { effects } = env;
    assert.equal(effects.soundEnabled, false);
    await effects.setSound(true);
    effects.fire('complete');
    const classicGain = effects.masterGain.gain.value;
    const classicNotes = effects.audioNodes.size;
    effects.setTheme('fever'); effects.setIntensity('max'); effects.fire('complete');
    assert.equal(effects.masterGain.gain.value, classicGain);
    assert.equal(effects.audioNodes.size, classicNotes);
    effects.clear(); effects.fire('tap');
    assert.equal(effects.particles.length, 32);
    assert.ok(effects.particles.some(p => p.kind === 'star'));
    assert.ok(effects.particles.some(p => p.kind === 'comet'));
    await effects.setSound(false);
    assert.equal(effects.audioNodes.size, 0);
    effects.destroy();
    assert.equal(env.frames.size, 0);
    assert.equal(effects.particles.length, 0);
  } finally { env.cleanup(); }
});

test('detection replaces celebration with inward warning streaks and markers, then expires', () => {
  const env = setup();
  try {
    const { effects } = env;
    effects.setTheme('fever'); effects.setIntensity('max');
    effects.fire('complete');
    const shakes = env.shakes;
    const center = { x: 700, y: 420 };
    effects.fire('detect', center);
    assert.equal(effects.particles.length, 99);
    assert.equal(env.shakes, shakes);
    const allowed = new Set(['ring', 'attention-streak', 'attention-marker']);
    assert.ok(effects.particles.every(p => allowed.has(p.kind)));
    assert.ok(effects.particles.every(p => ['#FFB83D', '#FF48BD'].includes(p.color)));
    assert.ok(effects.particles.every(p => p.duration < 2.2));
    const streaks = effects.particles.filter(p => p.kind === 'attention-streak');
    assert.equal(streaks.length, 84);
    assert.ok(streaks.every(p => (p.x - center.x) * p.vx + (p.y - center.y) * p.vy < 0));
    assert.equal(env.frames.size, 1);
    env.drain();
    assert.equal(effects.particles.length, 0);
    assert.equal(env.frames.size, 0);
    effects.setTheme('classic'); effects.setIntensity('pop'); effects.fire('detect', center);
    assert.equal(effects.particles.length, 35);
    effects.setIntensity('max'); effects.fire('detect', center);
    assert.equal(effects.particles.length, 67);
    env.motion(true); effects.fire('detect', center);
    assert.equal(effects.particles.length, 1);
    assert.equal(effects.particles[0].static, true);
    assert.equal(effects.particles[0].color, '#FFB83D');
    effects.setIntensity('off'); effects.fire('detect', center);
    assert.equal(effects.particles.length, 0);
    assert.equal(env.frames.size, 0);
  } finally { env.cleanup(); }
});

test('detection plays an opted-in alternating alarm for less than 1.4 seconds at the existing master gain', async () => {
  const env = setup();
  try {
    const { effects } = env;
    effects.fire('detect');
    assert.equal(effects.audioContext, null);
    assert.equal(effects.audioNodes.size, 0);
    await effects.setSound(true);
    effects.fire('complete');
    assert.equal(effects.audioNodes.size, 5);
    const gain = effects.masterGain.gain.value;
    effects.fire('detect');
    assert.equal(effects.audioNodes.size, 6);
    assert.equal(effects.masterGain.gain.value, gain);
    assert.deepEqual([...effects.audioNodes].map(n => n.oscillator.frequency.value), [880, 659.25, 880, 659.25, 987.77, 739.99]);
    assert.ok([...effects.audioNodes].every(n => n.oscillator.type === 'triangle'));
    assert.ok(effects.audioBusyUntil > 1 && effects.audioBusyUntil < 1.4);
    await effects.setSound(false);
    effects.fire('detect');
    assert.equal(effects.audioNodes.size, 0);
  } finally { env.cleanup(); }
});

test('warning sound preempts lower cues, survives visual clearing, and cannot stack with another warning', async () => {
  const env = setup();
  try {
    const { effects } = env;
    await effects.setSound(true);
    effects.playSound('complete');
    const celebration = [...effects.audioNodes];
    effects.playSound('detect');
    assert.ok(celebration.every(n => n.oscillator.stopped));
    const alarm = [...effects.audioNodes];
    for (const type of ['tap', 'press', 'start', 'resume', 'milestone', 'break', 'pause', 'complete', 'notify', 'end']) {
      assert.equal(effects.playSound(type), false, `${type} must not interrupt the warning`);
      assert.deepEqual([...effects.audioNodes], alarm);
    }
    effects.clear({ audio: false });
    effects.fire('detect', { audible: false });
    assert.deepEqual([...effects.audioNodes], alarm);
    effects.fire('pause');
    assert.deepEqual([...effects.audioNodes], alarm);
    effects.playSound('detect');
    assert.ok(alarm.every(n => n.oscillator.stopped));
    assert.equal(effects.audioNodes.size, 6);
    effects.audioContext.currentTime = effects.audioBusyUntil + 0.001;
    assert.equal(effects.playSound('tap'), true);
    assert.equal(effects.audioNodes.size, 1);
    effects.clear();
    assert.equal(effects.audioNodes.size, 0);
  } finally { env.cleanup(); }
});

test('each action has a distinct bounded cue and repeated clicks replace rather than stack notes', async () => {
  const env = setup();
  try {
    const { effects } = env;
    await effects.setSound(true);
    const signatures = new Set();
    for (const type of ['tap', 'press', 'start', 'resume', 'milestone', 'break', 'pause', 'complete', 'notify', 'end', 'detect']) {
      effects.stopAudio();
      assert.equal(effects.playSound(type), true, type);
      const nodes = [...effects.audioNodes];
      assert.ok(nodes.every(n => n.oscillator.startsAt >= 0 && n.oscillator.endsAt < 1.4));
      const signature = JSON.stringify(nodes.map(n => [n.oscillator.frequency.value, n.oscillator.startsAt, n.oscillator.endsAt]));
      assert.ok(!signatures.has(signature), `${type} is distinguishable`);
      signatures.add(signature);
      effects.playSound(type);
      assert.equal(effects.audioNodes.size, nodes.length);
      assert.ok(nodes.every(n => n.oscillator.stopped));
    }
    const count = effects.audioNodes.size;
    assert.equal(effects.playSound('unknown'), false);
    assert.equal(effects.audioNodes.size, count);
    await effects.setSound(false);
    assert.equal(effects.activeSound, null);
    assert.equal(effects.playSound('detect'), false);
    assert.equal(effects.audioNodes.size, 0);
  } finally { env.cleanup(); }
});

test('the first action waits for gesture unlock, preserving warning priority without replaying after sound OFF', async () => {
  const env = setup({ suspended: true });
  try {
    const { effects } = env;
    const unlocking = effects.setSound(true);
    effects.playSound('start');
    effects.playSound('detect');
    effects.playSound('tap');
    assert.equal(effects.audioNodes.size, 0);
    env.unlock();
    assert.equal(await unlocking, true);
    assert.equal(effects.activeSound, 'detect');
    assert.equal(effects.audioNodes.size, 6);
    await effects.setSound(false);
    effects.audioContext.state = 'suspended';
    const cancelledUnlock = effects.setSound(true);
    effects.playSound('detect');
    await effects.setSound(false);
    env.unlock();
    assert.equal(await cancelledUnlock, false);
    assert.equal(effects.soundEnabled, false);
    assert.equal(effects.audioNodes.size, 0);
  } finally { env.cleanup(); }
});

test('press overlays short stars and streaks without clearing prior particles, while remaining bounded', async () => {
  const env = setup();
  try {
    const { effects } = env;
    effects.setIntensity('max');
    effects.fire('notify');
    const prior = effects.particles[0];
    effects.fire('press', { x: 300, y: 400, level: 3 });
    assert.ok(effects.particles.includes(prior));
    const pressed = effects.particles.filter(p => p !== prior);
    assert.ok(pressed.some(p => p.kind === 'star'));
    assert.ok(pressed.some(p => p.kind === 'streak'));
    assert.ok(pressed.every(p => ['star', 'streak', 'ring'].includes(p.kind)));
    assert.ok(pressed.every(p => p.duration >= 0.35 && p.duration <= 0.8));
    assert.equal(effects.audioContext, null);
    await effects.setSound(true);
    const gain = effects.masterGain.gain.value;
    effects.fire('press');
    assert.equal(effects.audioNodes.size, 2);
    assert.equal(effects.masterGain.gain.value, gain);
    for (let i = 0; i < 30; i++) effects.fire('press', { level: 3 });
    assert.equal(effects.particles.length, 220);
    assert.equal(env.frames.size, 1);
    env.drain(1);
    assert.equal(effects.particles.length, 0);
    assert.equal(env.frames.size, 0);
  } finally { env.cleanup(); }
});

test('tap levels increase burst density and ring reach in both themes without changing classic level one', () => {
  const env = setup();
  try {
    const { effects } = env;
    effects.setIntensity('max');
    effects.fire('tap', { level: 1 });
    assert.equal(effects.particles.length, 18);
    for (const theme of ['classic', 'fever']) {
      effects.setTheme(theme);
      let previousCount = 0, previousReach = 0;
      for (const level of [1, 2, 3]) {
        effects.clear(); effects.fire('tap', { level });
        assert.ok(effects.particles.length > previousCount, `${theme} density grows at level ${level}`);
        const reach = Math.max(...effects.particles.filter(p => p.kind === 'ring').map(p => p.expand));
        assert.ok(reach > previousReach, `${theme} ring expands further at level ${level}`);
        if (level > 1) {
          assert.ok(effects.particles.some(p => p.kind === 'comet'));
          assert.ok(effects.particles.every(p => ['star', 'comet', 'ring'].includes(p.kind)));
        }
        previousCount = effects.particles.length;
        previousReach = reach;
      }
    }
    env.motion(true); effects.fire('press', { level: 3 });
    assert.equal(effects.particles.length, 1);
    assert.equal(effects.particles[0].static, true);
    effects.setIntensity('off'); effects.fire('press', { level: 3 });
    assert.equal(effects.particles.length, 0);
  } finally { env.cleanup(); }
});

test('resume gets a colorful second ring but pause still clears to one gentle outline', () => {
  const env = setup();
  try {
    const { effects } = env;
    effects.fire('resume');
    assert.equal(effects.particles.filter(p => p.kind === 'ring').length, 2);
    effects.fire('break');
    assert.equal(effects.particles.filter(p => p.kind === 'ring').length, 2);
    assert.equal(new Set(effects.particles.filter(p => p.kind === 'bubble').map(p => p.color)).size, 4);
    effects.fire('pause');
    assert.equal(effects.particles.length, 1);
    assert.equal(effects.particles[0].kind, 'ring');
    assert.equal(env.shakes, 0);
  } finally { env.cleanup(); }
});
