import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const JSON_LIMIT = 16 * 1024;
const IMAGE_LIMIT = 1024 * 1024;
const STATIC_FILES = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['public/app.mjs', 'text/javascript; charset=utf-8']],
  ['/remote-control.mjs', ['public/remote-control.mjs', 'text/javascript; charset=utf-8']],
  ['/mcp/setup', ['public/mcp-setup.html', 'text/html; charset=utf-8']],
  ['/mcp-setup.mjs', ['public/mcp-setup.mjs', 'text/javascript; charset=utf-8']],
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

function validateApiUrl(value, allowLoopbackHttp, name = 'FOCUS_API_URL') {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${name} must be a valid HTTPS URL.`); }
  const localHttp = allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new TypeError(`${name} must be HTTPS without credentials, a query, or a fragment.`);
  }
  if (name === 'FOCUS_EVENTS_URL' && url.pathname !== '/') throw new TypeError('FOCUS_EVENTS_URL must be an origin without a path.');
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

async function readJsonObject(req) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new RequestError(415, 'unsupported_media_type', 'JSONを送信してください。');
  const body = await readBody(req, JSON_LIMIT);
  try {
    const value = JSON.parse(body.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new RequestError(400, 'invalid_request', 'JSONオブジェクトを送信してください。'); }
}

const deviceIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const deviceStates = new Set(['on', 'off', 'blocked', 'error']);
const deviceErrors = {
  device_not_found: '端末が見つかりません。端末側の確認画面を開いてください。',
  device_offline: '端末がオフラインです。端末側の確認画面を表示してください。',
  remote_disabled: '端末側でリモート操作を許可してください。',
  future_revision: '端末の状態を同期できませんでした。画面を再読み込みしてください。',
  device_capacity: '接続できる端末数の上限に達しました。',
  invalid_device_request: '端末の操作内容が正しくありません。',
};

function publicDevice(value) {
  if (!value || !deviceIdentifier(value.device_id) || !['on', 'off'].includes(value.desired_state)
    || !deviceStates.has(value.observed_state) || typeof value.remote_enabled !== 'boolean'
    || typeof value.online !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Number.isSafeInteger(value.applied_revision) || value.applied_revision < 0) throw new Error('Invalid device response');
  const result = {};
  for (const key of ['device_id', 'name', 'type', 'desired_state', 'observed_state', 'remote_enabled', 'revision', 'applied_revision', 'last_seen_at', 'online', 'command_issued_at', 'command_expires_at', 'session_id']) result[key] = value[key] ?? null;
  return result;
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

// Independent, bounded best-effort delivery. Images never enter this queue.
function createEventRelay({ baseUrl, token, sourceId, fetchImpl }) {
  const queue = [], seen = new Set();
  let closed = false, busy = false, retryTimer, timeout, controller;
  const finish = () => { queue.shift(); busy = false; void drain(); };
  async function drain() {
    if (closed || busy || !queue.length) return;
    busy = true;
    const item = queue[0];
    controller = new AbortController();
    timeout = setTimeout(() => controller?.abort(), 5_000);
    timeout.unref();
    let retry = false, delivered = false;
    try {
      const response = await fetchImpl(`${baseUrl}/events/ingest`, {
        method: 'POST', headers: new Headers({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }),
        body: item.body, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      });
      delivered = response.ok;
      retry = response.status === 408 || response.status === 429 || response.status >= 500;
      await response.body?.cancel().catch(() => {});
    } catch { retry = true; }
    finally { clearTimeout(timeout); controller = null; }
    if (closed) return;
    item.attempts += 1;
    if (retry && item.attempts < 3) {
      retryTimer = setTimeout(() => { busy = false; void drain(); }, 250 * 2 ** (item.attempts - 1));
      retryTimer.unref();
      return;
    }
    if (!delivered) console.warn('Focus events: metadata delivery failed; camera detection continues.');
    finish();
  }
  return {
    enqueue(snapshot) {
      const id = snapshot?.notification_id;
      if (closed || snapshot?.notify !== true || typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id) || seen.has(id)) return;
      if (queue.length >= 64) {
        console.warn('Focus events: metadata queue is full; camera detection continues.');
        return;
      }
      seen.add(id);
      if (seen.size > 1024) seen.delete(seen.values().next().value);
      const data = { notification_id: id, session_id: snapshot.session_id, device_type: 'mac' };
      for (const name of ['continuous_hold_ms', 'required_hold_ms', 'phone_probability', 'observable_probability']) {
        data[name] = Number.isFinite(snapshot[name]) ? snapshot[name] : null;
      }
      data.provider = typeof snapshot.provider === 'string' ? snapshot.provider.slice(0, 80) : null;
      queue.push({ attempts: 0, body: JSON.stringify({ source_id: sourceId, event: {
        eventId: id, name: 'focus.phone_held', timestamp: new Date().toISOString(), data, cursor: null,
      } }) });
      void drain();
    },
    close() {
      closed = true;
      clearTimeout(retryTimer); clearTimeout(timeout); controller?.abort();
      queue.length = 0; seen.clear();
    },
  };
}

/** Credentials stay in this loopback process; the page only sees API responses. */
export function createCameraCheckServer({
  apiUrl = process.env.FOCUS_API_URL,
  apiToken = process.env.FOCUS_API_TOKEN,
  eventsUrl = process.env.FOCUS_EVENTS_URL,
  eventsToken = process.env.FOCUS_EVENTS_TOKEN,
  sourceId = process.env.FOCUS_SOURCE_ID,
  deviceId = process.env.FOCUS_DEVICE_ID,
  fetchImpl = globalThis.fetch,
  allowLoopbackHttp = false,
} = {}) {
  const upstreamBase = validateApiUrl(apiUrl, allowLoopbackHttp);
  const token = typeof apiToken === 'string' ? apiToken.trim() : '';
  if (/[\r\n]/.test(token)) throw new TypeError('FOCUS_API_TOKEN contains an invalid line break.');
  const configured = Boolean(upstreamBase && token);
  const eventsBase = validateApiUrl(eventsUrl, allowLoopbackHttp, 'FOCUS_EVENTS_URL');
  const relayToken = typeof eventsToken === 'string' ? eventsToken.trim() : '';
  if (/[\r\n]/.test(relayToken)) throw new TypeError('FOCUS_EVENTS_TOKEN contains an invalid line break.');
  if (sourceId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sourceId)) throw new TypeError('FOCUS_SOURCE_ID must be a UUID.');
  const localDeviceId = deviceId || sourceId;
  if (localDeviceId && !deviceIdentifier(localDeviceId)) throw new TypeError('FOCUS_DEVICE_ID must contain 1 to 128 identifier characters.');
  const eventsConfigured = Boolean(eventsBase && relayToken && sourceId);
  const relay = eventsConfigured ? createEventRelay({ baseUrl: eventsBase, token: relayToken, sourceId, fetchImpl }) : null;
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
        sendJson(res, 200, { configured, api_url: upstreamBase, events: { configured: eventsConfigured, mcp_url: eventsConfigured ? `${eventsBase}/mcp` : null, device_id: eventsConfigured ? localDeviceId : null } });
        return;
      }
      if (req.method === 'POST' && ['/devices/heartbeat', '/devices/list', '/devices/control'].includes(req.url)) {
        if (!eventsConfigured) throw new RequestError(503, 'events_not_configured', 'MCP Eventsのローカル設定がありません。');
        const input = await readJsonObject(req);
        const allowed = req.url === '/devices/list' ? [] : req.url === '/devices/control' ? ['device_id', 'enabled'] : ['name', 'observed_state', 'remote_enabled', 'applied_revision', 'session_id'];
        if (Object.keys(input).some(key => !allowed.includes(key))) throw new RequestError(400, 'invalid_device_request', deviceErrors.invalid_device_request);
        let value;
        if (req.url === '/devices/heartbeat') {
          if (!deviceStates.has(input.observed_state) || typeof input.remote_enabled !== 'boolean'
            || !Number.isSafeInteger(input.applied_revision) || input.applied_revision < 0
            || (input.session_id !== undefined && input.session_id !== null && !deviceIdentifier(input.session_id))
            || (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(input.name)))) throw new RequestError(400, 'invalid_device_request', deviceErrors.invalid_device_request);
          value = { ...input, source_id: sourceId, device_id: localDeviceId, device_type: 'mac' };
        } else if (req.url === '/devices/control') {
          if (!deviceIdentifier(input.device_id) || typeof input.enabled !== 'boolean') throw new RequestError(400, 'invalid_device_request', deviceErrors.invalid_device_request);
          value = { source_id: sourceId, device_id: input.device_id, enabled: input.enabled };
        } else value = { source_id: sourceId };
        timer = setTimeout(() => controller.abort(), 8_000); timer.unref();
        const response = await fetchImpl(`${eventsBase}${req.url}`, {
          method: 'POST', headers: new Headers({ Authorization: `Bearer ${relayToken}`, 'Content-Type': 'application/json' }),
          body: JSON.stringify(value), signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        });
        const result = await response.json();
        if (!response.ok) {
          const code = result?.error?.code;
          if (Object.hasOwn(deviceErrors, code)) throw new RequestError([400, 404, 409, 429].includes(response.status) ? response.status : 502, code, deviceErrors[code]);
          throw new RequestError(502, 'device_service_unavailable', '端末サービスに接続できませんでした。検知APIはそのまま利用できます。');
        }
        if (req.url === '/devices/list') {
          if (!Array.isArray(result.devices) || result.devices.length > 200) throw new Error('Invalid device list');
          sendJson(res, 200, { devices: result.devices.map(publicDevice) });
        } else sendJson(res, 200, publicDevice(result));
        return;
      }
      if (req.method === 'POST' && req.url === '/mcp/pairing') {
        if (!eventsConfigured) throw new RequestError(503, 'events_not_configured', 'MCP Eventsのローカル設定がありません。');
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/json') throw new RequestError(415, 'unsupported_media_type', 'JSONを送信してください。');
        const requestBody = await readBody(req, JSON_LIMIT);
        try {
          const parsed = JSON.parse(requestBody.toString());
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length) throw new Error();
        } catch { throw new RequestError(400, 'invalid_request', '空のJSONオブジェクトを送信してください。'); }
        timer = setTimeout(() => controller.abort(), 10_000); timer.unref();
        const response = await fetchImpl(`${eventsBase}/admin/pairing`, {
          method: 'POST', headers: new Headers({ Authorization: `Bearer ${relayToken}`, 'Content-Type': 'application/json' }),
          body: JSON.stringify({ source_id: sourceId }), signal: controller.signal,
          redirect: 'error', credentials: 'omit', cache: 'no-store',
        });
        if (!response.ok) throw new RequestError(502, 'pairing_unavailable', '接続コードを発行できませんでした。MCP Eventsの設定を確認してください。');
        const value = await response.json();
        if (typeof value.code !== 'string' || !value.code.trim() || value.code.length > 128 || !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= Date.now()) throw new Error('Invalid pairing response');
        sendJson(res, 200, { code: value.code, expires_at: value.expires_at });
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
      if (relay && response.ok && route.path.endsWith('/frames')) {
        try { relay.enqueue(JSON.parse(payload.toString('utf8'))); } catch { /* Optional delivery never affects API responses. */ }
      }
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
  server.once('close', () => relay?.close());
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
