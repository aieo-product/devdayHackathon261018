const timestamp = (value) => typeof value === 'number' ? value : Date.parse(value);

/** Browser-independent command policy. Camera acquisition is supplied by the page. */
export class RemoteController {
  constructor({ start, stop, permission, visible, observed, now = Date.now, onChange = () => {} }) {
    this.startCamera = start;
    this.stopCamera = stop;
    this.permission = permission;
    this.visible = visible;
    this.observed = observed;
    this.now = now;
    this.onChange = onChange;
    this.armed = false;
    this.arming = false;
    this.appliedRevision = 0;
    this.latestRevision = 0;
    this.epoch = 0;
    this.commandFloor = 0;
    this.error = '';
    this.failureState = null;
    this.pending = false;
    this.disposed = false;
  }
  get state() {
    return { armed: this.armed, arming: this.arming, appliedRevision: this.appliedRevision, pending: this.pending, error: this.error };
  }
  changed() { this.onChange(this.state); }
  async arm() {
    if (this.disposed || this.armed || this.arming) return this.armed;
    if (!this.visible()) { this.error = 'この画面を表示してから遠隔操作を許可してください。'; this.changed(); return false; }
    const epoch = ++this.epoch;
    this.arming = true; this.error = ''; this.failureState = null; this.changed();
    try {
      // Called before the first await so getUserMedia retains the local click gesture.
      const acquired = await this.permission();
      acquired.getTracks().forEach(track => track.stop());
      if (this.disposed || epoch !== this.epoch || !this.visible()) return false;
      this.armed = true;
      this.commandFloor = this.now();
      return true;
    } catch {
      if (epoch === this.epoch && !this.disposed) {
        this.error = 'カメラの許可を確認できませんでした。ChromeとmacOSのカメラ権限を確認してください。';
        this.failureState = 'blocked';
      }
      return false;
    } finally {
      if (epoch === this.epoch && !this.disposed) { this.arming = false; this.changed(); }
    }
  }
  stopNow() {
    const epoch = this.epoch;
    try {
      Promise.resolve(this.stopCamera()).catch(() => {
        if (!this.disposed && epoch === this.epoch) { this.error = '停止通知に失敗しました。カメラの状態を確認してください。'; this.failureState = 'error'; this.changed(); }
      });
    } catch {
      this.error = 'カメラを停止できませんでした。ページを閉じてください。'; this.failureState = 'error';
    }
  }
  unarm() {
    ++this.epoch;
    this.armed = false; this.arming = false; this.pending = false;
    this.commandFloor = this.now();
    this.appliedRevision = Math.max(this.appliedRevision, this.latestRevision);
    this.error = ''; this.failureState = null;
    this.stopNow(); this.changed();
  }
  localStop() {
    ++this.epoch;
    this.pending = false; this.arming = false;
    this.commandFloor = this.now();
    this.appliedRevision = Math.max(this.appliedRevision, this.latestRevision);
    this.error = ''; this.failureState = null;
    this.changed();
  }
  hidden() { this.unarm(); }
  observe(device) {
    if (this.disposed || !device || !Number.isSafeInteger(device.revision) || device.revision < 0) return;
    this.latestRevision = Math.max(this.latestRevision, device.revision);
    if (device.revision <= this.appliedRevision) return;
    this.appliedRevision = device.revision;
    if (device.desired_state === 'off') {
      ++this.epoch; this.pending = false; this.arming = false; this.error = ''; this.failureState = null;
      this.stopNow(); this.changed(); return;
    }
    if (device.desired_state !== 'on') { this.changed(); return; }
    const issued = timestamp(device.command_issued_at), expires = timestamp(device.command_expires_at), now = this.now();
    let blocked;
    if (!this.armed || this.arming) blocked = '遠隔ONは未許可のため実行しませんでした。許可後に新しくONを指示してください。';
    else if (!this.visible()) blocked = '画面が非表示のため遠隔ONを実行しませんでした。';
    else if (device.online !== true) blocked = '端末がオフラインのため遠隔ONを実行しませんでした。';
    else if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= now || now - issued > 120_000 || issued > now + 5000 || issued < this.commandFloor) blocked = '期限切れ、または許可以前のON指示を破棄しました。もう一度ONを指示してください。';
    if (blocked) { this.error = blocked; this.failureState = 'blocked'; this.changed(); return; }
    const epoch = ++this.epoch;
    this.pending = true; this.error = ''; this.failureState = null; this.changed();
    // Do not await: a later OFF must be able to cancel a pending permission/start.
    try {
      Promise.resolve(this.startCamera({ isCurrent: () => !this.disposed && epoch === this.epoch && this.armed && this.visible() && this.now() < expires && this.now() - issued <= 120_000 })).then(success => {
        if (epoch !== this.epoch || this.disposed) return;
        this.pending = false;
        if (success === false) { this.error = '遠隔ONを開始できませんでした。画面のエラーを確認し、新しくONを指示してください。'; this.failureState = 'error'; }
        this.changed();
      }, () => {
        if (epoch !== this.epoch || this.disposed) return;
        this.pending = false; this.error = '遠隔ONを開始できませんでした。カメラとAPIの状態を確認してください。'; this.failureState = 'error'; this.changed();
      });
    } catch {
      this.pending = false; this.error = '遠隔ONを開始できませんでした。'; this.failureState = 'error'; this.changed();
    }
  }
  heartbeat() {
    const actual = this.observed();
    return {
      observed_state: actual.observed_state === 'on' ? 'on' : this.failureState || actual.observed_state || 'off',
      remote_enabled: this.armed && !this.disposed,
      applied_revision: this.appliedRevision,
      session_id: actual.session_id || null,
    };
  }
  dispose() { this.unarm(); this.disposed = true; }
}

/** One request sequence at a time, including explicit refreshes. */
export function createSingleFlightPoll({ task, delayMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout, onError = () => {} }) {
  let active = false, flight = null, timer;
  const run = () => {
    if (flight) return flight;
    clearTimer(timer);
    flight = Promise.resolve().then(task).catch(onError).finally(() => {
      flight = null;
      if (active) timer = setTimer(run, delayMs);
    });
    return flight;
  };
  return { run, start() { active = true; return run(); }, stop() { active = false; clearTimer(timer); } };
}
