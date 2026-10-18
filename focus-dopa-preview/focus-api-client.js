const OBSERVING_STATES = new Set(['observing', 'suspected', 'cooldown', 'unknown']);
const STATES = new Set([...OBSERVING_STATES, 'paused', 'ended']);
const MAX_FRAME_BYTES = 1_048_576;

export class FocusApiError extends Error {
  constructor(message, { code = 'request_failed', status = 0 } = {}) {
    super(message);
    this.name = 'FocusApiError';
    this.code = code;
    this.status = status;
  }
}

/** Same-origin API client. Authentication belongs exclusively to the proxy. */
export class FocusApiClient {
  constructor({ baseUrl = '/api/focus', fetchImpl = globalThis.fetch.bind(globalThis), now = () => Date.now(), timeoutMs = 20000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.health = null;
    this.snapshot = null;
    this.sessionId = null;
    this.durationSeconds = 1500;
    this.startedAt = null;
    this.busy = false;
    this.generation = 0;
    this._suspended = true;
    this._frame = null;
    this._endedRemaining = null;
    this._seenNotifications = new Set();
    this._sequence = 0;
  }

  get remainingMs() {
    if (this._endedRemaining !== null) return this._endedRemaining;
    if (this.startedAt === null) return this.durationSeconds * 1000;
    return Math.max(0, this.durationSeconds * 1000 - (this.now() - this.startedAt));
  }

  get active() {
    return Boolean(this.sessionId && !this.busy && !this._suspended && this.remainingMs > 0 && OBSERVING_STATES.has(this.snapshot?.state));
  }

  stopFrames() {
    this.generation += 1;
    this._suspended = true;
    this._frame?.controller.abort();
  }

  reset() {
    this._assertIdle();
    this.stopFrames();
    this.snapshot = null;
    this.sessionId = null;
    this.startedAt = null;
    this._endedRemaining = null;
    this._seenNotifications.clear();
  }

  expire() {
    if (!this.sessionId || this.remainingMs > 0 || this.snapshot?.state === 'ended') return false;
    this.stopFrames();
    this._endedRemaining = 0;
    this.snapshot = { ...this.snapshot, state: 'ended', reason: 'local_session_expired', notify: false, notification_id: null, message: null };
    return true;
  }

  async checkHealth() {
    const health = await this._request('/health');
    if (!health || !['mock', 'openai'].includes(health.provider) || typeof health.configured !== 'boolean') {
      throw new FocusApiError('APIの設定状態を確認できません。', { code: 'invalid_health' });
    }
    this.health = health;
    return health;
  }

  async start({ durationSeconds = 1500 } = {}) {
    this._assertIdle();
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 14400) throw new FocusApiError('セッション時間が不正です。', { code: 'invalid_duration' });
    if (this.sessionId && this.snapshot?.state !== 'ended' && this.remainingMs > 0) throw new FocusApiError('現在のAPIセッションを終了してください。', { code: 'session_active' });
    this.stopFrames();
    this.busy = true;
    const generation = this.generation;
    this.durationSeconds = durationSeconds;
    this.startedAt = this.now();
    this._endedRemaining = null;
    this.sessionId = null;
    this.snapshot = null;
    this._seenNotifications.clear();
    this._sequence = 0;
    try {
      const data = this._validateSnapshot(await this._request('/v1/sessions', { method: 'POST', json: { device_type: 'mac', duration_seconds: durationSeconds } }));
      this.sessionId = data.session_id;
      this._save(data);
      this._suspended = generation !== this.generation || !OBSERVING_STATES.has(data.state);
      this.expire();
      return this.snapshot;
    } catch (error) {
      this._suspended = true;
      if (!this.sessionId) this.startedAt = null;
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async control(action, { keepalive = false } = {}) {
    this._assertIdle();
    if (!['pause', 'resume', 'end'].includes(action)) throw new FocusApiError('操作が不正です。', { code: 'invalid_action' });
    if (!this.sessionId) throw new FocusApiError('APIセッションがありません。', { code: 'session_not_found' });
    this.stopFrames();
    this.busy = true;
    const generation = this.generation;
    try {
      const data = this._validateSnapshot(await this._request(`/v1/sessions/${encodeURIComponent(this.sessionId)}/control`, { method: 'POST', json: { action }, keepalive }), this.sessionId);
      this._save(data);
      if ((action === 'end' && data.state !== 'ended') || (action === 'pause' && !['paused', 'ended'].includes(data.state)) || (action === 'resume' && data.state === 'paused')) {
        throw new FocusApiError('APIが操作の完了を確認できませんでした。', { code: 'unexpected_control_state' });
      }
      this._suspended = action !== 'resume' || generation !== this.generation || !OBSERVING_STATES.has(data.state);
      this.expire();
      return this.snapshot;
    } catch (error) {
      this._suspended = true;
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async get() {
    if (!this.sessionId || this.busy) return null;
    const sessionId = this.sessionId;
    const generation = this.generation;
    const data = this._validateSnapshot(await this._request(`/v1/sessions/${encodeURIComponent(sessionId)}`), sessionId);
    if (sessionId !== this.sessionId || generation !== this.generation) return null;
    this._save(data);
    this.expire();
    return this.snapshot;
  }

  async frame(blob) {
    if (!this.active || this._frame) return null;
    if (!(blob instanceof Blob) || !['image/jpeg', 'image/png'].includes(blob.type) || !blob.size || blob.size > MAX_FRAME_BYTES) {
      throw new FocusApiError('画像は1 MiB以下のJPEGまたはPNGが必要です。', { code: 'invalid_image' });
    }
    const request = { controller: new AbortController(), generation: this.generation, sessionId: this.sessionId };
    this._frame = request;
    const frameId = `mac-${Date.now().toString(36)}-${++this._sequence}`;
    try {
      const data = this._validateSnapshot(await this._request(`/v1/sessions/${encodeURIComponent(request.sessionId)}/frames`, {
        method: 'POST', body: blob, headers: { 'Content-Type': blob.type, 'X-Frame-Id': frameId }, signal: request.controller.signal,
      }), request.sessionId);
      if (request.generation !== this.generation || request.sessionId !== this.sessionId || this._suspended || this.remainingMs <= 0) return null;
      this._save(data);
      let notification = null;
      if (data.notify && !['unknown', 'paused', 'ended'].includes(data.state) && !this._seenNotifications.has(data.notification_id)) {
        this._seenNotifications.add(data.notification_id);
        notification = { id: data.notification_id, message: data.message || 'いまの作業に戻ろう', provider: data.provider };
      }
      return { snapshot: this.snapshot, notification };
    } catch (error) {
      if (request.generation !== this.generation || request.controller.signal.aborted) return null;
      throw error;
    } finally {
      if (this._frame === request) this._frame = null;
    }
  }

  _save(data) {
    if (data.state === 'ended' && this._endedRemaining === null) this._endedRemaining = data.reason === 'session_expired' ? 0 : this.remainingMs;
    if (['paused', 'ended'].includes(data.state)) this._suspended = true;
    // Stored display data can never accidentally replay an old notification.
    this.snapshot = { ...data, notify: false, notification_id: null, message: null };
  }

  _assertIdle() {
    if (this.busy) throw new FocusApiError('前の操作が完了するまでお待ちください。', { code: 'control_in_progress' });
  }

  _validateSnapshot(data, expectedId) {
    if (!data || typeof data.session_id !== 'string' || !data.session_id || (expectedId && data.session_id !== expectedId) || !STATES.has(data.state) || typeof data.notify !== 'boolean' || !Number.isFinite(data.next_capture_after_ms) || data.next_capture_after_ms < 0 || !['mock', 'openai'].includes(data.provider) || (data.notify && (typeof data.notification_id !== 'string' || !data.notification_id))) {
      throw new FocusApiError('API応答の形式を確認できません。', { code: 'invalid_snapshot' });
    }
    return data;
  }

  async _request(path, { method = 'GET', json, body, headers = {}, signal, keepalive = false } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method, headers: json === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        body: json === undefined ? body : JSON.stringify(json), signal: controller.signal, cache: 'no-store', keepalive,
      });
      let data;
      try { data = await response.json(); } catch { throw new FocusApiError('APIからJSON応答を取得できません。', { code: 'invalid_response', status: response.status }); }
      if (!response.ok) throw new FocusApiError(data?.error?.message || `APIとの通信に失敗しました（${response.status}）。`, { code: data?.error?.code || 'http_error', status: response.status });
      return data;
    } catch (error) {
      if (error instanceof FocusApiError) throw error;
      throw new FocusApiError(controller.signal.aborted ? 'API通信が中止されたか、時間切れになりました。' : 'APIに接続できません。', { code: controller.signal.aborted ? 'request_aborted' : 'network_error' });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
