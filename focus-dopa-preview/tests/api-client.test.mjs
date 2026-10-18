import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusApiClient } from '../focus-api-client.js';

const snapshot = (changes = {}) => ({ session_id: 'session-1', state: 'observing', notify: false, notification_id: null, message: null, next_capture_after_ms: 731, provider: 'mock', reason: 'session_started', ...changes });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const jpeg = () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' });

test('same-origin requests expose no token and health retains the mock distinction', async () => {
  const calls = [];
  const client = new FocusApiClient({ fetchImpl: async (url, options) => { calls.push({ url, options }); return response({ provider: 'mock', configured: true }); } });
  assert.deepEqual(await client.checkHealth(), { provider: 'mock', configured: true });
  assert.equal(calls[0].url, '/api/focus/health');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(client.active, false);
});

test('duration starts before network latency and continues during pause', async () => {
  let now = 1000;
  const start = deferred();
  const client = new FocusApiClient({ now: () => now, fetchImpl: async (_url, options) => {
    const action = options.body && JSON.parse(options.body).action;
    return action ? response(snapshot({ state: action === 'pause' ? 'paused' : 'observing' })) : start.promise;
  } });
  const beginning = client.start({ durationSeconds: 60 });
  now = 6000; start.resolve(response(snapshot())); await beginning;
  assert.equal(client.remainingMs, 55000);
  await client.control('pause'); now = 16000;
  assert.equal(client.remainingMs, 45000);
  await client.control('resume');
  assert.equal(client.remainingMs, 45000);
  assert.equal(client.active, true);
});

test('control calls serialize and pause aborts and rejects a late notifying frame', async () => {
  const frame = deferred(); let frameSignal;
  const client = new FocusApiClient({ fetchImpl: async (url, options) => {
    if (url.endsWith('/frames')) { frameSignal = options.signal; return frame.promise; }
    if (url.endsWith('/control')) return response(snapshot({ state: 'paused' }));
    return response(snapshot());
  } });
  await client.start(); const pendingFrame = client.frame(jpeg());
  const pause = client.control('pause');
  assert.equal(client.active, false);
  assert.equal(frameSignal.aborted, true);
  await assert.rejects(client.control('resume'), { code: 'control_in_progress' });
  await pause;
  frame.resolve(response(snapshot({ state: 'cooldown', notify: true, notification_id: 'late' })));
  assert.equal(await pendingFrame, null);
  assert.equal(client.snapshot.state, 'paused');
});

test('one raw JPEG request in flight and server capture delay is unchanged', async () => {
  const waiting = deferred(); const calls = [];
  const client = new FocusApiClient({ fetchImpl: async (url, options) => { calls.push({ url, options }); return url.endsWith('/frames') ? waiting.promise : response(snapshot()); } });
  await client.start(); const blob = jpeg(); const first = client.frame(blob);
  assert.equal(await client.frame(jpeg()), null);
  const request = calls.find(call => call.url.endsWith('/frames'));
  assert.equal(request.options.body, blob);
  assert.equal(request.options.headers['Content-Type'], 'image/jpeg');
  assert.match(request.options.headers['X-Frame-Id'], /^[A-Za-z0-9_.:-]{1,128}$/);
  assert.equal(request.options.headers.Authorization, undefined);
  waiting.resolve(response(snapshot({ next_capture_after_ms: 19 })));
  assert.equal((await first).snapshot.next_capture_after_ms, 19);
});

test('notify IDs execute once and stored or GET snapshots never replay notifications', async () => {
  let count = 0;
  const client = new FocusApiClient({ fetchImpl: async url => {
    if (url.endsWith('/frames')) { count++; return response(snapshot({ state: 'cooldown', notify: true, notification_id: 'one-id', message: '作業へ戻ろう', next_capture_after_ms: 0 })); }
    return response(snapshot());
  } });
  await client.start();
  assert.equal((await client.frame(jpeg())).notification.id, 'one-id');
  assert.equal(client.snapshot.notify, false);
  assert.equal(client.snapshot.notification_id, null);
  assert.equal((await client.frame(jpeg())).notification, null);
  assert.equal(count, 2);
  assert.equal((await client.get()).notify, false);
});

test('failed pause remains locally suspended instead of claiming it succeeded', async () => {
  const client = new FocusApiClient({ fetchImpl: async url => url.endsWith('/control') ? response({ error: { code: 'internal_error', message: 'failure' } }, 500) : response(snapshot()) });
  await client.start();
  await assert.rejects(client.control('pause'), { code: 'internal_error' });
  assert.equal(client.snapshot.state, 'observing');
  assert.equal(client.active, false);
  assert.equal(client.busy, false);
  assert.equal(await client.frame(jpeg()), null);
});

test('expiry while paused follows the deadline and drops frame results after expiry', async () => {
  let now = 0;
  const waiting = deferred();
  const client = new FocusApiClient({ now: () => now, fetchImpl: async url => url.endsWith('/frames') ? waiting.promise : response(snapshot()) });
  await client.start({ durationSeconds: 1 }); const frame = client.frame(jpeg()); now = 1001;
  assert.equal(client.expire(), true);
  waiting.resolve(response(snapshot({ notify: true, notification_id: 'expired' })));
  assert.equal(await frame, null);
  assert.equal(client.snapshot.reason, 'local_session_expired');
  assert.equal(client.remainingMs, 0);
  assert.equal(client.active, false);
});

test('invalid image and malformed response fail without issuing a false notification', async () => {
  let frames = 0;
  const client = new FocusApiClient({ fetchImpl: async url => {
    if (url.endsWith('/frames')) { frames++; return response(snapshot({ notify: true, notification_id: null })); }
    return response(snapshot());
  } });
  await client.start();
  await assert.rejects(client.frame(new Blob(['x'], { type: 'text/plain' })), { code: 'invalid_image' });
  await assert.rejects(client.frame(new Blob([new Uint8Array(1048577)], { type: 'image/jpeg' })), { code: 'invalid_image' });
  assert.equal(frames, 0);
  await assert.rejects(client.frame(jpeg()), { code: 'invalid_snapshot' });
  assert.equal(client.snapshot.notify, false);
});
