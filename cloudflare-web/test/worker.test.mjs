import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import worker, { ACCESS_TTL_MS, signAccess, verifyAccess, readBounded, apiRoute } from '../src/application.mjs';

const SECRET = 'test-cookie-secret-is-over-thirty-two-characters';
const now = Date.now();

test('signed cookies reject tampering, expiration, duplicate fields and another key', () => {
  const id = randomUUID();
  const expires = now + ACCESS_TTL_MS;
  const token = signAccess(id, expires, SECRET);
  assert.deepEqual(verifyAccess(token, SECRET, now), { browserId: id, expiresAt: expires });
  assert.equal(verifyAccess(`${token.slice(0, -1)}!`, SECRET, now), null);
  assert.equal(verifyAccess(token.replace(id, randomUUID()), SECRET, now), null);
  assert.equal(verifyAccess(token, `${SECRET}!`, now), null);
  assert.equal(verifyAccess(token, SECRET, expires), null);
  assert.equal(verifyAccess(signAccess(id, now + ACCESS_TTL_MS * 2, SECRET), SECRET, now), null);
  assert.equal(verifyAccess('a'.repeat(1000), SECRET, now), null);
});

test('route allowlist rejects queries encoded in paths and unsupported methods', () => {
  assert.equal(apiRoute('/api/focus/health', 'GET').health, true);
  assert.equal(apiRoute('/api/focus/v1/sessions/abc-123/frames', 'POST').sessionId, 'abc-123');
  for (const path of ['/api/focus/admin', '/api/focus//v1/sessions', '/api/focus/v1/sessions/a%2Fb', '/api/focus/v1/sessions/a?x=1', '/api/focus/v1/sessions/a/unknown']) assert.throws(() => apiRoute(path, 'GET'));
  assert.throws(() => apiRoute('/api/focus/v1/sessions', 'GET'), /メソッド/);
});

test('stream reader checks actual length without trusting Content-Length', async () => {
  const request = new Request('https://example.test', { method: 'POST', body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); controller.close(); } }), duplex: 'half' });
  await assert.rejects(readBounded(request, 10), error => error.status === 413);
  await assert.rejects(readBounded(new Request('https://example.test', { method: 'POST', body: 'x', headers: { 'content-length': '100' } }), 10), error => error.status === 413);
});

test('static assets work without secrets while API configuration fails closed', async () => {
  const response = await worker.fetch(new Request('https://example.test/'), { ASSETS: { fetch: () => new Response('<html>UI</html>', { headers: { 'content-type': 'text/html' } }) } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  const unavailable = await worker.fetch(new Request('https://example.test/api/access/status'), {});
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'service_not_configured');
});
