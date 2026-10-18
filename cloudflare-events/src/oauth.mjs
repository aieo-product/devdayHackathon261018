const SCOPES = ['focus:read', 'focus:events', 'focus:control'];
const SCOPE_DESCRIPTIONS = {
  'focus:read': 'この接続に登録された端末の検知結果を読み取ります。',
  'focus:events': 'この接続に登録された端末の検知イベントを購読します。',
  'focus:control': 'Web／dotから、この接続に登録されたすべての端末にカメラ監視の開始・停止を指示できます。監視中の画像は検知APIに送信されます。',
};
const MINUTE = 60_000;
const ACCESS_TTL = 15 * MINUTE;
const GRANT_TTL = 30 * 24 * 60 * MINUTE;
const UNUSED_CLIENT_TTL = 60 * MINUTE;
const CLIENT_GRACE = 24 * 60 * MINUTE;
const queues = new WeakMap();

class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

const invalid = (description = 'Invalid request.') => new OAuthError('invalid_request', description);
const headers = (type = 'application/json; charset=utf-8') => ({
  'content-type': type,
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: headers() });
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const digest = async value => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
};

function validRedirect(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' && !url.username && !url.password && !url.search && !url.hash
      && url.href === value && (url.pathname === '/connector_platform_oauth_redirect'
        || /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname));
  } catch { return false; }
}

function params(value) {
  const data = new URLSearchParams(value);
  const seen = new Set();
  for (const [key] of data) {
    if (seen.has(key)) throw invalid('Duplicate parameters are not supported.');
    seen.add(key);
  }
  return data;
}

async function body(request, type) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== type) throw invalid('Unsupported content type.');
  const reader = request.body?.getReader();
  if (!reader) throw invalid('A request body is required.');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16_384) {
      await reader.cancel();
      throw invalid('Request body is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

/** Small, isolated pairing-based OAuth server. All secrets are stored only as hashes. */
export class OAuthService {
  constructor({ storage, origin, clock = Date.now }) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('OAuth origin must be a canonical HTTPS origin.');
    this.storage = storage;
    this.origin = origin;
    this.resource = `${origin}/mcp`;
    this.clock = clock;
  }

  async serialized(callback) {
    const before = queues.get(this.storage) ?? Promise.resolve();
    const operation = before.then(callback);
    queues.set(this.storage, operation.catch(() => {}));
    return operation;
  }

  async put(key, record) {
    await this.storage.put(key, record);
    if (record.expiresAt) {
      await this.storage.put(`oauth:exp:${String(record.expiresAt).padStart(15, '0')}:${key}`, key);
    }
  }

  async cleanup() {
    const entries = await this.storage.list({ prefix: 'oauth:exp:', limit: 30 });
    const now = this.clock();
    for (const [index, key] of entries) {
      if (Number(index.split(':')[2]) > now) break;
      const record = await this.storage.get(key);
      if (record?.expiresAt <= now) await this.storage.delete(key);
      await this.storage.delete(index);
    }
  }

  async limit(name, maximum) {
    const minute = Math.floor(this.clock() / MINUTE);
    const key = `oauth:rate:${name}:${minute}`;
    const record = await this.storage.get(key);
    if ((record?.count ?? 0) >= maximum) throw new OAuthError('temporarily_unavailable', 'Please try again later.', 429);
    await this.put(key, { count: (record?.count ?? 0) + 1, expiresAt: (minute + 2) * MINUTE });
  }

  async getLive(key) {
    const record = await this.storage.get(key);
    return record && (!record.expiresAt || record.expiresAt > this.clock()) ? record : null;
  }

  async createPairing(sourceId) {
    if (typeof sourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(sourceId)) throw invalid('Invalid source identifier.');
    return this.serialized(async () => {
      await this.cleanup();
      await this.limit('pairing', 30);
      const code = `PAIR-${random()}`;
      const expiresAt = this.clock() + 10 * MINUTE;
      await this.put(`oauth:pair:${await digest(code)}`, { principal: sourceId, expiresAt });
      return { code, expires_at: new Date(expiresAt).toISOString() };
    });
  }

  async isGrantActive(grantId, principal) {
    const grant = typeof grantId === 'string' ? await this.getLive(`oauth:grant:${grantId}`) : null;
    return Boolean(grant && !grant.revoked && (principal === undefined || principal === grant.principal));
  }

  async authenticate(request) {
    const bearer = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
    if (!bearer) return null;
    return this.serialized(async () => {
      const token = await this.getLive(`oauth:access:${await digest(bearer)}`);
      if (!token || token.resource !== this.resource || !await this.isGrantActive(token.grantId, token.principal)) return null;
      return { principal: token.principal, scope: token.scope, grantId: token.grantId };
    });
  }

  async handle(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const known = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/authorize', '/oauth/token', '/oauth/revoke'];
    if (!known.includes(path)) return null;
    try {
      if (url.search.length > 8192) throw invalid('Query string is too large.');
      if (path.startsWith('/.well-known/')) {
        if (request.method !== 'GET') throw new OAuthError('invalid_request', 'Method not allowed.', 405);
        if (path.includes('oauth-protected-resource')) return json({ resource: this.resource, authorization_servers: [this.origin], scopes_supported: SCOPES, bearer_methods_supported: ['header'] });
        return json({ issuer: this.origin, authorization_endpoint: `${this.origin}/oauth/authorize`, token_endpoint: `${this.origin}/oauth/token`,
          registration_endpoint: `${this.origin}/oauth/register`, revocation_endpoint: `${this.origin}/oauth/revoke`,
          authorization_response_iss_parameter_supported: true, token_endpoint_auth_methods_supported: ['none'],
          revocation_endpoint_auth_methods_supported: ['none'], response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], scopes_supported: SCOPES });
      }
      return await this.serialized(async () => {
        await this.cleanup();
        if (path === '/oauth/authorize' && request.method === 'GET') return this.authorizePage(params(url.search));
        if (request.method !== 'POST') throw new OAuthError('invalid_request', 'Method not allowed.', 405);
        if (path === '/oauth/register') return this.register(request);
        if (path === '/oauth/authorize') return this.authorize(request);
        if (path === '/oauth/token') return this.token(request);
        return this.revoke(request);
      });
    } catch (error) {
      return json({ error: error instanceof OAuthError ? error.error : 'server_error',
        error_description: error instanceof OAuthError ? error.message : 'The authorization service could not complete this request.',
        ...(path === '/oauth/authorize' ? { iss: this.origin } : {}) }, error instanceof OAuthError ? error.status : 500);
    }
  }

  async register(request) {
    await this.limit('register', 10);
    let data;
    try { data = JSON.parse(await body(request, 'application/json')); }
    catch (error) { if (error instanceof OAuthError) throw error; throw invalid('Invalid JSON.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('Invalid client metadata.');
    if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length < 1 || data.redirect_uris.length > 4
      || !data.redirect_uris.every(validRedirect)) throw new OAuthError('invalid_redirect_uri', 'Only exact ChatGPT HTTPS redirect URIs are allowed.');
    if (data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== 'none') throw new OAuthError('invalid_client_metadata', 'Only public clients are supported.');
    if (data.grant_types !== undefined && (!Array.isArray(data.grant_types) || !data.grant_types.length || !data.grant_types.every(value => ['authorization_code', 'refresh_token'].includes(value)))) throw new OAuthError('invalid_client_metadata', 'Unsupported grant type.');
    if (data.response_types !== undefined && (!Array.isArray(data.response_types) || data.response_types.length !== 1 || data.response_types[0] !== 'code')) throw new OAuthError('invalid_client_metadata', 'Only code responses are supported.');
    // Count bounded, actual records rather than an irreversible total. Reclaim
    // expired registrations even if unrelated expiry indexes have a backlog.
    const clients = await this.storage.list({ prefix: 'oauth:client:', limit: 1001 });
    let count = clients.size;
    for (const [key, client] of clients) {
      if (client.expiresAt && client.expiresAt <= this.clock()) {
        await this.storage.delete(key);
        await this.storage.delete(`oauth:exp:${String(client.expiresAt).padStart(15, '0')}:${key}`);
        count -= 1;
      } else if (!client.expiresAt) {
        // Preserve pre-expiry-version clients through any existing 30-day grant.
        await this.put(key, { ...client, expiresAt: this.clock() + GRANT_TTL + CLIENT_GRACE });
      }
    }
    if (count >= 1000) throw new OAuthError('temporarily_unavailable', 'Client registration capacity reached.', 429);
    const clientId = random();
    const record = { client_id: clientId, client_id_issued_at: Math.floor(this.clock() / 1000), redirect_uris: [...new Set(data.redirect_uris)],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
    await this.put(`oauth:client:${clientId}`, { ...record, expiresAt: this.clock() + UNUSED_CLIENT_TTL });
    return json(record, 201);
  }

  async client(clientId) {
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(clientId)) throw new OAuthError('invalid_client', 'Unknown client.');
    const client = await this.getLive(`oauth:client:${clientId}`);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client.');
    return client;
  }

  async retainClient(clientId, expiresAt) {
    const client = await this.client(clientId);
    if (client.expiresAt >= expiresAt) return;
    const key = `oauth:client:${clientId}`;
    if (client.expiresAt) await this.storage.delete(`oauth:exp:${String(client.expiresAt).padStart(15, '0')}:${key}`);
    await this.put(key, { ...client, expiresAt });
  }

  async authorizePage(data) {
    await this.limit('authorize', 60);
    const client = await this.client(data.get('client_id'));
    if (!client.redirect_uris.includes(data.get('redirect_uri'))) throw invalid('Redirect URI does not match registration.');
    if (data.get('response_type') !== 'code') throw new OAuthError('unsupported_response_type', 'Only code responses are supported.');
    if (data.get('resource') !== this.resource) throw new OAuthError('invalid_target', 'The resource must match this MCP server.');
    if (data.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(data.get('code_challenge') ?? '')) throw invalid('PKCE with S256 is required.');
    // Omitted scope keeps the default-all behavior; the consent page explicitly
    // lists camera control. Existing grants never gain newly supported scopes.
    const requested = (data.get('scope') ?? SCOPES.join(' ')).trim().split(/\s+/);
    if (!requested.length || requested.some(scope => !SCOPES.includes(scope))) throw new OAuthError('invalid_scope', 'Unsupported scope.');
    const state = data.get('state');
    if (state !== null && state.length > 2048) throw invalid('State is too large.');
    const nonce = random();
    await this.put(`oauth:nonce:${await digest(nonce)}`, { clientId: client.client_id, redirectUri: data.get('redirect_uri'), state,
      challenge: data.get('code_challenge'), resource: this.resource, scope: SCOPES.filter(scope => requested.includes(scope)).join(' '),
      expiresAt: this.clock() + 10 * MINUTE });
    const permissions = SCOPES.filter(scope => requested.includes(scope));
    return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Focus Events を接続</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:10vh auto;padding:1.5rem;line-height:1.7;color:#17231f;background:#f7f8f5}input,button{font:inherit;padding:.8rem;box-sizing:border-box;width:100%;margin:.5rem 0}button{background:#145b46;color:white;border:0;border-radius:.5rem}small{color:#52615a}</style><h1>Focus Events を接続</h1><p>Mac確認UIで発行した接続コードを入力してください。次の権限を許可します。</p><ul>${permissions.map(scope => `<li>${escape(SCOPE_DESCRIPTIONS[scope])}</li>`).join('')}</ul><p><small>許可する権限: ${escape(permissions.join(', '))}</small></p><form action="/oauth/authorize" method="post"><input type="hidden" name="nonce" value="${escape(nonce)}"><label for="pairing">接続コード</label><input id="pairing" name="pairing_code" type="password" autocomplete="off" spellcheck="false" required maxlength="64" placeholder="PAIR-…"><button type="submit">接続を許可</button></form><small>コードは10分間有効で、一度だけ利用できます。カメラ画像はこの接続画面には送信されません。</small></html>`, { headers: headers('text/html; charset=utf-8') });
  }

  async authorize(request) {
    if (request.headers.get('origin') !== this.origin) throw invalid('Authorization form origin does not match.');
    await this.limit('pairing-attempt', 30);
    const data = params(await body(request, 'application/x-www-form-urlencoded'));
    const nonce = data.get('nonce') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw invalid('Invalid or expired authorization form. Reload the connection flow.');
    const nonceKey = `oauth:nonce:${await digest(nonce)}`;
    const transaction = await this.getLive(nonceKey);
    await this.storage.delete(nonceKey); // One guess per form, including failed pairing attempts.
    if (!transaction) throw invalid('Invalid or expired authorization form. Reload the connection flow.');
    const pairing = (data.get('pairing_code') ?? '').trim();
    const pairingKey = `oauth:pair:${await digest(pairing)}`;
    const identity = await this.getLive(pairingKey);
    if (!identity) throw new OAuthError('access_denied', 'The connection code is invalid, expired, or already used.');
    // Verified pairing can finish a code exchange near registration expiry.
    // Anonymous authorization-page visits do not keep unused clients alive.
    await this.retainClient(transaction.clientId, this.clock() + 5 * MINUTE);
    await this.storage.delete(pairingKey);
    const code = random();
    await this.put(`oauth:code:${await digest(code)}`, { ...transaction, principal: identity.principal, expiresAt: this.clock() + 2 * MINUTE });
    const redirect = new URL(transaction.redirectUri);
    redirect.searchParams.set('code', code);
    if (transaction.state !== null) redirect.searchParams.set('state', transaction.state);
    redirect.searchParams.set('iss', this.origin);
    return new Response(null, { status: 303, headers: { ...headers(), location: redirect.href } });
  }

  async issue(grant) {
    // Keep a linked client usable for its entire grant, including refresh. A
    // later authorization extends this horizon; refresh alone adds no indexes.
    await this.retainClient(grant.clientId, grant.expiresAt + CLIENT_GRACE);
    const access = random();
    const refresh = random();
    const common = { principal: grant.principal, scope: grant.scope, grantId: grant.grantId, clientId: grant.clientId, resource: this.resource };
    const accessExpiry = Math.min(this.clock() + ACCESS_TTL, grant.expiresAt);
    await this.put(`oauth:access:${await digest(access)}`, { ...common, expiresAt: accessExpiry });
    await this.put(`oauth:refresh:${await digest(refresh)}`, { ...common, expiresAt: grant.expiresAt, used: false });
    return json({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: Math.floor((accessExpiry - this.clock()) / 1000), scope: grant.scope });
  }

  async token(request) {
    await this.limit('token', 120);
    const data = params(await body(request, 'application/x-www-form-urlencoded'));
    const client = await this.client(data.get('client_id'));
    if (request.headers.has('authorization') || data.has('client_secret') || data.has('client_assertion')) throw new OAuthError('invalid_client', 'Use the public client PKCE flow.');
    if (data.get('resource') !== this.resource) throw new OAuthError('invalid_target', 'The resource must match this MCP server.');
    if (data.get('grant_type') === 'authorization_code') {
      const code = data.get('code') ?? '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new OAuthError('invalid_grant', 'Invalid authorization code.');
      const key = `oauth:code:${await digest(code)}`;
      const authorization = await this.getLive(key);
      // Consume before PKCE verification: a stolen code never offers unlimited guesses.
      await this.storage.delete(key);
      const verifier = data.get('code_verifier') ?? '';
      if (!authorization || authorization.clientId !== client.client_id || authorization.redirectUri !== data.get('redirect_uri')
        || authorization.resource !== this.resource || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
        || !same(await digest(verifier), authorization.challenge)) throw new OAuthError('invalid_grant', 'Authorization code or PKCE verification failed.');
      const grant = { grantId: random(), principal: authorization.principal, scope: authorization.scope, clientId: client.client_id,
        resource: this.resource, revoked: false, expiresAt: this.clock() + GRANT_TTL };
      await this.put(`oauth:grant:${grant.grantId}`, grant);
      return this.issue(grant);
    }
    if (data.get('grant_type') === 'refresh_token') {
      const refresh = data.get('refresh_token') ?? '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(refresh)) throw new OAuthError('invalid_grant', 'Invalid refresh token.');
      const key = `oauth:refresh:${await digest(refresh)}`;
      const token = await this.getLive(key);
      if (!token || token.clientId !== client.client_id || token.resource !== this.resource) throw new OAuthError('invalid_grant', 'Invalid refresh token.');
      const grant = await this.getLive(`oauth:grant:${token.grantId}`);
      if (!grant || grant.revoked) throw new OAuthError('invalid_grant', 'Authorization is expired or revoked.');
      if (token.used) {
        await this.put(`oauth:grant:${grant.grantId}`, { ...grant, revoked: true });
        throw new OAuthError('invalid_grant', 'Refresh token reuse revoked this authorization. Connect again.');
      }
      if (data.has('scope') && data.get('scope') !== grant.scope) throw new OAuthError('invalid_scope', 'Reconnect to change scopes.');
      await this.put(key, { ...token, used: true });
      return this.issue(grant);
    }
    throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
  }

  async revoke(request) {
    await this.limit('revoke', 120);
    const data = params(await body(request, 'application/x-www-form-urlencoded'));
    const client = await this.client(data.get('client_id'));
    const token = data.get('token') ?? '';
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
      const hash = await digest(token);
      const record = await this.getLive(`oauth:refresh:${hash}`) ?? await this.getLive(`oauth:access:${hash}`);
      if (record?.clientId === client.client_id) {
        const grant = await this.getLive(`oauth:grant:${record.grantId}`);
        if (grant) await this.put(`oauth:grant:${grant.grantId}`, { ...grant, revoked: true });
      }
    }
    return new Response(null, { status: 200, headers: headers() });
  }
}
