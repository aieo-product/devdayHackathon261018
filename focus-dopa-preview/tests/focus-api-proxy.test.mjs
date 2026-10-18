import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPreviewServer } from '../server.mjs';
import { loadFocusConfig, FOCUS_API_BASE_URL } from '../focus-api-proxy.mjs';

test('same-origin Focus proxy contract, bounded input, and secret isolation', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'focus-proxy-'));
  const credential = 'synthetic-test-credential';
  await writeFile(path.join(directory, '.env.local'), `FOCUS_API_TOKEN=${credential}\n`, { mode: 0o644 });
  await writeFile(path.join(directory, 'focus-api-proxy.mjs'), 'private server implementation');
  await writeFile(path.join(directory, 'index.html'), 'safe page');
  await symlink(path.join(directory, '.env.local'), path.join(directory, 'innocent.js'));
  await symlink(path.join(directory, 'focus-api-proxy.mjs'), path.join(directory, 'source.js'));
  const calls = [];
  let timeout = false;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (timeout) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    if (url.endsWith('/health')) return Response.json({ provider: 'mock', configured: true });
    if (url.endsWith('/frames')) return Response.json({ error: { code: 'invalid_image' }, request_id: 'upstream-123' }, { status: 400, headers: { 'X-Request-Id': 'upstream-123' } });
    return Response.json({ session_id: 'session-test', state: 'observing', notify: false }, { status: options.method === 'POST' ? 201 : 200 });
  };
  const server = createPreviewServer({ directory, focusConfig: { token: credential }, fetchImpl, timeoutMs: 25 });
  t.after(async () => {
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  await t.test('local environment loads privately with process-environment precedence', async () => {
    assert.equal((await loadFocusConfig({ directory, env: {} })).token, credential);
    assert.equal((await loadFocusConfig({ directory, env: { FOCUS_API_TOKEN: 'override-test-only' } })).token, 'override-test-only');
    assert.equal((await stat(path.join(directory, '.env.local'))).mode & 0o777, 0o600);
    const nested = path.join(directory, 'webroot');
    await mkdir(nested);
    await writeFile(path.join(directory, '.env.focus-api.local'), 'FOCUS_API_TOKEN=private-parent-test\n');
    await writeFile(path.join(nested, '.env.local'), 'FOCUS_API_TOKEN=fallback-test\n');
    assert.equal((await loadFocusConfig({ directory: nested, env: {} })).token, 'private-parent-test');
    assert.equal((await loadFocusConfig({ directory: nested, env: { FOCUS_API_TOKEN: '' } })).token, '');
  });
  await t.test('forwards only allowlisted headers and returns health without credentials', async () => {
    const health = await fetch(`${base}/api/focus/health`);
    assert.equal(health.status, 200); assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await health.json(), { provider: 'mock', configured: true });
    assert.equal(calls.at(-1).options.headers.Authorization, undefined);
    const started = await fetch(`${base}/api/focus/v1/sessions`, { method: 'POST',
      headers: { Origin: base, Authorization: 'Bearer untrusted-client-value', 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_type: 'mac', duration_seconds: 60 }) });
    assert.equal(started.status, 201);
    const upstream = calls.at(-1);
    assert.equal(upstream.url, `${FOCUS_API_BASE_URL}/v1/sessions`);
    assert.equal(upstream.options.headers.Authorization, `Bearer ${credential}`);
    assert.equal(upstream.options.headers.Origin, undefined);
    assert.equal(upstream.options.headers['upstreamOrigin'], undefined);
    assert.equal(upstream.options.redirect, 'error');
    assert.equal(JSON.stringify(await started.json()).includes(credential), false);
  });
  await t.test('preserves upstream error status, body, and request identifier', async () => {
    const response = await fetch(`${base}/api/focus/v1/sessions/session-test/frames`, { method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'X-Frame-Id': 'test-001' }, body: new Uint8Array([1, 2, 3]) });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('x-request-id'), 'upstream-123');
    assert.equal((await response.json()).error.code, 'invalid_image');
  });
  await t.test('rejects cross-origin, invalid Host, paths, methods, and media before forwarding', async () => {
    const count = calls.length;
    assert.equal((await fetch(`${base}/api/focus/health`, { headers: { Origin: 'https://outside.example' } })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      const outgoing = request(`${base}/api/focus/health`, { headers: { Host: 'outside.example' } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      outgoing.on('error', reject); outgoing.end();
    });
    assert.equal(badHostStatus, 403);
    assert.equal((await fetch(`${base}/api/focus/admin`)).status, 404);
    assert.equal((await fetch(`${base}/api/focus/health?redirect=bad`)).status, 404);
    assert.equal((await fetch(`${base}/api/focus/v1/sessions`)).status, 405);
    assert.equal((await fetch(`${base}/api/focus/v1/sessions`, { method: 'POST', body: '{}' })).status, 415);
    assert.equal(calls.length, count);
  });
  await t.test('enforces 16 KiB JSON and 1 MiB frame limits', async () => {
    const count = calls.length;
    assert.equal((await fetch(`${base}/api/focus/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(16_385) })).status, 413);
    assert.equal((await fetch(`${base}/api/focus/v1/sessions/session-test/frames`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Frame-Id': 'test-large' }, body: new Uint8Array(1_048_577) })).status, 413);
    assert.equal(calls.length, count);
  });
  await t.test('denies direct and aliased environment/server files', async () => {
    for (const route of ['/.env.local', '/innocent.js', '/focus-api-proxy.mjs', '/source.js', '/server.mjs', '/package.json']) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 403, route);
      assert.equal((await response.text()).includes(credential), false);
    }
    assert.equal(await (await fetch(base)).text(), 'safe page');
  });
  await t.test('times out upstream calls without leaking internal failures', async () => {
    timeout = true;
    const response = await fetch(`${base}/api/focus/health`);
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'upstream_timeout');
  });
});
