/** Only sends short visual cues to the local helper, never camera frames or API credentials. */
export class DesktopOverlayClient {
  constructor({ fetchImpl = globalThis.fetch.bind(globalThis), sourceId = crypto.randomUUID() } = {}) {
    this.fetch = fetchImpl;
    this.sourceId = sourceId;
    this.connected = false;
    this.revision = 0;
    this.queue = Promise.resolve();
  }

  async refresh() {
    try {
      const response = await this.fetch('/api/desktop-overlay/status', { cache: 'no-store', signal: AbortSignal.timeout(1800) });
      this.connected = response.ok && (await response.json()).connected === true;
    } catch { this.connected = false; }
    return this.connected;
  }

  show({ character, message, kind, intensity, reduced }) {
    const revision = ++this.revision;
    return this._enqueue(async () => {
      if (revision !== this.revision) return false;
      try {
        const result = await this._post({ action: 'detect', sourceId: this.sourceId, revision, character, message: String(message).slice(0, 500), kind, intensity, reduced });
        return result.delivered === true && revision === this.revision;
      } catch { this.connected = false; return false; }
    });
  }

  clear({ keepalive = false } = {}) {
    const revision = ++this.revision;
    const send = () => this._post({ action: 'clear', sourceId: this.sourceId, revision }, { keepalive }).catch(() => false);
    // On page exit dispatch immediately: deferred microtasks may not survive unloading.
    return keepalive ? send() : this._enqueue(send);
  }

  _enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async _post(body, { keepalive = false } = {}) {
    const response = await this.fetch('/api/desktop-overlay/cue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      keepalive, ...(keepalive ? {} : { signal: AbortSignal.timeout(1800) }),
    });
    if (!response.ok) throw new Error('Desktop overlay unavailable');
    return response.json();
  }
}
