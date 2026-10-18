import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const UPSTREAM_ORIGIN = 'https://focus-shared-api-20261018.take-otani.workers.dev';
export const COOKIE_NAME = '__Host-focus_access';
export const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_BROWSER_SESSIONS = 32;
const MAX_JSON_BYTES = 16_384;
const MAX_IMAGE_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 262_144;
const UPSTREAM_TIMEOUT_MS = 18_000;
const SESSION_ID = /^[a-zA-Z0-9-]{1,80}$/;
const MIME = request => (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();

class PublicError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new PublicError(status, code, message); };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const errorResponse = error => json({ error: { code: error instanceof PublicError ? error.code : 'internal_error', message: error instanceof PublicError ? error.message : '処理に失敗しました。もう一度お試しください。' } }, error instanceof PublicError ? error.status : 500);
const unauthorized = () => fail(401, 'authentication_required', 'チーム用コードでログインしてください。');
const hmac = (value, secret) => createHmac('sha256', secret).update(value).digest('base64url');
const equal = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export function signAccess(browserId, expiresAt, secret) {
  const value = `v1.${browserId}.${expiresAt}`;
  return `${value}.${hmac(value, secret)}`;
}

export function verifyAccess(value, secret, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const match = /^(v1\.([a-f0-9-]{36})\.(\d{13}))\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match || !equal(hmac(match[1], secret), match[4])) return null;
  const expiresAt = Number(match[3]);
  if (expiresAt <= now || expiresAt > now + ACCESS_TTL_MS + 1000) return null;
  return { browserId: match[2], expiresAt };
}

function accessCookie(request, secret) {
  const values = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  return verifyAccess(values[0].slice(COOKIE_NAME.length + 1), secret);
}
const cookie = value => `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${value ? ACCESS_TTL_MS / 1000 : 0}`;
const authResult = (authenticated, expiresAt) => ({ required: true, authenticated, ...(authenticated ? { expires_at: new Date(expiresAt).toISOString() } : {}) });

function configured(env) {
  if (typeof env.TEAM_ACCESS_CODE !== 'string' || env.TEAM_ACCESS_CODE.length < 8 || env.TEAM_ACCESS_CODE.length > 128
      || typeof env.COOKIE_SECRET !== 'string' || env.COOKIE_SECRET.length < 32
      || typeof env.FOCUS_API_TOKEN !== 'string' || !env.FOCUS_API_TOKEN || /[\r\n]/.test(env.FOCUS_API_TOKEN)
      || !env.BROWSER_SESSIONS) fail(503, 'service_not_configured', '公開画面の設定を確認してください。');
}

function checkOrigin(request) {
  const origin = request.headers.get('origin');
  if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== new URL(request.url).origin)
      || (request.method !== 'GET' && request.method !== 'HEAD' && origin !== new URL(request.url).origin)) {
    fail(403, 'origin_not_allowed', 'この画面の同一オリジンからアクセスしてください。');
  }
}

export async function readBounded(request, maximum) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) fail(413, 'body_too_large', '送信データが上限を超えています。');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); fail(413, 'body_too_large', '送信データが上限を超えています。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function readJson(request) {
  if (MIME(request) !== 'application/json') fail(415, 'unsupported_media_type', 'Content-Typeにapplication/jsonを指定してください。');
  let value;
  const bytes = await readBounded(request, MAX_JSON_BYTES);
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'invalid_json', 'JSONを読み取れません。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_json_object', 'JSONオブジェクトを指定してください。');
  return value;
}

export function apiRoute(pathname, method) {
  const route = pathname.slice('/api/focus'.length);
  const match = /^\/v1\/sessions\/([a-zA-Z0-9-]{1,80})(?:\/(frames|control))?$/.exec(route);
  if (route !== '/health' && route !== '/v1/sessions' && !match) fail(404, 'not_found', '利用できないAPIパスです。');
  const expected = route === '/health' || (match && !match[2]) ? 'GET' : 'POST';
  if (method !== expected) fail(405, 'method_not_allowed', 'このAPIでは指定のメソッドを使用できません。');
  return { route, sessionId: match?.[1], operation: match?.[2], create: route === '/v1/sessions', health: route === '/health' };
}

async function prepareApi(request, route) {
  const headers = new Headers({ accept: 'application/json' });
  if (request.method === 'GET') return { headers };
  if (route.operation === 'frames') {
    const mime = MIME(request);
    if (!['image/jpeg', 'image/png'].includes(mime)) fail(415, 'unsupported_media_type', '1 MiB以下のJPEGまたはPNGを送信してください。');
    const frameId = request.headers.get('x-frame-id');
    if (!frameId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(frameId)) fail(400, 'invalid_frame_id', '有効なX-Frame-Idを指定してください。');
    headers.set('content-type', mime);
    headers.set('x-frame-id', frameId);
    const body = await readBounded(request, MAX_IMAGE_BYTES);
    const valid = mime === 'image/jpeg' ? body.length >= 3 && body[0] === 255 && body[1] === 216 && body[2] === 255
      : body.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => body[i] === byte);
    if (!valid) fail(400, 'invalid_image', '画像の形式とContent-Typeが一致していません。');
    return { headers, body };
  }
  const value = await readJson(request);
  let data;
  if (route.create) {
    const duration = value.duration_seconds ?? 1500;
    if (!Number.isInteger(duration) || duration < 1 || duration > 14400) fail(400, 'invalid_duration', 'duration_secondsは1〜14400の整数を指定してください。');
    if (typeof value.device_type !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.device_type)) fail(400, 'invalid_device_type', 'device_typeに短い識別名を指定してください。');
    data = { device_type: value.device_type, duration_seconds: duration };
  } else {
    if (!['pause', 'resume', 'end'].includes(value.action)) fail(400, 'invalid_action', 'actionはpause、resume、endのいずれかを指定してください。');
    data = { action: value.action };
  }
  headers.set('content-type', 'application/json');
  return { headers, body: JSON.stringify(data) };
}

function secure(response) {
  const result = new Response(response.body, response);
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Referrer-Policy', 'same-origin');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return result;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'method_not_allowed', 'このメソッドは利用できません。');
        if (!env.ASSETS) fail(503, 'assets_not_configured', '画面を準備しています。');
        return secure(await env.ASSETS.fetch(request));
      }
      checkOrigin(request);
      if (url.search) fail(404, 'not_found', '利用できないAPIパスです。');
      configured(env);
      if (url.pathname === '/api/access/login') {
        if (request.method !== 'POST') fail(405, 'method_not_allowed', 'POSTを指定してください。');
        const input = await readJson(request);
        if (typeof input.code !== 'string' || input.code.length > 128) fail(401, 'invalid_access_code', 'チーム用コードが正しくありません。');
        const limiter = env.BROWSER_SESSIONS.get(env.BROWSER_SESSIONS.idFromName(`login:${hmac(request.headers.get('cf-connecting-ip') || 'unknown', env.COOKIE_SECRET)}`));
        const attempt = await limiter.fetch('https://internal/attempt', { method: 'POST' });
        if (!attempt.ok) return secure(attempt);
        if (!equal(input.code, env.TEAM_ACCESS_CODE)) fail(401, 'invalid_access_code', 'チーム用コードが正しくありません。');
        const browserId = randomUUID();
        const expiresAt = Date.now() + ACCESS_TTL_MS;
        const stub = env.BROWSER_SESSIONS.get(env.BROWSER_SESSIONS.idFromName(browserId));
        const initialized = await stub.fetch('https://internal/initialize', { method: 'POST', body: JSON.stringify({ expiresAt }) });
        if (!initialized.ok) return secure(initialized);
        return secure(json(authResult(true, expiresAt), 200, { 'Set-Cookie': cookie(signAccess(browserId, expiresAt, env.COOKIE_SECRET)) }));
      }
      const access = accessCookie(request, env.COOKIE_SECRET);
      const stub = access ? env.BROWSER_SESSIONS.get(env.BROWSER_SESSIONS.idFromName(access.browserId)) : null;
      if (url.pathname === '/api/access/status') {
        if (request.method !== 'GET') fail(405, 'method_not_allowed', 'GETを指定してください。');
        const active = stub && (await stub.fetch('https://internal/status')).ok;
        return secure(json(authResult(Boolean(active), access?.expiresAt)));
      }
      if (url.pathname === '/api/access/logout') {
        if (request.method !== 'POST') fail(405, 'method_not_allowed', 'POSTを指定してください。');
        if (stub) {
          const result = await stub.fetch('https://internal/logout', { method: 'POST' });
          if (!result.ok) return secure(result);
        }
        return secure(json(authResult(false), 200, { 'Set-Cookie': cookie('') }));
      }
      if (!stub) unauthorized();
      if (url.pathname.startsWith('/api/desktop-overlay/')) {
        if (!(await stub.fetch('https://internal/status')).ok) unauthorized();
        if (url.pathname === '/api/desktop-overlay/status' && request.method === 'GET') return secure(json({ connected: false, supported: false, reason: 'public_browser_only' }));
        if (url.pathname === '/api/desktop-overlay/cue' && request.method === 'POST') {
          await readJson(request);
          return secure(json({ connected: false, delivered: false, supported: false }));
        }
        fail(404, 'not_found', '公開画面では利用できない機能です。');
      }
      if (!url.pathname.startsWith('/api/focus/')) fail(404, 'not_found', '利用できないAPIパスです。');
      const route = apiRoute(url.pathname, request.method);
      // Authorize before reading an image; ownership is checked again in the DO.
      if (!(await stub.fetch('https://internal/status')).ok) unauthorized();
      const prepared = await prepareApi(request, route);
      return secure(await stub.fetch(`https://internal${url.pathname}`, { method: request.method, ...prepared }));
    } catch (error) { return secure(errorResponse(error)); }
  },
};

export class FocusBrowserSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.pendingCreates = 0;
    this.pendingFrames = new Set();
    ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get('browser');
      this.attempts = await ctx.storage.get('attempts');
    });
  }

  active() { return Boolean(this.state && !this.state.revoked && this.state.expiresAt > Date.now()); }
  async save() { await this.ctx.storage.put('browser', this.state); }
  prune() {
    for (const [id, session] of Object.entries(this.state.sessions)) if (session.expiresAt <= Date.now()) delete this.state.sessions[id];
  }

  async upstream(route, { method = 'GET', headers = {}, body } = {}) {
    const forwarded = new Headers(headers);
    forwarded.set('accept', 'application/json');
    forwarded.set('authorization', `Bearer ${this.env.FOCUS_API_TOKEN}`);
    // Never copy browser cookies, Origin, Authorization or forwarding headers.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const request = new Request(`${UPSTREAM_ORIGIN}${route}`, { method, headers: forwarded, body, redirect: 'manual', signal: controller.signal });
      const response = await (this.env.FOCUS_API ? this.env.FOCUS_API.fetch(request) : fetch(request));
      if (response.status >= 300 && response.status < 400) fail(502, 'upstream_redirect', '共有APIから予期しない応答がありました。');
      if (MIME(response) !== 'application/json') fail(502, 'invalid_upstream_response', '共有APIの応答を読み取れません。');
      let bytes;
      try { bytes = await readBounded(response, MAX_RESPONSE_BYTES); } catch { fail(502, 'invalid_upstream_response', '共有APIの応答を読み取れません。'); }
      let value;
      try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(502, 'invalid_upstream_response', '共有APIの応答を読み取れません。'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(502, 'invalid_upstream_response', '共有APIの応答を読み取れません。');
      const cleanHeaders = new Headers();
      for (const name of ['x-request-id', 'retry-after']) {
        const value = response.headers.get(name);
        if (value) cleanHeaders.set(name, value);
      }
      return { response: json(value, response.status, Object.fromEntries(cleanHeaders)), value };
    } catch (error) {
      if (error instanceof PublicError) throw error;
      fail(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'upstream_timeout' : 'upstream_unavailable', controller.signal.aborted ? '共有APIの応答がタイムアウトしました。' : '共有APIに接続できません。');
    } finally { clearTimeout(timer); }
  }

  async endSession(id) {
    try { await this.upstream(`/v1/sessions/${id}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"end"}' }); } catch { /* Revocation remains effective even if the upstream is unavailable. */ }
  }

  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/attempt') {
        const now = Date.now();
        if (!this.attempts || this.attempts.until <= now) this.attempts = { until: now + 600_000, count: 0 };
        if (++this.attempts.count > 30) return json({ error: { code: 'login_rate_limited', message: 'ログインの試行が多すぎます。しばらく待ってください。' } }, 429, { 'Retry-After': String(Math.ceil((this.attempts.until - now) / 1000)) });
        await this.ctx.storage.put('attempts', this.attempts);
        await this.ctx.storage.setAlarm(this.attempts.until);
        return json({ allowed: true });
      }
      if (path === '/initialize') {
        if (this.state) fail(409, 'browser_exists', 'ログインをやり直してください。');
        const { expiresAt } = await request.json();
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + ACCESS_TTL_MS + 1000) fail(400, 'invalid_expiration', '有効期限が不正です。');
        this.state = { expiresAt, revoked: false, sessions: {} };
        await this.save();
        await this.ctx.storage.setAlarm(expiresAt);
        return json({ initialized: true });
      }
      if (path === '/status') { if (!this.active()) unauthorized(); return json({ active: true }); }
      if (path === '/logout') {
        if (this.state) {
          this.state.revoked = true;
          const ids = Object.keys(this.state.sessions);
          this.state.sessions = {};
          await this.save();
          await Promise.allSettled(ids.map(id => this.endSession(id)));
        }
        return json({ logged_out: true });
      }
      if (!this.active()) unauthorized();
      const route = apiRoute(path, request.method);
      this.prune();
      if (route.sessionId && !Object.hasOwn(this.state.sessions, route.sessionId)) fail(404, 'session_not_found', 'このブラウザのセッションが見つかりません。');
      if (route.create) {
        // Retain recent completed sessions while making room for another demo.
        if (Object.keys(this.state.sessions).length + this.pendingCreates >= MAX_BROWSER_SESSIONS) {
          const ended = Object.entries(this.state.sessions).find(([, session]) => session.ended);
          if (ended) delete this.state.sessions[ended[0]];
        }
        if (Object.keys(this.state.sessions).length + this.pendingCreates >= MAX_BROWSER_SESSIONS) fail(429, 'session_limit', 'セッション数の上限です。使用中のセッションを終了してください。');
      }
      if (route.operation === 'frames' && this.pendingFrames.has(route.sessionId)) fail(409, 'frame_in_progress', '前の画像の判定が完了するまでお待ちください。');
      const prepared = await prepareApi(request, route);
      // The body read yields: logout or another creation may have happened.
      if (!this.active()) unauthorized();
      if (route.create && Object.keys(this.state.sessions).length + this.pendingCreates >= MAX_BROWSER_SESSIONS) fail(429, 'session_limit', 'セッション数の上限です。使用中のセッションを終了してください。');
      if (route.operation === 'frames' && this.pendingFrames.has(route.sessionId)) fail(409, 'frame_in_progress', '前の画像の判定が完了するまでお待ちください。');
      if (route.create) this.pendingCreates++;
      if (route.operation === 'frames') this.pendingFrames.add(route.sessionId);
      try {
        const { response, value } = await this.upstream(route.route, { method: request.method, ...prepared });
        if (route.create && response.ok) {
          if (typeof value.session_id !== 'string' || !SESSION_ID.test(value.session_id)) fail(502, 'invalid_upstream_response', '共有APIのセッションIDを確認できません。');
          if (!this.active()) { await this.endSession(value.session_id); unauthorized(); }
          const duration = JSON.parse(prepared.body).duration_seconds;
          this.state.sessions[value.session_id] = { expiresAt: Math.min(this.state.expiresAt, Date.now() + duration * 1000 + 1_800_000), ended: false };
          await this.save();
        }
        if (!this.active()) unauthorized();
        if (route.sessionId && response.ok && value.state === 'ended' && this.state.sessions[route.sessionId]) {
          this.state.sessions[route.sessionId].ended = true;
          await this.save();
        }
        return response;
      } finally {
        if (route.create) this.pendingCreates--;
        if (route.operation === 'frames') this.pendingFrames.delete(route.sessionId);
      }
    } catch (error) { return errorResponse(error); }
  }

  async alarm() {
    if (this.state) {
      this.state.revoked = true;
      const ids = Object.keys(this.state.sessions);
      this.state.sessions = {};
      await this.save();
      await Promise.allSettled(ids.map(id => this.endSession(id)));
    }
    await this.ctx.storage.deleteAll();
    this.state = null;
    this.attempts = null;
  }
}
