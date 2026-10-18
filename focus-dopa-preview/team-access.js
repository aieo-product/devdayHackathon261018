/** Team codes are sent only in a same-origin POST body and never retained. */
export class TeamAccess {
  constructor({ fetchImpl = globalThis.fetch.bind(globalThis), allowLocalBypass = false, now = () => Date.now(), setTimer = globalThis.setTimeout.bind(globalThis), clearTimer = globalThis.clearTimeout.bind(globalThis), onChange = () => {}, onLost = () => {} } = {}) {
    this.fetchImpl = fetchImpl;
    this.allowLocalBypass = allowLocalBypass;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onChange = onChange;
    this.onLost = onLost;
    this.required = true;
    this.authenticated = false;
    this.checked = false;
    this.busy = false;
    this.expiresAt = null;
    this.generation = 0;
    this.message = '利用権限を確認中です。';
    this._expiryTimer = null;
    this._requests = new Set();
  }

  get allowed() { return this.checked && (!this.required || this.authenticated); }
  get nativeAllowed() { return this.checked && !this.required; }

  async check() {
    const generation = this.generation;
    try {
      const response = await this._request('/status');
      if (generation !== this.generation) return this.allowed;
      if (response.status === 404 && this.allowLocalBypass) {
        this.required = false;
        this.authenticated = false;
        this.checked = true;
        this.message = 'ローカル接続を利用します。';
        this.onChange();
        return true;
      }
      if (!response.ok) throw new Error('利用権限を確認できません。接続を確認して再試行してください。');
      const data = await response.json();
      if (generation !== this.generation) return this.allowed;
      if (typeof data?.required !== 'boolean' || typeof data?.authenticated !== 'boolean' || (!data.required && !this.allowLocalBypass)) throw new Error('利用権限を確認できません。');
      this._apply(data);
      return this.allowed;
    } catch (error) {
      if (generation !== this.generation) return this.allowed;
      this.invalidate('利用権限を確認できません。接続を確認して再試行してください。');
      throw error;
    }
  }

  async login(code) {
    if (this.busy || this.authenticated) return false;
    if (!code.trim()) { this.message = 'チーム用コードを入力してください。'; this.onChange(); return false; }
    this.busy = true;
    this.generation += 1;
    this.message = 'チーム用コードを確認中です。';
    this.onChange();
    const generation = this.generation;
    try {
      const response = await this._request('/login', { code });
      // Do not echo a remote error or the supplied code into the page.
      if (!response.ok) throw new Error(response.status === 401 ? 'チーム用コードが正しくありません。' : response.status === 429 ? '試行が多いため、少し待ってから入力してください。' : 'ログインできませんでした。接続を確認して再試行してください。');
      const data = await response.json();
      if (generation !== this.generation) return false;
      if (data?.authenticated !== true) throw new Error('ログインを確認できませんでした。');
      this._apply({ ...data, required: true });
      return this.allowed;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.message = error.message;
      return false;
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  async logout({ beforeLogout = async () => {} } = {}) {
    if (this.busy) return false;
    this.busy = true;
    this.message = 'セッションを終了してログアウトしています。';
    this.onChange();
    let timeout;
    try {
      // Best effort server cleanup while the cookie is still valid. Local capture
      // is stopped by the caller first; this wait must never delay it.
      await Promise.race([Promise.resolve().then(beforeLogout).catch(() => {}), new Promise(resolve => { timeout = this.setTimer(resolve, 1800); })]);
    } finally {
      if (timeout !== undefined) this.clearTimer(timeout);
      this.invalidate('ログアウトしました。チーム用コードを入力してください。');
    }
    try {
      const response = await this._request('/logout', {});
      if (!response.ok) throw new Error('logout_failed');
      return true;
    } catch {
      this.message = 'この画面のカメラと通信は停止済みです。ログアウトの確認に失敗しました。接続を確認して再試行してください。';
      return false;
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  invalidate(message = '利用期限が切れました。チーム用コードを入力してください。') {
    this.generation += 1;
    this.required = true;
    this.authenticated = false;
    this.checked = true;
    this.expiresAt = null;
    this.message = message;
    if (this._expiryTimer !== null) this.clearTimer(this._expiryTimer);
    this._expiryTimer = null;
    for (const controller of this._requests) controller.abort();
    this._requests.clear();
    this.onLost();
    this.onChange();
  }

  async fetchAuthorized(url, options = {}) {
    if (!this.allowed) throw Object.assign(new Error('チーム用コードを入力してください。'), { status: 401, code: 'authentication_required' });
    const generation = this.generation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    this._requests.add(controller);
    try {
      const response = await this.fetchImpl(url, { ...options, credentials: 'same-origin', signal: controller.signal });
      if (generation !== this.generation || controller.signal.aborted) throw Object.assign(new Error('古い通信を破棄しました。'), { name: 'AbortError' });
      if (response.status === 401) this.invalidate();
      return response;
    } finally {
      this._requests.delete(controller);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  _apply(data) {
    this.required = data.required;
    this.checked = true;
    if (data.required && !data.authenticated) {
      this.invalidate(this.authenticated ? undefined : 'チーム用コードを入力してください。');
      return;
    }
    this.authenticated = data.authenticated;
    this.expiresAt = data.expires_at || null;
    this.message = data.required ? 'ログイン済み · カメラと共有APIを利用できます。' : 'ローカル接続を利用します。';
    if (this._expiryTimer !== null) this.clearTimer(this._expiryTimer);
    this._expiryTimer = null;
    if (this.required && this.expiresAt) {
      const remaining = Date.parse(this.expiresAt) - this.now();
      if (!Number.isFinite(remaining) || remaining <= 0) { this.invalidate(); return; }
      const generation = this.generation;
      this._expiryTimer = this.setTimer(() => { if (generation === this.generation) this.invalidate(); }, Math.min(remaining, 2147483647));
    }
    this.onChange();
  }

  _request(path, json) {
    return this.fetchImpl(`/api/access${path}`, {
      method: json === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000),
      ...(json === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) }),
    });
  }
}
