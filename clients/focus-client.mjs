/** Small browser/Node client. Camera capture and native notifications belong to the app. */
export class FocusApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'FocusApiError';
    this.status = status;
    this.code = code;
  }
}

export class FocusClient {
  #url; #token; #fetch; #epoch = 0; #active = false; #id = null;
  #snapshot = null; #deadline = 0; #timer; #flight = null;
  #queue = Promise.resolve(); #starting = false; #notifications = new Set();

  constructor({ baseUrl, token, fetchImpl = globalThis.fetch.bind(globalThis) }) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError('baseUrl must be an HTTP(S) URL without credentials, query or fragment');
    }
    if (typeof token !== 'string' || !token.trim()) throw new TypeError('token is required');
    this.#url = url.href.replace(/\/$/, '');
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  get active() {
    if (this.#active && Date.now() >= this.#deadline) this.#expire();
    return this.#active;
  }
  get snapshot() { return this.#snapshot && { ...this.#snapshot }; }
  get remainingMs() { return Math.max(0, this.#deadline - Date.now()); }

  #stopLocal() {
    this.#epoch += 1;
    this.#active = false;
    this.#flight?.abort();
    clearTimeout(this.#timer);
    return this.#epoch;
  }

  #expire() {
    this.#stopLocal();
    if (this.#snapshot) this.#snapshot = {
      ...this.#snapshot, state: 'ended', notify: false, notification_id: null,
      message: null, next_capture_after_ms: 0, reason: 'local_session_expired',
      continuous_hold_ms: 0, consecutive_count: 0,
    };
  }

  #enqueue(work) {
    const next = this.#queue.then(work);
    this.#queue = next.catch(() => {});
    return next;
  }

  #accept(result, epoch) {
    if (epoch !== this.#epoch) return null;
    if (Date.now() >= this.#deadline) {
      this.#snapshot = { ...result };
      this.#expire();
      return null;
    }
    if (result.state === 'ended' || result.state === 'paused') this.#stopLocal();
    let snapshot = { ...result };
    if (snapshot.notify) {
      if (!this.#active || !snapshot.notification_id || this.#notifications.has(snapshot.notification_id)) {
        snapshot = { ...snapshot, notify: false, notification_id: null, message: null };
      } else this.#notifications.add(snapshot.notification_id);
    }
    this.#snapshot = snapshot;
    return { ...snapshot };
  }

  #activate() {
    this.#active = !['paused', 'ended'].includes(this.#snapshot?.state) && this.remainingMs > 0;
    clearTimeout(this.#timer);
    if (this.#active) {
      this.#timer = setTimeout(() => this.#expire(), this.remainingMs);
      this.#timer.unref?.();
    }
  }

  async #request(path, { method = 'GET', body, contentType, headers = {}, controller = new AbortController() } = {}) {
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref?.();
    try {
      const response = await this.#fetch(this.#url + path, {
        method, body, signal: controller.signal, cache: 'no-store', credentials: 'omit',
        redirect: 'error',
        headers: { Authorization: `Bearer ${this.#token}`, ...(contentType ? { 'Content-Type': contentType } : {}), ...headers },
      });
      const data = await response.json();
      if (!response.ok) throw new FocusApiError(data.error?.message ?? 'API request failed', response.status, data.error?.code ?? 'api_error');
      return data;
    } finally { clearTimeout(timer); }
  }

  #json(path, body) {
    return this.#request(path, { method: 'POST', contentType: 'application/json', body: JSON.stringify(body) });
  }

  async start({ deviceType = 'mac', durationSeconds = 1500 } = {}) {
    if (this.#starting || (this.#id && this.#snapshot?.state !== 'ended')) {
      throw new Error('End the existing session before starting another');
    }
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 14400) {
      throw new TypeError('durationSeconds must be an integer from 1 to 14400');
    }
    this.#starting = true;
    const epoch = this.#stopLocal();
    try {
      return await this.#enqueue(async () => {
        if (epoch !== this.#epoch) return null;
        const beganAt = Date.now();
        const result = await this.#json('/v1/sessions', { device_type: deviceType, duration_seconds: durationSeconds });
        this.#id = result.session_id;
        this.#deadline = beganAt + durationSeconds * 1000;
        this.#notifications.clear();
        const snapshot = this.#accept(result, epoch);
        if (snapshot) this.#activate();
        return snapshot;
      });
    } finally { this.#starting = false; }
  }

  async get() {
    if (!this.#id) throw new Error('Start a session first');
    const epoch = this.#epoch;
    return this.#accept(await this.#request(`/v1/sessions/${encodeURIComponent(this.#id)}`), epoch);
  }

  async frame(image, { contentType = image?.type, frameId = globalThis.crypto.randomUUID() } = {}) {
    if (!this.active || this.#flight) return null;
    if (!['image/jpeg', 'image/png'].includes(contentType)) throw new TypeError('JPEG or PNG is required');
    const size = image?.size ?? image?.byteLength;
    if (!Number.isFinite(size) || size < 1 || size > 1024 * 1024) throw new TypeError('Image must be between 1 byte and 1 MiB');
    const epoch = this.#epoch;
    const controller = new AbortController();
    this.#flight = controller;
    try {
      const result = await this.#request(`/v1/sessions/${encodeURIComponent(this.#id)}/frames`, {
        method: 'POST', body: image, contentType, headers: { 'X-Frame-Id': frameId }, controller,
      });
      return this.#accept(result, epoch);
    } catch (error) {
      if (epoch !== this.#epoch) return null;
      throw error;
    } finally { if (this.#flight === controller) this.#flight = null; }
  }

  #control(action) {
    const epoch = this.#stopLocal();
    return this.#enqueue(async () => {
      if (!this.#id) return null;
      if (action === 'resume' && epoch !== this.#epoch) return null;
      const result = await this.#json(`/v1/sessions/${encodeURIComponent(this.#id)}/control`, { action });
      const snapshot = this.#accept(result, epoch);
      if (snapshot && action === 'resume') this.#activate();
      return snapshot;
    });
  }

  pause() { return this.#control('pause'); }
  resume() { return this.#control('resume'); }
  end() { return this.#control('end'); }
}
