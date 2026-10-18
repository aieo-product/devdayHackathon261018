import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signAccess, COOKIE_NAME, MAX_BROWSER_SESSIONS } from '../src/application.mjs';

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const runtimeOptions = options => convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options;
const ORIGIN = 'https://web.test';
const TEAM_CODE = 'integration-team-code';
const COOKIE_SECRET = 'integration-cookie-secret-over-thirty-two-characters';
const TOKEN = 'integration-upstream-token-never-public';
const image = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);

// All API traffic is serviced by in-process fixtures, including in failure cases.
test('Workers runtime: team access, isolated ownership, revocation and proxy security', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'focus-web-worker-test-'));
  const bundle = join(directory, 'worker.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/worker.mjs', import.meta.url))], outfile: bundle, bundle: true, format: 'esm', platform: 'neutral', external: ['node:*'] });
  const calls = [];
  const sessions = new Map();
  let nextResponse;
  let delayedCreate;
  let createStarted;
  const upstream = async request => {
    assert.equal(new URL(request.url).origin, 'https://focus-shared-api-20261018.take-otani.workers.dev');
    assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`);
    for (const name of ['cookie', 'origin', 'x-evil', 'x-forwarded-host']) assert.equal(request.headers.get(name), null, name);
    const path = new URL(request.url).pathname;
    const body = request.method === 'POST' ? await request.arrayBuffer() : null;
    calls.push({ path, method: request.method, body });
    if (nextResponse) { const response = nextResponse; nextResponse = null; return response(); }
    if (path === '/health') return Response.json({ configured: true, provider: 'openai' }, { headers: { 'set-cookie': 'evil=1', 'x-secret': TOKEN, 'access-control-allow-origin': '*', 'x-request-id': 'safe-request-id' } });
    if (path === '/v1/sessions') {
      if (delayedCreate) { createStarted(); await delayedCreate; }
      const session_id = randomUUID();
      sessions.set(session_id, { session_id, state: 'observing', notify: false });
      return Response.json(sessions.get(session_id), { status: 201 });
    }
    const [, id, operation] = path.match(/^\/v1\/sessions\/([^/]+)(?:\/(frames|control))?$/) || [];
    if (!sessions.has(id)) return Response.json({ error: { code: 'session_not_found', message: 'missing' } }, { status: 404 });
    const data = sessions.get(id);
    if (operation === 'control') {
      const { action } = JSON.parse(new TextDecoder().decode(body));
      data.state = action === 'end' ? 'ended' : action === 'pause' ? 'paused' : 'observing';
    }
    return Response.json(data);
  };
  const options = {
    modules: true, script: await readFile(bundle, 'utf8'), compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { BROWSER_SESSIONS: { className: 'FocusBrowserSession', useSQLite: true } }, resourcePersistencePath: join(directory, 'storage'),
    bindings: { TEAM_ACCESS_CODE: TEAM_CODE, COOKIE_SECRET, FOCUS_API_TOKEN: TOKEN },
    serviceBindings: { FOCUS_API: upstream, ASSETS: () => new Response('<html>public UI</html>', { headers: { 'content-type': 'text/html' } }) },
    outboundService: () => { throw new Error('Unexpected external network request'); },
  };
  let mf = new Miniflare(runtimeOptions(options));
  const call = (path, { cookie, method = 'GET', body, json, headers = {}, origin = ORIGIN } = {}) => mf.dispatchFetch(`${ORIGIN}${path}`, {
    method, ...(body !== undefined || json !== undefined ? { body: json === undefined ? body : JSON.stringify(json) } : {}),
    headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' && origin ? { origin } : {}), ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, redirect: 'manual',
  });
  const login = async (ip = '192.0.2.1') => {
    const response = await call('/api/access/login', { method: 'POST', json: { code: TEAM_CODE }, headers: { 'cf-connecting-ip': ip } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.headers.get('set-cookie').split(';')[0];
  };
  const create = cookie => call('/api/focus/v1/sessions', { cookie, method: 'POST', json: { device_type: 'mac', duration_seconds: 60 } });
  let browserA, browserB, sessionId;
  try {
    await t.test('public UI and access status; login cookie flags and invalid code', async () => {
      assert.equal((await call('/')).status, 200);
      assert.deepEqual(await (await call('/api/access/status')).json(), { required: true, authenticated: false });
      assert.equal((await call('/api/focus/health')).status, 401);
      const wrong = await call('/api/access/login', { method: 'POST', json: { code: 'wrong-code' } });
      assert.equal(wrong.status, 401);
      assert.equal((await wrong.json()).error.code, 'invalid_access_code');
      const loggedIn = await call('/api/access/login', { method: 'POST', json: { code: TEAM_CODE } });
      assert.equal(loggedIn.status, 200);
      const setCookie = loggedIn.headers.get('set-cookie');
      for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(setCookie.includes(flag));
      browserA = setCookie.split(';')[0];
      browserB = await login();
      const status = await (await call('/api/access/status', { cookie: browserA })).json();
      assert.equal(status.authenticated, true);
      assert.ok(Date.parse(status.expires_at) > Date.now());
      assert.equal(setCookie.includes(TEAM_CODE), false);
      assert.equal(setCookie.includes(TOKEN), false);
    });
    await t.test('cookie tampering, expired signature and duplicate cookie rejected', async () => {
      for (const value of [`${browserA}!`, `${browserA}; ${browserA}`, `${COOKIE_NAME}=${signAccess(randomUUID(), Date.now() - 1000, COOKIE_SECRET)}`, `${COOKIE_NAME}=${signAccess(randomUUID(), Date.now() + 60000, COOKIE_SECRET)}`]) {
        assert.equal((await (await call('/api/access/status', { cookie: value })).json()).authenticated, false);
        assert.equal((await call('/api/focus/health', { cookie: value })).status, 401);
      }
    });
    await t.test('CSRF blocks missing, different, null and cross-site origins before upstream', async () => {
      const count = calls.length;
      for (const origin of [undefined, 'https://evil.test', 'null']) {
        assert.equal((await call('/api/access/login', { method: 'POST', json: { code: TEAM_CODE }, origin: origin ?? '' })).status, 403);
        assert.equal((await call('/api/focus/v1/sessions', { cookie: browserA, method: 'POST', json: { device_type: 'web' }, origin: origin ?? '' })).status, 403);
        assert.equal((await call('/api/access/logout', { cookie: browserA, method: 'POST', origin: origin ?? '' })).status, 403);
      }
      assert.equal((await call('/api/focus/health', { cookie: browserA, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
      assert.equal(calls.length, count);
    });
    await t.test('fixed destination, route/method allowlist and outgoing header isolation', async () => {
      const health = await call('/api/focus/health', { cookie: browserA, headers: { authorization: 'Bearer attacker', 'x-evil': 'bad', 'x-forwarded-host': 'evil.test' } });
      assert.equal(health.status, 200);
      for (const name of ['set-cookie', 'x-secret', 'access-control-allow-origin']) assert.equal(health.headers.get(name), null);
      assert.equal(health.headers.get('x-request-id'), 'safe-request-id');
      assert.equal(health.headers.get('cache-control'), 'no-store');
      assert.equal((await health.text()).includes(TOKEN), false);
      const count = calls.length;
      for (const path of ['/api/focus/health?url=https://evil.test', '/api/focus/admin', '/api/focus/v1/sessions/a%2Fb', '/api/focus/v1/sessions/a/control/extra']) assert.equal((await call(path, { cookie: browserA })).status, 404);
      assert.equal((await call('/api/focus/v1/sessions', { cookie: browserA })).status, 405);
      assert.equal(calls.length, count);
    });
    await t.test('session ownership prevents every cross-browser operation', async () => {
      const response = await create(browserA);
      assert.equal(response.status, 201);
      sessionId = (await response.json()).session_id;
      const path = `/api/focus/v1/sessions/${sessionId}`;
      assert.equal((await call(path, { cookie: browserA })).status, 200);
      const count = calls.length;
      assert.equal((await call(path, { cookie: browserB })).status, 404);
      assert.equal((await call(`${path}/control`, { cookie: browserB, method: 'POST', json: { action: 'end' } })).status, 404);
      assert.equal((await call(`${path}/frames`, { cookie: browserB, method: 'POST', body: image, headers: { 'content-type': 'image/jpeg', 'x-frame-id': 'foreign' } })).status, 404);
      assert.equal(calls.length, count);
    });
    await t.test('JSON/frame bounds and frame ID validation never reach upstream', async () => {
      const path = `/api/focus/v1/sessions/${sessionId}/frames`;
      const count = calls.length;
      assert.equal((await call('/api/access/login', { method: 'POST', body: 'x'.repeat(16385), headers: { 'content-type': 'application/json' } })).status, 413);
      assert.equal((await call('/api/focus/v1/sessions', { cookie: browserA, method: 'POST', body: 'x'.repeat(16385), headers: { 'content-type': 'application/json' } })).status, 413);
      // Reject Content-Length before transmitting the body; avoid a keep-alive
      // client reset when workerd correctly stops reading a rejected upload.
      const { request: httpRequest } = await import('node:http');
      const workerUrl = await mf.ready;
      const oversizedStatus = await new Promise((resolve, reject) => {
        const upload = httpRequest(new URL(path, workerUrl), { method: 'POST', headers: { cookie: browserA, origin: workerUrl.origin, 'content-type': 'image/jpeg', 'x-frame-id': 'oversized', 'content-length': '1048577' } }, response => { response.resume(); resolve(response.statusCode); upload.destroy(); });
        upload.on('error', reject);
        upload.flushHeaders();
      });
      assert.equal(oversizedStatus, 413);
      for (const id of ['', 'a'.repeat(129), 'with space']) assert.equal((await call(path, { cookie: browserA, method: 'POST', body: image, headers: { 'content-type': 'image/jpeg', 'x-frame-id': id } })).status, 400);
      assert.equal((await call(path, { cookie: browserA, method: 'POST', body: 'not a jpeg', headers: { 'content-type': 'image/jpeg', 'x-frame-id': 'invalid-image' } })).status, 400);
      assert.equal((await call(path, { cookie: browserA, method: 'POST', body: image, headers: { 'content-type': 'text/plain', 'x-frame-id': 'bad-type' } })).status, 415);
      assert.equal(calls.length, count);
      assert.equal((await call(path, { cookie: browserA, method: 'POST', body: image, headers: { 'content-type': 'image/jpeg', 'x-frame-id': 'valid' } })).status, 200);
    });
    await t.test('upstream status/error and safe headers preserved; redirect/HTML/oversize rejected', async () => {
      nextResponse = () => Response.json({ error: { code: 'decision_unavailable', message: 'retry later' } }, { status: 503, headers: { 'retry-after': '2', 'x-request-id': 'r1', 'set-cookie': 'evil=1' } });
      const failed = await call('/api/focus/health', { cookie: browserA });
      assert.equal(failed.status, 503);
      assert.equal((await failed.json()).error.code, 'decision_unavailable');
      assert.equal(failed.headers.get('retry-after'), '2');
      assert.equal(failed.headers.get('set-cookie'), null);
      for (const fixture of [() => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }), () => new Response('<html>error</html>', { status: 500, headers: { 'content-type': 'text/html' } }), () => Response.json({ data: 'x'.repeat(262145) }), () => new Response('{', { headers: { 'content-type': 'application/json' } })]) {
        nextResponse = fixture;
        assert.equal((await call('/api/focus/health', { cookie: browserA })).status, 502);
      }
    });
    await t.test('public desktop integration truthfully unavailable', async () => {
      assert.equal((await (await call('/api/desktop-overlay/status', { cookie: browserA })).json()).connected, false);
      assert.equal((await (await call('/api/desktop-overlay/cue', { cookie: browserA, method: 'POST', json: { action: 'detect' } })).json()).delivered, false);
    });
    await t.test('ownership and revocation persist across Workers runtime restart', async () => {
      await mf.dispose();
      mf = new Miniflare(runtimeOptions(options));
      assert.equal((await call(`/api/focus/v1/sessions/${sessionId}`, { cookie: browserA })).status, 200);
      assert.equal((await call(`/api/focus/v1/sessions/${sessionId}`, { cookie: browserB })).status, 404);
      const logout = await call('/api/access/logout', { cookie: browserA, method: 'POST' });
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
      assert.equal(sessions.get(sessionId).state, 'ended');
      await mf.dispose();
      mf = new Miniflare(runtimeOptions(options));
      assert.equal((await (await call('/api/access/status', { cookie: browserA })).json()).authenticated, false);
      assert.equal((await call(`/api/focus/v1/sessions/${sessionId}`, { cookie: browserA })).status, 401);
      assert.equal((await call('/api/focus/health', { cookie: browserB })).status, 200);
    });
    await t.test('logout racing session creation ends the late session and rejects its response', async () => {
      const cookie = await login();
      let release;
      delayedCreate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { createStarted = resolve; });
      const pending = create(cookie);
      await started;
      assert.equal((await call('/api/access/logout', { cookie, method: 'POST' })).status, 200);
      release();
      const response = await pending;
      delayedCreate = null;
      assert.equal(response.status, 401);
      assert.equal([...sessions.values()].at(-1).state, 'ended');
    });
    await t.test('bounded sessions allow completed-session replacement', async () => {
      const cookie = await login();
      let first;
      for (let i = 0; i < MAX_BROWSER_SESSIONS; i++) {
        const response = await create(cookie);
        assert.equal(response.status, 201);
        const value = await response.json();
        if (!first) first = value.session_id;
      }
      const count = calls.length;
      assert.equal((await create(cookie)).status, 429);
      assert.equal(calls.length, count);
      assert.equal((await call(`/api/focus/v1/sessions/${first}/control`, { cookie, method: 'POST', json: { action: 'end' } })).status, 200);
      assert.equal((await create(cookie)).status, 201);
    });
    await t.test('login attempt throttle persists and does not expose credentials', async () => {
      for (let i = 0; i < 30; i++) assert.equal((await call('/api/access/login', { method: 'POST', json: { code: 'wrong-code' }, headers: { 'cf-connecting-ip': '192.0.2.99' } })).status, 401);
      const response = await call('/api/access/login', { method: 'POST', json: { code: TEAM_CODE }, headers: { 'cf-connecting-ip': '192.0.2.99' } });
      assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      const content = await response.text();
      for (const secret of [TOKEN, TEAM_CODE, COOKIE_SECRET]) assert.equal(content.includes(secret), false);
    });
    await mf.dispose();
    const files = await readdir(join(directory, 'storage'), { recursive: true });
    for (const file of files.filter(file => file.endsWith('.sqlite'))) {
      const bytes = await readFile(join(directory, 'storage', file));
      for (const secret of [TOKEN, TEAM_CODE, COOKIE_SECRET]) assert.equal(bytes.includes(Buffer.from(secret)), false, `No credential persistence: ${file}`);
      assert.equal(bytes.includes(image), false, 'Camera bytes are never persisted');
    }
  } finally {
    await mf.dispose().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
