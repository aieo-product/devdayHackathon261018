import { readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const FOCUS_API_BASE_URL = 'https://focus-shared-api-20261018.take-otani.workers.dev';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export async function loadFocusConfig({ directory, env = process.env }) {
  const local = {};
  // The webroot's optional fallback loads first; the private sibling wins.
  for (const filename of [path.join(directory, '.env.local'), path.resolve(directory, '../.env.focus-api.local')]) {
   try {
    const source = await readFile(filename, 'utf8');
    await chmod(filename, 0o600);
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      local[match[1]] = value;
    }
   } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Unable to load local API configuration.');
   }
  }
  const token = String(env.FOCUS_API_TOKEN ?? local.FOCUS_API_TOKEN ?? '').trim();
  if (/[\r\n]/.test(token)) throw new Error('Invalid local API credential format.');
  const configuredUrl = String(env.FOCUS_API_URL ?? local.FOCUS_API_URL ?? FOCUS_API_BASE_URL).replace(/\/$/, '');
  if (configuredUrl !== FOCUS_API_BASE_URL) throw new Error('Unexpected upstream API destination.');
  return { token, baseUrl: FOCUS_API_BASE_URL };
}

export function validLocalHost(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) return false;
  try {
    const url = new URL(`http://${host}`);
    return LOCAL_HOSTS.has(url.hostname) && Number(url.port || 80) === req.socket.localPort;
  } catch { return false; }
}

function allowedOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return origin === `http://${req.headers.host}`;
}

function jsonError(res, status, code, message) {
  const requestId = randomUUID();
  const body = JSON.stringify({ error: { code, message }, request_id: requestId });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Request-Id': requestId, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const fail = (code) => { cleanup(); req.resume(); reject(Object.assign(new Error(code), { code })); };
    const data = chunk => {
      size += chunk.length;
      if (size > maximum) { fail('body_too_large'); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const aborted = () => fail('request_aborted');
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', aborted); req.off('aborted', aborted); };
    if (Number(req.headers['content-length']) > maximum) { fail('body_too_large'); return; }
    req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted);
  });
}

export function createFocusApiProxy({ token = '', baseUrl = FOCUS_API_BASE_URL, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  if (baseUrl !== FOCUS_API_BASE_URL) throw new Error('Unexpected upstream API destination.');
  return async function proxy(req, res, pathname, search = '') {
    if (!validLocalHost(req) || !allowedOrigin(req)) {
      jsonError(res, 403, 'origin_not_allowed', 'この端末の同一オリジンからアクセスしてください。');
      return;
    }
    const route = pathname.replace(/^\/api\/focus/, '');
    const session = /^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})(?:\/(frames|control))?$/.exec(route);
    const health = route === '/health';
    const start = route === '/v1/sessions';
    if (search || (!health && !start && !session)) {
      jsonError(res, 404, 'not_found', '利用できないAPIパスです。'); return;
    }
    const expected = health || (session && !session[2]) ? 'GET' : 'POST';
    if (req.method !== expected) {
      res.setHeader('Allow', expected);
      jsonError(res, 405, 'method_not_allowed', 'このAPIでは指定のメソッドを使用できません。'); return;
    }
    if (!health && !token) {
      jsonError(res, 503, 'service_not_configured', '共有APIトークンが未設定です。'); return;
    }
    const headers = { Accept: 'application/json' };
    if (!health) headers.Authorization = `Bearer ${token}`;
    let body;
    if (expected === 'POST') {
      const media = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const frame = session?.[2] === 'frames';
      if (frame ? !['image/jpeg', 'image/png'].includes(media) : media !== 'application/json') {
        jsonError(res, 415, 'unsupported_media_type', '正しいContent-Typeを指定してください。'); req.resume(); return;
      }
      headers['Content-Type'] = media;
      if (frame) {
        const frameId = req.headers['x-frame-id'];
        if (typeof frameId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(frameId)) {
          jsonError(res, 400, 'invalid_frame_id', '有効なX-Frame-Idを指定してください。'); req.resume(); return;
        }
        headers['X-Frame-Id'] = frameId;
      }
      try { body = await readBody(req, frame ? 1_048_576 : 16_384); }
      catch (error) {
        jsonError(res, error.code === 'body_too_large' ? 413 : 400, error.code, 'リクエスト本文を受理できません。'); return;
      }
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', close);
    try {
      const response = await fetchImpl(`${baseUrl}${route}`, { method: expected, headers, body,
        signal: controller.signal, redirect: 'error' });
      const data = Buffer.from(await response.arrayBuffer());
      const responseHeaders = { 'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'Content-Length': data.length };
      for (const header of ['x-request-id', 'retry-after']) {
        const value = response.headers.get(header);
        if (value) responseHeaders[header] = value;
      }
      res.writeHead(response.status, responseHeaders);
      res.end(data);
    } catch {
      if (!res.destroyed) jsonError(res, timedOut ? 504 : 502, timedOut ? 'upstream_timeout' : 'upstream_unavailable',
        timedOut ? '共有APIの応答がタイムアウトしました。' : '共有APIに接続できません。');
    } finally {
      clearTimeout(timer);
      res.off('close', close);
    }
  };
}
