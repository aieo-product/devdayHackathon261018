/** Keeps only the latest unseen visual cue; replay never dispatches a notification. */
export class DetectionReplay {
  constructor({ now = () => Date.now(), maxAgeMs = 60000 } = {}) {
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.pending = null;
  }

  remember(notification, { context, unseen } = {}) {
    this.pending = unseen && notification
      ? { notification, context, recordedAt: this.now() }
      : null;
  }

  take({ context, enabled, status, visible, focused } = {}) {
    const pending = this.pending;
    if (!pending) return null;

    if (!enabled || context !== pending.context
      || this.now() - pending.recordedAt >= this.maxAgeMs
      || (status !== 'running' && pending.notification.kind !== 'test')) {
      this.clear();
      return null;
    }

    if (!visible || !focused) return null;
    this.clear();
    return pending.notification;
  }

  clear() {
    this.pending = null;
  }
}
