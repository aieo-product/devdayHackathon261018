import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createDesktopOverlayBridge } from '../desktop-overlay-bridge.mjs';

async function fixture(t) {
  let time = 10_000;
  const token = 'synthetic-native-overlay-credential';
  const bridge = createDesktopOverlayBridge({ token, now: () => time });
  const server = http.createServer(async (req, res) => {
    if (!await bridge.handle(req, res, new URL(req.url, 'http://localhost').pathname)) {
      res.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    bridge.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/desktop-overlay${route}`, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, text, data: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (Array.isArray(body)) { for (const chunk of body) req.write(chunk); req.end(); }
    else req.end(body);
  });
  const detect = { action: 'detect', sourceId: 'tab-a', character: 'cloud', message: 'いまの作業に戻ろう！', kind: 'detect', intensity: 'max', reduced: false };
  const cue = (body = detect, headers = {}) => request('/cue', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const poll = (after = 0) => request(`/native/poll?after=${after}`, { headers: { Authorization: `Bearer ${token}` } });
  return { bridge, token, base, request, cue, poll, detect, advance(ms) { time += ms; } };
}

test('native heartbeat gates delivery and polling returns each event by sequence', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/status')).data, { connected: false });
  assert.deepEqual((await f.cue()).data, { delivered: false, sequence: 0 });
  assert.deepEqual((await f.poll()).data, { event: null, sequence: 0 });
  assert.deepEqual((await f.request('/status')).data, { connected: true });
  assert.deepEqual((await f.cue()).data, { delivered: true, sequence: 1 });
  const response = await f.poll();
  assert.deepEqual(response.data, { sequence: 1, event: { ...f.detect, sequence: 1, createdAt: 10_000 } });
  assert.deepEqual((await f.poll(1)).data, { sequence: 1, event: null });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.text.includes(f.token), false);
  f.advance(4000);
  assert.deepEqual((await f.request('/status')).data, { connected: false });
  assert.deepEqual((await f.cue()).data, { delivered: false, sequence: 1 });
});

test('events expire without a durable queue and only the latest cue is retained', async t => {
  const f = await fixture(t);
  await f.poll();
  await f.cue();
  await f.cue({ ...f.detect, sourceId: 'tab-b', message: 'Second cue' });
  assert.equal((await f.poll()).data.event.sourceId, 'tab-b');
  f.advance(6000);
  assert.deepEqual((await f.poll()).data, { event: null, sequence: 2 });
  assert.deepEqual((await f.cue({ ...f.detect, reduced: true })).data, { delivered: false, sequence: 2 });
  assert.deepEqual((await f.cue({ ...f.detect, intensity: 'off' })).data, { delivered: false, sequence: 2 });
  assert.deepEqual((await f.poll()).data, { event: null, sequence: 2 });
});

test('clearing another source cannot cancel the current detection', async t => {
  const f = await fixture(t);
  await f.poll();
  await f.cue();
  assert.deepEqual((await f.cue({ action: 'clear', sourceId: 'tab-b' })).data, { delivered: false, sequence: 1 });
  assert.equal((await f.poll()).data.event.action, 'detect');
  assert.deepEqual((await f.cue({ action: 'clear', sourceId: 'tab-a' })).data, { delivered: true, sequence: 2 });
  const event = (await f.poll(1)).data.event;
  assert.equal(event.action, 'clear');
  assert.equal(event.sourceId, 'tab-a');
  assert.equal(event.character, 'cloud');
  assert.equal(event.message, '');
  f.advance(6000);
  await f.poll(2);
  assert.deepEqual((await f.cue({ action: 'clear', sourceId: 'tab-b' })).data, { delivered: true, sequence: 3 });
});

test('source revisions reject late requests even after a suppressed detection', async t => {
  const f = await fixture(t);
  await f.poll();
  assert.deepEqual((await f.cue({ action: 'clear', sourceId: 'tab-a', revision: 2 })).data, { delivered: true, sequence: 1 });
  assert.deepEqual((await f.cue({ ...f.detect, revision: 1 })).data, { delivered: false, sequence: 1 });
  assert.equal((await f.poll()).data.event.action, 'clear');
  assert.deepEqual((await f.cue({ ...f.detect, revision: 3 })).data, { delivered: true, sequence: 2 });
  assert.deepEqual((await f.cue({ ...f.detect, revision: 3 })).data, { delivered: false, sequence: 2 });
  assert.deepEqual((await f.cue({ ...f.detect, revision: 5, intensity: 'off' })).data, { delivered: false, sequence: 2 });
  assert.deepEqual((await f.cue({ ...f.detect, revision: 4 })).data, { delivered: false, sequence: 2 });
  assert.deepEqual((await f.cue({ ...f.detect, revision: 7, reduced: true })).data, { delivered: false, sequence: 2 });
  assert.deepEqual((await f.cue({ ...f.detect, revision: 6 })).data, { delivered: false, sequence: 2 });
  f.advance(6000);
  assert.deepEqual((await f.cue({ ...f.detect, revision: 9 })).data, { delivered: false, sequence: 2 });
  await f.poll();
  assert.deepEqual((await f.cue({ ...f.detect, revision: 8 })).data, { delivered: false, sequence: 2 });
  assert.deepEqual((await f.cue({ ...f.detect, revision: 10 })).data, { delivered: true, sequence: 3 });
  assert.deepEqual((await f.cue({ ...f.detect, sourceId: 'tab-b', revision: 1 })).data, { delivered: true, sequence: 4 });
});

test('native polling requires authentication and malformed polling does not create a heartbeat', async t => {
  const f = await fixture(t);
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: f.token }]) {
    assert.equal((await f.request('/native/poll', { headers })).status, 401);
  }
  for (const query of ['after=-1', 'after=1.5', 'after=NaN', 'after=9007199254740992', 'after=0&after=1', 'other=0']) {
    assert.equal((await f.request(`/native/poll?${query}`, { headers: { Authorization: `Bearer ${f.token}` } })).status, 400);
  }
  assert.deepEqual((await f.request('/status')).data, { connected: false });
  assert.equal((await f.poll()).status, 200);
});

test('browser mutations require same origin and valid loopback Host', async t => {
  const f = await fixture(t);
  const body = JSON.stringify(f.detect);
  for (const headers of [
    {}, { Origin: 'https://outside.example' }, { Origin: 'null' },
    { Origin: `${f.base}.outside.example` },
    { Origin: f.base, 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'https://outside.example', 'Sec-Fetch-Site': 'same-origin' },
  ]) {
    assert.equal((await f.request('/cue', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })).status, 403);
  }
  assert.equal((await f.request('/cue', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body })).status, 200);
  const localhost = f.base.replace('127.0.0.1', 'localhost');
  assert.equal((await f.cue(f.detect, { Host: new URL(localhost).host, Origin: localhost })).status, 200);
  for (const Host of ['outside.example', 'localhost:1', '127.0.0.1:1', 'localhost', '[::1]:1234']) {
    assert.equal((await f.request('/status', { headers: { Host } })).status, 403);
  }
  assert.deepEqual((await f.request('/status')).data, { connected: false });
});

test('cue body is bounded for declared and chunked lengths and validates fields', async t => {
  const f = await fixture(t);
  const headers = { Origin: f.base, 'Content-Type': 'application/json' };
  assert.equal((await f.request('/cue', { method: 'POST', headers: { ...headers, 'Content-Length': 4097 }, body: 'x'.repeat(4097) })).status, 413);
  assert.equal((await f.request('/cue', { method: 'POST', headers, body: ['x'.repeat(2048), 'x'.repeat(2049)] })).status, 413);
  assert.equal((await f.request('/cue', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await f.request('/cue', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  for (const body of [
    null, [], {}, { ...f.detect, action: 'execute' }, { ...f.detect, sourceId: '' },
    { ...f.detect, sourceId: 'x'.repeat(81) }, { ...f.detect, message: 'x'.repeat(501) },
    { ...f.detect, character: 'other' }, { ...f.detect, kind: 'other' },
    { ...f.detect, intensity: 'other' }, { ...f.detect, reduced: 'false' },
    { ...f.detect, revision: 0 }, { ...f.detect, revision: -1 }, { ...f.detect, revision: 1.5 },
    { ...f.detect, revision: '1' }, { ...f.detect, revision: Number.MAX_SAFE_INTEGER + 1 },
    { action: 'clear', sourceId: 'tab-a', revision: null },
  ]) assert.equal((await f.cue(body)).status, 400);
  assert.equal((await f.cue({ ...f.detect, sourceId: 'x'.repeat(80), message: 'x'.repeat(500) })).status, 200);
});

test('route methods are constrained, unmatched paths fall through, and dispose stops delivery', async t => {
  const f = await fixture(t);
  for (const [route, method, allow] of [['/status', 'POST', 'GET'], ['/cue', 'GET', 'POST'], ['/native/poll', 'POST', 'GET']]) {
    const result = await f.request(route, { method });
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, allow);
  }
  assert.equal((await f.request('/anything')).status, 404);
  assert.equal((await f.request('/status?other=1')).status, 400);
  await f.poll();
  f.bridge.dispose();
  assert.equal((await f.cue()).status, 503);
  assert.equal((await f.poll()).status, 503);
});
