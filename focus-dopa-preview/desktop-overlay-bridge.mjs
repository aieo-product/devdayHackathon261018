import { createHash, timingSafeEqual } from 'node:crypto';

const PREFIX = '/api/desktop-overlay';
const MAX_BODY_BYTES = 4096;
const HEARTBEAT_MS = 4000;
const EVENT_LIFETIME_MS = 6000;
const MAX_SOURCE_REVISIONS = 128;

function json(res, status, body, headers = {}) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(encoded);
}

function error(res, status, code, headers) {
  json(res, status, { error: { code } }, headers);
}

function validHost(req) {
  const host = req.headers.host;
  const match = typeof host === 'string' && /^(localhost|127\.0\.0\.1):(\d{1,5})$/.exec(host);
  return Boolean(match && Number(match[2]) === req.socket.localPort);
}

function browserMutationAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  // A declared Origin always wins; Fetch Metadata cannot override a mismatch.
  if (origin !== undefined) return origin === `http://${req.headers.host}`;
  return site === 'same-origin';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', aborted);
      req.off('aborted', aborted);
    };
    const fail = code => {
      cleanup();
      req.resume();
      reject(Object.assign(new Error(code), { code }));
    };
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { fail('body_too_large'); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const aborted = () => fail('request_aborted');
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      fail('body_too_large');
      return;
    }
    req.on('data', data);
    req.once('end', end);
    req.once('error', aborted);
    req.once('aborted', aborted);
  });
}

function validCue(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (!['detect', 'clear'].includes(body.action)) return false;
  if (typeof body.sourceId !== 'string' || !body.sourceId.length || body.sourceId.length > 80) return false;
  if (body.revision !== undefined && (!Number.isSafeInteger(body.revision) || body.revision < 1)) return false;
  if (body.action === 'clear') return true;
  return ['green', 'cloud', 'cat'].includes(body.character)
    && typeof body.message === 'string' && body.message.length <= 500
    && ['test', 'detect'].includes(body.kind)
    && ['max', 'pop', 'off'].includes(body.intensity)
    && typeof body.reduced === 'boolean';
}

/** Ephemeral, loopback-only transport. Credentials never enter browser responses. */
export function createDesktopOverlayBridge({ token, now = Date.now } = {}) {
  if (typeof token !== 'string' || !token.length || /[\r\n]/.test(token)) {
    throw new TypeError('A local native-overlay credential is required.');
  }
  const credentialHash = createHash('sha256').update(`Bearer ${token}`).digest();
  let lastPollAt = null;
  let sequence = 0;
  let latest = null;
  let disposed = false;
  const sourceRevisions = new Map();

  const connected = at => !disposed && lastPollAt !== null && at >= lastPollAt && at - lastPollAt < HEARTBEAT_MS;
  const currentEvent = at => {
    if (latest && (at < latest.createdAt || at - latest.createdAt >= EVENT_LIFETIME_MS)) latest = null;
    return latest;
  };

  async function handle(req, res, pathname) {
    const statusRoute = pathname === `${PREFIX}/status`;
    const cueRoute = pathname === `${PREFIX}/cue`;
    const pollRoute = pathname === `${PREFIX}/native/poll`;
    if (!statusRoute && !cueRoute && !pollRoute) return false;
    if (!validHost(req)) { error(res, 403, 'host_not_allowed'); req.resume(); return true; }
    if (disposed) { error(res, 503, 'bridge_closed'); req.resume(); return true; }
    const method = cueRoute ? 'POST' : 'GET';
    if (req.method !== method) {
      error(res, 405, 'method_not_allowed', { Allow: method }); req.resume(); return true;
    }
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { error(res, 400, 'invalid_url'); req.resume(); return true; }
    if (!pollRoute && url.search) { error(res, 400, 'unexpected_query'); req.resume(); return true; }

    if (statusRoute) {
      json(res, 200, { connected: connected(now()) });
      return true;
    }
    if (pollRoute) {
      const supplied = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const suppliedHash = createHash('sha256').update(supplied).digest();
      if (!timingSafeEqual(credentialHash, suppliedHash)) {
        error(res, 401, 'native_auth_required'); return true;
      }
      const values = url.searchParams.getAll('after');
      const after = values[0] ?? '0';
      if ([...url.searchParams.keys()].some(key => key !== 'after') || values.length > 1
          || !/^(0|[1-9]\d*)$/.test(after) || !Number.isSafeInteger(Number(after))) {
        error(res, 400, 'invalid_sequence'); return true;
      }
      const at = now();
      lastPollAt = at;
      const event = currentEvent(at);
      json(res, 200, { event: event && event.sequence > Number(after) ? event : null, sequence });
      return true;
    }

    if (!browserMutationAllowed(req)) {
      error(res, 403, 'origin_not_allowed'); req.resume(); return true;
    }
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      error(res, 415, 'unsupported_media_type'); req.resume(); return true;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (failure) {
      error(res, failure.code === 'body_too_large' ? 413 : 400, failure.code || 'invalid_json');
      return true;
    }
    if (!validCue(body)) { error(res, 400, 'invalid_cue'); return true; }
    if (body.revision !== undefined) {
      if (body.revision <= (sourceRevisions.get(body.sourceId) ?? 0)) {
        json(res, 200, { delivered: false, sequence }); return true;
      }
      // Record even suppressed cues: a delayed request must not undo a newer clear.
      sourceRevisions.delete(body.sourceId);
      sourceRevisions.set(body.sourceId, body.revision);
      if (sourceRevisions.size > MAX_SOURCE_REVISIONS) {
        sourceRevisions.delete(sourceRevisions.keys().next().value);
      }
    }
    const at = now();
    const previous = currentEvent(at);
    const isConnected = connected(at);
    if (body.action === 'detect' && (!isConnected || body.reduced || body.intensity === 'off')) {
      json(res, 200, { delivered: false, sequence }); return true;
    }
    if (body.action === 'clear' && previous && previous.sourceId !== body.sourceId) {
      json(res, 200, { delivered: false, sequence }); return true;
    }
    latest = {
      sequence: ++sequence,
      action: body.action,
      sourceId: body.sourceId,
      character: body.action === 'detect' ? body.character : previous?.character ?? 'green',
      message: body.action === 'detect' ? body.message : '',
      kind: body.action === 'detect' ? body.kind : previous?.kind ?? 'detect',
      intensity: body.action === 'detect' ? body.intensity : 'off',
      reduced: body.action === 'detect' ? body.reduced : false,
      createdAt: at,
    };
    json(res, 200, { delivered: isConnected, sequence });
    return true;
  }

  return {
    handle,
    dispose() { disposed = true; latest = null; lastPollAt = null; sourceRevisions.clear(); },
  };
}
