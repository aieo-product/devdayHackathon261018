import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const JSON_LIMIT = 16 * 1024;
const IMAGE_LIMIT = 1024 * 1024;
const STATIC_FILES = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['public/app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/focus-client.mjs', ['../../clients/focus-client.mjs', 'text/javascript; charset=utf-8']],
]);
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parsePort(value = '3000') {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) {
    throw new TypeError('MAC_CAMERA_PORT must be an integer from 1 to 65535.');
  }
  return Number(value);
}

function validateApiUrl(value, allowLoopbackHttp) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new TypeError('FOCUS_API_URL must be a valid HTTPS URL.'); }
  const localHttp = allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('FOCUS_API_URL must be HTTPS without credentials, a query, or a fragment.');
  }
  return url.href.replace(/\/$/, '');
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      req.resume();
      reject(new RequestError(413, 'body_too_large', '送信データが上限を超えています。'));
      return;
    }
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const onError = () => {
      cleanup();
      reject(new RequestError(400, 'request_interrupted', '送信が中断されました。'));
    };
    const onAborted = onError;
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.resume();
        reject(new RequestError(413, 'body_too_large', '送信データが上限を超えています。'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolveBody(Buffer.concat(chunks, size));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function proxyRoute(method, path) {
  if (method === 'GET' && path === '/api/health') return { path: '/health' };
  if (method === 'POST' && path === '/api/v1/sessions') return { path: '/v1/sessions', limit: JSON_LIMIT, types: ['application/json'] };
  const match = path.match(/^\/api(\/v1\/sessions\/[a-zA-Z0-9-]{1,80})(?:\/(frames|control))?$/);
  if (!match) return null;
  if (method === 'GET' && !match[2]) return { path: match[1] };
  if (method !== 'POST') return null;
  if (match[2] === 'frames') return { path: `${match[1]}/frames`, limit: IMAGE_LIMIT, types: ['image/jpeg', 'image/png'] };
  if (match[2] === 'control') return { path: `${match[1]}/control`, limit: JSON_LIMIT, types: ['application/json'] };
  return null;
}

/** Credentials stay in this loopback process; the page only sees API responses. */
export function createCameraCheckServer({
  apiUrl = process.env.FOCUS_API_URL,
  apiToken = process.env.FOCUS_API_TOKEN,
  fetchImpl = globalThis.fetch,
  allowLoopbackHttp = false,
} = {}) {
  const upstreamBase = validateApiUrl(apiUrl, allowLoopbackHttp);
  const token = typeof apiToken === 'string' ? apiToken.trim() : '';
  if (/[\r\n]/.test(token)) throw new TypeError('FOCUS_API_TOKEN contains an invalid line break.');
  const configured = Boolean(upstreamBase && token);
  const server = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const controller = new AbortController();
    const abortDisconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abortDisconnected);
    req.once('aborted', () => controller.abort());
    let timer;
    try {
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const host = req.headers.host;
      if (!allowedHosts.includes(host)) throw new RequestError(403, 'host_not_allowed', 'このHostからのアクセスは許可されていません。');
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new RequestError(403, 'origin_not_allowed', 'このOriginからのアクセスは許可されていません。');
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) throw new RequestError(403, 'origin_not_allowed', 'このサイトからのアクセスは許可されていません。');

      const staticFile = req.method === 'GET' && STATIC_FILES.get(req.url);
      if (staticFile) {
        const body = await readFile(new URL(staticFile[0], import.meta.url));
        res.writeHead(200, { 'Content-Type': staticFile[1] });
        res.end(body);
        return;
      }
      if (req.method === 'GET' && req.url === '/config') {
        sendJson(res, 200, { configured, api_url: upstreamBase });
        return;
      }
      const route = proxyRoute(req.method, req.url);
      if (!route) throw new RequestError(404, 'not_found', 'エンドポイントが見つかりません。');
      if (!configured) throw new RequestError(503, 'service_not_configured', 'FOCUS_API_URL と FOCUS_API_TOKEN をローカルで設定してください。');
      const headers = new Headers({ Authorization: `Bearer ${token}` });
      let body;
      if (route.limit) {
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!route.types.includes(contentType)) throw new RequestError(415, 'unsupported_media_type', '送信データの形式が対応していません。');
        headers.set('Content-Type', contentType);
        if (req.headers['x-frame-id']) headers.set('X-Frame-Id', req.headers['x-frame-id']);
        body = await readBody(req, route.limit);
      }
      timer = setTimeout(() => controller.abort(), 20_000);
      timer.unref();
      const response = await fetchImpl(`${upstreamBase}${route.path}`, {
        method: req.method, headers, body, signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store',
      });
      // Only the JSON response is relayed; upstream cookies and other headers are not.
      const payload = Buffer.from(await response.arrayBuffer());
      if (res.destroyed) return;
      res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(payload);
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        const known = error instanceof RequestError;
        sendJson(res, known ? error.status : 502, {
          error: {
            code: known ? error.code : 'upstream_unavailable',
            message: known ? error.message : 'APIに接続できませんでした。接続設定とネットワークを確認してください。',
          },
        });
      }
    } finally {
      clearTimeout(timer);
      res.off('close', abortDisconnected);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = parsePort(process.env.MAC_CAMERA_PORT ?? '3000');
    const server = createCameraCheckServer();
    server.on('error', error => {
      console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set MAC_CAMERA_PORT to another port.` : 'Camera check server could not start.');
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => console.log(`Mac camera check: http://127.0.0.1:${port}`));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
