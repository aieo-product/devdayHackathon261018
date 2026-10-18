import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DesktopOverlayClient } from '../desktop-overlay-client.js';
import { createDesktopOverlayBridge } from '../desktop-overlay-bridge.mjs';

const notice = { character: 'cloud', message: 'いまの作業に戻ろう！', kind: 'detect', intensity: 'max', reduced: false };
const response = (body, ok = true) => ({ ok, json: async () => body });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('connection and delivery failures return false so the caller can use browser fallback', async () => {
  for (const fetchImpl of [
    async () => { throw new TypeError('Network unavailable'); },
    async () => response({}, false),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } }),
  ]) {
    const client = new DesktopOverlayClient({ fetchImpl, sourceId: 'fallback-tab' });
    client.connected = true;
    assert.equal(await client.refresh(), false);
    assert.equal(client.connected, false);
    client.connected = true;
    assert.equal(await client.show(notice), false);
    assert.equal(client.connected, false);
  }
  let fail = true;
  const client = new DesktopOverlayClient({ sourceId: 'retry-tab', fetchImpl: async () => {
    if (fail) throw new TypeError('Disconnected');
    return response({ delivered: true });
  } });
  assert.equal(await client.show(notice), false);
  fail = false;
  assert.equal(await client.show(notice), true);
});

test('normal clear reaches the bridge before a delayed detect and prevents a late native notification', async () => {
  const pending = deferred();
  const calls = [];
  const bridge = createDesktopOverlayBridge({ token: 'synthetic-stop-test-credential', now: () => 1000 });
  async function deliver(pathname, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, {
      method: body === undefined ? 'GET' : 'POST', url: pathname, socket: { localPort: 4327 },
      headers: { host: '127.0.0.1:4327', origin: 'http://127.0.0.1:4327',
        'content-type': 'application/json', authorization: 'Bearer synthetic-stop-test-credential' },
    });
    let status, payload;
    await bridge.handle(req, {
      writeHead(value) { status = value; return this; },
      end(value) { payload = value; },
    }, pathname);
    return response(JSON.parse(payload), status >= 200 && status < 300);
  }
  const poll = () => deliver('/api/desktop-overlay/native/poll').then(result => result.json());
  await poll(); // Mark the synthetic native receiver connected without opening a server or app.
  const client = new DesktopOverlayClient({ sourceId: 'stopping-tab', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.action === 'detect') await pending.promise;
    return deliver(url, body);
  } });
  const showing = client.show(notice);
  await Promise.resolve();
  assert.deepEqual(calls.map(body => body.action), ['detect']);
  let cleared;
  try {
    const clearing = client.clear();
    assert.deepEqual(calls.map(body => [body.action, body.revision]), [['detect', 1], ['clear', 2]],
      'normal stop must dispatch immediately instead of waiting for the old response');
    await clearing;
    cleared = await poll();
    assert.equal(cleared.event.action, 'clear');
  } finally { pending.resolve(); }
  assert.equal(await showing, false);
  assert.deepEqual(await poll(), cleared, 'the older detect must not replace the native clear event');
  assert.equal(calls.every(body => body.sourceId === 'stopping-tab'), true);
});

test('a canceled queued show is never sent after a newer clear', async () => {
  const pending = deferred();
  const calls = [];
  const client = new DesktopOverlayClient({ sourceId: 'queued-tab', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return calls.length === 1 ? pending.promise : response({ delivered: true });
  } });
  const first = client.show(notice);
  await Promise.resolve();
  const queued = client.show({ ...notice, message: 'This canceled cue must not appear.' });
  const clearing = client.clear();
  pending.resolve(response({ delivered: true }));
  assert.equal(await first, false);
  assert.equal(await queued, false);
  await clearing;
  assert.deepEqual(calls.map(body => [body.action, body.revision]), [['detect', 1], ['clear', 3]]);
  assert.equal(calls.some(body => body.message?.includes('canceled')), false);
});

test('page-exit clear dispatches immediately with a newer revision and keepalive', async () => {
  const pending = deferred();
  const calls = [];
  const client = new DesktopOverlayClient({ sourceId: 'leaving-tab', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ body, options });
    return body.action === 'detect' ? pending.promise : response({ delivered: true });
  } });
  const showing = client.show(notice);
  await Promise.resolve();
  const clearing = client.clear({ keepalive: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { action: 'clear', sourceId: 'leaving-tab', revision: 2 });
  assert.equal(calls[1].options.keepalive, true);
  assert.equal('signal' in calls[1].options, false);
  await clearing;
  pending.resolve(response({ delivered: true }));
  assert.equal(await showing, false);
});

test('browser transport sends only bounded visual fields and no native or shared-API credentials', async () => {
  const calls = [];
  const client = new DesktopOverlayClient({
    sourceId: 'public-tab-id',
    token: 'synthetic-native-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(url.endsWith('/status') ? { connected: true, token: 'ignored-server-extra' } : { delivered: true });
    },
  });
  assert.equal(await client.refresh(), true);
  assert.equal(await client.show({ ...notice, message: 'x'.repeat(800), cameraFrame: 'private-frame', apiToken: 'synthetic-api-secret' }), true);
  await client.clear();
  assert.deepEqual(calls.map(call => call.url), ['/api/desktop-overlay/status', '/api/desktop-overlay/cue', '/api/desktop-overlay/cue']);
  assert.equal(calls[0].options.cache, 'no-store');
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.message.length, 500);
  assert.deepEqual(Object.keys(body).sort(), ['action', 'sourceId', 'revision', 'character', 'message', 'kind', 'intensity', 'reduced'].sort());
  for (const call of calls) {
    assert.equal(call.options.headers?.Authorization, undefined);
    assert.equal(call.options.headers?.authorization, undefined);
  }
  const serialized = JSON.stringify(calls);
  for (const secret of ['synthetic-native-secret', 'synthetic-api-secret', 'private-frame', 'ignored-server-extra']) {
    assert.equal(serialized.includes(secret), false);
  }
  const another = new DesktopOverlayClient({ fetchImpl: async () => response({}) });
  const other = new DesktopOverlayClient({ fetchImpl: async () => response({}) });
  assert.notEqual(another.sourceId, other.sourceId);
});
