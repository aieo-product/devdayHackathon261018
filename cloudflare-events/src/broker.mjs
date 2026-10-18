import { validateCallbackUrl, parseSigningSecret, verifyCallback, deliverEvent } from './webhook.mjs';

const PREFIX = 'events:';
const DAY = 86_400_000;
const ROTATION_MS = 300_000;
const VERIFY_LEASE_MS = 30_000;
const DELIVERY_LEASE_MS = 30_000;
const LIMITS = Object.freeze({ subscriptionsPerSource: 64, subscriptions: 256, jobs: 1000, dedupe: 10000, recent: 100, attempts: 5 });
const DATA_FIELDS = ['notification_id', 'session_id', 'device_type', 'continuous_hold_ms', 'required_hold_ms', 'phone_probability', 'observable_probability', 'provider'];

export const EVENT_DEFINITION = Object.freeze({
  name: 'focus.phone_held',
  description: 'A phone was held continuously for the configured detection threshold during a focus session. Contains detection facts only. Optional filters select one session or device type belonging to the connected source.',
  delivery: ['webhook'],
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', minLength: 1, maxLength: 128, description: 'Exact focus session identifier.' },
      device_type: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$', description: 'Exact device type, for example mac or reachy_mini.' },
    },
    additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      notification_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
      session_id: { type: 'string', minLength: 1, maxLength: 128 },
      device_type: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
      continuous_hold_ms: { type: 'integer', minimum: 0, maximum: DAY },
      required_hold_ms: { type: 'integer', minimum: 1, maximum: DAY },
      phone_probability: { type: 'number', minimum: 0, maximum: 1 },
      observable_probability: { type: 'number', minimum: 0, maximum: 1 },
      provider: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
    },
    required: DATA_FIELDS,
    additionalProperties: false,
  },
});

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

const invalid = (message) => { throw new RpcError(-32602, message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, label) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(`Invalid ${label}.`);
}
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) invalid(`Invalid ${label}.`);
  return value;
}
function shortName(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) invalid(`Invalid ${label}.`);
  return value;
}
function filters(value = {}) {
  keys(value, ['session_id', 'device_type'], 'event arguments');
  const normalized = {};
  if (value.device_type !== undefined) normalized.device_type = shortName(value.device_type, 'device_type');
  if (value.session_id !== undefined) normalized.session_id = identifier(value.session_id, 'session_id');
  return normalized;
}
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
function eventValue(input) {
  keys(input, ['eventId', 'name', 'timestamp', 'data', 'cursor'], 'event');
  if (input.name !== EVENT_DEFINITION.name || input.cursor !== null) invalid('Unsupported event name or cursor.');
  identifier(input.eventId, 'eventId');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.eventId)) invalid('Invalid eventId.');
  if (typeof input.timestamp !== 'string' || input.timestamp.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.timestamp) || !Number.isFinite(Date.parse(input.timestamp))) invalid('Invalid event timestamp.');
  keys(input.data, DATA_FIELDS, 'event data');
  if (DATA_FIELDS.some(key => !Object.hasOwn(input.data, key))) invalid('Incomplete event data.');
  const data = {};
  for (const key of ['notification_id', 'session_id']) data[key] = identifier(input.data[key], key);
  for (const key of ['device_type', 'provider']) data[key] = shortName(input.data[key], key);
  for (const key of ['continuous_hold_ms', 'required_hold_ms']) {
    const value = input.data[key];
    if (!Number.isSafeInteger(value) || value < (key === 'required_hold_ms' ? 1 : 0) || value > DAY) invalid(`Invalid ${key}.`);
    data[key] = value;
  }
  for (const key of ['phone_probability', 'observable_probability']) {
    const value = input.data[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid(`Invalid ${key}.`);
    data[key] = value;
  }
  if (input.eventId !== data.notification_id || data.continuous_hold_ms < data.required_hold_ms) invalid('Event does not describe a completed hold detection.');
  return { eventId: input.eventId, name: EVENT_DEFINITION.name, timestamp: new Date(input.timestamp).toISOString(), data, cursor: null };
}
const matches = (args, data) => Object.entries(args).every(([key, value]) => data[key] === value);
const iso = value => new Date(value).toISOString();

/** One Durable Object owns this broker. Network operations run outside its storage mutation queue. */
export class EventBroker {
  constructor({ storage, allowedHosts, fetchImpl = fetch, clock = Date.now, isGrantActive = async () => true }) {
    this.storage = storage;
    this.allowedHosts = allowedHosts;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.isGrantActive = isGrantActive;
    this.mutationQueue = Promise.resolve();
    this.drainPromise = null;
  }

  mutate(fn) {
    const result = this.mutationQueue.then(fn);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async records(kind) { return this.storage.list({ prefix: `${PREFIX}${kind}:` }); }
  key(kind, id) { return `${PREFIX}${kind}:${id}`; }

  async deleteKeys(ids) {
    for (let offset = 0; offset < ids.length; offset += 128) await this.storage.delete(ids.slice(offset, offset + 128));
  }

  async cleanup(now) {
    const [subscriptions, jobs, seen, recent] = await Promise.all([this.records('sub'), this.records('job'), this.records('seen'), this.records('recent')]);
    const remove = [];
    const retained = new Map();
    for (const [key, sub] of subscriptions) {
      if ((sub.active && sub.expiresAt <= now) || (!sub.active && (!sub.pending || sub.pending.expiresAt <= now))) {
        remove.push(key);
        continue;
      }
      if (sub.pending?.expiresAt <= now) {
        delete sub.pending;
        await this.storage.put(key, sub);
      }
      if (sub.previousSecret && sub.previousSecretExpiresAt <= now) {
        delete sub.previousSecret;
        delete sub.previousSecretExpiresAt;
        await this.storage.put(key, sub);
      }
      retained.set(sub.id, sub);
    }
    for (const [key, job] of jobs) if (!retained.get(job.subscriptionId)?.active || job.expiresAt <= now) remove.push(key);
    for (const [key, record] of seen) if (record.expiresAt <= now) remove.push(key);
    const newest = [...recent.entries()].filter(([key, record]) => {
      if (record.expiresAt <= now) { remove.push(key); return false; }
      return true;
    }).sort((a, b) => b[1].receivedAt - a[1].receivedAt || b[0].localeCompare(a[0]));
    remove.push(...newest.slice(LIMITS.recent).map(([key]) => key));
    await this.deleteKeys(remove);
  }

  async schedule() {
    if (typeof this.storage.setAlarm !== 'function') return;
    const [subscriptions, jobs, seen, recent] = await Promise.all([this.records('sub'), this.records('job'), this.records('seen'), this.records('recent')]);
    const times = [];
    for (const sub of subscriptions.values()) {
      if (sub.active) times.push(sub.expiresAt);
      if (sub.pending) times.push(sub.pending.expiresAt);
      if (sub.previousSecretExpiresAt) times.push(sub.previousSecretExpiresAt);
    }
    for (const job of jobs.values()) times.push(job.dueAt, job.expiresAt);
    for (const record of seen.values()) times.push(record.expiresAt);
    for (const record of recent.values()) times.push(record.expiresAt);
    if (times.length) await this.storage.setAlarm(Math.max(this.clock() + 1, Math.min(...times)));
    else if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
  }

  async identity(principal, params, subscribe = false) {
    identifier(principal, 'principal');
    keys(params, subscribe ? ['name', 'arguments', 'delivery', 'cursor', 'ttlMs'] : ['name', 'arguments', 'delivery'], 'subscription');
    if (params.name !== EVENT_DEFINITION.name) invalid('Unsupported event name.');
    const args = filters(params.arguments);
    keys(params.delivery, subscribe ? ['mode', 'url', 'secret'] : ['mode', 'url'], 'delivery');
    if (params.delivery.mode !== 'webhook') invalid('Only webhook delivery is supported.');
    let url;
    try { url = validateCallbackUrl(params.delivery.url, this.allowedHosts); }
    catch { throw new RpcError(-32015, 'Callback URL is not allowed.', { reason: 'invalid_url' }); }
    const id = `sub_${await hash(JSON.stringify([principal, url, EVENT_DEFINITION.name, args]))}`;
    return { id, principal, url, name: EVENT_DEFINITION.name, arguments: args };
  }

  async subscribe(principal, grantId, params) {
    identifier(grantId, 'grantId');
    const identity = await this.identity(principal, params, true);
    if (params.cursor !== undefined && params.cursor !== null) invalid('This event does not support replay; cursor must be null.');
    try { parseSigningSecret(params.delivery.secret); } catch { invalid('A valid whsec_ signing secret is required.'); }
    let ttl = DAY;
    if (params.ttlMs !== undefined && params.ttlMs !== null) {
      if (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0) invalid('ttlMs must be a positive integer or null.');
      ttl = Math.min(DAY, Math.max(60_000, params.ttlMs));
    }
    if (!await this.isGrantActive(grantId, principal)) throw new RpcError(-32001, 'Access has been revoked.');
    const revision = crypto.randomUUID();
    const secret = params.delivery.secret;
    const cached = await this.mutate(async () => {
      const now = this.clock();
      await this.cleanup(now);
      const all = await this.records('sub');
      const existing = all.get(this.key('sub', identity.id));
      if (!existing && (all.size >= LIMITS.subscriptions || [...all.values()].filter(sub => sub.principal === principal).length >= LIMITS.subscriptionsPerSource)) throw new RpcError(-32029, 'Subscription capacity reached.');
      const verified = [...all.values()].find(sub => sub.active && sub.principal === principal && sub.url === identity.url && sub.secret === secret && sub.verifiedAt + ROTATION_MS > now);
      await this.storage.put(this.key('sub', identity.id), {
        ...(existing || { ...identity, active: false }),
        pending: { revision, expiresAt: now + VERIFY_LEASE_MS },
      });
      await this.schedule();
      return verified?.verifiedAt ?? null;
    });
    let verification = { accepted: true };
    if (cached === null) {
      try { verification = await verifyCallback({ url: identity.url, secret, subscriptionId: identity.id, allowedHosts: this.allowedHosts, fetchImpl: this.fetchImpl, clock: this.clock }); }
      catch { verification = { accepted: false, reason: 'verification_failed' }; }
    }
    let activeGrant = false;
    try { activeGrant = await this.isGrantActive(grantId, principal); } catch { /* Fail closed if the grant cannot be rechecked. */ }
    return this.mutate(async () => {
      const now = this.clock();
      const key = this.key('sub', identity.id);
      const current = await this.storage.get(key);
      if (current?.pending?.revision !== revision || current.pending.expiresAt <= now) throw new RpcError(-32015, 'Subscription changed while verifying callback.', { reason: 'subscription_changed' });
      if (!verification.accepted || !activeGrant) {
        if (current.active) { delete current.pending; await this.storage.put(key, current); }
        else await this.storage.delete(key);
        await this.schedule();
        if (!activeGrant) throw new RpcError(-32001, 'Access has been revoked.');
        throw new RpcError(-32015, 'Callback verification failed.', { reason: verification.reason || 'challenge_failed' });
      }
      const expiresAt = now + ttl;
      const next = {
        ...identity, active: true, activeRevision: revision, grantId, secret, expiresAt, verifiedAt: cached ?? now,
        createdAt: current.createdAt || now,
        deliveredCount: current.deliveredCount || 0,
        failedCount: current.failedCount || 0,
        lastDeliveryAt: current.lastDeliveryAt || null,
        lastDeliveryStatus: current.lastDeliveryStatus || null,
        lastDeliveryReason: current.lastDeliveryReason || null,
      };
      if (current.active && current.secret !== secret) {
        next.previousSecret = current.secret;
        next.previousSecretExpiresAt = now + ROTATION_MS;
      } else if (current.previousSecretExpiresAt > now) {
        next.previousSecret = current.previousSecret;
        next.previousSecretExpiresAt = current.previousSecretExpiresAt;
      }
      await this.storage.put(key, next);
      await this.schedule();
      return { id: identity.id, refreshBefore: iso(expiresAt), cursor: null, truncated: false };
    });
  }

  async unsubscribe(principal, params) {
    const identity = await this.identity(principal, params);
    return this.mutate(async () => {
      await this.storage.delete(this.key('sub', identity.id));
      const jobs = await this.records('job');
      await this.deleteKeys([...jobs].filter(([, job]) => job.subscriptionId === identity.id && job.principal === principal).map(([key]) => key));
      await this.schedule();
      return {};
    });
  }

  async ingest(principal, input) {
    identifier(principal, 'principal');
    const event = eventValue(input);
    const eventKey = await hash(JSON.stringify([principal, event.eventId]));
    return this.mutate(async () => {
      const now = this.clock();
      await this.cleanup(now);
      if (await this.storage.get(this.key('seen', eventKey))) return { accepted: true, duplicate: true, eventId: event.eventId, queued: 0 };
      const [subscriptions, jobs, seen] = await Promise.all([this.records('sub'), this.records('job'), this.records('seen')]);
      const recipients = [...subscriptions.values()].filter(sub => sub.active && sub.principal === principal && sub.expiresAt > now && matches(sub.arguments, event.data));
      if (seen.size >= LIMITS.dedupe || jobs.size + recipients.length > LIMITS.jobs) throw new RpcError(-32029, 'Event delivery capacity reached; retry later.');
      const entries = {
        [this.key('seen', eventKey)]: { principal, eventId: event.eventId, expiresAt: now + DAY },
        [this.key('recent', eventKey)]: { principal, event, receivedAt: now, expiresAt: now + DAY },
      };
      for (const sub of recipients) {
        const id = await hash(JSON.stringify([sub.id, event.eventId]));
        entries[this.key('job', id)] = { id, principal, subscriptionId: sub.id, event, attempts: 0, createdAt: now, expiresAt: now + DAY, dueAt: now };
      }
      // A single atomic multi-key write makes dedupe and delivery jobs durable together.
      await this.storage.put(entries);
      await this.cleanup(now);
      await this.schedule();
      return { accepted: true, duplicate: false, eventId: event.eventId, queued: recipients.length };
    });
  }

  async disable(subscriptionId) {
    await this.storage.delete(this.key('sub', subscriptionId));
    const jobs = await this.records('job');
    await this.deleteKeys([...jobs].filter(([, job]) => job.subscriptionId === subscriptionId).map(([key]) => key));
  }

  async claim() {
    return this.mutate(async () => {
      const now = this.clock();
      await this.cleanup(now);
      const jobs = [...await this.records('job')].filter(([, job]) => job.dueAt <= now).sort((a, b) => a[1].dueAt - b[1].dueAt || a[0].localeCompare(b[0]));
      const claims = [];
      for (const [key, job] of jobs.slice(0, 8)) {
        const sub = await this.storage.get(this.key('sub', job.subscriptionId));
        if (!sub?.active || sub.expiresAt <= now) { await this.storage.delete(key); continue; }
        if (job.attempts >= LIMITS.attempts) {
          if (job.attemptRevision === sub.activeRevision) {
            sub.failedCount = (sub.failedCount || 0) + 1;
            await this.storage.put(this.key('sub', sub.id), sub);
          }
          await this.storage.delete(key);
          continue;
        }
        const leaseToken = crypto.randomUUID();
        await this.storage.put(key, { ...job, leaseToken, dueAt: now + DELIVERY_LEASE_MS });
        claims.push({ job: { ...job, leaseToken }, sub });
      }
      await this.schedule();
      return claims;
    });
  }

  async attempt({ job, sub }) {
    let authorized;
    try { authorized = await this.isGrantActive(sub.grantId, sub.principal); }
    catch { authorized = null; }
    const current = await this.mutate(async () => {
      const key = this.key('job', job.id);
      const stored = await this.storage.get(key);
      const subscription = await this.storage.get(this.key('sub', sub.id));
      const now = this.clock();
      if (!stored || stored.leaseToken !== job.leaseToken) return null;
      if (!subscription?.active || subscription.expiresAt <= now || stored.expiresAt <= now) { await this.storage.delete(key); return null; }
      if (subscription.activeRevision !== sub.activeRevision) {
        delete stored.leaseToken;
        stored.dueAt = now;
        await this.storage.put(key, stored);
        return null;
      }
      if (authorized === false) { await this.disable(sub.id); return null; }
      if (subscription.previousSecretExpiresAt <= now) {
        delete subscription.previousSecret;
        delete subscription.previousSecretExpiresAt;
        await this.storage.put(this.key('sub', sub.id), subscription);
      }
      stored.attempts += 1;
      stored.attemptRevision = subscription.activeRevision;
      await this.storage.put(key, stored);
      return { job: stored, subscription };
    });
    if (!current) return;
    let result;
    if (authorized === null) result = { accepted: false, retryable: true, reason: 'grant_check_failed' };
    else {
      try { result = await deliverEvent({ subscription: current.subscription, event: job.event, allowedHosts: this.allowedHosts, fetchImpl: this.fetchImpl, clock: this.clock }); }
      catch { result = { accepted: false, retryable: true, reason: 'delivery_failed' }; }
    }
    await this.mutate(async () => {
      const key = this.key('job', job.id);
      const stored = await this.storage.get(key);
      if (!stored || stored.leaseToken !== job.leaseToken) return;
      const subscription = await this.storage.get(this.key('sub', sub.id));
      if (!subscription) { await this.storage.delete(key); return; }
      const now = this.clock();
      if (subscription.activeRevision !== current.subscription.activeRevision) {
        // A refresh can finish while the old request is in flight. Its response
        // belongs to that old revision and must never disable or mark the new
        // subscription as failed. A transient job may retry with the new grant
        // and signing key; terminal responses still terminate only that job.
        if (!result.accepted && result.retryable && !result.terminal && result.status !== 410 && result.status !== 413 && stored.attempts < LIMITS.attempts && subscription.expiresAt > now && stored.expiresAt > now) {
          delete stored.leaseToken;
          stored.dueAt = now + Math.min(60_000, 1000 * 2 ** (stored.attempts - 1));
          await this.storage.put(key, stored);
        } else await this.storage.delete(key);
        return;
      }
      subscription.lastDeliveryAt = now;
      subscription.lastDeliveryStatus = Number.isInteger(result.status) ? result.status : null;
      subscription.lastDeliveryReason = typeof result.reason === 'string' ? result.reason : null;
      if (result.disableSubscription || result.status === 410) { await this.disable(sub.id); return; }
      if (result.accepted) {
        subscription.deliveredCount = (subscription.deliveredCount || 0) + 1;
        await this.storage.delete(key);
      } else if (result.retryable && !result.terminal && result.status !== 413 && stored.attempts < LIMITS.attempts && subscription.expiresAt > now) {
        delete stored.leaseToken;
        stored.dueAt = now + Math.min(60_000, 1000 * 2 ** (stored.attempts - 1));
        await this.storage.put(key, stored);
      } else {
        subscription.failedCount = (subscription.failedCount || 0) + 1;
        await this.storage.delete(key);
      }
      await this.storage.put(this.key('sub', sub.id), subscription);
    });
  }

  drain() {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = (async () => {
      const claims = await this.claim();
      // At most four HTTPS requests concurrently, eight per invocation.
      for (let offset = 0; offset < claims.length; offset += 4) await Promise.allSettled(claims.slice(offset, offset + 4).map(claim => this.attempt(claim)));
      await this.mutate(async () => { await this.cleanup(this.clock()); await this.schedule(); });
      return { attempted: claims.length };
    })().finally(() => { this.drainPromise = null; });
    return this.drainPromise;
  }

  async status(principal) {
    identifier(principal, 'principal');
    return this.mutate(async () => {
      await this.cleanup(this.clock());
      const [subscriptions, jobs] = await Promise.all([this.records('sub'), this.records('job')]);
      await this.schedule();
      return {
        subscriptions: [...subscriptions.values()].filter(sub => sub.principal === principal).map(sub => ({
          id: sub.id, name: sub.name, arguments: sub.arguments, active: sub.active,
          refreshBefore: sub.active ? iso(sub.expiresAt) : null,
          delivered: sub.deliveredCount || 0, failed: sub.failedCount || 0,
          lastDeliveryAt: sub.lastDeliveryAt ? iso(sub.lastDeliveryAt) : null,
          lastDeliveryStatus: sub.lastDeliveryStatus || null,
          lastDeliveryReason: sub.lastDeliveryReason || null,
        })),
        pending_deliveries: [...jobs.values()].filter(job => job.principal === principal).length,
        limits: LIMITS,
      };
    });
  }

  async recent(principal, options = {}) {
    identifier(principal, 'principal');
    keys(options, ['session_id', 'limit'], 'recent event options');
    if (options.session_id !== undefined) identifier(options.session_id, 'session_id');
    const limit = options.limit === undefined ? 20 : options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.recent) invalid('limit must be an integer between 1 and 100.');
    return this.mutate(async () => {
      await this.cleanup(this.clock());
      const records = await this.records('recent');
      await this.schedule();
      return {
        events: [...records.values()]
          .filter(record => record.principal === principal && (options.session_id === undefined || record.event.data.session_id === options.session_id))
          .sort((a, b) => b.receivedAt - a.receivedAt || b.event.eventId.localeCompare(a.event.eventId))
          .slice(0, limit).map(record => record.event),
        cursor: null,
      };
    });
  }
}
