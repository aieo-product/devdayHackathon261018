import { randomUUID, timingSafeEqual } from 'node:crypto';
import { FocusEngine } from '../../api/src/engine.mjs';
import { createProvider } from '../../api/src/provider.mjs';
import { readConfig } from '../../api/src/config.mjs';
import { HttpError, DecisionError } from '../../api/src/errors.mjs';
import apiSpec from '../API仕様書.md';
import openApi from '../openapi.yaml';

const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const errorResponse = (error, requestId) => json({ error: { code: error instanceof HttpError ? error.code : 'internal_error', message: error instanceof HttpError ? error.message : 'サーバーでエラーが発生しました。' }, request_id: requestId }, error instanceof HttpError ? error.status : 500);
const mime = request => (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
async function readBody(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) fail(413, 'body_too_large', '送信データが上限を超えています。');
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); fail(413, 'body_too_large', '送信データが上限を超えています。'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}
async function readJson(request) {
  if (mime(request) !== 'application/json') fail(415, 'unsupported_media_type', 'Content-Type は application/json を指定してください。');
  const bytes = await readBody(request, 16384);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(400, 'invalid_json', 'JSONを読み取れません。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_json_object', 'JSONオブジェクトを指定してください。');
  return value;
}

export default {
  async fetch(request, env) {
    const requestId = randomUUID();
    const headers = new Headers({ 'X-Request-Id': requestId });
    let response;
    try {
      let config;
      try { config = readConfig(env); } catch { /* Health remains available with missing configuration. */ }
      const origins = config?.allowedOrigins || (env.ALLOWED_ORIGINS ?? 'http://localhost:3000,http://localhost:5173').split(',').map(s => s.trim()).filter(Boolean);
      const origin = request.headers.get('origin');
      if (origin) {
        headers.set('Vary', 'Origin');
        if (!origins.includes(origin)) fail(403, 'origin_not_allowed', 'このOriginからのアクセスは許可されていません。');
        headers.set('Access-Control-Allow-Origin', origin);
      }
      const pathname = new URL(request.url).pathname;
      if (request.method === 'OPTIONS') {
        const method = request.headers.get('access-control-request-method');
        const requested = (request.headers.get('access-control-request-headers') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if ((method && !['GET', 'POST'].includes(method)) || requested.some(h => !['authorization', 'content-type', 'x-frame-id'].includes(h))) fail(403, 'preflight_not_allowed', 'このメソッドまたはヘッダーは許可されていません。');
        response = new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Frame-Id', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' } });
      } else if (request.method === 'GET' && pathname === '/health') {
        response = json({ provider: config?.provider || env.DECISION_PROVIDER || 'openai', configured: Boolean(config && env.FOCUS_SESSIONS && createProvider(config).configured) });
      } else if (request.method === 'GET' && pathname === '/') {
        response = json({ name: 'Focus 共通判定API', version: 'v1', base_url: new URL(request.url).origin, documentation: '/docs', openapi: '/openapi.json', health: '/health', authentication: 'Authorization: Bearer <FOCUS_API_TOKEN>' });
      } else if (request.method === 'GET' && pathname === '/docs') {
        response = new Response(apiSpec, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      } else if (request.method === 'GET' && pathname === '/openapi.json') {
        response = new Response(openApi, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      } else {
        if (!(pathname === '/v1' || pathname.startsWith('/v1/'))) fail(404, 'not_found', 'エンドポイントが見つかりません。');
        if (!config || !env.FOCUS_SESSIONS) fail(503, 'service_not_configured', 'APIが設定されていません。');
        const actual = Buffer.from(request.headers.get('authorization') || '');
        const expected = Buffer.from(`Bearer ${config.apiToken}`);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(401, 'unauthorized', '有効なBearerトークンが必要です。');
        const create = request.method === 'POST' && pathname === '/v1/sessions';
        const match = pathname.match(/^\/v1\/sessions\/([a-zA-Z0-9-]{1,80})(?:\/(frames|control))?$/);
        if (!create && !match) fail(404, 'not_found', 'エンドポイントが見つかりません。');
        const id = create ? randomUUID() : match[1];
        const stub = env.FOCUS_SESSIONS.get(env.FOCUS_SESSIONS.idFromName(id));
        const forwarded = new Headers(request.headers);
        forwarded.delete('authorization');
        forwarded.set('x-internal-session-id', id);
        forwarded.set('x-internal-request-id', requestId);
        forwarded.set('x-internal-create', create ? '1' : '0');
        response = await stub.fetch(new Request(request, { headers: forwarded }));
      }
    } catch (error) { response = errorResponse(error, requestId); }
    const result = new Response(response.body, response);
    for (const [key, value] of headers) result.headers.set(key, value);
    return result;
  },
};

export class FocusSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.writeTail = Promise.resolve();
    this.persistedFrames = new Set();
    const provider = createProvider(readConfig(env));
    this.engine = new FocusEngine({ provider: {
      name: provider.name, configured: provider.configured,
      decide: async args => {
        const session = this.session;
        const generation = session.generation;
        await this.persist();
        this.engine.refresh(session);
        if (args.signal.aborted || session.generation !== generation || !session.inFlight) throw new DecisionError('decision_cancelled');
        return provider.decide(args);
      },
    } });
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('session');
      if (!saved) return;
      const frames = await ctx.storage.list({ prefix: 'frame:' });
      this.persistedFrames = new Set([...frames.keys()].map(k => k.slice(6)));
      this.session = { ...saved, seenFrames: new Set([...frames.keys()].map(k => k.slice(6))), inFlight: null };
      this.engine.sessions.set(saved.id, this.session);
      if (saved.pending) {
        this.engine.invalidate(this.session);
        if (!['ended', 'paused'].includes(this.session.state)) this.session.state = 'unknown';
        this.session.reason = 'decision_interrupted';
      }
      delete this.session.pending;
      this.engine.refresh(this.session);
      await this.persist();
    });
  }

  persist() {
    // Capture synchronously, then serialize writes: a pause cannot be overwritten by an older inference write.
    const session = this.session;
    if (!session) return Promise.resolve();
    const { seenFrames, inFlight, ...values } = session;
    const snapshot = { ...values, pending: Boolean(inFlight) };
    const frameIds = [...seenFrames];
    const write = this.writeTail.then(async () => {
      await this.ctx.storage.transaction(async storage => {
        await storage.put('session', snapshot);
        for (const id of frameIds) {
          if (!this.persistedFrames.has(id)) await storage.put(`frame:${id}`, true);
        }
        await storage.setAlarm((snapshot.endedAt ?? snapshot.expiresAt) + this.engine.settings.retentionMs + 1);
      });
      for (const id of frameIds) this.persistedFrames.add(id);
    });
    this.writeTail = write.catch(() => {});
    return write;
  }

  async fetch(request) {
    const requestId = request.headers.get('x-internal-request-id');
    try {
      const sessionId = request.headers.get('x-internal-session-id');
      const owner = 'shared-api';
      const pathname = new URL(request.url).pathname;
      let result;
      let status = 200;
      let resultGeneration;
      if (request.headers.get('x-internal-create') === '1') {
        const body = await readJson(request);
        if (typeof body.device_type !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(body.device_type)) fail(400, 'invalid_device_type', 'device_typeに短い識別名を指定してください。');
        const durationSeconds = body.duration_seconds === undefined ? 1500 : body.duration_seconds;
        if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 14400) fail(400, 'invalid_duration', 'duration_secondsは1〜14400の整数を指定してください。');
        if (this.session) fail(409, 'session_exists', 'セッションは既に存在します。');
        const created = this.engine.create({ owner, deviceType: body.device_type, durationSeconds });
        this.session = this.engine.sessions.get(created.session_id);
        this.engine.sessions.delete(created.session_id);
        this.session.id = sessionId;
        this.engine.sessions.set(sessionId, this.session);
        result = this.engine.snapshot(this.session);
        status = 201;
      } else {
        const args = { owner, sessionId };
        this.engine.find(owner, sessionId);
        if (request.method === 'GET' && !pathname.endsWith('/frames') && !pathname.endsWith('/control')) result = this.engine.get(args);
        else if (request.method === 'POST' && pathname.endsWith('/control')) {
          const body = await readJson(request);
          if (!['pause', 'resume', 'end'].includes(body.action)) fail(400, 'invalid_action', 'actionはpause、resume、endのいずれかです。');
          result = this.engine.control({ ...args, action: body.action });
        } else if (request.method === 'POST' && pathname.endsWith('/frames')) {
          const expectedGeneration = this.engine.getGeneration(args);
          const contentType = mime(request);
          if (!['image/jpeg', 'image/png'].includes(contentType)) fail(415, 'unsupported_media_type', 'JPEGまたはPNG画像を送信してください。');
          const frameId = request.headers.get('x-frame-id');
          if (!frameId || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(frameId)) fail(400, 'invalid_frame_id', '一意なX-Frame-Idを指定してください。');
          const bytes = await readBody(request, 1024 * 1024);
          const valid = contentType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
          if (!valid) fail(400, 'invalid_image', '画像の形式とContent-Typeが一致していません。');
          resultGeneration = expectedGeneration;
          result = await this.engine.frame({ ...args, frameId, bytes, contentType, expectedGeneration });
        } else fail(405, 'method_not_allowed', 'このメソッドは利用できません。');
      }
      const generation = resultGeneration ?? this.session.generation;
      await this.persist();
      this.engine.refresh(this.session);
      if (generation !== this.session.generation || this.session.state === 'ended' || this.session.state === 'paused') {
        result = this.engine.snapshot(this.session);
        await this.persist();
      }
      return json(result, status);
    } catch (error) { return errorResponse(error, requestId); }
  }

  async alarm() {
    if (!this.session) { await this.ctx.storage.deleteAll(); return; }
    this.engine.refresh(this.session);
    const deadline = (this.session.endedAt ?? this.session.expiresAt) + this.engine.settings.retentionMs;
    if (Date.now() > deadline) {
      this.engine.invalidate(this.session);
      this.engine.sessions.clear();
      this.session = null;
      await this.writeTail;
      await this.ctx.storage.deleteAll();
    } else await this.ctx.storage.setAlarm(deadline + 1);
  }
}
