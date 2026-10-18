/** Short, cancellable typography cues for detection, start, and completion. */
export class LyricMotion {
  constructor(container) {
    if (!container) throw new TypeError('LyricMotion needs a container element.');
    this.container = container;
    this.animations = new Set();
    this.timer = null;
    this.character = null;
    container.classList.add('lyric-motion');
    container.setAttribute('aria-hidden', 'true');
    this.cards = Object.fromEntries(
      ['start', 'detect', 'complete'].map(kind => [kind, this._preloadCard(kind)]),
    );
  }

  _preloadCard(kind) {
    const image = this.container.ownerDocument.createElement('img');
    image.className = 'lyric-generated-card';
    image.alt = '';
    image.draggable = false;
    image.decoding = 'async';
    image.loading = 'eager';
    const card = { image, status: 'loading', ready: null };
    card.ready = new Promise(resolve => {
      let settled = false;
      let decoding = false;
      const finish = success => {
        if (settled) return;
        settled = true;
        image.onload = null;
        image.onerror = null;
        card.status = success ? 'ready' : 'error';
        resolve(success);
      };
      const loaded = async () => {
        if (settled || decoding) return;
        decoding = true;
        try {
          if (typeof image.decode === 'function') await image.decode();
          finish(image.naturalWidth > 0);
        } catch {
          // Some browsers reject decode() even when the loaded bitmap is usable.
          finish(image.complete && image.naturalWidth > 0);
        }
      };
      image.onload = loaded;
      image.onerror = () => finish(false);
      const filename = kind === 'detect' ? 'alert' : kind;
      image.src = new URL(`./assets/lyric-type/${filename}.png`, import.meta.url).href;
      if (image.complete) {
        if (image.naturalWidth > 0) loaded();
        else finish(false);
      }
    });
    return card;
  }

  _animate(element, frames, options) {
    const animation = element.animate(frames, { fill: 'both', ...options });
    this.animations.add(animation);
    animation.finished.then(
      () => this.animations.delete(animation),
      () => this.animations.delete(animation),
    );
    return animation;
  }

  setCharacter(profile) {
    this.clear();
    this.character = profile || null;
  }

  clear() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    this.container.replaceChildren();
    this.container.removeAttribute('data-lyric-level');
    this.container.removeAttribute('data-lyric-kind');
    this.container.removeAttribute('data-lyric-render');
  }

  play({ reduced = false, intensity = 'max', kind = 'detect' } = {}) {
    this.clear();
    // The ordinary application notice remains available when motion is disabled.
    if (reduced || intensity === 'off' || typeof this.container.animate !== 'function') return false;
    const selectedKind = Object.hasOwn(this.cards, kind) ? kind : 'detect';
    this.container.dataset.lyricKind = selectedKind;
    if (this.cards[selectedKind].status === 'ready') {
      this.container.dataset.lyricRender = 'image';
      return selectedKind === 'detect'
        ? this._playAlertVisual(this.cards[selectedKind].image, intensity)
        : this._playVisual(this.cards[selectedKind].image, intensity);
    }

    // Preloading only updates the cache: a late load/decode cannot restart a
    // cleared cue or replace another event. This play uses text immediately.
    this.container.dataset.lyricRender = 'text';
    return this._playText({ intensity, kind: selectedKind });
  }

  _playVisual(visual, intensity) {
    const maximum = intensity === 'max';
    const total = maximum ? 4600 : 1900;
    this.container.dataset.lyricLevel = maximum ? 'max' : 'pop';

    const atmosphere = this.container.ownerDocument.createElement('div');
    atmosphere.className = 'lyric-image-atmosphere';
    const frame = this.container.ownerDocument.createElement('div');
    frame.className = 'lyric-image-frame';
    const panel = this.container.ownerDocument.createElement('div');
    panel.className = 'lyric-dots-panel';
    const outline = this._makeDotsOutline();
    const content = this.container.ownerDocument.createElement('div');
    content.className = 'lyric-dots-content';
    content.append(visual);
    panel.append(outline, content);
    frame.append(panel);
    this.container.append(atmosphere, frame);

    this._animate(atmosphere, [
      { opacity: 0 },
      { opacity: 1, offset: 0.1 },
      { opacity: 1, offset: 0.88 },
      { opacity: 0 },
    ], { duration: total, easing: 'linear' });

    const frames = maximum ? [
      { opacity: 1, transform: 'translateY(84px) rotate(2deg) scale(.84,.79)', offset: 0 },
      { opacity: 1, transform: 'translateY(-10px) rotate(-.7deg) scale(1.025,.955)', offset: 0.15 },
      { opacity: 1, transform: 'translateX(0) rotate(0deg) scale(.985,1.015)', offset: 0.21 },
      { opacity: 1, transform: 'translateX(0) rotate(0deg) scale(1)', offset: 0.28 },
      { opacity: 1, transform: 'translateX(0) rotate(0deg) scale(.992,.985)', offset: 0.52 },
      { opacity: 1, transform: 'translateX(0) rotate(0deg) scale(1)', offset: 0.63 },
      { opacity: 1, transform: 'translateX(0) rotate(0deg) scale(1)', offset: 0.86 },
      { opacity: 0, transform: 'translateY(28px) rotate(-1deg) scale(.96)', offset: 1 },
    ] : [
      { opacity: 1, transform: 'translateY(24px) scale(.96,.91)' },
      { opacity: 1, transform: 'translateY(0) scale(1.015,.985)', offset: 0.16 },
      { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.27 },
      { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.82 },
      { opacity: 0, transform: 'translateY(-10px) scale(.99)' },
    ];
    this._animate(frame, frames, { duration: total, easing: 'cubic-bezier(.22,.68,.26,1)' });

    this.timer = setTimeout(() => this.clear(), total);
    return true;
  }

  _playAlertVisual(visual, intensity) {
    const maximum = intensity === 'max';
    const total = maximum ? 4600 : 1900;
    this.container.dataset.lyricLevel = maximum ? 'max' : 'pop';
    const make = (className, text) => {
      const element = this.container.ownerDocument.createElement('div');
      element.className = className;
      if (text) element.textContent = text;
      return element;
    };

    const scene = make('lyric-alarm-scene');
    const atmosphere = make('lyric-alarm-atmosphere');
    const beacon = make('lyric-alarm-beacon');
    const top = make('lyric-alarm-caution lyric-alarm-caution-top');
    const bottom = make('lyric-alarm-caution lyric-alarm-caution-bottom');
    const leftEdge = make('lyric-alarm-edge lyric-alarm-edge-left');
    const rightEdge = make('lyric-alarm-edge lyric-alarm-edge-right');
    const heading = make('lyric-alarm-heading');
    const headingLine = make('lyric-alarm-heading-line');
    const title = make('lyric-alarm-title', 'ALERT');
    const subtitle = make('lyric-alarm-subtitle', '検知アクション');
    headingLine.append(this._makeAlertIcon(), title);
    heading.append(headingLine, subtitle);

    const leftRail = make('lyric-alarm-rail lyric-alarm-rail-left', 'ATTENTION / ATTENTION');
    const rightRail = make('lyric-alarm-rail lyric-alarm-rail-right', 'ATTENTION / ATTENTION');
    const stage = make('lyric-alarm-stage');
    const panel = make('lyric-dots-panel lyric-alarm-dots');
    const content = make('lyric-dots-content');
    content.append(visual);
    panel.append(this._makeDotsOutline('#FFB52E'), content);
    stage.append(panel);
    const footer = make('lyric-alarm-footer', 'BACK TO YOUR TASK');
    scene.append(atmosphere, beacon, leftRail, rightRail, stage, heading, footer, top, bottom, leftEdge, rightEdge);
    this.container.append(scene);

    // Each track is finite and owned by this instance. clear() also removes the
    // entire scene, so no red styling can survive into a start/completion cue.
    this._animate(scene, [
      { opacity: 1 },
      { opacity: 1, offset: 0.9 },
      { opacity: 0 },
    ], { duration: total, easing: 'linear' });
    this._animate(stage, maximum ? [
      { transform: 'scale(1.12,.94)' },
      { transform: 'scale(.985,1.02)', offset: 0.16 },
      { transform: 'scale(1)', offset: 0.28 },
      { transform: 'scale(1)', offset: 0.88 },
      { transform: 'scale(.97)' },
    ] : [
      { transform: 'scale(.96)' },
      { transform: 'scale(1)', offset: 0.2 },
      { transform: 'scale(1)', offset: 0.88 },
      { transform: 'scale(.98)' },
    ], { duration: total, easing: 'cubic-bezier(.22,.68,.26,1)' });
    this._animate(heading, [
      { transform: `translateY(${maximum ? -45 : -12}px)` },
      { transform: 'translateY(0)' },
    ], { duration: maximum ? 500 : 260, easing: 'cubic-bezier(.16,1,.3,1)' });

    for (const [rail, direction] of [[leftRail, -1], [rightRail, 1]]) {
      const angle = direction * 5;
      this._animate(rail, [
        { transform: `translateX(${direction * 110}%) rotate(${angle}deg)` },
        { transform: `translateX(0) rotate(${angle}deg)`, offset: 0.18 },
        { transform: `translateX(0) rotate(${angle}deg)`, offset: 0.86 },
        { transform: `translateX(${direction * 110}%) rotate(${angle}deg)` },
      ], { duration: total, easing: 'cubic-bezier(.2,.65,.3,1)' });
    }
    if (maximum) {
      this._animate(beacon, [
        { transform: 'rotate(-58deg)' },
        { transform: 'rotate(76deg)' },
      ], { duration: total, easing: 'linear' });
    }

    this.timer = setTimeout(() => this.clear(), total);
    return true;
  }

  _makeAlertIcon() {
    const namespace = 'http://www.w3.org/2000/svg';
    const icon = this.container.ownerDocument.createElementNS(namespace, 'svg');
    icon.setAttribute('class', 'lyric-alarm-icon');
    icon.setAttribute('viewBox', '0 0 88 82');
    icon.setAttribute('aria-hidden', 'true');
    const triangle = this.container.ownerDocument.createElementNS(namespace, 'path');
    triangle.setAttribute('d', 'M44 6 L82 73 Q84 77 79 77 L9 77 Q4 77 6 73 Z');
    triangle.setAttribute('fill', '#FFB52E');
    triangle.setAttribute('stroke', '#FFE1A0');
    triangle.setAttribute('stroke-width', '3');
    const mark = this.container.ownerDocument.createElementNS(namespace, 'path');
    mark.setAttribute('d', 'M44 28 L44 48 M44 61 L44 62');
    mark.setAttribute('fill', 'none');
    mark.setAttribute('stroke', '#24141B');
    mark.setAttribute('stroke-width', '9');
    mark.setAttribute('stroke-linecap', 'round');
    icon.append(triangle, mark);
    return icon;
  }

  _makeDotsOutline(fill) {
    const namespace = 'http://www.w3.org/2000/svg';
    const shape = this.container.ownerDocument.createElementNS(namespace, 'svg');
    shape.setAttribute('class', 'lyric-dots-outline');
    shape.setAttribute('viewBox', '0 0 1200 900');
    shape.setAttribute('aria-hidden', 'true');
    shape.setAttribute('focusable', 'false');
    const path = this.container.ownerDocument.createElementNS(namespace, 'path');
    // A plump oval body flows into two large round eye protrusions. No face,
    // straight edges, inner card, outlines, or gradients are drawn.
    const silhouette = this.character?.silhouette || 'M240 296 C218 234 228 140 280 88 C327 39 401 33 456 64 C514 96 540 151 533 213 C578 203 621 203 666 213 C659 151 685 96 743 64 C798 33 872 39 919 88 C971 140 981 234 959 296 C1092 354 1177 459 1177 579 C1177 746 955 875 600 875 C245 875 23 746 23 579 C23 459 108 354 240 296 Z';
    path.setAttribute('d', silhouette);
    path.setAttribute('fill', fill || this.character?.color || '#CEFF34');
    path.setAttribute('stroke', 'none');
    shape.append(path);
    return shape;
  }

  _playText({ intensity, kind }) {
    const copy = {
      start: ['ここから、ひとつずつ。', '集中！', 'LET’S FOCUS'],
      detect: ['動きを検知', '作業に戻ろう！', 'BACK TO YOUR TASK'],
      complete: ['やりきった、その一歩が', '最高！', 'YOU DID IT'],
    }[kind];
    const visual = this.container.ownerDocument.createElement('div');
    visual.className = kind === 'detect' ? 'lyric-type-fallback lyric-alarm-fallback' : 'lyric-type-fallback';
    for (const [index, text] of copy.entries()) {
      const line = this.container.ownerDocument.createElement('span');
      line.className = ['lyric-type-kicker', 'lyric-type-main', 'lyric-type-caption'][index];
      line.textContent = text;
      visual.append(line);
    }
    return kind === 'detect' ? this._playAlertVisual(visual, intensity) : this._playVisual(visual, intensity);
  }
}
