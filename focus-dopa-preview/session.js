const configurableStates = new Set(['ready', 'ended', 'completed']);
const activeStates = new Set(['running', 'paused', 'break']);
const validDuration = (seconds) => Number.isFinite(seconds) && seconds >= 60 && seconds <= 7200;

/** Local demo session clock. This class performs no camera or notification I/O. */
export class Session {
  constructor({ duration = 1500, now = () => performance.now() } = {}) {
    if (!validDuration(duration)) throw new RangeError('Duration must be between 60 and 7200 seconds.');
    if (typeof now !== 'function') throw new TypeError('now must be a function returning milliseconds.');
    this.duration = duration;
    this.now = now;
    this.status = 'ready';
    this.generation = 0;
    this.notificationCount = 0;
    this.notificationEnabled = true;
    this._elapsed = 0;
    this._anchor = null;
    this._lastAcceptedAt = null;
  }

  get elapsed() {
    const live = this.status === 'running' ? Math.max(0, this.now() - this._anchor) / 1000 : 0;
    return Math.min(this.duration, Math.max(0, this._elapsed + live));
  }

  get remaining() {
    return Math.max(0, this.duration - this.elapsed);
  }

  /** Remaining fraction, suitable for a countdown gauge. */
  get ratio() {
    return this.remaining / this.duration;
  }

  start() {
    if (!configurableStates.has(this.status)) return false;
    this._elapsed = 0;
    this._anchor = this.now();
    this._lastAcceptedAt = null;
    this.notificationCount = 0;
    this.status = 'running';
    this.generation += 1;
    return true;
  }

  pause() {
    if (this.status !== 'running') return false;
    this._elapsed = this.elapsed;
    this._anchor = null;
    this._lastAcceptedAt = null;
    this.status = 'paused';
    this.generation += 1;
    return true;
  }

  takeBreak() {
    if (this.status !== 'running' && this.status !== 'paused') return false;
    this._elapsed = this.elapsed;
    this._anchor = null;
    this._lastAcceptedAt = null;
    this.status = 'break';
    this.generation += 1;
    return true;
  }

  resume() {
    if (this.status !== 'paused' && this.status !== 'break') return false;
    this._anchor = this.now();
    this.status = 'running';
    this.generation += 1;
    return true;
  }

  end() {
    if (!activeStates.has(this.status)) return false;
    this._elapsed = this.elapsed;
    this._anchor = null;
    this._lastAcceptedAt = null;
    this.status = 'ended';
    this.generation += 1;
    return true;
  }

  tick() {
    if (this.status !== 'running' || this.remaining > 0) return false;
    this._elapsed = this.duration;
    this._anchor = null;
    this._lastAcceptedAt = null;
    this.status = 'completed';
    this.generation += 1;
    return true;
  }

  setDuration(seconds) {
    if (!configurableStates.has(this.status) || !validDuration(seconds)) return false;
    this.duration = seconds;
    this._elapsed = 0;
    this._anchor = null;
    this._lastAcceptedAt = null;
    this.notificationCount = 0;
    this.status = 'ready';
    this.generation += 1;
    return true;
  }

  receiveDetection({ generation = this.generation } = {}) {
    if (generation !== this.generation) return false;
    if (this.status !== 'running' || !this.notificationEnabled || this.remaining === 0) return false;
    const now = this.now();
    if (this._lastAcceptedAt !== null && now - this._lastAcceptedAt <= 60_000) return false;
    this._lastAcceptedAt = now;
    this.notificationCount += 1;
    return true;
  }
}
