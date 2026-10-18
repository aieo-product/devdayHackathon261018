import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_EVENT_BYTES = 256 * 1024;
const MAX_VERIFICATION_BYTES = 4096;
const MAX_TIMEOUT_MS = 10_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

export class CallbackSecurityError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'CallbackSecurityError';
    this.reason = reason;
  }
}

function fail(reason) {
  throw new CallbackSecurityError(reason);
}

function isPublicHostname(host) {
  if (typeof host !== 'string' || host.length > 253 || !host.includes('.')) return false;
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.')) return false;
  if (/(?:^|\.)(?:localhost|local|internal|home|lan|onion|invalid|test|arpa)$/.test(host)) return false;
  return host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/**
 * Restricted egress policy, NOT arbitrary-host DNS pinning. Only operator-trusted
 * exact callback hosts are supported. Cloudflare fetch does not expose a way to
 * pin an arbitrary external address while retaining its TLS hostname. Supporting
 * user-controlled hostnames requires a separate, connection-validating egress
 * proxy; a preflight DNS lookup followed by fetch would not prevent rebinding.
 */
export function validateCallbackUrl(value, allowedHosts) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(value)) {
    fail('invalid_callback');
  }
  let url;
  try { url = new URL(value); } catch { fail('invalid_callback'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash) {
    fail('invalid_callback');
  }
  // Reject empty credentials and fragments as well, even though URL normalizes them.
  const authority = value.match(/^https:\/\/([^/?#]*)/i)?.[1];
  if (authority === undefined || authority.includes('@') || value.includes('#')) {
    fail('invalid_callback');
  }
  const host = url.hostname.toLowerCase();
  if (!isPublicHostname(host)) fail('invalid_callback');
  const configured = typeof allowedHosts === 'string' ? allowedHosts.split(',') : allowedHosts;
  if (!configured || typeof configured[Symbol.iterator] !== 'function') fail('callback_host_not_allowed');
  const trusted = new Set();
  for (const candidate of configured) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim().toLowerCase();
    if (isPublicHostname(normalized)) trusted.add(normalized);
  }
  if (!trusted.has(host)) fail('callback_host_not_allowed');
  return url.href;
}

export function parseSigningSecret(secret) {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_') || secret.length > 94) fail('invalid_secret');
  const encoded = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1 || (encoded.includes('=') && encoded.length % 4 !== 0)) {
    fail('invalid_secret');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length < 24 || decoded.length > 64 || decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    fail('invalid_secret');
  }
  return new Uint8Array(decoded);
}

/** timestamp is Unix seconds; body is the exact serialized UTF-8 request body. */
export function signWebhook({ secret, id, timestamp, body, previousSecret }) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || !Number.isSafeInteger(timestamp) || timestamp < 0 || typeof body !== 'string') fail('invalid_event');
  const input = `${id}.${timestamp}.${body}`;
  const secrets = previousSecret && previousSecret !== secret ? [secret, previousSecret] : [secret];
  return secrets.map((key) => `v1,${createHmac('sha256', parseSigningSecret(key)).update(input, 'utf8').digest('base64')}`).join(' ');
}

function cancelBody(response) {
  try { void response.body?.cancel().catch(() => {}); } catch { /* Already locked/closed. */ }
}

async function readBoundedJson(response, signal) {
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_VERIFICATION_BYTES)) {
    cancelBody(response);
    fail('response_too_large');
  }
  if (!response.body || typeof response.body.getReader !== 'function') fail('challenge_failed');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VERIFICATION_BYTES) {
        void reader.cancel().catch(() => {});
        fail('response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('challenge_failed'); }
}

function timeoutValue(value) {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
}

async function signedPost({ url, secret, previousSecret, id, subscriptionId, body, fetchImpl, clock, timeoutMs, receive }) {
  if (typeof subscriptionId !== 'string' || !ID_PATTERN.test(subscriptionId)) fail('invalid_subscription');
  const timestamp = Math.floor(clock() / 1000);
  const signature = signWebhook({ secret, previousSecret, id, timestamp, body });
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CallbackSecurityError('timeout'));
    }, timeoutValue(timeoutMs));
  });
  const operation = (async () => {
    // Calling a supplied fetch as a local function also avoids illegal invocation
    // when this module is exercised in a browser harness.
    const response = await fetchImpl(url, {
      // workerd supports manual/follow but not redirect:error. Manual never
      // follows Location; all 3xx responses are rejected below before reading.
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signature,
        'X-MCP-Subscription-Id': subscriptionId,
      },
      body,
    });
    if (controller.signal.aborted) { cancelBody(response); fail('timeout'); }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      cancelBody(response);
      return { accepted: false, status: response.status, reason: 'redirect_refused' };
    }
    return receive(response, controller.signal);
  })();
  try { return await Promise.race([operation, deadline]); } finally { clearTimeout(timer); }
}

function safeFailure(error) {
  return error instanceof CallbackSecurityError ? error.reason : 'network_error';
}

export async function verifyCallback({ url, secret, subscriptionId, allowedHosts, fetchImpl = fetch, clock = Date.now, timeoutMs = MAX_TIMEOUT_MS }) {
  try {
    const callback = validateCallbackUrl(url, allowedHosts);
    parseSigningSecret(secret);
    const challenge = randomBytes(32).toString('base64url');
    const id = `msg_verification_${randomBytes(16).toString('hex')}`;
    const body = JSON.stringify({ type: 'verification', challenge });
    return await signedPost({
      url: callback, secret, id, subscriptionId, body, fetchImpl, clock, timeoutMs,
      receive: async (response, signal) => {
        if (!response.ok) {
          cancelBody(response);
          return { accepted: false, status: response.status, reason: 'challenge_failed' };
        }
        let result;
        try { result = await readBoundedJson(response, signal); } catch (error) {
          return { accepted: false, status: response.status, reason: safeFailure(error) };
        }
        // Compare equal-sized digests with timingSafeEqual, including when the
        // echoed string has the wrong length. The random value is single-use.
        const echoed = typeof result?.challenge === 'string' ? result.challenge : '';
        const compareKey = randomBytes(32);
        const expected = createHmac('sha256', compareKey).update(challenge).digest();
        const actual = createHmac('sha256', compareKey).update(echoed).digest();
        const accepted = timingSafeEqual(expected, actual);
        return { accepted, status: response.status, reason: accepted ? null : 'challenge_failed' };
      },
    });
  } catch (error) {
    return { accepted: false, status: null, reason: safeFailure(error) };
  }
}

function deliveryResult(status, reason = null) {
  const accepted = status !== null && status >= 200 && status < 300 && reason === null;
  const retryable = !accepted && (reason === 'network_error' || reason === 'timeout' || status === 429 || (status !== null && status >= 500));
  return {
    accepted, status, retryable, terminal: !accepted && !retryable,
    disableSubscription: status === 410,
    reason: reason ?? (accepted ? null : status === 410 ? 'subscription_gone' : status === 413 ? 'payload_too_large' : 'http_error'),
  };
}

export async function deliverEvent({ subscription, event, allowedHosts, fetchImpl = fetch, clock = Date.now, timeoutMs = MAX_TIMEOUT_MS }) {
  try {
    const callback = validateCallbackUrl(subscription?.url, allowedHosts);
    if (!event || Array.isArray(event) || typeof event !== 'object' || typeof event.eventId !== 'string' || !ID_PATTERN.test(event.eventId) ||
        typeof event.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(event.name) ||
        (subscription.name && event.name !== subscription.name) || Object.hasOwn(event, 'type') ||
        typeof event.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(event.timestamp) || !Number.isFinite(Date.parse(event.timestamp)) ||
        !event.data || Array.isArray(event.data) || typeof event.data !== 'object' || event.cursor !== null) {
      fail('invalid_event');
    }
    let body;
    try { body = JSON.stringify(event); } catch { fail('invalid_event'); }
    if (Buffer.byteLength(body, 'utf8') > MAX_EVENT_BYTES) fail('payload_too_large');
    const result = await signedPost({
      url: callback, secret: subscription.secret, previousSecret: subscription.previousSecret,
      id: event.eventId, subscriptionId: subscription.id, body, fetchImpl, clock, timeoutMs,
      receive: async (response) => {
        cancelBody(response); // Event acknowledgement has no response payload contract.
        return { accepted: response.ok, status: response.status, reason: null };
      },
    });
    return deliveryResult(result.status, result.reason);
  } catch (error) {
    return deliveryResult(null, safeFailure(error));
  }
}
