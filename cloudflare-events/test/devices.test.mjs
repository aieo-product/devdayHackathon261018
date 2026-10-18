import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRegistry, DeviceError } from '../src/devices.mjs';

const START = Date.UTC(2026, 9, 18, 0, 0, 0);
class MemoryStorage {
  data = new Map();
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async list({ prefix }) { return new Map([...this.data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); }
}
function harness() {
  const h = { now: START, storage: new MemoryStorage() };
  h.restart = () => { h.registry = new DeviceRegistry({ storage: h.storage, clock: () => h.now }); };
  h.restart();
  return h;
}
const report = (overrides = {}) => ({ device_id: 'mac_1', device_type: 'mac', name: 'Mac テスト', observed_state: 'off', remote_enabled: true, applied_revision: 0, ...overrides });
const control = (enabled, device_id = 'mac_1') => ({ device_id, enabled });
const rejectsCode = code => error => error instanceof DeviceError && error.code === code && Number.isInteger(error.status);

test('first heartbeat registers a safe OFF default without claiming the camera is off', async () => {
  const h = harness();
  const device = await h.registry.heartbeat('source_a', report({ observed_state: 'on', session_id: 'session_1' }));
  assert.deepEqual(device, {
    device_id: 'mac_1', name: 'Mac テスト', type: 'mac', desired_state: 'off', observed_state: 'on',
    remote_enabled: true, revision: 0, applied_revision: 0, last_seen_at: new Date(START).toISOString(),
    online: true, command_issued_at: null, command_expires_at: null, session_id: 'session_1',
  });
  h.restart();
  assert.deepEqual((await h.registry.list('source_a')).devices, [device]);
  assert.ok([...h.storage.data.keys()].every(key => key.startsWith('devices:')));
});

test('source owners cannot list or control another source, including colliding delimiter identifiers', async () => {
  const h = harness();
  await h.registry.heartbeat('source_a', report());
  assert.deepEqual(await h.registry.list('source_b'), { devices: [] });
  await assert.rejects(h.registry.setDesired('source_b', control(false)), rejectsCode('device_not_found'));
  await h.registry.heartbeat('source_b', report({ name: 'Other Mac', remote_enabled: false }));
  await h.registry.setDesired('source_a', control(true));
  assert.equal((await h.registry.list('source_b')).devices[0].desired_state, 'off');
  assert.equal((await h.registry.list('source_a')).devices[0].name, 'Mac テスト');
  await h.registry.heartbeat('a:b', report({ device_id: 'c' }));
  await h.registry.heartbeat('a', report({ device_id: 'b:c', remote_enabled: false }));
  assert.equal((await h.registry.list('a:b')).devices[0].remote_enabled, true);
  assert.equal((await h.registry.list('a')).devices[0].remote_enabled, false);
});

test('remote ON requires a fresh heartbeat and local permission; OFF remains available', async () => {
  const h = harness();
  await h.registry.heartbeat('source_a', report({ remote_enabled: false, observed_state: 'on' }));
  await assert.rejects(h.registry.setDesired('source_a', control(true)), rejectsCode('remote_disabled'));
  assert.equal((await h.registry.list('source_a')).devices[0].revision, 0);
  h.now += 10_001;
  await assert.rejects(h.registry.setDesired('source_a', control(true)), rejectsCode('device_offline'));
  const off = await h.registry.setDesired('source_a', control(false));
  assert.equal(off.desired_state, 'off');
  assert.equal(off.observed_state, 'on', 'OFF is pending until the device confirms stopping');
  assert.equal(off.revision, 1);
  assert.equal(off.applied_revision, 0);
  assert.equal(off.online, false);
  assert.equal(off.command_expires_at, null);
  h.now += 500_000;
  assert.equal((await h.registry.list('source_a')).devices[0].revision, 1, 'OFF does not expire');
  const acknowledged = await h.registry.heartbeat('source_a', report({ remote_enabled: false, applied_revision: 1 }));
  assert.equal(acknowledged.observed_state, 'off');
  assert.equal(acknowledged.applied_revision, 1);
});

test('online boundary is inclusive at ten seconds and recovers with a heartbeat', async () => {
  const h = harness();
  await h.registry.heartbeat('source_a', report());
  h.now += 10_000;
  assert.equal((await h.registry.list('source_a')).devices[0].online, true);
  assert.equal((await h.registry.setDesired('source_a', control(true))).revision, 1);
  h.now += 1;
  assert.equal((await h.registry.list('source_a')).devices[0].online, false);
  await assert.rejects(h.registry.setDesired('source_a', control(true)), rejectsCode('device_offline'));
  const fresh = await h.registry.heartbeat('source_a', report());
  assert.equal(fresh.online, true);
  assert.equal(fresh.last_seen_at, new Date(h.now).toISOString());
});

test('every command gets a distinct revision even when the desired state repeats', async () => {
  const h = harness();
  await h.registry.heartbeat('source_a', report());
  for (const [index, enabled] of [true, true, false, false, true].entries()) {
    const result = await h.registry.setDesired('source_a', control(enabled));
    assert.equal(result.revision, index + 1);
    assert.equal(result.desired_state, enabled ? 'on' : 'off');
    assert.equal(result.command_issued_at, new Date(h.now).toISOString());
    assert.equal(result.command_expires_at, enabled ? new Date(h.now + 120_000).toISOString() : null);
  }
});

test('late lower acknowledgements cannot overwrite a newer observed or armed state', async () => {
  const h = harness();
  await h.registry.heartbeat('source_a', report());
  await h.registry.setDesired('source_a', control(true));
  await h.registry.heartbeat('source_a', report({ applied_revision: 1, observed_state: 'on', session_id: 'live' }));
  await h.registry.setDesired('source_a', control(false));
  const off = await h.registry.heartbeat('source_a', report({ applied_revision: 2, remote_enabled: false }));
  h.now += 2000;
  const stale = await h.registry.heartbeat('source_a', report({ applied_revision: 1, observed_state: 'on', name: 'Stale', session_id: 'old' }));
  assert.deepEqual(stale, { ...off, last_seen_at: new Date(h.now).toISOString() });
});

test('a delayed ON acknowledgement never overwrites a newer OFF command', async () => {
  const h = harness();
  await h.registry.heartbeat('source_a', report());
  await h.registry.setDesired('source_a', control(true));
  await h.registry.setDesired('source_a', control(false));
  const result = await h.registry.heartbeat('source_a', report({ applied_revision: 1, observed_state: 'on' }));
  assert.equal(result.desired_state, 'off');
  assert.equal(result.revision, 2);
  assert.equal(result.applied_revision, 1);
  assert.equal(result.observed_state, 'on');
});

test('future acknowledgements are rejected without registration or state changes', async () => {
  const h = harness();
  await assert.rejects(h.registry.heartbeat('source_a', report({ applied_revision: 1 })), rejectsCode('future_revision'));
  assert.equal(h.storage.data.size, 0);
  await h.registry.heartbeat('source_a', report());
  await h.registry.setDesired('source_a', control(true));
  const before = await h.registry.list('source_a');
  await assert.rejects(h.registry.heartbeat('source_a', report({ applied_revision: 2, observed_state: 'on' })), rejectsCode('future_revision'));
  assert.deepEqual(await h.registry.list('source_a'), before);
});

test('unacknowledged ON expires at 120 seconds and becomes a pending OFF revision', async () => {
  const h = harness();
  await h.registry.heartbeat('source_a', report());
  await h.registry.setDesired('source_a', control(true));
  h.now += 119_999;
  assert.equal((await h.registry.list('source_a')).devices[0].desired_state, 'on');
  h.now += 1;
  const expired = (await h.registry.list('source_a')).devices[0];
  assert.equal(expired.desired_state, 'off');
  assert.equal(expired.revision, 2);
  assert.equal(expired.applied_revision, 0);
  assert.equal(expired.command_issued_at, new Date(h.now).toISOString());
  assert.equal(expired.command_expires_at, null);
  h.restart();
  assert.deepEqual((await h.registry.list('source_a')).devices[0], expired);
});

test('an acknowledgement arriving at expiry cannot rescue an expired ON', async () => {
  const h = harness();
  await h.registry.heartbeat('source_a', report());
  await h.registry.setDesired('source_a', control(true));
  h.now += 120_000;
  const late = await h.registry.heartbeat('source_a', report({ applied_revision: 1, observed_state: 'on' }));
  assert.equal(late.desired_state, 'off');
  assert.equal(late.revision, 2);
  assert.equal(late.observed_state, 'on', 'reporting ON does not claim the safety OFF already succeeded');
  assert.equal(late.applied_revision, 1);
});

test('acknowledged ON remains applied beyond its delivery timeout', async () => {
  const h = harness();
  await h.registry.heartbeat('source_a', report());
  await h.registry.setDesired('source_a', control(true));
  h.now += 119_999;
  const applied = await h.registry.heartbeat('source_a', report({ applied_revision: 1, observed_state: 'on' }));
  assert.equal(applied.command_expires_at, null);
  h.now += 500_000;
  const later = (await h.registry.list('source_a')).devices[0];
  assert.equal(later.desired_state, 'on');
  assert.equal(later.revision, 1);
  assert.equal(later.online, false, 'an applied command is not a guarantee the device is still reachable');
});

test('local disarm revokes pending or applied ON and re-arming does not resurrect it', async () => {
  for (const acknowledged of [false, true]) {
    const h = harness();
    await h.registry.heartbeat('source_a', report());
    await h.registry.setDesired('source_a', control(true));
    if (acknowledged) await h.registry.heartbeat('source_a', report({ applied_revision: 1, observed_state: 'on' }));
    const disarmed = await h.registry.heartbeat('source_a', report({ applied_revision: acknowledged ? 1 : 0, remote_enabled: false, observed_state: acknowledged ? 'on' : 'off' }));
    assert.equal(disarmed.desired_state, 'off');
    assert.equal(disarmed.revision, 2);
    assert.equal(disarmed.command_expires_at, null);
    assert.equal(disarmed.observed_state, acknowledged ? 'on' : 'off');
    const rearmed = await h.registry.heartbeat('source_a', report({ applied_revision: 2 }));
    assert.equal(rearmed.desired_state, 'off');
    assert.equal(rearmed.revision, 2);
    assert.equal((await h.registry.setDesired('source_a', control(true))).revision, 3);
  }
});

test('processed blocked/error commands never claim monitoring is on or silently retry', async () => {
  for (const observed_state of ['blocked', 'error']) {
    const h = harness();
    await h.registry.heartbeat('source_a', report());
    await h.registry.setDesired('source_a', control(true));
    const processed = await h.registry.heartbeat('source_a', report({ applied_revision: 1, observed_state }));
    assert.equal(processed.observed_state, observed_state);
    assert.equal(processed.applied_revision, 1);
    assert.equal(processed.revision, 1);
    assert.equal(processed.command_expires_at, null);
    assert.equal(processed.desired_state, 'on', 'desired ON and a blocked/error observation remain distinct');
    assert.equal((await h.registry.setDesired('source_a', control(true))).revision, 2, 'explicit retry gets a fresh command');
  }
});

test('validation rejects client-controlled command fields, coercion and oversized values', async () => {
  const h = harness();
  for (const override of [
    { desired_state: 'on' }, { revision: 7 }, { command_expires_at: null },
    { device_id: '' }, { device_type: 'Mac space' }, { remote_enabled: 'true' },
    { observed_state: 'unknown' }, { applied_revision: -1 }, { applied_revision: 0.5 },
    { applied_revision: Number.MAX_SAFE_INTEGER + 1 }, { name: 'x'.repeat(81) }, { name: '\n' },
    { session_id: {} },
  ]) await assert.rejects(h.registry.heartbeat('source_a', report(override)), rejectsCode('invalid_device_request'));
  await assert.rejects(h.registry.list('../source'), rejectsCode('invalid_device_request'));
  await h.registry.heartbeat('source_a', report());
  await assert.rejects(h.registry.setDesired('source_a', { ...control(true), revision: 9 }), rejectsCode('invalid_device_request'));
  await assert.rejects(h.registry.setDesired('source_a', control('false')), rejectsCode('invalid_device_request'));
});

test('concurrent registration respects twenty devices per source and two hundred globally', async () => {
  const h = harness();
  const first = await Promise.allSettled(Array.from({ length: 21 }, (_, index) => h.registry.heartbeat('source_0', report({ device_id: `mac_${index}` }))));
  assert.equal(first.filter(item => item.status === 'fulfilled').length, 20);
  assert.equal(first.filter(item => item.status === 'rejected' && item.reason.code === 'device_capacity').length, 1);
  const remaining = await Promise.allSettled(Array.from({ length: 200 }, (_, index) => h.registry.heartbeat(`source_${1 + Math.floor(index / 20)}`, report({ device_id: `mac_${index}` }))));
  assert.equal(remaining.filter(item => item.status === 'fulfilled').length, 180);
  assert.equal(remaining.filter(item => item.status === 'rejected' && item.reason.code === 'device_capacity').length, 20);
  assert.equal(h.storage.data.size, 200);
  await h.registry.heartbeat('source_0', report({ device_id: 'mac_0', name: 'Still updates' }));
  assert.equal((await h.registry.list('source_0')).devices.length, 20);
});

test('serialized concurrent controls preserve every revision and recover after a rejected action', async () => {
  const h = harness();
  await h.registry.heartbeat('source_a', report());
  const controls = Array.from({ length: 12 }, (_, index) => h.registry.setDesired('source_a', control(index % 2 === 0)));
  const results = await Promise.all(controls);
  assert.deepEqual(results.map(value => value.revision), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal((await h.registry.list('source_a')).devices[0].desired_state, 'off');
  await assert.rejects(h.registry.setDesired('source_a', control(false, 'missing')), rejectsCode('device_not_found'));
  assert.equal((await h.registry.setDesired('source_a', control(false))).revision, 13);
});
