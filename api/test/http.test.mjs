import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.mjs';
import { FocusEngine } from '../src/engine.mjs';

const TOKEN = 'test-token';
const ORIGIN = 'http://localhost:3000';
const MAX_IMAGE_BYTES = 1024 * 1024;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jyaUAAAAASUVORK5CYII=',
  'base64',
);
// A real, one-pixel JPEG, generated with Pillow; no image package is needed by tests.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
);

async function fixture(t) {
  const calls = [];
  const provider = {
    name: 'mock',
    configured: true,
    async decide(input) {
      calls.push(input);
      return { phoneProbability: 0, observableProbability: 1 };
    },
  };
  const server = createApp({
    config: {
      apiToken: TOKEN,
      provider: 'mock',
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: [ORIGIN],
      maxImageBytes: MAX_IMAGE_BYTES,
    },
    engine: new FocusEngine({ provider }),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(base + path, options);
  const authenticated = (path, options = {}) => request(path, {
    ...options,
    headers: { Authorization: `Bearer ${TOKEN}`, ...options.headers },
  });
  const json = (path, body) => authenticated(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const start = async () => {
    const response = await json('/v1/sessions', {
      device_type: 'mac', duration_seconds: 1500,
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(typeof body.session_id, 'string');
    assert.ok(body.session_id.length > 0);
    assert.equal(body.continuous_hold_ms, 0);
    assert.equal(body.required_hold_ms, 2000);
    return body.session_id;
  };
  const frame = (id, frameId, body = PNG, contentType = 'image/png') => authenticated(
    `/v1/sessions/${id}/frames`,
    {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'X-Frame-Id': frameId },
      body,
    },
  );
  return { request, authenticated, json, start, frame, calls, base, server };
}

test('health is public, but every session operation requires a valid token even in mock mode', async (t) => {
  const api = await fixture(t);
  const health = await api.request('/health');
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.provider, 'mock');
  assert.equal(healthBody.configured, true);
  assert.ok(!JSON.stringify(healthBody).includes(TOKEN));

  const id = await api.start();
  const operations = [
    ['POST', '/v1/sessions', 'application/json', '{"device_type":"mac","duration_seconds":1500}'],
    ['GET', `/v1/sessions/${id}`],
    ['POST', `/v1/sessions/${id}/frames`, 'image/png', PNG],
    ['POST', `/v1/sessions/${id}/control`, 'application/json', '{"action":"pause"}'],
  ];
  for (const token of [undefined, 'wrong-token']) {
    for (const [method, path, contentType, body] of operations) {
      const headers = { 'X-Frame-Id': 'auth-check' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (contentType) headers['Content-Type'] = contentType;
      const response = await api.request(path, { method, headers, body });
      assert.equal(response.status, 401, `${method} ${path} with ${token ?? 'no token'}`);
      await response.arrayBuffer();
    }
  }
  assert.equal(api.calls.length, 0, 'unauthorized images must never reach the provider');
});

test('CORS allows only an exact configured origin and supports authenticated image preflights', async (t) => {
  const api = await fixture(t);
  const preflight = await api.request('/v1/sessions', {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,x-frame-id',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  const headers = preflight.headers.get('access-control-allow-headers')?.toLowerCase() ?? '';
  for (const required of ['authorization', 'content-type', 'x-frame-id']) {
    assert.ok(headers.split(',').map((part) => part.trim()).includes(required), required);
  }
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);

  for (const origin of ['http://localhost:30000', 'http://localhost:3000.attacker.example', 'null']) {
    const response = await api.request('/health', { headers: { Origin: origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), null, origin);
    await response.arrayBuffer();
  }
  const allowed = await api.request('/health', { headers: { Origin: ORIGIN } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
  await allowed.arrayBuffer();
});

test('malformed JSON, invalid session types, and unsupported control actions are rejected', async (t) => {
  const api = await fixture(t);
  const broken = await api.authenticated('/v1/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(broken.status, 400);
  await broken.arrayBuffer();
  for (const body of [
    null,
    [],
    'mac',
    { device_type: 7, duration_seconds: 1500 },
    { device_type: 'device with spaces', duration_seconds: 1500 },
    { device_type: 'mac', duration_seconds: '1500' },
    { device_type: 'mac', duration_seconds: -1 },
    { device_type: 'mac', duration_seconds: 0 },
    { device_type: 'mac', duration_seconds: 1.5 },
  ]) {
    const response = await api.json('/v1/sessions', body);
    assert.equal(response.status, 400, `invalid session body: ${JSON.stringify(body)}`);
    await response.arrayBuffer();
  }
  const id = await api.start();
  for (const body of [null, [], { action: 'delete-everything' }, { action: 1 }]) {
    const response = await api.json(`/v1/sessions/${id}/control`, body);
    assert.equal(response.status, 400, `invalid control body: ${JSON.stringify(body)}`);
    await response.arrayBuffer();
  }
});

test('image MIME and signatures must agree, and frames need an id before inference', async (t) => {
  const api = await fixture(t);
  const id = await api.start();
  for (const [body, mime, expected] of [
    [PNG, 'text/plain', 415],
    [PNG, 'image/jpeg', 400],
    [JPEG, 'image/png', 400],
    [Buffer.from('not an image'), 'image/png', 400],
    [Buffer.alloc(0), 'image/jpeg', 400],
  ]) {
    const response = await api.frame(id, 'invalid-image', body, mime);
    assert.equal(response.status, expected, `${mime}: ${body.length} bytes`);
    await response.arrayBuffer();
  }
  for (const frameId of [undefined, '']) {
    const headers = { 'Content-Type': 'image/png' };
    if (frameId !== undefined) headers['X-Frame-Id'] = frameId;
    const response = await api.authenticated(`/v1/sessions/${id}/frames`, {
      method: 'POST', headers, body: PNG,
    });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  assert.equal(api.calls.length, 0);

  for (const [frameId, body, mime] of [['png-frame', PNG, 'image/png'], ['jpeg-frame', JPEG, 'image/jpeg']]) {
    const freshSession = await api.start();
    const response = await api.frame(freshSession, frameId, body, mime);
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.equal(api.calls.length, 2);
});

test('an image larger than the configured limit is rejected before provider invocation', async (t) => {
  const api = await fixture(t);
  const id = await api.start();
  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  PNG.copy(oversized);
  const response = await api.frame(id, 'oversized', oversized);
  assert.equal(response.status, 413);
  await response.arrayBuffer();
  const chunked = await api.authenticated(`/v1/sessions/${id}/frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-Frame-Id': 'oversized-chunked' },
    body: Readable.from([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]),
    duplex: 'half',
  });
  assert.equal(chunked.status, 413, 'the limit also applies without Content-Length');
  await chunked.arrayBuffer();
  assert.equal(api.calls.length, 0);
});

test('a real HTTP session accepts frames and suppresses inference while paused or ended', async (t) => {
  const api = await fixture(t);
  const id = await api.start();
  const get = await api.authenticated(`/v1/sessions/${id}`);
  assert.equal(get.status, 200);
  assert.equal((await get.json()).session_id, id);

  const first = await api.frame(id, 'frame-1');
  assert.equal(first.status, 200);
  await first.json();
  assert.equal(api.calls.length, 1);

  for (const action of ['pause', 'end']) {
    const control = await api.json(`/v1/sessions/${id}/control`, { action });
    assert.equal(control.status, 200);
    await control.json();
    const lateFrame = await api.frame(id, `after-${action}`);
    assert.equal(lateFrame.status, 200);
    const snapshot = await lateFrame.json();
    assert.equal(snapshot.notify, false);
    assert.equal(snapshot.continuous_hold_ms, 0);
    assert.equal(snapshot.required_hold_ms, 2000);
    assert.equal(snapshot.reason, action === 'pause' ? 'session_paused' : 'session_ended');
    assert.equal(api.calls.length, 1, `${action} must prevent provider calls`);
  }
});

test('an image upload started before pause/resume is discarded even when its body finishes after resume', { timeout: 5000 }, async (t) => {
  const api = await fixture(t);
  const id = await api.start();
  const uploadStarted = new Promise((resolve) => api.server.once('request', resolve));
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(`${api.base}/v1/sessions/${id}/frames`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'image/png',
        'X-Frame-Id': 'before-pause-stream',
        'Content-Length': PNG.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.write(PNG.subarray(0, 16));
  });
  t.after(() => request.destroy());
  await uploadStarted;
  for (const action of ['pause', 'resume']) {
    const control = await api.json(`/v1/sessions/${id}/control`, { action });
    assert.equal(control.status, 200);
    await control.json();
  }
  request.end(PNG.subarray(16));
  const stale = await response;
  assert.equal(stale.status, 200);
  assert.equal(stale.body.state, 'observing');
  assert.equal(stale.body.notify, false);
  assert.equal(stale.body.reason, 'session_changed');
  assert.equal(stale.body.consecutive_count, 0);
  assert.equal(api.calls.length, 0, 'a pre-pause upload must not cause an inference or charge');
  const fresh = await api.frame(id, 'after-resume-fresh');
  assert.equal(fresh.status, 200);
  await fresh.json();
  assert.equal(api.calls.length, 1, 'a newly captured image still works after resume');
});
