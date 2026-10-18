import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { CallbackSecurityError, MAX_EVENT_BYTES, validateCallbackUrl, parseSigningSecret, signWebhook, verifyCallback, deliverEvent } from '../src/webhook.mjs';

const key = Buffer.from('0123456789abcdef0123456789abcdef');
const secret = `whsec_${key.toString('base64')}`;
const previousKey = Buffer.from('fedcba9876543210fedcba9876543210');
const previousSecret = `whsec_${previousKey.toString('base64')}`;
const allowedHosts = ['chatgpt.com', 'chat.openai.com', 'api.openai.com'];
const url = 'https://chatgpt.com/mcp-events/callback_test';
const subscription = { id: 'sub_test', name: 'focus.phone_held', url, secret };
const event = {
  eventId: 'evt_test', name: 'focus.phone_held', timestamp: '2026-10-18T04:05:06.000Z',
  data: { session_id: 'session_test', message: 'スマホを持っています。', continuous_hold_ms: 2000 }, cursor: null,
};
const clock = () => 1792296306000;
const signature = (keyBytes, id, timestamp, body) => `v1,${createHmac('sha256', keyBytes).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64')}`;

test('callback allowlist is exact, HTTPS-only and rejects private/IP/local/ambiguous URLs', () => {
  assert.equal(validateCallbackUrl('https://CHATGPT.com:443/path?a=1', allowedHosts), 'https://chatgpt.com/path?a=1');
  assert.equal(validateCallbackUrl(url, 'chatgpt.com,api.openai.com'), url);
  assert.equal(validateCallbackUrl(url, new Set(allowedHosts)), url);
  for (const candidate of [
    'http://chatgpt.com/callback', 'https://chatgpt.com:444/callback', 'https://user:pass@chatgpt.com/',
    'https://@chatgpt.com/', 'https://chatgpt.com/#fragment', 'https://chatgpt.com/#',
    'https://chatgpt.com.evil.example/', 'https://evil.chatgpt.com/', 'https://chatgpt.com./',
    'https://localhost/', 'https://127.0.0.1/', 'https://10.0.0.1/', 'https://169.254.169.254/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://0x7f000001/', 'https://2130706433/',
    'https://192.168.1.1/', 'https://service.local/', 'https://service.internal/',
    'https://chatgpt.com\\@evil.example/', 'https://chatgpt.com\n/', ' https://chatgpt.com/',
    'https:chatgpt.com/callback', '/relative', 'data:text/plain,test',
  ]) {
    assert.throws(() => validateCallbackUrl(candidate, [...allowedHosts, '127.0.0.1', 'service.local', '[::1]', 'service.internal']), CallbackSecurityError, candidate);
  }
  assert.throws(() => validateCallbackUrl(url, ['*.chatgpt.com']), /callback_host_not_allowed/);
  assert.throws(() => validateCallbackUrl(url, []), /callback_host_not_allowed/);
});

test('signing secret requires strict base64 encoding of 24–64 bytes', () => {
  assert.deepEqual(Buffer.from(parseSigningSecret(secret)), key);
  assert.deepEqual(Buffer.from(parseSigningSecret(secret.replace(/=+$/, ''))), key);
  for (const size of [24, 64]) assert.equal(parseSigningSecret(`whsec_${Buffer.alloc(size, 1).toString('base64')}`).length, size);
  for (const candidate of [
    null, '', key.toString('base64'), `other_${key.toString('base64')}`, `${secret}\n`,
    `whsec_${Buffer.alloc(23).toString('base64')}`, `whsec_${Buffer.alloc(65).toString('base64')}`,
    'whsec_!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!', `${secret}=`, secret.replace('=', '==='),
    'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!', 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB=',
  ]) assert.throws(() => parseSigningSecret(candidate), /invalid_secret/);
});

test('Standard Webhooks signature covers exact Unicode bytes, ID and Unix seconds; rotation appends both signatures', () => {
  const timestamp = 1792296306;
  const body = JSON.stringify(event);
  const expected = signature(key, event.eventId, timestamp, body);
  assert.equal(signWebhook({ secret, id: event.eventId, timestamp, body }), expected);
  assert.notEqual(signWebhook({ secret, id: event.eventId, timestamp, body: `${body}\n` }), expected);
  assert.notEqual(signWebhook({ secret, id: 'evt_other', timestamp, body }), expected);
  assert.equal(signWebhook({ secret, previousSecret, id: event.eventId, timestamp, body }), `${expected} ${signature(previousKey, event.eventId, timestamp, body)}`);
  assert.equal(signWebhook({ secret, previousSecret: secret, id: event.eventId, timestamp, body }), expected);
  assert.throws(() => signWebhook({ secret, id: 'bad\r\nid', timestamp, body }), /invalid_event/);
});

test('callback verification sends unique signed challenges, no credentials, and accepts only the echoed challenge', async () => {
  const ids = new Set();
  const challenges = new Set();
  const fetchImpl = async (actualUrl, options) => {
    assert.equal(actualUrl, url);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers['X-MCP-Subscription-Id'], subscription.id);
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.type, 'verification');
    assert.equal(body.challenge.length, 43);
    assert.equal(options.headers['webhook-signature'], signature(key, options.headers['webhook-id'], options.headers['webhook-timestamp'], options.body));
    ids.add(options.headers['webhook-id']);
    challenges.add(body.challenge);
    return Response.json({ challenge: body.challenge });
  };
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(await verifyCallback({ url, secret, subscriptionId: subscription.id, allowedHosts, clock, fetchImpl }), { accepted: true, status: 200, reason: null });
  }
  assert.equal(ids.size, 2);
  assert.equal(challenges.size, 2);
});

test('verification rejects wrong echoes, non-2xx, malformed/large responses, and never exposes upstream text', async () => {
  for (const [response, reason] of [
    [Response.json({ challenge: 'different' }), 'challenge_failed'],
    [Response.json({ challenge: null }), 'challenge_failed'],
    [new Response('upstream-secret-diagnostic'), 'challenge_failed'],
    [new Response('upstream-secret-diagnostic', { status: 401 }), 'challenge_failed'],
    [new Response('x'.repeat(4097)), 'response_too_large'],
    [new Response('{}', { headers: { 'content-length': '4097' } }), 'response_too_large'],
  ]) {
    const result = await verifyCallback({ url, secret, subscriptionId: subscription.id, allowedHosts, fetchImpl: async () => response });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, reason);
    assert.ok(!JSON.stringify(result).includes('upstream-secret-diagnostic'));
  }
});

test('validation fails before any outbound request and redirect responses are refused', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }); };
  assert.equal((await verifyCallback({ url: 'https://evil.example/', secret, subscriptionId: subscription.id, allowedHosts, fetchImpl })).accepted, false);
  assert.equal((await verifyCallback({ url, secret: 'bad', subscriptionId: subscription.id, allowedHosts, fetchImpl })).accepted, false);
  assert.equal(requests, 0);
  assert.deepEqual(await verifyCallback({ url, secret, subscriptionId: subscription.id, allowedHosts, fetchImpl }), { accepted: false, status: 302, reason: 'redirect_refused' });
  const result = await deliverEvent({ subscription, event, allowedHosts, fetchImpl });
  assert.equal(result.reason, 'redirect_refused');
  assert.equal(result.terminal, true);
  assert.equal(result.retryable, false);
  assert.equal(requests, 2);
});

test('verification deadline covers both stalled headers and a stalled body', async () => {
  for (const stalledBody of [false, true]) {
    let signal;
    let bodyCancelled = false;
    const fetchImpl = async (_, options) => {
      signal = options.signal;
      if (!stalledBody) return new Promise(() => {});
      return new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }));
    };
    const started = Date.now();
    const result = await verifyCallback({ url, secret, subscriptionId: subscription.id, allowedHosts, fetchImpl, timeoutMs: 25 });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'timeout');
    assert.ok(signal.aborted);
    assert.ok(Date.now() - started < 1000);
    if (stalledBody) assert.equal(bodyCancelled, true);
  }
});

test('manual redirect handling rejects every 3xx status without issuing a second request', async () => {
  let requests = 0;
  for (let status = 300; status < 400; status++) {
    const fetchImpl = async (actualUrl, options) => {
      requests++;
      assert.equal(actualUrl, url);
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status, headers: { location: 'http://169.254.169.254/credentials' } });
    };
    const verification = await verifyCallback({ url, secret, subscriptionId: subscription.id, allowedHosts, fetchImpl });
    assert.deepEqual(verification, { accepted: false, status, reason: 'redirect_refused' });
    const delivery = await deliverEvent({ subscription, event, allowedHosts, fetchImpl });
    assert.equal(delivery.status, status);
    assert.equal(delivery.reason, 'redirect_refused');
    assert.equal(delivery.retryable, false);
    assert.equal(delivery.terminal, true);
  }
  assert.equal(requests, 200);
});

test('a response that arrives after the deadline is cancelled without processing a challenge', async () => {
  let finishFetch;
  let cancelled = false;
  const fetchImpl = () => new Promise((resolve) => { finishFetch = resolve; });
  const result = await verifyCallback({ url, secret, subscriptionId: subscription.id, allowedHosts, fetchImpl, timeoutMs: 10 });
  assert.equal(result.reason, 'timeout');
  finishFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('delivery sends one exact signed event, does not read arbitrary response data, and preserves ID on retries', async () => {
  let calls = 0;
  const seen = [];
  const fetchImpl = async (actualUrl, options) => {
    assert.equal(actualUrl, url);
    assert.equal(options.body, JSON.stringify(event));
    assert.equal(options.headers['webhook-id'], event.eventId);
    assert.equal(options.headers['X-MCP-Subscription-Id'], subscription.id);
    assert.equal(options.headers['webhook-signature'], `${signature(key, event.eventId, options.headers['webhook-timestamp'], options.body)} ${signature(previousKey, event.eventId, options.headers['webhook-timestamp'], options.body)}`);
    assert.equal(options.redirect, 'manual');
    seen.push({ id: options.headers['webhook-id'], timestamp: options.headers['webhook-timestamp'] });
    calls++;
    return new Response(new ReadableStream(), { status: 202 });
  };
  for (let index = 0; index < 2; index++) {
    const result = await deliverEvent({ subscription: { ...subscription, previousSecret }, event, allowedHosts, fetchImpl, clock: () => clock() + index * 1000 });
    assert.deepEqual(result, { accepted: true, status: 202, retryable: false, terminal: false, disableSubscription: false, reason: null });
  }
  assert.equal(calls, 2);
  assert.equal(seen[0].id, seen[1].id);
  assert.notEqual(seen[0].timestamp, seen[1].timestamp);
});

test('delivery rejects invalid events and enforces 256 KiB UTF-8 request limit before fetching', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(null, { status: 204 }); };
  const circular = { ...event, data: {} }; circular.data.self = circular;
  for (const invalid of [
    { ...event, eventId: 42 }, { ...event, name: 'wrong.event' }, { ...event, timestamp: '2026-10-18T04:05:06' },
    { ...event, timestamp: 'October 18 2026Z' }, { ...event, type: 'control' }, { ...event, data: [] },
    { ...event, cursor: undefined }, circular,
  ]) {
    const result = await deliverEvent({ subscription, event: invalid, allowedHosts, fetchImpl });
    assert.equal(result.terminal, true);
    assert.equal(result.reason, 'invalid_event');
  }
  const tooLarge = { ...event, data: { text: 'あ'.repeat(MAX_EVENT_BYTES / 2) } };
  const result = await deliverEvent({ subscription, event: tooLarge, allowedHosts, fetchImpl });
  assert.equal(result.reason, 'payload_too_large');
  assert.equal(result.retryable, false);
  assert.equal(calls, 0);
  const base = { ...event, data: { text: '' } };
  const overhead = Buffer.byteLength(JSON.stringify(base));
  assert.equal((await deliverEvent({ subscription, event: { ...base, data: { text: 'a'.repeat(MAX_EVENT_BYTES - overhead) } }, allowedHosts, fetchImpl })).accepted, true);
  assert.equal(calls, 1);
});

test('HTTP delivery classification disables 410, drops 413, and retries only transient failures', async () => {
  for (const [status, accepted, retryable, disableSubscription] of [
    [200, true, false, false], [204, true, false, false], [400, false, false, false],
    [401, false, false, false], [403, false, false, false], [410, false, false, true],
    [413, false, false, false], [429, false, true, false], [500, false, true, false], [503, false, true, false],
  ]) {
    const result = await deliverEvent({ subscription, event, allowedHosts, fetchImpl: async () => new Response(null, { status }) });
    assert.equal(result.accepted, accepted, `accepted ${status}`);
    assert.equal(result.retryable, retryable, `retryable ${status}`);
    assert.equal(result.terminal, !accepted && !retryable, `terminal ${status}`);
    assert.equal(result.disableSubscription, disableSubscription, `disable ${status}`);
  }
  const network = await deliverEvent({ subscription, event, allowedHosts, fetchImpl: async () => { throw new Error('secret-in-upstream-error'); } });
  assert.equal(network.reason, 'network_error');
  assert.equal(network.retryable, true);
  assert.ok(!JSON.stringify(network).includes('secret-in-upstream-error'));
  const timeout = await deliverEvent({ subscription, event, allowedHosts, timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
  assert.equal(timeout.reason, 'timeout');
  assert.equal(timeout.retryable, true);
});
