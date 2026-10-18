import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FocusClient } from './focus-client.mjs';
import { createApp } from '../api/src/server.mjs';
import { FocusEngine } from '../api/src/engine.mjs';

const image = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jyaUAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' });
const snapshot = (patch = {}) => ({ session_id: 'test-session', state: 'observing', notify: false,
  notification_id: null, message: null, phone_probability: null, observable_probability: null,
  consecutive_count: 0, continuous_hold_ms: 0, required_hold_ms: 2000,
  cooldown_remaining_ms: 0, next_capture_after_ms: 0, provider: 'mock', reason: 'test', ...patch });
const response = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('default fetch keeps the global receiver required by browser fetch', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  // Native Window.fetch rejects a class instance as its receiver; Node fetch does not.
  globalThis.fetch = async function (url, options) {
    assert.equal(this, globalThis, 'fetch must be called with the browser global receiver');
    requests.push(url);
    return response(snapshot({ state: url.endsWith('/control') ? 'ended' : 'observing' }));
  };
  try {
    const client = new FocusClient({ baseUrl: 'https://api.example.test', token: 'test-only-token' });
    await client.start();
    assert.equal(client.active, true);
    assert.equal((await client.frame(image)).state, 'observing');
    assert.equal((await client.end()).state, 'ended');
    assert.equal(requests.length, 3, 'session creation, image upload and end all use the bound fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('thin client works against real HTTP app: notification, duplicate, pause, resume and end', async (t) => {
  let calls = 0;
  let now = 0;
  const engine = new FocusEngine({
    provider: { name: 'mock', configured: true, async decide() { calls += 1; return { phoneProbability: 0.99, observableProbability: 1 }; } },
    clock: () => now,
  });
  const server = createApp({ config: { apiToken: 'test-only-token' }, engine });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const client = new FocusClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test-only-token' });
  await client.start({ deviceType: 'mac' });
  assert.equal(client.active, true);
  for (now = 0; now < 2000; now += 1000) {
    const pending = await client.frame(image);
    assert.equal(pending.notify, false);
    assert.equal(pending.continuous_hold_ms, now);
    assert.equal(pending.required_hold_ms, 2000);
  }
  const confirmed = await client.frame(image, { frameId: 'confirmed' });
  assert.equal(confirmed.notify, true);
  assert.equal(confirmed.continuous_hold_ms, 2000);
  assert.ok(confirmed.notification_id);
  assert.equal((await client.frame(image, { frameId: 'confirmed' })).notify, false);
  assert.equal(calls, 3);
  assert.equal((await client.pause()).state, 'paused');
  assert.equal(client.active, false);
  assert.equal(await client.frame(image), null);
  assert.equal((await client.resume()).state, 'observing');
  assert.equal(client.active, true);
  assert.equal((await client.end()).state, 'ended');
  assert.equal(client.active, false);
  assert.equal(await client.frame(image), null);
});

test('STOP aborts a pending frame and drops even a transport that returns a late notification', async () => {
  let resolveFrame;
  let frameSignal;
  const client = new FocusClient({ baseUrl: 'https://api.example.test', token: 'test-only-token',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/frames')) {
        frameSignal = options.signal;
        return new Promise((resolve) => { resolveFrame = resolve; });
      }
      if (url.endsWith('/control')) return response(snapshot({ state: JSON.parse(options.body).action === 'end' ? 'ended' : 'paused' }));
      return response(snapshot());
    },
  });
  await client.start();
  const pending = client.frame(image);
  assert.equal(await client.frame(image), null, 'overlapping frame is skipped');
  const stopping = client.pause();
  assert.equal(client.active, false, 'local capture stops before server reply');
  assert.equal(frameSignal.aborted, true);
  await stopping;
  resolveFrame(response(snapshot({ notify: true, notification_id: 'late', message: 'ignored' })));
  assert.equal(await pending, null);
  assert.equal(client.snapshot.state, 'paused');
  await client.end();
});

test('end during session creation prevents activation and closes the newly created session', async () => {
  let resolveCreate;
  const actions = [];
  const client = new FocusClient({ baseUrl: 'https://api.example.test', token: 'test-only-token',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/sessions')) return new Promise((resolve) => { resolveCreate = resolve; });
      actions.push(JSON.parse(options.body).action);
      return response(snapshot({ state: 'ended' }));
    },
  });
  const starting = client.start();
  await Promise.resolve();
  const stopping = client.end();
  resolveCreate(response(snapshot()));
  assert.equal(await starting, null);
  assert.equal((await stopping).state, 'ended');
  assert.deepEqual(actions, ['end']);
  assert.equal(client.active, false);
});

test('a failed pause still stops locally and preserves an error for the UI', async () => {
  const client = new FocusClient({ baseUrl: 'https://api.example.test', token: 'test-only-token',
    fetchImpl: async (url) => {
      if (url.endsWith('/control')) throw new TypeError('network unavailable');
      return response(snapshot());
    },
  });
  await client.start();
  await assert.rejects(client.pause(), /network unavailable/);
  assert.equal(client.active, false);
  assert.equal(await client.frame(image), null);
});

test('local duration stops capture without needing another API response', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const client = new FocusClient({ baseUrl: 'https://api.example.test', token: 'test-only-token', fetchImpl: async () => response(snapshot({ continuous_hold_ms: 1000 })) });
  await client.start({ durationSeconds: 1 });
  assert.equal(client.active, true);
  t.mock.timers.tick(1001);
  assert.equal(client.active, false);
  assert.equal(client.snapshot.state, 'ended');
  assert.equal(client.snapshot.continuous_hold_ms, 0);
  assert.equal(await client.frame(image), null);
});

test('a start response arriving after local expiry still permits starting a fresh session', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let creates = 0;
  const client = new FocusClient({ baseUrl: 'https://api.example.test', token: 'test-only-token',
    fetchImpl: async () => {
      creates += 1;
      if (creates === 1) t.mock.timers.tick(1500);
      return response(snapshot({ session_id: `session-${creates}` }));
    },
  });
  assert.equal(await client.start({ durationSeconds: 1 }), null);
  assert.equal(client.snapshot.state, 'ended');
  assert.equal(client.active, false);
  assert.equal((await client.start()).session_id, 'session-2');
  assert.equal(client.active, true);
  t.mock.timers.tick(1500_001);
});
