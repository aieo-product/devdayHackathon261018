import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { FocusEngine } from './engine.mjs';
import { createProvider } from './provider.mjs';
import { HttpError } from './errors.mjs';

const validToken = (actual, expected) => {
  const received = Buffer.from(actual || '');
  const required = Buffer.from(`Bearer ${expected}`);
  return received.length === required.length && timingSafeEqual(received, required);
};

function readBody(req, maxBytes) {
  if (Number(req.headers['content-length']) > maxBytes) {
    req.resume();
    throw new HttpError(413, 'body_too_large', '送信データが上限を超えています。');
  }
  return new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(new HttpError(413, 'body_too_large', '送信データが上限を超えています。'));
      } else chunks.push(chunk);
    });
    req.once('end', () => {
      if (!settled) { settled = true; resolve(Buffer.concat(chunks)); }
    });
    const interrupted = () => {
      if (!settled) { settled = true; reject(new HttpError(400, 'request_interrupted', '送信が中断されました。')); }
    };
    req.once('error', interrupted);
    req.once('aborted', interrupted);
  });
}

const mimeType = (req) => (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();

async function readJson(req) {
  if (mimeType(req) !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Content-Type は application/json を指定してください。');
  const body = await readBody(req, 16 * 1024);
  let value;
  try { value = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json', 'JSONを読み取れません。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_json_object', 'JSONオブジェクトを指定してください。');
  return value;
}

function verifyImage(bytes, contentType) {
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if ((contentType === 'image/jpeg' && !jpeg) || (contentType === 'image/png' && !png)) {
    throw new HttpError(400, 'invalid_image', '画像の形式とContent-Typeが一致していません。');
  }
}

export function createApp({ config, engine } = {}) {
  config = { maxImageBytes: 1024 * 1024, allowedOrigins: ['http://localhost:3000', 'http://localhost:5173'], ...config };
  if (!config.apiToken) throw new Error('FOCUS_API_TOKEN is required.');
  engine ||= new FocusEngine({ provider: createProvider(config) });
  const send = (res, status, data) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    try {
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Vary', 'Origin');
        if (!config.allowedOrigins.includes(origin)) throw new HttpError(403, 'origin_not_allowed', 'このOriginからのアクセスは許可されていません。');
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      if (req.method === 'OPTIONS') {
        const method = req.headers['access-control-request-method'];
        const headers = (req.headers['access-control-request-headers'] || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
        if ((method && !['GET', 'POST'].includes(method)) || headers.some((name) => !['authorization', 'content-type', 'x-frame-id'].includes(name))) {
          throw new HttpError(403, 'preflight_not_allowed', 'このメソッドまたはヘッダーは許可されていません。');
        }
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Frame-Id',
          'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/health') {
        send(res, 200, { provider: engine.provider.name, configured: engine.provider.configured });
        return;
      }
      if (pathname === '/v1' || pathname.startsWith('/v1/')) {
        if (!validToken(req.headers.authorization, config.apiToken)) throw new HttpError(401, 'unauthorized', '有効なBearerトークンが必要です。');
      } else throw new HttpError(404, 'not_found', 'エンドポイントが見つかりません。');
      const owner = config.apiToken;
      if (req.method === 'POST' && pathname === '/v1/sessions') {
        const body = await readJson(req);
        if (typeof body.device_type !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(body.device_type)) throw new HttpError(400, 'invalid_device_type', 'device_typeに短い識別名を指定してください。');
        const durationSeconds = body.duration_seconds === undefined ? 1500 : body.duration_seconds;
        if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 14400) throw new HttpError(400, 'invalid_duration', 'duration_secondsは1〜14400の整数を指定してください。');
        send(res, 201, engine.create({ owner, deviceType: body.device_type, durationSeconds }));
        return;
      }
      const match = pathname.match(/^\/v1\/sessions\/([a-zA-Z0-9-]{1,80})(?:\/(frames|control))?$/);
      if (!match) throw new HttpError(404, 'not_found', 'エンドポイントが見つかりません。');
      const sessionId = match[1];
      if (req.method === 'GET' && !match[2]) {
        send(res, 200, engine.get({ owner, sessionId }));
      } else if (req.method === 'POST' && match[2] === 'control') {
        const body = await readJson(req);
        if (!['pause', 'resume', 'end'].includes(body.action)) throw new HttpError(400, 'invalid_action', 'actionはpause、resume、endのいずれかです。');
        send(res, 200, engine.control({ owner, sessionId, action: body.action }));
      } else if (req.method === 'POST' && match[2] === 'frames') {
        const expectedGeneration = engine.getGeneration({ owner, sessionId });
        const contentType = mimeType(req);
        if (!['image/jpeg', 'image/png'].includes(contentType)) throw new HttpError(415, 'unsupported_media_type', 'JPEGまたはPNG画像を送信してください。');
        const frameId = req.headers['x-frame-id'];
        if (typeof frameId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(frameId)) throw new HttpError(400, 'invalid_frame_id', '一意なX-Frame-Idを指定してください。');
        const bytes = await readBody(req, config.maxImageBytes);
        verifyImage(bytes, contentType);
        send(res, 200, await engine.frame({ owner, sessionId, frameId, bytes, contentType, expectedGeneration }));
      } else throw new HttpError(405, 'method_not_allowed', 'このメソッドは利用できません。');
    } catch (error) {
      req.resume();
      const known = error instanceof HttpError;
      send(res, known ? error.status : 500, {
        error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'サーバーでエラーが発生しました。' },
        request_id: requestId,
      });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
