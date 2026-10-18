import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuthService } from '../src/oauth.mjs';

const ORIGIN = 'https://focus-events.example.workers.dev';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const RESOURCE = `${ORIGIN}/mcp`;
const VERIFIER = 'a'.repeat(64);
const challenge = async verifier => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');

class MemoryStorage {
  data = new Map();
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async delete(key) { return this.data.delete(key); }
  async list({ prefix, limit }) { return new Map([...this.data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)); }
}

function setup() {
  const storage = new MemoryStorage();
  let now = Date.UTC(2026, 9, 18);
  const service = new OAuthService({ storage, origin: ORIGIN, clock: () => now });
  const request = (path, options) => service.handle(new Request(`${ORIGIN}${path}`, options));
  const form = (path, data, origin = undefined) => request(path, { method: 'POST', headers: {
    'content-type': 'application/x-www-form-urlencoded', ...(origin === undefined ? {} : { origin }),
  }, body: new URLSearchParams(data) });
  const register = async overrides => {
    const response = await request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...overrides }) });
    return { response, data: await response.json() };
  };
  const page = async (clientId, overrides = {}) => {
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
      resource: RESOURCE, code_challenge: await challenge(VERIFIER), code_challenge_method: 'S256',
      scope: 'focus:read focus:events', state: 'state-<safe>', ...overrides });
    const response = await request(`/oauth/authorize?${query}`);
    const text = await response.text();
    return { response, text, nonce: text.match(/name="nonce" value="([^"]+)"/)?.[1] };
  };
  const authorize = async (clientId, source = 'mac-source-a') => {
    const pairing = await service.createPairing(source);
    const authorization = await page(clientId);
    assert.equal(authorization.response.status, 200);
    const response = await form('/oauth/authorize', { nonce: authorization.nonce, pairing_code: pairing.code }, ORIGIN);
    assert.equal(response.status, 303);
    const redirect = new URL(response.headers.get('location'));
    return { code: redirect.searchParams.get('code'), redirect, pairing, nonce: authorization.nonce };
  };
  const exchange = (clientId, code, overrides = {}) => form('/oauth/token', {
    grant_type: 'authorization_code', client_id: clientId, redirect_uri: REDIRECT,
    resource: RESOURCE, code, code_verifier: VERIFIER, ...overrides,
  });
  const mint = async (source = 'mac-source-a') => {
    const { data: client } = await register();
    const authorization = await authorize(client.client_id, source);
    const response = await exchange(client.client_id, authorization.code);
    assert.equal(response.status, 200);
    return { client, authorization, tokens: await response.json() };
  };
  const authenticate = token => service.authenticate(new Request(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${token}` } }));
  return { storage, service, request, form, register, page, authorize, exchange, mint, authenticate, advance: amount => { now += amount; } };
}

test('metadata advertises DCR, S256, exact audience, scopes, and issuer identification', async () => {
  const ctx = setup();
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await ctx.request(path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { resource: RESOURCE, authorization_servers: [ORIGIN], scopes_supported: ['focus:read', 'focus:events', 'focus:control'], bearer_methods_supported: ['header'] });
  }
  const metadata = await (await ctx.request('/.well-known/oauth-authorization-server')).json();
  assert.equal(metadata.issuer, ORIGIN);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(await ctx.request('/unowned'), null);
});

test('pairing + PKCE authorizes one source without persisting plaintext credentials', async () => {
  const ctx = setup();
  const { client, authorization, tokens } = await ctx.mint();
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.equal(client.client_secret, undefined);
  assert.equal(authorization.redirect.origin, 'https://chatgpt.com');
  assert.equal(authorization.redirect.searchParams.get('state'), 'state-<safe>');
  assert.equal(authorization.redirect.searchParams.get('iss'), ORIGIN);
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 900);
  const identity = await ctx.authenticate(tokens.access_token);
  assert.equal(identity.principal, 'mac-source-a');
  assert.equal(identity.scope, 'focus:read focus:events');
  assert.equal(await ctx.service.isGrantActive(identity.grantId, 'mac-source-a'), true);
  assert.equal(await ctx.service.isGrantActive(identity.grantId, 'mac-source-b'), false);
  const serialized = JSON.stringify([...ctx.storage.data]);
  for (const secret of [tokens.access_token, tokens.refresh_token, authorization.code, authorization.pairing.code, authorization.nonce]) {
    assert.equal(serialized.includes(secret), false, 'raw credential must not be persisted');
  }
});

test('DCR rejects hostile callbacks and unsupported clients but allows both official callback forms', async () => {
  for (const redirect of ['https://attacker.example/callback', 'http://chatgpt.com/connector_platform_oauth_redirect',
    `${REDIRECT}?next=evil`, `${REDIRECT}#fragment`, 'https://chatgpt.com.attacker.example/connector/oauth/abc',
    'https://user@chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com:8443/connector/oauth/abc']) {
    const { response, data } = await setup().register({ redirect_uris: [redirect] });
    assert.equal(response.status, 400);
    assert.equal(data.error, 'invalid_redirect_uri');
  }
  assert.equal((await setup().register({ redirect_uris: ['https://chatgpt.com/connector/oauth/callback_123'] })).response.status, 201);
  assert.equal((await setup().register({ token_endpoint_auth_method: 'client_secret_post' })).data.error, 'invalid_client_metadata');
});

test('authorization requires exact resource, registered redirect, allowed scopes, and S256', async () => {
  const ctx = setup();
  const { data: client } = await ctx.register();
  for (const overrides of [{ resource: ORIGIN }, { redirect_uri: 'https://chatgpt.com/connector/oauth/other' },
    { scope: 'focus:admin' }, { code_challenge_method: 'plain' }, { code_challenge: 'too-short' }]) {
    const result = await ctx.page(client.client_id, overrides);
    assert.equal(result.response.status, 400);
    assert.equal(JSON.parse(result.text).iss, ORIGIN);
    assert.equal(result.nonce, undefined);
  }
});

test('form nonce requires same Origin, binds authorization, and permits only one pairing attempt', async () => {
  const ctx = setup();
  const { data: client } = await ctx.register();
  const pairing = await ctx.service.createPairing('mac-source-a');
  const { nonce, response } = await ctx.page(client.client_id);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await ctx.form('/oauth/authorize', { nonce, pairing_code: pairing.code }, 'https://attacker.example')).status, 400);
  assert.equal((await ctx.form('/oauth/authorize', { nonce, pairing_code: 'wrong-code' }, ORIGIN)).status, 400);
  assert.equal((await ctx.form('/oauth/authorize', { nonce, pairing_code: pairing.code }, ORIGIN)).status, 400);
  const fresh = await ctx.page(client.client_id);
  assert.equal((await ctx.form('/oauth/authorize', { nonce: fresh.nonce, pairing_code: pairing.code }, ORIGIN)).status, 303);
  const replay = await ctx.page(client.client_id);
  assert.equal((await ctx.form('/oauth/authorize', { nonce: replay.nonce, pairing_code: pairing.code }, ORIGIN)).status, 400);
});

test('authorization codes are single-use and incorrect PKCE consumes the code', async () => {
  const ctx = setup();
  const { data: client } = await ctx.register();
  const first = await ctx.authorize(client.client_id);
  const wrong = await ctx.exchange(client.client_id, first.code, { code_verifier: 'b'.repeat(64) });
  assert.equal((await wrong.json()).error, 'invalid_grant');
  assert.equal((await ctx.exchange(client.client_id, first.code)).status, 400);
  const second = await ctx.authorize(client.client_id);
  const results = await Promise.all([ctx.exchange(client.client_id, second.code), ctx.exchange(client.client_id, second.code)]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 400]);
});

test('token audience and client identity cannot be substituted', async () => {
  const ctx = setup();
  const { data: client } = await ctx.register();
  const { data: other } = await ctx.register();
  const { code } = await ctx.authorize(client.client_id);
  assert.equal((await ctx.exchange(client.client_id, code, { resource: 'https://other.example/mcp' })).status, 400);
  assert.equal((await ctx.exchange(other.client_id, code)).status, 400);
  assert.equal((await ctx.exchange(client.client_id, code)).status, 400);
});

test('refresh rotates tokens, preserves principal, and replay revokes the whole grant', async () => {
  const ctx = setup();
  const { client, tokens } = await ctx.mint();
  const firstIdentity = await ctx.authenticate(tokens.access_token);
  const request = { grant_type: 'refresh_token', client_id: client.client_id, resource: RESOURCE, refresh_token: tokens.refresh_token };
  const next = await (await ctx.form('/oauth/token', request)).json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.deepEqual(await ctx.authenticate(next.access_token), firstIdentity);
  assert.equal((await ctx.form('/oauth/token', request)).status, 400);
  assert.equal(await ctx.authenticate(next.access_token), null);
  assert.equal(await ctx.authenticate(tokens.access_token), null);
  assert.equal(await ctx.service.isGrantActive(firstIdentity.grantId), false);
  assert.equal((await ctx.form('/oauth/token', { ...request, refresh_token: next.refresh_token })).status, 400);
});

test('camera control requires a new consent grant and cannot be added during refresh', async () => {
  const ctx = setup();
  const { client, tokens } = await ctx.mint();
  const refresh = { grant_type: 'refresh_token', client_id: client.client_id, resource: RESOURCE, refresh_token: tokens.refresh_token };
  const escalation = await ctx.form('/oauth/token', { ...refresh, scope: 'focus:read focus:events focus:control' });
  assert.equal(escalation.status, 400);
  assert.equal((await escalation.json()).error, 'invalid_scope');
  const renewed = await (await ctx.form('/oauth/token', refresh)).json();
  assert.equal((await ctx.authenticate(renewed.access_token)).scope, 'focus:read focus:events');
  const limitedPage = await ctx.page(client.client_id);
  assert.doesNotMatch(limitedPage.text, /カメラ監視の開始・停止/);
  const controlPage = await ctx.page(client.client_id, { scope: 'focus:read focus:events focus:control' });
  assert.match(controlPage.text, /カメラ監視の開始・停止/);
  assert.match(controlPage.text, /監視中の画像は検知APIに送信/);
  const pairing = await ctx.service.createPairing('mac-source-a');
  const consent = await ctx.form('/oauth/authorize', { nonce: controlPage.nonce, pairing_code: pairing.code }, ORIGIN);
  const code = new URL(consent.headers.get('location')).searchParams.get('code');
  const added = await (await ctx.exchange(client.client_id, code)).json();
  assert.equal((await ctx.authenticate(added.access_token)).scope, 'focus:read focus:events focus:control');
  assert.equal((await ctx.authenticate(renewed.access_token)).scope, 'focus:read focus:events', 'older grant remains unchanged');
});

test('default scopes include camera control and disclose it before consent', async () => {
  const ctx = setup();
  const { data: client } = await ctx.register();
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code',
    resource: RESOURCE, code_challenge: await challenge(VERIFIER), code_challenge_method: 'S256' });
  const response = await ctx.request(`/oauth/authorize?${query}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /focus:control/);
  assert.match(html, /Web／dotから、この接続に登録されたすべての端末にカメラ監視の開始・停止を指示できます/);
  const nonce = html.match(/name="nonce" value="([^"]+)"/)[1];
  const pairing = await ctx.service.createPairing('mac-source-a');
  const consent = await ctx.form('/oauth/authorize', { nonce, pairing_code: pairing.code }, ORIGIN);
  const code = new URL(consent.headers.get('location')).searchParams.get('code');
  const tokens = await (await ctx.exchange(client.client_id, code)).json();
  assert.equal(tokens.scope, 'focus:read focus:events focus:control');
});

test('revocation is client-bound, revokes access and refresh, and isolates other sources', async () => {
  const ctx = setup();
  const a = await ctx.mint('mac-source-a');
  const b = await ctx.mint('mac-source-b');
  const identity = await ctx.authenticate(a.tokens.access_token);
  await ctx.form('/oauth/revoke', { client_id: b.client.client_id, token: a.tokens.access_token });
  assert.notEqual(await ctx.authenticate(a.tokens.access_token), null);
  const response = await ctx.form('/oauth/revoke', { client_id: a.client.client_id, token: a.tokens.access_token });
  assert.equal(response.status, 200);
  assert.equal(await ctx.authenticate(a.tokens.access_token), null);
  assert.equal(await ctx.service.isGrantActive(identity.grantId), false);
  assert.equal((await ctx.authenticate(b.tokens.access_token)).principal, 'mac-source-b');
  assert.equal((await ctx.form('/oauth/token', { grant_type: 'refresh_token', client_id: a.client.client_id, resource: RESOURCE, refresh_token: a.tokens.refresh_token })).status, 400);
});

test('pairing, form, code, access, and grant expiry are enforced', async () => {
  const ctx = setup();
  const { data: client } = await ctx.register();
  const pairing = await ctx.service.createPairing('mac-source-a');
  const page = await ctx.page(client.client_id);
  ctx.advance(10 * 60_000);
  assert.equal((await ctx.form('/oauth/authorize', { nonce: page.nonce, pairing_code: pairing.code }, ORIGIN)).status, 400);
  const freshPage = await ctx.page(client.client_id);
  assert.equal((await ctx.form('/oauth/authorize', { nonce: freshPage.nonce, pairing_code: pairing.code }, ORIGIN)).status, 400);
  const auth = await ctx.authorize(client.client_id);
  ctx.advance(2 * 60_000);
  assert.equal((await ctx.exchange(client.client_id, auth.code)).status, 400);
  const { tokens, client: tokenClient } = await ctx.mint();
  const identity = await ctx.authenticate(tokens.access_token);
  ctx.advance(15 * 60_000);
  assert.equal(await ctx.authenticate(tokens.access_token), null);
  assert.equal(await ctx.service.isGrantActive(identity.grantId), true, 'access expiry must not end a subscribed grant');
  const refresh = await ctx.form('/oauth/token', { grant_type: 'refresh_token', client_id: tokenClient.client_id, resource: RESOURCE, refresh_token: tokens.refresh_token });
  assert.equal(refresh.status, 200);
  const rotated = await refresh.json();
  ctx.advance(30 * 24 * 60 * 60_000);
  assert.equal(await ctx.service.isGrantActive(identity.grantId), false);
  assert.equal((await ctx.form('/oauth/token', { grant_type: 'refresh_token', client_id: tokenClient.client_id, resource: RESOURCE, refresh_token: rotated.refresh_token })).status, 400);
});

test('bounded client registration and request parsing prevent unbounded anonymous writes', async () => {
  const ctx = setup();
  for (let index = 0; index < 10; index += 1) assert.equal((await ctx.register()).response.status, 201);
  assert.equal((await ctx.register()).response.status, 429);
  ctx.advance(60_000);
  assert.equal((await ctx.register()).response.status, 201);
  const malformed = await ctx.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=a&client_id=b' });
  assert.equal((await malformed.json()).error, 'invalid_request');
  const large = await ctx.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a'.repeat(16_385) });
  assert.equal((await large.json()).error, 'invalid_request');
});

test('1000 unused client registrations expire and capacity recovers without a counter reset', async () => {
  const ctx = setup();
  const { data: client } = await ctx.register();
  const record = await ctx.storage.get(`oauth:client:${client.client_id}`);
  // Seed a full bounded store to exercise expiry reclamation independently of
  // the public 10/minute limit (which itself limits unused clients to 600/hour).
  for (let index = 1; index < 1000; index += 1) {
    const id = String(index).padStart(43, 'a');
    await ctx.storage.put(`oauth:client:${id}`, { ...record, client_id: id });
  }
  assert.equal((await ctx.register()).response.status, 429);
  ctx.advance(60 * 60_000);
  assert.equal((await ctx.register()).response.status, 201);
  assert.equal((await ctx.storage.list({ prefix: 'oauth:client:', limit: 1001 })).size, 1);
  assert.equal((await ctx.page(client.client_id)).response.status, 400);
});

test('linked clients survive unused expiry and refresh for the entire grant with one expiry index', async () => {
  const ctx = setup();
  const { client, tokens } = await ctx.mint();
  const identity = await ctx.authenticate(tokens.access_token);
  const original = await ctx.storage.get(`oauth:client:${client.client_id}`);
  const refresh = { grant_type: 'refresh_token', client_id: client.client_id, resource: RESOURCE, refresh_token: tokens.refresh_token };
  ctx.advance(29 * 24 * 60 * 60_000);
  const refreshed = await ctx.form('/oauth/token', refresh);
  assert.equal(refreshed.status, 200);
  assert.deepEqual(await ctx.authenticate((await refreshed.json()).access_token), identity);
  assert.equal((await ctx.storage.get(`oauth:client:${client.client_id}`)).expiresAt, original.expiresAt);
  const indexes = [...ctx.storage.data.keys()].filter(key => key.startsWith('oauth:exp:') && key.endsWith(`:oauth:client:${client.client_id}`));
  assert.equal(indexes.length, 1);
  const reauthorization = await ctx.authorize(client.client_id);
  assert.equal((await ctx.exchange(client.client_id, reauthorization.code)).status, 200);
  assert.ok((await ctx.storage.get(`oauth:client:${client.client_id}`)).expiresAt > original.expiresAt, 'new authorization extends the client lifetime');
  ctx.advance(2 * 24 * 60 * 60_000);
  assert.equal((await ctx.page(client.client_id)).response.status, 200, 'earlier expiry index must not delete an extended client');
});

test('unexpected storage failures return a generic OAuth error', async () => {
  const service = new OAuthService({ origin: ORIGIN, storage: { async list() { throw new Error('secret-database-details'); } } });
  const response = await service.handle(new Request(`${ORIGIN}/oauth/token`, { method: 'POST' }));
  assert.equal(response.status, 500);
  const output = await response.text();
  assert.match(output, /server_error/);
  assert.doesNotMatch(output, /secret-database/);
});
