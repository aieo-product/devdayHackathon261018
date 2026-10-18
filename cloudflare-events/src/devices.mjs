const PREFIX = 'devices:';
const ONLINE_MS = 10_000;
const ON_COMMAND_MS = 120_000;
const SOURCE_LIMIT = 20;
const GLOBAL_LIMIT = 200;
const HEARTBEAT_FIELDS = ['device_id', 'device_type', 'name', 'observed_state', 'remote_enabled', 'applied_revision', 'session_id'];
const STATES = new Set(['on', 'off', 'blocked', 'error']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = value => value === null ? null : new Date(value).toISOString();

/** Safe public error; messages never contain submitted values or credentials. */
export class DeviceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DeviceError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message) { throw new DeviceError('invalid_device_request', message); }
function fields(input, allowed) {
  if (!isObject(input) || Object.keys(input).some(key => !allowed.includes(key))) invalid('Invalid device parameters.');
}
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) invalid(`Invalid ${label}.`);
  return value;
}
function heartbeatValue(body) {
  fields(body, HEARTBEAT_FIELDS);
  identifier(body.device_id, 'device_id');
  if (typeof body.device_type !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(body.device_type)) invalid('Invalid device_type.');
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(body.name))) invalid('Invalid device name.');
  if (!STATES.has(body.observed_state)) invalid('Invalid observed_state.');
  if (typeof body.remote_enabled !== 'boolean') invalid('Invalid remote_enabled.');
  if (!Number.isSafeInteger(body.applied_revision) || body.applied_revision < 0) invalid('Invalid applied_revision.');
  if (body.session_id !== undefined && body.session_id !== null) identifier(body.session_id, 'session_id');
  return { ...body, ...(body.name === undefined ? {} : { name: body.name.trim() }) };
}

/** One Durable Object owns this registry. All read/modify/write operations share a queue. */
export class DeviceRegistry {
  constructor({ storage, clock = Date.now }) {
    this.storage = storage;
    this.clock = clock;
    this.mutationQueue = Promise.resolve();
  }

  mutate(fn) {
    const result = this.mutationQueue.then(fn);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  // Length-prefixed source prevents collisions even when identifiers contain colons.
  prefix(principal) { return `${PREFIX}${principal.length}:${principal}:`; }
  key(principal, deviceId) { return `${this.prefix(principal)}${deviceId}`; }

  view(record, now) {
    return {
      device_id: record.device_id,
      name: record.name,
      type: record.type,
      desired_state: record.desired_state,
      observed_state: record.observed_state,
      remote_enabled: record.remote_enabled,
      revision: record.revision,
      applied_revision: record.applied_revision,
      last_seen_at: iso(record.last_seen_at),
      online: now >= record.last_seen_at && now - record.last_seen_at <= ONLINE_MS,
      command_issued_at: iso(record.command_issued_at),
      command_expires_at: iso(record.command_expires_at),
      session_id: record.session_id,
    };
  }

  async expire(key, record, now) {
    if (record.desired_state === 'on' && record.applied_revision < record.revision && record.command_expires_at !== null && now >= record.command_expires_at) {
      record = { ...record, desired_state: 'off', revision: record.revision + 1, command_issued_at: now, command_expires_at: null };
      await this.storage.put(key, record);
    }
    return record;
  }

  async heartbeat(principal, input) {
    identifier(principal, 'principal');
    const body = heartbeatValue(input);
    return this.mutate(async () => {
      const now = this.clock();
      const key = this.key(principal, body.device_id);
      let record = await this.storage.get(key);
      if (!record) {
        if (body.applied_revision !== 0) throw new DeviceError('future_revision', 'Device acknowledgement exceeds its command revision.', 409);
        const all = await this.storage.list({ prefix: PREFIX });
        if (all.size >= GLOBAL_LIMIT || [...all.keys()].filter(value => value.startsWith(this.prefix(principal))).length >= SOURCE_LIMIT) throw new DeviceError('device_capacity', 'Device capacity reached.', 429);
        record = {
          device_id: body.device_id, name: body.name ?? body.device_id, type: body.device_type,
          desired_state: 'off', observed_state: body.observed_state, remote_enabled: body.remote_enabled,
          revision: 0, applied_revision: 0, last_seen_at: now,
          command_issued_at: null, command_expires_at: null, session_id: body.session_id ?? null,
        };
      } else {
        // Check the actual issued revision before expiry can issue a new safety command.
        if (body.applied_revision > record.revision) throw new DeviceError('future_revision', 'Device acknowledgement exceeds its command revision.', 409);
        record = await this.expire(key, record, now);
        if (body.applied_revision >= record.applied_revision) {
          record = {
            ...record, name: body.name ?? record.name, type: body.device_type,
            observed_state: body.observed_state, remote_enabled: body.remote_enabled,
            applied_revision: body.applied_revision, session_id: body.session_id ?? null,
          };
          // Acknowledgement means the device processed the command, including blocked/error outcomes.
          if (record.applied_revision === record.revision) record.command_expires_at = null;
          // Local disarming revokes pending and applied ON commands. Re-arming must need a new ON.
          if (!record.remote_enabled && record.desired_state === 'on') {
            record = { ...record, desired_state: 'off', revision: record.revision + 1, command_issued_at: now, command_expires_at: null };
          }
        }
        record.last_seen_at = now;
      }
      await this.storage.put(key, record);
      return this.view(record, now);
    });
  }

  async list(principal) {
    identifier(principal, 'principal');
    return this.mutate(async () => {
      const now = this.clock();
      const records = await this.storage.list({ prefix: this.prefix(principal) });
      const devices = [];
      for (const [key, record] of records) devices.push(this.view(await this.expire(key, record, now), now));
      devices.sort((a, b) => a.device_id.localeCompare(b.device_id));
      return { devices };
    });
  }

  async setDesired(principal, body) {
    identifier(principal, 'principal');
    fields(body, ['device_id', 'enabled']);
    identifier(body.device_id, 'device_id');
    if (typeof body.enabled !== 'boolean') invalid('Invalid enabled.');
    return this.mutate(async () => {
      const now = this.clock();
      const key = this.key(principal, body.device_id);
      let record = await this.storage.get(key);
      if (!record) throw new DeviceError('device_not_found', 'Device not found.', 404);
      record = await this.expire(key, record, now);
      if (body.enabled && !this.view(record, now).online) throw new DeviceError('device_offline', 'Device is offline; turn it on locally before remote start.', 409);
      if (body.enabled && !record.remote_enabled) throw new DeviceError('remote_disabled', 'Enable remote control on the device before remote start.', 409);
      record = {
        ...record, desired_state: body.enabled ? 'on' : 'off', revision: record.revision + 1,
        command_issued_at: now, command_expires_at: body.enabled ? now + ON_COMMAND_MS : null,
      };
      await this.storage.put(key, record);
      return this.view(record, now);
    });
  }
}
