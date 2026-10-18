import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createCameraCheckServer, parsePort } from './server.mjs';

const API_URL = 'https://worker.example.test';
const TOKEN = 'worker-test-secret';

async function serve(t, options = {}) {
  const server = createCameraCheckServer({ apiUrl: API_URL, apiToken: TOKEN, ...options });
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
  assert.deepEqual(JSON.parse(config.text), { configured: true, api_url: API_URL });
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
