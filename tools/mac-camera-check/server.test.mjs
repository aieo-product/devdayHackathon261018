import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createCameraCheckServer, parsePort } from './server.mjs';

const API_URL = 'https://worker.example.test';
const TOKEN = 'worker-test-secret';

async function serve(t, options = {}) {
  const server = createCameraCheckServer({ apiUrl: API_URL, apiToken: TOKEN, eventsUrl: '', eventsToken: '', sourceId: '', deviceId: '', ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function request(base, path, { method = 'GET', headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, res => {
      const body = [];
      res.on('data', chunk => body.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(body).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('configuration is safe to expose and unknown paths cannot read local secrets', async t => {
  const { base } = await serve(t, { fetchImpl: () => assert.fail('must not contact upstream') });
  const config = await request(base, '/config');
  assert.equal(config.status, 200);
  assert.deepEqual(JSON.parse(config.text), { configured: true, api_url: API_URL, events: { configured: false, mcp_url: null, device_id: null } });
  assert.ok(!config.text.includes(TOKEN));
  assert.equal(config.headers['cache-control'], 'no-store');
  assert.equal(config.headers['x-content-type-options'], 'nosniff');
  assert.ok(config.headers['content-security-policy'].includes("connect-src 'self'"));
  assert.equal(config.headers['permissions-policy'], 'camera=(self), microphone=(), geolocation=()');
  for (const path of ['/cloudflare/.env.connection', '/.env', '/../server.mjs', '/%2e%2e/server.mjs', '/config?secret=1']) {
    const result = await request(base, path);
    assert.equal(result.status, 404, path);
    assert.ok(!result.text.includes(TOKEN));
  }
  const sdk = await request(base, '/focus-client.mjs');
  assert.equal(sdk.status, 200);
  assert.match(sdk.text, /export class FocusClient/);
  assert.ok(!sdk.text.includes(TOKEN));
});

test('only real server credentials and explicitly allowed headers reach the upstream', async t => {
  const calls = [];
  const { base } = await serve(t, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return Response.json({ session_id: 'session-1' }, { status: 201, headers: { 'Set-Cookie': 'bad=cookie', 'X-Upstream-Secret': 'never' } });
  } });
  const data = JSON.stringify({ device_type: 'mac', duration_seconds: 60 });
  const result = await request(base, '/api/v1/sessions', {
    method: 'POST', chunks: [data], headers: {
      Authorization: 'Bearer local-preview', Origin: base,
      Cookie: 'browser-cookie=secret', 'X-Internal-Create': '1',
      'X-Other': 'drop', 'Content-Type': 'application/json; charset=utf-8',
    },
  });
  assert.equal(result.status, 201);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, `${API_URL}/v1/sessions`);
  assert.equal(call.init.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.deepEqual([...call.init.headers.keys()].sort(), ['authorization', 'content-type']);
  assert.equal(call.init.body.toString(), data);
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.headers['x-upstream-secret'], undefined);
  assert.ok(!result.text.includes(TOKEN));

  await request(base, '/api/v1/sessions/session-1/frames', {
    method: 'POST', chunks: [Buffer.from([0xff, 0xd8, 0xff])],
    headers: { 'Content-Type': 'image/jpeg', 'X-Frame-Id': 'frame-1' },
  });
  assert.equal(calls[1].init.headers.get('x-frame-id'), 'frame-1');
  assert.deepEqual([...calls[1].init.headers.keys()].sort(), ['authorization', 'content-type', 'x-frame-id']);
});

test('unexpected hosts, origins and browser cross-site requests are blocked before proxying', async t => {
  const { base } = await serve(t, { fetchImpl: () => assert.fail('must not contact upstream') });
  const cases = [
    { Host: 'attacker.example' },
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
    { Origin: `${base}1` },
  ];
  for (const headers of cases) {
    const result = await request(base, '/api/v1/sessions', { method: 'POST', headers });
    assert.equal(result.status, 403, JSON.stringify(headers));
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  const preflight = await request(base, '/api/v1/sessions', { method: 'OPTIONS' });
  assert.equal(preflight.status, 404);
});

test('only the explicit read/create/frame/control API routes can be forwarded', async t => {
  const calls = [];
  const { base } = await serve(t, { fetchImpl: async (url, init) => {
    calls.push([url, init.method]);
    return Response.json({ ok: true });
  } });
  for (const [method, path] of [
    ['GET', '/api/health'], ['POST', '/api/v1/sessions'],
    ['GET', '/api/v1/sessions/abc-123'], ['POST', '/api/v1/sessions/abc-123/control'],
  ]) {
    const result = await request(base, path, { method, headers: { 'Content-Type': 'application/json' }, chunks: method === 'POST' ? ['{}'] : [] });
    assert.equal(result.status, 200);
  }
  assert.equal(calls.length, 4);
  for (const [method, path] of [
    ['DELETE', '/api/v1/sessions/abc-123'], ['GET', '/api/v1/sessions'],
    ['GET', '/api/v1/sessions/abc-123/frames'], ['POST', '/api/health'],
    ['GET', '/api/docs'], ['GET', '/api/health?target=evil'],
    ['POST', '/api/v1/sessions/abc/../../x'], ['GET', '/api/https://attacker.example'],
  ]) {
    assert.equal((await request(base, path, { method })).status, 404, `${method} ${path}`);
  }
  assert.equal(calls.length, 4);
});

test('JSON and image limits are enforced for both Content-Length and chunked uploads', async t => {
  const calls = [];
  const { base } = await serve(t, { fetchImpl: async (_url, init) => {
    calls.push(init.body.length);
    return Response.json({ ok: true });
  } });
  for (const [path, contentType, limit] of [
    ['/api/v1/sessions', 'application/json', 16 * 1024],
    ['/api/v1/sessions/abc/frames', 'image/jpeg', 1024 * 1024],
  ]) {
    const exact = await request(base, path, { method: 'POST', headers: { 'Content-Type': contentType }, chunks: [Buffer.alloc(limit)] });
    assert.equal(exact.status, 200);
    const fixed = await request(base, path, { method: 'POST', headers: { 'Content-Type': contentType, 'Content-Length': limit + 1 }, chunks: [Buffer.alloc(limit + 1)] });
    assert.equal(fixed.status, 413);
    const chunked = await request(base, path, { method: 'POST', headers: { 'Content-Type': contentType }, chunks: [Buffer.alloc(limit), Buffer.alloc(1)] });
    assert.equal(chunked.status, 413);
  }
  assert.deepEqual(calls, [16 * 1024, 1024 * 1024]);
  assert.equal((await request(base, '/api/v1/sessions/abc/frames', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, chunks: ['image'] })).status, 415);
});

test('network failures expose a generic error and missing credentials never call upstream', async t => {
  const { base } = await serve(t, { fetchImpl: async () => { throw new Error(`Network error with ${TOKEN}`); } });
  const failed = await request(base, '/api/health');
  assert.equal(failed.status, 502);
  assert.equal(JSON.parse(failed.text).error.code, 'upstream_unavailable');
  assert.ok(!failed.text.includes(TOKEN));
  const { base: unconfigured } = await serve(t, { apiToken: '', fetchImpl: () => assert.fail('must not contact upstream') });
  assert.equal((await request(unconfigured, '/api/health')).status, 503);
  assert.equal(JSON.parse((await request(unconfigured, '/config')).text).configured, false);
});

test('disconnecting the browser aborts a pending upstream inference', async t => {
  let upstreamStarted;
  const started = new Promise(resolve => { upstreamStarted = resolve; });
  let upstreamAborted;
  const aborted = new Promise(resolve => { upstreamAborted = resolve; });
  const { base } = await serve(t, { fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { upstreamAborted(); reject(new Error('cancelled')); }, { once: true });
    upstreamStarted();
  }) });
  const browser = http.request(`${base}/api/v1/sessions/abc/frames`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' } });
  browser.on('error', () => {});
  browser.end(Buffer.from([0xff, 0xd8, 0xff]));
  await started;
  browser.destroy();
  await Promise.race([aborted, new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error('Upstream was not aborted')), 1000);
    timeout.unref();
  })]);
});

test('production configuration rejects insecure upstreams and invalid listening ports', () => {
  for (const url of ['http://worker.example.test', 'http://127.0.0.1:1234', 'ftp://worker.example.test', 'https://user:pass@worker.example.test', 'https://worker.example.test?token=secret', 'https://worker.example.test#secret']) {
    assert.throws(() => createCameraCheckServer({ apiUrl: url, apiToken: TOKEN }), TypeError);
  }
  assert.doesNotThrow(() => createCameraCheckServer({ apiUrl: 'http://127.0.0.1:1234', apiToken: TOKEN, allowLoopbackHttp: true }));
  assert.throws(() => createCameraCheckServer({ apiUrl: 'http://worker.example.test', apiToken: TOKEN, allowLoopbackHttp: true }), TypeError);
  for (const value of ['', '0', '65536', '3000x', '1.5', '-1', ' 3000', '03000']) assert.throws(() => parsePort(value), TypeError);
  assert.equal(parsePort(), 3000);
  assert.equal(parsePort('65535'), 65535);
});

const EVENTS_URL = 'https://events.example.test';
const EVENTS_TOKEN = 'events-admin-secret';
const SOURCE_ID = '8d1e61d7-b6d9-4c42-bf12-4a4c366fcfa8';
const DEVICE_ID = 'mac-local-test';
const eventOptions = { eventsUrl: EVENTS_URL, eventsToken: EVENTS_TOKEN, sourceId: SOURCE_ID, deviceId: DEVICE_ID };
const notification = {
  session_id: 'session-1', notification_id: 'notification-1', notify: true, provider: 'openai',
  continuous_hold_ms: 2100, required_hold_ms: 2000, phone_probability: 0.98, observable_probability: 0.95,
};
const frameRequest = { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, chunks: [Buffer.from('private camera image bytes')] };

async function eventually(predicate, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('optional events configuration reveals no credentials or source ID', async t => {
  const { base } = await serve(t, { ...eventOptions, fetchImpl: () => assert.fail('must not contact upstream') });
  const response = await request(base, '/config');
  const config = JSON.parse(response.text);
  assert.deepEqual(config.events, { configured: true, mcp_url: `${EVENTS_URL}/mcp`, device_id: DEVICE_ID });
  for (const secret of [TOKEN, EVENTS_TOKEN, SOURCE_ID]) assert.ok(!response.text.includes(secret));
  const { base: partial } = await serve(t, { eventsUrl: EVENTS_URL, eventsToken: EVENTS_TOKEN });
  assert.deepEqual(JSON.parse((await request(partial, '/config')).text).events, { configured: false, mcp_url: null, device_id: null });
  assert.equal((await request(partial, '/mcp/pairing', { method: 'POST' })).status, 503);
  for (const eventsUrl of ['http://events.example.test', 'https://events.example.test/path', 'https://events.example.test?secret=1']) {
    assert.throws(() => createCameraCheckServer({ ...eventOptions, eventsUrl }), TypeError);
  }
  assert.throws(() => createCameraCheckServer({ ...eventOptions, sourceId: 'not-a-uuid' }), TypeError);
});

test('fresh notifications relay only selected metadata without delaying frames; duplicates are suppressed', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const calls = [];
  const { base } = await serve(t, { ...eventOptions, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith(EVENTS_URL)) { await held; return Response.json({ accepted: true }); }
    return Response.json({ ...notification, notification_id: init.method === 'GET' ? 'ignored-get-notification' : notification.notification_id, image: 'private upstream image', ignored_secret: 'private metadata' });
  } });
  t.after(() => release());
  const pending = request(base, '/api/v1/sessions/session-1/frames', frameRequest);
  let timeout;
  const result = await Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('frame response waited for event delivery')), 500); })]).finally(() => clearTimeout(timeout));
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.text).notification_id, notification.notification_id);
  const relayCall = calls.find(call => call.url.startsWith(EVENTS_URL));
  assert.equal(relayCall.url, `${EVENTS_URL}/events/ingest`);
  assert.equal(relayCall.init.headers.get('authorization'), `Bearer ${EVENTS_TOKEN}`);
  assert.deepEqual([...relayCall.init.headers.keys()].sort(), ['authorization', 'content-type']);
  assert.equal(relayCall.init.redirect, 'error');
  const payload = JSON.parse(relayCall.init.body);
  assert.equal(payload.source_id, SOURCE_ID);
  assert.equal(payload.event.eventId, notification.notification_id);
  assert.equal(payload.event.name, 'focus.phone_held');
  assert.ok(Number.isFinite(Date.parse(payload.event.timestamp)));
  assert.equal(payload.event.cursor, null);
  const { notify: _notify, ...expectedData } = notification;
  assert.deepEqual(payload.event.data, { ...expectedData, device_type: 'mac' });
  for (const secret of [TOKEN, EVENTS_TOKEN, 'private camera image bytes', 'private upstream image', 'private metadata']) assert.ok(!relayCall.init.body.includes(secret));
  await request(base, '/api/v1/sessions/session-1/frames', frameRequest);
  await request(base, '/api/v1/sessions/session-1');
  release();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls.filter(call => call.url.startsWith(EVENTS_URL)).length, 1);
});

test('transient relay failures retry the same event three times while normal API responses succeed', async t => {
  const deliveries = [];
  const { base } = await serve(t, { ...eventOptions, fetchImpl: async (url, init) => {
    if (!url.startsWith(EVENTS_URL)) return Response.json(notification);
    deliveries.push(init.body);
    if (deliveries.length === 1) throw new Error(`network failure ${EVENTS_TOKEN}`);
    return Response.json({}, { status: deliveries.length === 2 ? 503 : 202 });
  } });
  const result = await request(base, '/api/v1/sessions/session-1/frames', frameRequest);
  assert.equal(result.status, 200);
  await eventually(() => deliveries.length === 3);
  assert.equal(new Set(deliveries).size, 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(deliveries.length, 3);
});

test('pairing injects source and admin authentication; browser input cannot change either', async t => {
  const calls = [];
  const expires = new Date(Date.now() + 600_000).toISOString();
  const { base } = await serve(t, { ...eventOptions, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return Response.json({ code: 'ONE-TIME-CODE', expires_at: expires, admin_token: EVENTS_TOKEN, source_id: SOURCE_ID });
  } });
  const options = { method: 'POST', chunks: ['{}'], headers: { 'Content-Type': 'application/json', Authorization: 'Bearer browser-token' } };
  const response = await request(base, '/mcp/pairing', { ...options, headers: { ...options.headers, Origin: base } });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { code: 'ONE-TIME-CODE', expires_at: expires });
  assert.equal(calls[0].url, `${EVENTS_URL}/admin/pairing`);
  assert.equal(calls[0].init.headers.get('authorization'), `Bearer ${EVENTS_TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { source_id: SOURCE_ID });
  assert.ok(!response.text.includes(EVENTS_TOKEN));
  assert.ok(!response.text.includes(SOURCE_ID));
  assert.equal((await request(base, '/mcp/pairing', { ...options, headers: { ...options.headers, Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request(base, '/mcp/pairing', { ...options, chunks: [JSON.stringify({ source_id: 'attacker-source' })] })).status, 400);
  assert.equal((await request(base, '/mcp/pairing', { ...options, chunks: ['bad json'] })).status, 400);
  assert.equal((await request(base, '/mcp/pairing', { ...options, chunks: [Buffer.alloc(16385)] })).status, 413);
  assert.equal((await request(base, '/mcp/pairing', { ...options, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(calls.length, 1);
});

test('failed event delivery stops after three attempts, and permanent rejection is not retried', async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  let attempts = 0, nextNotification = 'transient-event';
  const { base } = await serve(t, { ...eventOptions, fetchImpl: async (url) => {
    if (!url.startsWith(EVENTS_URL)) return Response.json({ ...notification, notification_id: nextNotification });
    attempts += 1;
    return Response.json({ secret: EVENTS_TOKEN }, { status: nextNotification === 'transient-event' ? 503 : 401 });
  } });
  assert.equal((await request(base, '/api/v1/sessions/session-1/frames', frameRequest)).status, 200);
  await eventually(() => warnings.mock.callCount() === 1);
  assert.equal(attempts, 3);
  nextNotification = 'permanent-event';
  assert.equal((await request(base, '/api/v1/sessions/session-1/frames', frameRequest)).status, 200);
  await eventually(() => warnings.mock.callCount() === 2);
  await new Promise(resolve => setTimeout(resolve, 275));
  assert.equal(attempts, 4);
  for (const call of warnings.mock.calls) assert.ok(!JSON.stringify(call.arguments).includes(EVENTS_TOKEN));
});

test('pairing failures do not expose an upstream token or permit API routes to change', async t => {
  const { base } = await serve(t, { ...eventOptions, fetchImpl: async url => {
    if (url.startsWith(EVENTS_URL)) return Response.json({ error: EVENTS_TOKEN }, { status: 401 });
    return Response.json({ ok: true });
  } });
  const response = await request(base, '/mcp/pairing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, chunks: ['{}'] });
  assert.equal(response.status, 502);
  assert.equal(JSON.parse(response.text).error.code, 'pairing_unavailable');
  assert.ok(!response.text.includes(EVENTS_TOKEN));
  assert.equal((await request(base, '/api/health')).status, 200);
});

test('closing the local server aborts relay work independently from the frame response', async t => {
  let relaySignal;
  const { base, server } = await serve(t, { ...eventOptions, fetchImpl: async (url, init) => {
    if (!url.startsWith(EVENTS_URL)) return Response.json(notification);
    relaySignal = init.signal;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  assert.equal((await request(base, '/api/v1/sessions/session-1/frames', frameRequest)).status, 200);
  assert.ok(relaySignal);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  assert.equal(relaySignal.aborted, true);
});

const registeredDevice = {
  device_id: DEVICE_ID, name: 'Mac', type: 'mac', desired_state: 'off', observed_state: 'off',
  remote_enabled: false, revision: 0, applied_revision: 0, last_seen_at: '2026-10-18T08:00:00.000Z',
  online: true, command_issued_at: null, command_expires_at: null, session_id: null,
};
const heartbeat = { observed_state: 'off', remote_enabled: false, applied_revision: 0, session_id: null };
const jsonRequest = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, chunks: [JSON.stringify(value)] });

test('device routes inject the source, local identity and admin token without changing the camera API', async t => {
  const calls = [];
  const { base } = await serve(t, { ...eventOptions, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url === `${API_URL}/health`) return Response.json({ ok: true });
    const device = { ...registeredDevice, secret: EVENTS_TOKEN, source_id: SOURCE_ID };
    return Response.json(url.endsWith('/list') ? { devices: [device], secret: EVENTS_TOKEN } : device);
  } });
  const response = await request(base, '/devices/heartbeat', { ...jsonRequest(heartbeat), headers: { 'Content-Type': 'application/json', Origin: base, Authorization: 'Bearer browser-token', Cookie: 'session=secret' } });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), registeredDevice);
  assert.deepEqual(JSON.parse(calls[0].init.body), { ...heartbeat, source_id: SOURCE_ID, device_id: DEVICE_ID, device_type: 'mac' });
  assert.equal(calls[0].url, `${EVENTS_URL}/devices/heartbeat`);
  assert.equal(calls[0].init.headers.get('authorization'), `Bearer ${EVENTS_TOKEN}`);
  assert.deepEqual([...calls[0].init.headers.keys()].sort(), ['authorization', 'content-type']);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  const listed = await request(base, '/devices/list', jsonRequest({}));
  assert.deepEqual(JSON.parse(listed.text), { devices: [registeredDevice] });
  assert.deepEqual(JSON.parse(calls[1].init.body), { source_id: SOURCE_ID });
  const controlled = await request(base, '/devices/control', jsonRequest({ device_id: 'reachy-mini-1', enabled: true }));
  assert.equal(controlled.status, 200);
  assert.deepEqual(JSON.parse(calls[2].init.body), { source_id: SOURCE_ID, device_id: 'reachy-mini-1', enabled: true });
  for (const body of [response.text, listed.text, controlled.text]) for (const secret of [TOKEN, EVENTS_TOKEN, SOURCE_ID]) assert.ok(!body.includes(secret));
  assert.equal((await request(base, '/api/health')).status, 200);
  assert.equal(calls[3].init.headers.get('authorization'), `Bearer ${TOKEN}`);
});

test('device routes prevent cross-origin commands and reject identity injection or invalid states', async t => {
  const { base } = await serve(t, { ...eventOptions, fetchImpl: () => assert.fail('invalid command must not leave localhost') });
  for (const path of ['/devices/heartbeat', '/devices/list', '/devices/control']) {
    assert.equal((await request(base, path, { ...jsonRequest({}), headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await request(base, path, { ...jsonRequest({}), headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await request(base, path)).status, 404);
    assert.equal((await request(base, path, { ...jsonRequest({}), headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await request(base, path, { ...jsonRequest({}), chunks: [Buffer.alloc(16385)] })).status, 413);
  }
  for (const value of [
    { ...heartbeat, source_id: 'attacker-source' }, { ...heartbeat, device_id: 'other-device' },
    { ...heartbeat, device_type: 'other' }, { ...heartbeat, remote_enabled: 'true' },
    { ...heartbeat, observed_state: 'running' }, { ...heartbeat, applied_revision: -1 },
    { ...heartbeat, applied_revision: 1.5 }, { ...heartbeat, session_id: '../session' },
    { ...heartbeat, name: 'bad\nname' },
  ]) assert.equal((await request(base, '/devices/heartbeat', jsonRequest(value))).status, 400);
  for (const value of [{ device_id: 'device', enabled: true, source_id: 'other' }, { device_id: '../device', enabled: false }, { device_id: 'device', enabled: 'true' }]) {
    assert.equal((await request(base, '/devices/control', jsonRequest(value))).status, 400);
  }
  assert.equal((await request(base, '/devices/list', jsonRequest({ source_id: 'other' }))).status, 400);
});

test('device control errors remain actionable and never disclose upstream messages', async t => {
  let code = 'remote_disabled';
  const { base } = await serve(t, { ...eventOptions, fetchImpl: async url => {
    if (url === `${API_URL}/health`) return Response.json({ ok: true });
    return Response.json({ error: { code, message: EVENTS_TOKEN } }, { status: 409 });
  } });
  const blocked = await request(base, '/devices/control', jsonRequest({ device_id: DEVICE_ID, enabled: true }));
  assert.equal(blocked.status, 409);
  assert.equal(JSON.parse(blocked.text).error.code, 'remote_disabled');
  assert.ok(!blocked.text.includes(EVENTS_TOKEN));
  code = 'unknown_internal_error';
  const unknown = await request(base, '/devices/control', jsonRequest({ device_id: DEVICE_ID, enabled: false }));
  assert.equal(unknown.status, 502);
  assert.equal(JSON.parse(unknown.text).error.code, 'device_service_unavailable');
  assert.ok(!unknown.text.includes(EVENTS_TOKEN));
  assert.equal((await request(base, '/api/health')).status, 200);
  const { base: disabled } = await serve(t);
  assert.equal((await request(disabled, '/devices/heartbeat', jsonRequest(heartbeat))).status, 503);
});

test('a stable device identity defaults to the source ID and invalid overrides are rejected', async t => {
  const { base } = await serve(t, { ...eventOptions, deviceId: '' });
  assert.equal(JSON.parse((await request(base, '/config')).text).events.device_id, SOURCE_ID);
  assert.throws(() => createCameraCheckServer({ ...eventOptions, deviceId: '../escape' }), TypeError);
});
