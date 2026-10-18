import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Run from the repository root after deploying the Events Worker:
// node --env-file=cloudflare/.env.connection scripts/smoke-events.mjs
// Uses FOCUS_EVENTS_URL, FOCUS_EVENTS_TOKEN and FOCUS_SOURCE_ID.
// A stable, separate smoke principal/device is derived from the configured source.
// No real device, camera, AI inference, subscription or external callback is used.
const VERSION = '2026-07-28';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const DEVICE_ID = 'smoke-fake-mac-v1';
const DEVICE_NAME = 'SMOKE TEST - no camera';
let passed = 0;
let failed = 0;

class SmokeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireValue = (condition, code = 'unexpected_response') => { if (!condition) throw new SmokeError(code); };
async function check(name, operation) {
  try {
    const value = await operation();
    passed += 1;
    console.log(`PASS ${name}`);
    return value;
  } catch (error) {
    failed += 1;
    const reason = error instanceof SmokeError && /^[a-z0-9_]{1,100}$/.test(error.code) ? error.code : 'request_failed';
    // Never log raw exceptions, URLs with query strings, response bodies, or credentials.
    console.log(`FAIL ${name} reason=${reason}`);
    throw error;
  }
}

async function main() {
  const configuration = await check('configuration', async () => {
    let url;
    try { url = new URL(process.env.FOCUS_EVENTS_URL); } catch { throw new SmokeError('invalid_events_url'); }
    requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === '/' || url.pathname === ''), 'invalid_events_url');
    const token = process.env.FOCUS_EVENTS_TOKEN;
    requireValue(typeof token === 'string' && token.length >= 32 && token.trim() === token, 'missing_events_token');
    const configuredSource = process.env.FOCUS_SOURCE_ID;
    requireValue(typeof configuredSource === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(configuredSource), 'invalid_events_source');
    // Reuse this isolated fixture across runs, avoiding growth in the device registry.
    const source = `smoke_${createHash('sha256').update(`focus-events-smoke-v1:${configuredSource}`).digest('hex').slice(0, 40)}`;
    requireValue(source !== configuredSource, 'fixture_must_be_isolated');
    return { origin: url.origin, token, source };
  });
  const { origin, token, source } = configuration;
  console.log(`TARGET ${origin}/mcp fake_device=${DEVICE_ID}`);
  let rpcId = 0;
  let account;
  let fixtureRegistered = false;
  let fixtureRevision = 0;

  async function request(path, { method = 'GET', body, headers = {} } = {}, expected = 200) {
    let response;
    const started = Date.now();
    try {
      response = await fetch(`${origin}${path}`, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    } catch { throw new SmokeError('network_or_timeout'); }
    if (process.env.FOCUS_SMOKE_TIMING === '1') console.log(`HTTP ${method} ${path.split('?')[0]} status=${response.status} elapsed_ms=${Date.now() - started}`);
    requireValue(response.status === expected, `http_${response.status}_expected_${expected}`);
    return response;
  }
  async function readJson(response) {
    try { return await response.json(); } catch { throw new SmokeError('invalid_json'); }
  }
  const json = (path, body, credential, expected = 200) => request(path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(body),
  }, expected).then(readJson);
  const admin = (path, body, expected = 200) => json(path, { source_id: source, ...body }, token, expected);
  const form = (path, body, headers = {}, expected = 200) => request(path, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString(),
  }, expected);
  async function rpc(method, params = {}, expected = 200) {
    const id = ++rpcId;
    const response = await request('/mcp', { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${account.accessToken}`, 'MCP-Protocol-Version': VERSION, 'Mcp-Method': method,
      ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientCapabilities': {},
    } } }) }, expected);
    const payload = await readJson(response);
    if (expected !== 200) return payload;
    requireValue(payload.jsonrpc === '2.0' && payload.id === id && !payload.error && payload.result?.resultType === 'complete', 'invalid_mcp_result');
    return payload.result;
  }
  async function tool(name, args = {}, expectError = false) {
    const result = await rpc('tools/call', { name, arguments: args });
    if (result.isError && !expectError) {
      const allowed = new Set(['invalid_device_request', 'device_not_found', 'device_offline', 'remote_disabled', 'future_revision', 'device_capacity']);
      const code = result.structuredContent?.error;
      throw new SmokeError(allowed.has(code) ? `tool_${code}` : 'unexpected_tool_error');
    }
    requireValue(result.isError === expectError && result.structuredContent && typeof result.structuredContent === 'object', 'invalid_tool_result');
    return result.structuredContent;
  }
  async function heartbeat(observedState, remoteEnabled, revision, sessionId = null) {
    const result = await admin('/devices/heartbeat', { device_id: DEVICE_ID, device_type: 'mac', name: DEVICE_NAME,
      observed_state: observedState, remote_enabled: remoteEnabled, applied_revision: revision, session_id: sessionId });
    requireValue(result.device_id === DEVICE_ID && Number.isSafeInteger(result.revision), 'invalid_device_response');
    fixtureRegistered = true;
    fixtureRevision = result.revision;
    return result;
  }

  try {
    await check('health', async () => {
      const health = await readJson(await request('/health'));
      requireValue(health.service === 'focus-events' && health.configured === true && health.protocol_version === VERSION);
    });
    await check('unauthenticated_access_denied', async () => {
      await json('/admin/pairing', { source_id: source }, undefined, 401);
      await json('/mcp', {}, undefined, 401);
    });
    await check('oauth_pairing_pkce', async () => {
      const client = await json('/oauth/register', { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }, undefined, 201);
      requireValue(typeof client.client_id === 'string' && client.token_endpoint_auth_method === 'none', 'invalid_oauth_registration');
      const pairing = await admin('/admin/pairing', {}, 201);
      requireValue(typeof pairing.code === 'string', 'invalid_pairing_response');
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const state = randomUUID();
      const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code',
        resource: `${origin}/mcp`, code_challenge: challenge, code_challenge_method: 'S256',
        scope: 'focus:read focus:events focus:control', state });
      const consentPage = await (await request(`/oauth/authorize?${query}`)).text();
      const nonce = consentPage.match(/name="nonce" value="([^"]+)"/)?.[1];
      requireValue(typeof nonce === 'string', 'invalid_oauth_consent');
      const authorization = await form('/oauth/authorize', { nonce, pairing_code: pairing.code }, { origin }, 303);
      let redirect;
      try { redirect = new URL(authorization.headers.get('location')); } catch { throw new SmokeError('invalid_oauth_redirect'); }
      requireValue(`${redirect.origin}${redirect.pathname}` === REDIRECT && redirect.searchParams.get('state') === state &&
        redirect.searchParams.get('iss') === origin && redirect.searchParams.get('code'), 'invalid_oauth_redirect');
      const tokens = await readJson(await form('/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id,
        redirect_uri: REDIRECT, resource: `${origin}/mcp`, code: redirect.searchParams.get('code'), code_verifier: verifier }));
      requireValue(typeof tokens.access_token === 'string' && tokens.token_type === 'Bearer', 'invalid_oauth_tokens');
      account = { clientId: client.client_id, accessToken: tokens.access_token };
    });
    await check('mcp_discovery_and_tools', async () => {
      const discovery = await rpc('server/discover');
      requireValue(discovery.supportedVersions?.includes(VERSION) && discovery.capabilities?.events && discovery.capabilities?.tools);
      const listing = await rpc('tools/list');
      for (const name of ['get_profile', 'get_focus_events', 'list_focus_devices', 'set_device_monitoring']) {
        requireValue(listing.tools?.some(item => item.name === name), 'required_tool_missing');
      }
      const control = listing.tools.find(item => item.name === 'set_device_monitoring');
      requireValue(control.annotations?.readOnlyHint === false && control.securitySchemes?.some(item => item.scopes?.includes('focus:control')));
      requireValue((await tool('get_profile')).id === source, 'wrong_profile');
      const status = await tool('get_focus_status');
      requireValue(Array.isArray(status.subscriptions) && status.subscriptions.length === 0 && status.pending_deliveries === 0, 'fixture_has_unexpected_subscriptions');
    });
    await check('isolated_fake_device_disarmed', async () => {
      const listed = await admin('/devices/list', {});
      requireValue(Array.isArray(listed.devices), 'invalid_device_list');
      const existing = listed.devices.find(device => device.device_id === DEVICE_ID);
      if (existing) {
        requireValue(existing.name === DEVICE_NAME && existing.type === 'mac', 'fixture_identity_conflict');
        const off = await admin('/devices/control', { device_id: DEVICE_ID, enabled: false });
        fixtureRevision = off.revision;
      }
      const registered = await heartbeat('off', false, fixtureRevision);
      requireValue(registered.online && registered.observed_state === 'off' && registered.desired_state === 'off' && !registered.remote_enabled);
    });
    await check('remote_on_requires_local_permission', async () => {
      const blocked = await tool('set_device_monitoring', { device_id: DEVICE_ID, enabled: true }, true);
      requireValue(blocked.error === 'remote_disabled');
    });
    await check('remote_on_pending_then_acknowledged', async () => {
      await heartbeat('off', true, fixtureRevision);
      const command = await tool('set_device_monitoring', { device_id: DEVICE_ID, enabled: true });
      requireValue(command.desired_state === 'on' && command.observed_state === 'off' && command.revision > command.applied_revision && command.command_expires_at);
      fixtureRevision = command.revision;
      const acknowledgement = await heartbeat('on', true, fixtureRevision, randomUUID());
      requireValue(acknowledgement.observed_state === 'on' && acknowledgement.desired_state === 'on' &&
        acknowledgement.applied_revision === command.revision && acknowledgement.command_expires_at === null);
    });
    await check('remote_off_pending_then_acknowledged', async () => {
      const command = await tool('set_device_monitoring', { device_id: DEVICE_ID, enabled: false });
      requireValue(command.desired_state === 'off' && command.observed_state === 'on' && command.revision > command.applied_revision);
      fixtureRevision = command.revision;
      const acknowledgement = await heartbeat('off', false, fixtureRevision);
      requireValue(acknowledgement.observed_state === 'off' && acknowledgement.desired_state === 'off' &&
        acknowledgement.applied_revision === command.revision && !acknowledgement.remote_enabled);
      const listed = await tool('list_focus_devices');
      requireValue(listed.devices?.some(device => device.device_id === DEVICE_ID && device.observed_state === 'off'));
    });
    await check('synthetic_event_history_and_deduplication', async () => {
      const id = randomUUID();
      const sessionId = randomUUID();
      const event = { eventId: id, name: 'focus.phone_held', timestamp: new Date().toISOString(), cursor: null,
        data: { notification_id: id, session_id: sessionId, device_type: 'mac', continuous_hold_ms: 2100,
          required_hold_ms: 2000, phone_probability: 1, observable_probability: 1, provider: 'smoke_test' } };
      const accepted = await admin('/events/ingest', { event }, 202);
      requireValue(accepted.accepted && !accepted.duplicate && accepted.eventId === id && accepted.queued === 0);
      const duplicate = await admin('/events/ingest', { event }, 202);
      requireValue(duplicate.accepted && duplicate.duplicate && duplicate.queued === 0);
      const history = await tool('get_focus_events', { session_id: sessionId, limit: 10 });
      requireValue(history.events?.length === 1 && history.events[0].eventId === id &&
        Object.keys(history.events[0].data).length === 8 && Object.entries(event.data).every(([key, value]) => history.events[0].data[key] === value));
    });
  } finally {
    // Always leave the fake fixture OFF/disarmed, even when a later assertion fails.
    if (fixtureRegistered) {
      await check('cleanup_fake_device_off', async () => {
        const command = await admin('/devices/control', { device_id: DEVICE_ID, enabled: false });
        const stopped = await heartbeat('off', false, command.revision);
        requireValue(stopped.desired_state === 'off' && stopped.observed_state === 'off' && !stopped.remote_enabled);
      }).catch(() => {});
    }
    if (account) {
      await check('oauth_revocation', async () => {
        await form('/oauth/revoke', { client_id: account.clientId, token: account.accessToken });
        await rpc('tools/list', {}, 401);
      }).catch(() => {});
    }
  }
}

await main().catch(() => {});
console.log(`${failed ? 'FAIL' : 'PASS'} events_smoke passed=${passed} failed=${failed}`);
process.exitCode = failed ? 1 : 0;
