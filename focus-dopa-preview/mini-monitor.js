const STATUS_LABELS = Object.freeze({
  ready: 'スタンバイ', running: '集中セッション中', paused: '一時停止中',
  break: 'ひと休み中', ended: 'セッション終了', completed: '集中完了！',
  unknown: '接続を確認中',
});

function formatRemaining(value) {
  if (typeof value === 'string') return value;
  const seconds = Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A view of parent-owned session state. It never owns a clock, camera, or API. */
export class MiniMonitor {
  constructor({ onToggle, onEnd, onOpenMain, onChange } = {}) {
    this.callbacks = { onToggle, onEnd, onOpenMain, onChange };
    this.child = null;
    this.mode = null;
    this.elements = null;
    this._opening = false;
    this._noticeTimer = null;
    this._removeListeners = [];
    this._state = {
      status: 'ready', remaining: '25:00', profile: null,
      cameraText: 'カメラは停止中', notificationCount: 0,
      notificationEnabled: true, motion: true, disabled: false,
    };
  }

  get supported() {
    return typeof globalThis.window?.documentPictureInPicture?.requestWindow === 'function';
  }

  get active() {
    try { return Boolean(this.child && !this.child.closed); }
    catch { return false; }
  }

  async open() {
    const owner = globalThis.window;
    if (this.active) {
      try { this.child.focus(); } catch { /* Focus is browser-controlled. */ }
      return { ok: true, mode: this.mode, message: '小窓を表示しています。' };
    }
    if (this._opening) {
      return { ok: false, mode: this.supported ? 'pip' : 'window', message: '小窓を準備中です。' };
    }
    if (!owner) return { ok: false, mode: 'unsupported', message: 'この環境では小窓を開けません。' };

    this._opening = true;
    let mode = this.supported ? 'pip' : 'window';
    let child;
    try {
      if (mode === 'pip') {
        // Call before any await so the button's user activation reaches the browser.
        child = await owner.documentPictureInPicture.requestWindow({ width: 420, height: 360 });
      } else {
        if (typeof owner.open !== 'function') {
          return { ok: false, mode: 'unsupported', message: 'このブラウザでは小窓を開けません。' };
        }
        child = owner.open('', 'focus-mini-monitor', 'popup,width=440,height=400');
        if (!child) {
          return { ok: false, mode, message: '小窓がブロックされました。ポップアップを許可して、もう一度押してください。' };
        }
      }
      if (!child || child.closed) {
        return { ok: false, mode, message: '小窓を開けませんでした。もう一度ボタンを押してください。' };
      }
      this._attach(child, mode, owner);
      return {
        ok: true, mode,
        message: mode === 'pip' ? 'ほかの画面の上に小窓を表示します。' : '別ウィンドウで表示します。最前面の固定はブラウザによって異なります。',
      };
    } catch {
      if (child) { try { child.close(); } catch { /* Already closed. */ } }
      if (this.child === child) this._detach();
      return {
        ok: false, mode,
        message: mode === 'pip'
          ? '小窓を開けませんでした。「小窓で表示」を直接押して再試行してください。'
          : '小窓を開けませんでした。ブラウザのポップアップ設定を確認してください。',
      };
    } finally {
      this._opening = false;
    }
  }

  _listen(target, type, listener) {
    target.addEventListener(type, listener);
    this._removeListeners.push(() => target.removeEventListener(type, listener));
  }

  _attach(child, mode, owner) {
    this._detach();
    this.child = child;
    this.mode = mode;
    const doc = child.document;
    doc.documentElement.lang = 'ja';
    doc.title = 'FOCUS! 小窓';
    const charset = doc.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    const viewport = doc.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1';
    const style = doc.createElement('link');
    style.rel = 'stylesheet';
    style.href = new URL('./mini-monitor.css', import.meta.url).href;
    doc.head.replaceChildren(charset, viewport, style);
    doc.body.replaceChildren();

    const make = (tag, className, text = '') => {
      const node = doc.createElement(tag);
      node.className = className;
      node.textContent = text;
      return node;
    };
    const button = (className, text) => {
      const node = make('button', className, text);
      node.type = 'button';
      return node;
    };
    const root = make('main', 'mini-monitor');
    const header = make('header', 'mini-header');
    const brand = make('strong', 'mini-brand', 'FOCUS!');
    const status = make('span', 'mini-status');
    status.setAttribute('role', 'status');
    header.append(brand, status);

    const center = make('div', 'mini-center');
    const companion = make('div', 'mini-companion');
    companion.setAttribute('aria-hidden', 'true');
    const image = make('img', 'mini-character');
    image.alt = '';
    image.draggable = false;
    const spark = make('span', 'mini-spark', '✦');
    companion.append(image, spark);
    const timing = make('div', 'mini-timing');
    const caption = make('span', 'mini-caption', '残り時間');
    const timer = make('strong', 'mini-timer');
    timer.setAttribute('role', 'timer');
    timer.setAttribute('aria-live', 'off');
    const camera = make('span', 'mini-camera');
    timing.append(caption, timer, camera);
    center.append(companion, timing);

    const notice = make('div', 'mini-notice');
    notice.hidden = true;
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.setAttribute('aria-atomic', 'true');
    const noticeIcon = make('span', 'mini-notice-icon', '！');
    noticeIcon.setAttribute('aria-hidden', 'true');
    const noticeText = make('p', 'mini-notice-text');
    notice.append(noticeIcon, noticeText);

    const controls = make('div', 'mini-controls');
    const toggle = button('mini-toggle', 'はじめる');
    const end = button('mini-end', '終了');
    const openMain = button('mini-open-main', '画面を開く ↗');
    controls.append(toggle, end, openMain);
    const footer = make('footer', 'mini-footer');
    const notifications = make('span', 'mini-notifications');
    const hint = make('span', 'mini-hint', '小窓を閉じてもセッションは続きます');
    footer.append(notifications, hint);
    root.append(header, center, notice, controls, footer);
    doc.body.append(root);
    this.elements = { root, status, companion, image, timer, camera, notice, noticeText, toggle, end, openMain, notifications };

    this._listen(toggle, 'click', () => this._invoke(this.callbacks.onToggle));
    this._listen(end, 'click', () => this._invoke(this.callbacks.onEnd));
    this._listen(openMain, 'click', () => {
      try { owner.focus(); } catch { /* Browser may decline focusing. */ }
      this._invoke(this.callbacks.onOpenMain);
    });
    this._listen(child, 'pagehide', () => {
      if (this.child === child) this._detach();
    });
    this._listen(owner, 'pagehide', () => this.close());
    this.update(this._state);
    this._changed(true, mode);
  }

  _invoke(callback) {
    if (typeof callback !== 'function') return;
    try {
      Promise.resolve(callback()).catch(() => this.notify('操作を完了できませんでした。メイン画面を確認してください。'));
    } catch {
      this.notify('操作を完了できませんでした。メイン画面を確認してください。');
    }
  }

  _changed(active, mode) {
    try { this.callbacks.onChange?.({ active, mode }); }
    catch { /* A host callback must not prevent window cleanup. */ }
  }

  update(next = {}) {
    this._state = { ...this._state, ...next };
    if (!this.active || !this.elements) return;
    const state = this._state;
    const el = this.elements;
    this.child.document.title = `${formatRemaining(state.remaining)} · ${STATUS_LABELS[state.status] || 'FOCUS!'} — FOCUS!`;
    const put = (node, value) => {
      const text = String(value ?? '');
      if (node.textContent !== text) node.textContent = text;
    };
    el.root.dataset.status = state.status;
    el.root.dataset.motion = state.motion === false || state.motion === 'off' ? 'off' : 'on';
    put(el.status, STATUS_LABELS[state.status] || state.status || STATUS_LABELS.ready);
    put(el.timer, formatRemaining(state.remaining));
    el.timer.setAttribute('aria-label', `残り時間 ${formatRemaining(state.remaining)}`);
    put(el.camera, state.cameraText);
    put(el.notifications, `通知 ${state.notificationEnabled ? 'ON' : 'OFF'} · ${state.notificationCount || 0}回`);
    if (state.profile?.asset) {
      const src = new URL(state.profile.asset, import.meta.url).href;
      if (el.image.src !== src) el.image.src = src;
      el.image.hidden = false;
    } else {
      el.image.hidden = true;
    }
    if (state.profile?.color) el.root.style.setProperty('--mini-accent', state.profile.color);
    const running = state.status === 'running';
    const paused = state.status === 'paused' || state.status === 'break';
    put(el.toggle, running ? 'Ⅱ 一時停止' : paused ? '▶ 再開' : state.status === 'unknown' ? '確認中…' : '▶ はじめる');
    el.toggle.disabled = Boolean(state.disabled) || state.status === 'unknown';
    el.end.disabled = Boolean(state.disabled) || !['running', 'paused', 'break', 'unknown'].includes(state.status);
  }

  notify(message) {
    if (!this.active || !this.elements) return false;
    clearTimeout(this._noticeTimer);
    this.elements.noticeText.textContent = String(message || 'いまの作業に戻ろう！');
    this.elements.notice.hidden = false;
    this.elements.root.dataset.alert = 'true';
    this._noticeTimer = setTimeout(() => this.clearNotice(), 8000);
    return true;
  }

  clearNotice() {
    clearTimeout(this._noticeTimer);
    this._noticeTimer = null;
    if (!this.elements) return;
    this.elements.notice.hidden = true;
    delete this.elements.root.dataset.alert;
  }

  _detach() {
    const wasActive = Boolean(this.child);
    const mode = this.mode;
    clearTimeout(this._noticeTimer);
    this._noticeTimer = null;
    for (const remove of this._removeListeners.splice(0)) {
      try { remove(); } catch { /* A child may already have been destroyed. */ }
    }
    this.child = null;
    this.mode = null;
    this.elements = null;
    if (wasActive) this._changed(false, mode);
  }

  close() {
    const child = this.child;
    this._detach();
    if (child) { try { child.close(); } catch { /* Already closed. */ } }
  }
}
