import test from 'node:test';
import assert from 'node:assert/strict';
import { TeamAccess } from '../team-access.js';
import { FocusApiClient } from '../focus-api-client.js';

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const snapshot = (changes = {}) => ({ session_id: 'session-test', state: 'observing', notify: false, notification_id: null, message: null, next_capture_after_ms: 700, provider: 'mock', ...changes });
const expiry = '2026-10-18T12:00:00.000Z';
function clock() {
  const timers = [];
  return { timers, now: () => Date.parse(expiry) - 1000, setTimer: (run, delay) => { timers.push({ run, delay, cancelled: false }); return timers.length - 1; }, clearTimer: id => { timers[id].cancelled = true; } };
}

test('initial access fails closed and makes no API or native calls', async () => {
  let calls = 0;
  const access = new TeamAccess({ fetchImpl: async () => { calls++; return response({}); } });
  assert.equal(access.allowed, false);
  assert.equal(access.nativeAllowed, false);
  await assert.rejects(access.fetchAuthorized('/api/focus/health'), { code: 'authentication_required', status: 401 });
  assert.equal(calls, 0);
});

test('public status requires a team code, which is sent only in the login body', async () => {
  const calls = [];
  const access = new TeamAccess({ ...clock(), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(url.endsWith('/login') ? { authenticated: true, expires_at: expiry } : { required: true, authenticated: false });
  } });
  assert.equal(await access.check(), false);
  assert.equal(await access.login('team-code-fixture'), true);
  assert.equal(access.authenticated, true);
  assert.equal(access.nativeAllowed, false);
  assert.equal(calls[1].url, '/api/access/login');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(calls[1].options.body, JSON.stringify({ code: 'team-code-fixture' }));
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(JSON.stringify(access).includes('team-code-fixture'), false);
});

test('wrong codes remain locked and the remote response is never shown or retained', async () => {
  const access = new TeamAccess({ fetchImpl: async () => response({ error: { message: 'echo-secret-code' } }, 401) });
  assert.equal(await access.login('echo-secret-code'), false);
  assert.equal(access.allowed, false);
  assert.equal(access.message, 'チーム用コードが正しくありません。');
  assert.equal(JSON.stringify(access).includes('echo-secret-code'), false);
});

test('empty codes do not make a request and rate limited attempts stay locked', async () => {
  let calls = 0;
  const access = new TeamAccess({ fetchImpl: async () => { calls++; return response({}, 429); } });
  assert.equal(await access.login('   '), false);
  assert.equal(calls, 0);
  assert.equal(await access.login('test-code'), false);
  assert.equal(access.allowed, false);
  assert.match(access.message, /少し待って/);
});

test('only an explicitly local host accepts a missing status route', async () => {
  const fetchImpl = async () => response({}, 404);
  const local = new TeamAccess({ fetchImpl, allowLocalBypass: true });
  assert.equal(await local.check(), true);
  assert.equal(local.required, false);
  assert.equal(local.nativeAllowed, true);
  const remote = new TeamAccess({ fetchImpl });
  await assert.rejects(remote.check());
  assert.equal(remote.allowed, false);
  assert.equal(remote.nativeAllowed, false);
});

test('a malformed or unexpected public bypass response cannot allow camera/API use', async () => {
  for (const body of [{ required: false, authenticated: false }, { authenticated: true }, {}]) {
    const access = new TeamAccess({ fetchImpl: async () => response(body) });
    await assert.rejects(access.check());
    assert.equal(access.allowed, false);
  }
});

test('expired cookies are rejected immediately; an expiry timer revokes current access', async () => {
  const time = clock(); let losses = 0;
  const access = new TeamAccess({ ...time, onLost: () => losses++, fetchImpl: async () => response({ required: true, authenticated: true, expires_at: expiry }) });
  assert.equal(await access.check(), true);
  assert.equal(time.timers[0].delay, 1000);
  time.timers[0].run();
  assert.equal(access.allowed, false);
  assert.equal(losses, 1);
  assert.match(access.message, /期限が切れ/);
  const expired = new TeamAccess({ now: () => Date.parse(expiry), fetchImpl: async () => response({ required: true, authenticated: true, expires_at: expiry }) });
  assert.equal(await expired.check(), false);
});

test('expiry from an old login cannot revoke a later login', async () => {
  const time = clock();
  const access = new TeamAccess({ ...time, fetchImpl: async () => response({ required: true, authenticated: true, expires_at: expiry }) });
  await access.check();
  access.invalidate();
  assert.equal(time.timers[0].cancelled, true);
  await access.login('new-code');
  time.timers[0].run();
  assert.equal(access.allowed, true);
});

test('an old status request cannot override a successful login', async () => {
  const pending = deferred();
  const access = new TeamAccess({ ...clock(), fetchImpl: async url => url.endsWith('/status') ? pending.promise : response({ authenticated: true, expires_at: expiry }) });
  const checking = access.check();
  await access.login('new-code');
  pending.resolve(response({ required: true, authenticated: false }));
  assert.equal(await checking, true);
  assert.equal(access.allowed, true);
});

test('401 stops an in-flight camera frame and rejects its late notification', async () => {
  const waiting = deferred(); let signal; let cameraStopped = false; let client;
  const access = new TeamAccess({ ...clock(), onLost: () => { cameraStopped = true; client?.stopFrames(); }, fetchImpl: async (url, options) => {
    if (url.startsWith('/api/access')) return response({ required: true, authenticated: true, expires_at: expiry });
    if (url.endsWith('/frames')) { signal = options.signal; return waiting.promise; }
    if (url.endsWith('/health')) return response({ error: { code: 'authentication_required' } }, 401);
    return response(snapshot());
  } });
  client = new FocusApiClient({ fetchImpl: (...args) => access.fetchAuthorized(...args) });
  await access.check(); await client.start();
  const frame = client.frame(new Blob(['jpeg'], { type: 'image/jpeg' }));
  await assert.rejects(client.checkHealth(), { status: 401 });
  assert.equal(cameraStopped, true);
  assert.equal(signal.aborted, true);
  assert.equal(access.allowed, false);
  waiting.resolve(response(snapshot({ notify: true, notification_id: 'must-not-display' })));
  assert.equal(await frame, null);
  assert.equal(client.snapshot.notify, false);
});

test('logout attempts server end before deleting the cookie and revokes pending results', async () => {
  const order = []; const pending = deferred(); let pendingSignal;
  const access = new TeamAccess({ ...clock(), fetchImpl: async (url, options) => {
    order.push(url);
    if (url === '/api/focus/slow') { pendingSignal = options.signal; return pending.promise; }
    return response({ required: true, authenticated: true, expires_at: expiry });
  } });
  await access.check();
  const oldRequest = access.fetchAuthorized('/api/focus/slow');
  assert.equal(await access.logout({ beforeLogout: () => access.fetchAuthorized('/api/focus/end') }), true);
  assert.equal(access.allowed, false);
  assert.equal(pendingSignal.aborted, true);
  assert.ok(order.indexOf('/api/focus/end') < order.indexOf('/api/access/logout'));
  pending.resolve(response({ old: true }));
  await assert.rejects(oldRequest, { name: 'AbortError' });
});

test('logout waits at most 1.8 seconds for a stalled end before revoking the cookie', async () => {
  const time = clock(); const calls = [];
  const access = new TeamAccess({ ...time, fetchImpl: async url => { calls.push(url); return response({ required: true, authenticated: true, expires_at: expiry }); } });
  await access.check();
  const logout = access.logout({ beforeLogout: () => new Promise(() => {}) });
  const timeout = time.timers.find(timer => timer.delay === 1800);
  assert.ok(timeout);
  timeout.run();
  await logout;
  assert.equal(access.allowed, false);
  assert.ok(calls.includes('/api/access/logout'));
});

test('logout network failure still disables local access and reports the failed confirmation', async () => {
  const access = new TeamAccess({ ...clock(), fetchImpl: async url => {
    if (url.endsWith('/logout')) throw new Error('offline');
    return response({ required: true, authenticated: true, expires_at: expiry });
  } });
  await access.check();
  assert.equal(await access.logout(), false);
  assert.equal(access.allowed, false);
  assert.match(access.message, /ログアウトの確認に失敗/);
});

test('a missing access service after a local bypass returns to fail-closed state', async () => {
  let offline = false;
  const access = new TeamAccess({ allowLocalBypass: true, fetchImpl: async () => { if (offline) throw new Error('offline'); return response({}, 404); } });
  await access.check(); offline = true;
  await assert.rejects(access.check());
  assert.equal(access.allowed, false);
  assert.equal(access.nativeAllowed, false);
});

test('default timers keep the browser global receiver through login and logout', async t => {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', function (callback, delay) {
    assert.equal(this, globalThis, 'browser setTimeout requires its Window receiver');
    timers.push({ callback, delay, cancelled: false });
    return timers.length - 1;
  });
  t.mock.method(globalThis, 'clearTimeout', function (id) {
    assert.equal(this, globalThis, 'browser clearTimeout requires its Window receiver');
    timers[id].cancelled = true;
  });
  const access = new TeamAccess({
    now: () => Date.parse(expiry) - 1000,
    fetchImpl: async () => response({ required: true, authenticated: true, expires_at: expiry }),
  });
  assert.equal(await access.login('timer-regression-code'), true);
  assert.equal(access.allowed, true);
  assert.equal(timers[0].delay, 1000);
  assert.equal(await access.logout(), true);
  assert.equal(access.allowed, false);
  assert.deepEqual(timers.map(({ delay, cancelled }) => ({ delay, cancelled })), [
    { delay: 1000, cancelled: true },
    { delay: 1800, cancelled: true },
  ]);
});
