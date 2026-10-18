import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Prefer repository dependencies; retain the existing Worker test's offline fallback.
const require = createRequire(import.meta.url);
function dependency(name) {
  try { return require(name); } catch {}
  return require(`${process.env.WRANGLER_NODE_MODULES || '/opt/homebrew/lib/node_modules/wrangler/node_modules'}/${name}`);
}
const { Miniflare, convertV4MiniflareOptions } = dependency('miniflare');
const { build } = dependency('esbuild');
const runtimeOptions = options => convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options;
const ORIGIN = 'https://events.test';
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CALLBACK = 'https://chatgpt.com/focus-test-webhook';
const PROTOCOL = '2026-07-28';
const ADMIN = 'integration-only-ingest-secret-at-least-32-characters';
const SECRET = `whsec_${Buffer.alloc(32, 37).toString('base64')}`;
const VERIFIER = 'a'.repeat(64);
const SOURCE_A = 'source_mac_a_0123456789';
const SOURCE_B = 'source_mac_b_0123456789';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function detection(sessionId = randomUUID(), overrides = {}) {
  const id = randomUUID();
  return {
    eventId: id, name: 'focus.phone_held', timestamp: new Date().toISOString(), cursor: null,
    data: { notification_id: id, session_id: sessionId, device_type: 'mac',
      continuous_hold_ms: 2100, required_hold_ms: 2000, phone_probability: 1,
      observable_probability: 1, provider: 'openai', ...overrides },
  };
}

test('Workers runtime: OAuth pairing, MCP 2.0, signed events, isolation and persisted revocation', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'focus-events-test-'));
  const bundle = join(directory, 'worker.mjs');
  const callbacks = [];
  const callbackErrors = [];
  let callbackStatus = 204;
  await build({ entryPoints: [fileURLToPath(new URL('../src/worker.mjs', import.meta.url))], outfile: bundle,
    bundle: true, format: 'esm', platform: 'neutral', external: ['node:*'] });
  const options = {
    modules: true, script: await readFile(bundle, 'utf8'), compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { FOCUS_EVENTS: { className: 'FocusEventsStore', useSQLite: true } },
    resourcePersistencePath: join(directory, 'storage'),
    bindings: { PUBLIC_ORIGIN: ORIGIN, INGEST_TOKEN: ADMIN, MCP_CALLBACK_HOSTS: 'chatgpt.com' },
    // All callback traffic is intercepted in process; this suite makes no external requests.
    outboundService: async request => {
      try {
        assert.equal(request.url, CALLBACK);
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.get('authorization'), null, 'OAuth/ingest credentials must never reach the callback');
        const body = await request.text();
        const id = request.headers.get('webhook-id');
        const timestamp = request.headers.get('webhook-timestamp');
        assert.match(timestamp, /^\d+$/);
        assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 60);
        const expected = `v1,${createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
        assert.equal(request.headers.get('webhook-signature'), expected, 'verify exact bytes using an independent HMAC implementation');
        const subscriptionId = request.headers.get('x-mcp-subscription-id');
        assert.match(subscriptionId, /^sub_[a-f0-9]{64}$/);
        const payload = JSON.parse(body);
        callbacks.push({ payload, subscriptionId, id, status: callbackStatus });
        if (payload.type === 'verification') {
          assert.deepEqual(Object.keys(payload).sort(), ['challenge', 'type']);
          return Response.json({ challenge: payload.challenge });
        }
        assert.equal(id, payload.eventId);
        assert.deepEqual(Object.keys(payload).sort(), ['cursor', 'data', 'eventId', 'name', 'timestamp']);
        assert.deepEqual(Object.keys(payload.data).sort(), ['continuous_hold_ms', 'device_type', 'notification_id',
          'observable_probability', 'phone_probability', 'provider', 'required_hold_ms', 'session_id']);
        assert.equal(body.includes(ADMIN), false);
        assert.equal(body.includes('data:image'), false);
        return new Response(null, { status: callbackStatus });
      } catch (error) {
        callbackErrors.push(error);
        return new Response(null, { status: 500 });
      }
    },
  };
  let mf = new Miniflare(runtimeOptions(options));
  let rpcId = 0;
  const request = (path, options = {}) => mf.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...options });
  const json = async (path, value, token) => request(path, { method: 'POST', headers: {
    'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(value) });
  const form = (path, data, headers = {}) => request(path, { method: 'POST', headers: {
    'content-type': 'application/x-www-form-urlencoded', ...headers,
  }, body: new URLSearchParams(data).toString() });
  const mint = async (source, scope = 'focus:read focus:events') => {
    const registration = await json('/oauth/register', { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    const pairingResponse = await json('/admin/pairing', { source_id: source }, ADMIN);
    assert.equal(pairingResponse.status, 201);
    const pairing = await pairingResponse.json();
    assert.ok(pairing.code);
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER))).toString('base64url');
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT,
      response_type: 'code', resource: RESOURCE, code_challenge: challenge, code_challenge_method: 'S256', scope, state: 'safe-state' });
    const consent = await request(`/oauth/authorize?${query}`);
    assert.equal(consent.status, 200);
    const html = await consent.text();
    const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
    assert.ok(nonce);
    const authorization = await form('/oauth/authorize', { nonce, pairing_code: pairing.code }, { origin: ORIGIN });
    assert.equal(authorization.status, 303);
    const redirect = new URL(authorization.headers.get('location'));
    assert.equal(redirect.origin, 'https://chatgpt.com');
    assert.equal(redirect.searchParams.get('state'), 'safe-state');
    assert.equal(redirect.searchParams.get('iss'), ORIGIN);
    const tokenResponse = await form('/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id,
      redirect_uri: REDIRECT, resource: RESOURCE, code: redirect.searchParams.get('code'), code_verifier: VERIFIER });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    return { client, tokens, source };
  };
  const rpc = async (account, method, params = {}, headers = {}) => {
    const id = ++rpcId;
    const response = await request('/mcp', { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${account.tokens.access_token}`, 'MCP-Protocol-Version': PROTOCOL,
      'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}), ...headers,
    }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {},
    } } }) });
    const value = await response.json();
    if (value.result) {
      assert.equal(value.id, id);
      assert.equal(value.result.resultType, 'complete');
    }
    return { response, value };
  };
  const tool = async (account, name, args = {}) => {
    const result = await rpc(account, 'tools/call', { name, arguments: args });
    assert.equal(result.response.status, 200);
    assert.equal(result.value.error, undefined);
    return result.value.result.structuredContent;
  };
  const ingest = async (source, event) => {
    const response = await json('/events/ingest', { source_id: source, event }, ADMIN);
    return { response, value: await response.json() };
  };
  const deliveries = () => callbacks.filter(item => item.payload.type !== 'verification');
  const awaitCondition = async (predicate, description) => {
    const deadline = Date.now() + 5000;
    do {
      if (callbackErrors.length) throw callbackErrors[0];
      if (await predicate()) return;
      await sleep(25);
    } while (Date.now() < deadline);
    assert.fail(description);
  };
  const subscriptionParams = { name: 'focus.phone_held', arguments: { device_type: 'mac' },
    delivery: { mode: 'webhook', url: CALLBACK, secret: SECRET }, cursor: null, ttlMs: 600000 };
  const unsubscribeParams = { name: subscriptionParams.name, arguments: subscriptionParams.arguments,
    delivery: { mode: 'webhook', url: CALLBACK } };
  let accountA;
  let accountB;
  let readOnly;
  try {
    await mf.ready;
    await t.test('requires OAuth and scoped source pairing before any callback is possible', async () => {
      assert.equal((await request('/health')).status, 200);
      const unauthorized = await json('/mcp', {});
      assert.equal(unauthorized.status, 401);
      assert.match(unauthorized.headers.get('www-authenticate'), /oauth-protected-resource/);
      assert.equal((await json('/admin/pairing', { source_id: SOURCE_A })).status, 401);
      assert.equal((await json('/events/ingest', { source_id: SOURCE_A, event: detection() })).status, 401);
      assert.equal((await json('/admin/pairing', { source_id: 'invalid' }, ADMIN)).status, 400);
      const metadata = await (await request('/.well-known/oauth-protected-resource/mcp')).json();
      assert.equal(metadata.resource, RESOURCE);
      accountA = await mint(SOURCE_A);
      accountB = await mint(SOURCE_B);
      readOnly = await mint(SOURCE_A, 'focus:read');
      assert.equal((await rpc(readOnly, 'events/subscribe', subscriptionParams)).response.status, 403);
      assert.equal((await tool(readOnly, 'get_profile')).id, SOURCE_A);
      assert.equal((await tool(accountB, 'get_profile')).id, SOURCE_B);
      assert.equal((await ingest(SOURCE_A, detection())).value.queued, 0);
      assert.equal(callbacks.length, 0, 'ingestion cannot publish until an authenticated subscription exists');
    });

    await t.test('discovers MCP 2.0 tools and events, validates transport, and verifies signed subscription', async () => {
      const discovered = await rpc(accountA, 'server/discover');
      assert.deepEqual(discovered.value.result.supportedVersions, [PROTOCOL]);
      assert.deepEqual(discovered.value.result.capabilities.events, {});
      const listing = (await rpc(accountA, 'tools/list')).value.result;
      assert.equal(listing.cacheScope, 'private');
      assert.equal(listing.ttlMs, 0);
      for (const name of ['get_focus_events', 'get_focus_status', 'get_profile', 'list_focus_devices', 'set_device_monitoring']) {
        assert.ok(listing.tools.some(item => item.name === name), `expected tool ${name}`);
      }
      assert.equal(listing.tools.find(item => item.name === 'get_profile')._meta['openai/profile'], true);
      const controlTool = listing.tools.find(item => item.name === 'set_device_monitoring');
      assert.equal(controlTool.annotations.readOnlyHint, false);
      assert.deepEqual(controlTool.securitySchemes, [{ type: 'oauth2', scopes: ['focus:control'] }]);
      const events = (await rpc(accountA, 'events/list')).value.result.events;
      assert.equal(events[0].name, 'focus.phone_held');
      assert.equal(events[0].payloadSchema.additionalProperties, false);
      assert.equal((await rpc(accountA, 'tools/list', {}, { 'Mcp-Method': 'tools/call' })).value.error.code, -32020);
      assert.equal((await rpc(accountA, 'tools/list', {}, { origin: 'https://attacker.example' })).response.status, 403);
      const blocked = await rpc(accountA, 'events/subscribe', { ...subscriptionParams,
        delivery: { ...subscriptionParams.delivery, url: 'https://attacker.example/callback' } });
      assert.equal(blocked.value.error.code, -32015);
      assert.equal(callbacks.length, 0);
      const subscribed = await rpc(accountA, 'events/subscribe', subscriptionParams);
      if (callbackErrors.length) throw callbackErrors[0];
      assert.equal(subscribed.value.error, undefined);
      assert.ok(subscribed.value.result.refreshBefore);
      assert.equal(callbacks.length, 1);
      assert.equal(callbacks[0].payload.type, 'verification');
      assert.equal(callbacks[0].subscriptionId, subscribed.value.result.id);
    });

    await t.test('delivers matching events exactly once and isolates source, filters, and sensitive payloads', async () => {
      const matching = detection();
      const accepted = await ingest(SOURCE_A, matching);
      assert.equal(accepted.response.status, 202);
      assert.equal(accepted.value.queued, 1);
      await awaitCondition(async () => (await tool(accountA, 'get_focus_status')).pending_deliveries === 0, 'matching delivery should finish');
      assert.equal(deliveries().length, 1);
      assert.deepEqual(deliveries()[0].payload, matching);
      assert.equal((await ingest(SOURCE_A, matching)).value.duplicate, true);
      assert.equal((await ingest(SOURCE_B, detection())).value.queued, 0);
      assert.equal((await ingest(SOURCE_A, detection(randomUUID(), { device_type: 'reachy_mini' }))).value.queued, 0);
      const invalid = detection();
      invalid.data.image = 'data:image/jpeg;base64,c2VjcmV0';
      assert.equal((await ingest(SOURCE_A, invalid)).response.status, 400);
      const eventsA = await tool(accountA, 'get_focus_events', { session_id: matching.data.session_id });
      assert.deepEqual(eventsA.events, [matching]);
      assert.deepEqual((await tool(accountB, 'get_focus_events', { session_id: matching.data.session_id })).events, []);
      assert.deepEqual((await tool(accountB, 'get_focus_status')).subscriptions, []);
      assert.equal(deliveries().length, 1);
      assert.equal((await tool(accountA, 'get_focus_status')).subscriptions[0].delivered, 1);
      assert.equal(callbackErrors.length, 0);
    });

    await t.test('SQLite restart preserves OAuth grants, subscriptions, dedupe, and queued event retries', async () => {
      callbackStatus = 503;
      const pending = detection();
      assert.equal((await ingest(SOURCE_A, pending)).value.queued, 1);
      await awaitCondition(async () => {
        const status = await tool(accountA, 'get_focus_status');
        return status.pending_deliveries === 1 && status.subscriptions[0].lastDeliveryStatus === 503;
      }, 'failed event should be durably scheduled for retry');
      await mf.dispose();
      const files = await readdir(join(directory, 'storage'), { recursive: true });
      assert.ok(files.some(file => file.endsWith('.sqlite')), 'Durable Object uses SQLite persistence');
      for (const file of files.filter(file => file.endsWith('.sqlite'))) {
        const bytes = await readFile(join(directory, 'storage', file));
        assert.equal(bytes.includes(Buffer.from(ADMIN)), false);
        assert.equal(bytes.includes(Buffer.from(accountA.tokens.access_token)), false);
        assert.equal(bytes.includes(Buffer.from(accountA.tokens.refresh_token)), false);
        assert.equal(bytes.includes(Buffer.from('data:image/jpeg')), false);
      }
      callbackStatus = 204;
      mf = new Miniflare(runtimeOptions(options));
      assert.equal((await tool(accountA, 'get_profile')).id, SOURCE_A);
      assert.equal((await ingest(SOURCE_A, pending)).value.duplicate, true);
      await awaitCondition(async () => (await tool(accountA, 'get_focus_status')).pending_deliveries === 0, 'persisted alarm should retry queued event after restart');
      assert.equal(deliveries().filter(item => item.payload.eventId === pending.eventId && item.status === 204).length, 1);
      assert.equal((await tool(accountA, 'get_focus_status')).subscriptions[0].delivered, 2);
      assert.ok((await tool(accountA, 'get_focus_events')).events.some(event => event.eventId === pending.eventId));
    });

    await t.test('remote monitoring enforces source and control scope, local arming, online state, and device acknowledgement', async () => {
      const deviceId = randomUUID();
      const heartbeat = { source_id: SOURCE_A, device_id: deviceId, device_type: 'mac', name: 'Integration Mac',
        observed_state: 'off', remote_enabled: false, applied_revision: 0, session_id: null };
      for (const path of ['/devices/heartbeat', '/devices/list', '/devices/control']) {
        assert.equal((await json(path, heartbeat)).status, 401);
      }
      assert.equal((await json('/devices/heartbeat', heartbeat, ADMIN)).status, 200);
      assert.equal((await json('/devices/heartbeat', { ...heartbeat, applied_revision: 99 }, ADMIN)).status, 409);
      const localList = await (await json('/devices/list', { source_id: SOURCE_A }, ADMIN)).json();
      assert.equal(localList.devices.length, 1);
      assert.equal(localList.devices[0].online, true);
      assert.deepEqual((await (await json('/devices/list', { source_id: SOURCE_B }, ADMIN)).json()).devices, []);
      assert.deepEqual((await tool(accountB, 'list_focus_devices')).devices, []);
      assert.equal((await tool(readOnly, 'list_focus_devices')).devices[0].device_id, deviceId);
      const setParams = { name: 'set_device_monitoring', arguments: { device_id: deviceId, enabled: true } };
      const forbidden = await rpc(readOnly, 'tools/call', setParams);
      assert.equal(forbidden.response.status, 403);
      assert.match(forbidden.response.headers.get('www-authenticate'), /focus:control/);
      const controlA = await mint(SOURCE_A, 'focus:read focus:control');
      const controlB = await mint(SOURCE_B, 'focus:read focus:control');
      const crossSource = await rpc(controlB, 'tools/call', setParams);
      assert.equal(crossSource.value.result.isError, true);
      assert.equal(crossSource.value.result.structuredContent.error, 'device_not_found');
      assert.equal((await json('/devices/control', { source_id: SOURCE_B, device_id: deviceId, enabled: true }, ADMIN)).status, 404);
      const unarmed = await rpc(controlA, 'tools/call', setParams);
      assert.equal(unarmed.value.result.isError, true);
      assert.equal(unarmed.value.result.structuredContent.error, 'remote_disabled');
      await json('/devices/heartbeat', { ...heartbeat, remote_enabled: true }, ADMIN);
      const on = await tool(controlA, 'set_device_monitoring', setParams.arguments);
      assert.equal(on.desired_state, 'on');
      assert.equal(on.observed_state, 'off', 'issuing ON is not confirmation that the camera started');
      assert.equal(on.applied_revision, 0);
      assert.equal(on.revision, 1);
      assert.ok(on.command_expires_at);
      const sessionId = randomUUID();
      const acknowledgement = await json('/devices/heartbeat', { ...heartbeat, remote_enabled: true,
        observed_state: 'on', applied_revision: on.revision, session_id: sessionId }, ADMIN);
      assert.equal(acknowledgement.status, 200);
      const actual = (await tool(controlA, 'list_focus_devices')).devices[0];
      assert.equal(actual.observed_state, 'on');
      assert.equal(actual.applied_revision, on.revision);
      assert.equal(actual.session_id, sessionId);
      assert.equal(actual.command_expires_at, null);
      // Exercise the real runtime's online timeout; no fake clock or storage mutation bypasses HTTP.
      await sleep(10050);
      assert.equal((await tool(controlA, 'list_focus_devices')).devices[0].online, false);
      const offlineOn = await json('/devices/control', { source_id: SOURCE_A, device_id: deviceId, enabled: true }, ADMIN);
      assert.equal(offlineOn.status, 409);
      assert.equal((await offlineOn.json()).error, 'device_offline');
      const offlineOff = await tool(controlA, 'set_device_monitoring', { device_id: deviceId, enabled: false });
      assert.equal(offlineOff.desired_state, 'off');
      assert.equal(offlineOff.observed_state, 'on', 'an offline device cannot confirm stopping until it reconnects');
      assert.equal(offlineOff.online, false);
      const adminOff = await json('/devices/control', { source_id: SOURCE_A, device_id: deviceId, enabled: false }, ADMIN);
      assert.equal(adminOff.status, 200);
      const finalCommand = await adminOff.json();
      const stopped = await (await json('/devices/heartbeat', { ...heartbeat, remote_enabled: true,
        applied_revision: finalCommand.revision }, ADMIN)).json();
      assert.equal(stopped.observed_state, 'off');
      assert.equal(stopped.applied_revision, finalCommand.revision);
      assert.equal((await tool(accountB, 'list_focus_devices')).devices.length, 0);
    });

    await t.test('another source cannot unsubscribe, while unsubscribe and OAuth revocation stop delivery', async () => {
      await rpc(accountB, 'events/unsubscribe', unsubscribeParams);
      assert.equal((await tool(accountA, 'get_focus_status')).subscriptions.length, 1);
      callbackStatus = 503;
      const cancelledRetry = detection();
      await ingest(SOURCE_A, cancelledRetry);
      await awaitCondition(async () => {
        const status = await tool(accountA, 'get_focus_status');
        return status.pending_deliveries === 1 && status.subscriptions[0].lastDeliveryStatus === 503;
      }, 'a failed delivery should be pending before unsubscribe');
      const before = deliveries().length;
      assert.equal((await rpc(accountA, 'events/unsubscribe', unsubscribeParams)).value.error, undefined);
      assert.deepEqual((await tool(accountA, 'get_focus_status')).subscriptions, []);
      assert.equal((await tool(accountA, 'get_focus_status')).pending_deliveries, 0);
      callbackStatus = 204;
      assert.equal((await ingest(SOURCE_A, detection())).value.queued, 0);
      await sleep(1100);
      assert.equal(deliveries().length, before);
      assert.equal((await rpc(accountA, 'events/subscribe', subscriptionParams)).value.error, undefined);
      const revoke = await form('/oauth/revoke', { client_id: accountA.client.client_id, token: accountA.tokens.access_token });
      assert.equal(revoke.status, 200);
      assert.equal((await rpc(accountA, 'tools/list')).response.status, 401);
      assert.equal((await form('/oauth/token', { grant_type: 'refresh_token', client_id: accountA.client.client_id,
        resource: RESOURCE, refresh_token: accountA.tokens.refresh_token })).status, 400);
      await ingest(SOURCE_A, detection());
      const newGrant = await mint(SOURCE_A);
      await awaitCondition(async () => (await tool(newGrant, 'get_focus_status')).subscriptions.length === 0, 'revoked subscription should be removed without delivering');
      assert.equal(deliveries().length, before);
      assert.equal((await tool(accountB, 'get_profile')).id, SOURCE_B);
      assert.equal(callbackErrors.length, 0);
    });
  } finally {
    await mf.dispose().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
