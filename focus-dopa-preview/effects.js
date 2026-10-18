import { createWarningBuffer, WARNING_GAIN } from './warning-sound.js';

const TAU = Math.PI * 2;
const COLORS = ['#CAFF27', '#A279FF', '#52E6F4', '#FF73C7', '#FFF6AD'];
const FEVER_COLORS = ['#FF38DF', '#35F3FF', '#CCFF22', '#FFD63D', '#B884FF'];
const VALID_TYPES = new Set(['tap', 'press', 'start', 'resume', 'milestone', 'break', 'pause', 'complete', 'notify', 'detect']);
const SOUND_SEQUENCES = {
  tap: [[784, 0, 0.09]],
  press: [[880, 0, 0.075], [1318.51, 0.035, 0.1]],
  start: [[523.25, 0, 0.17], [659.25, 0.08, 0.17], [783.99, 0.16, 0.2], [1046.5, 0.27, 0.3]],
  resume: [[659.25, 0, 0.15], [783.99, 0.09, 0.24]],
  milestone: [[783.99, 0, 0.17], [1046.5, 0.11, 0.21], [1318.51, 0.24, 0.3]],
  break: [[659.25, 0, 0.3], [523.25, 0.17, 0.35]],
  pause: [[440, 0, 0.18]],
  end: [[392, 0, 0.16], [261.63, 0.13, 0.25]],
  complete: [[523.25, 0, 0.2], [659.25, 0.11, 0.2], [783.99, 0.22, 0.23],
    [1046.5, 0.36, 0.3], [1318.51, 0.53, 0.4]],
  notify: [[523.25, 0, 0.2], [659.25, 0.14, 0.25]],
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const random = (min, max) => min + Math.random() * (max - min);

/** Small, event-driven effects layer. Coordinates are viewport CSS pixels. */
export class Effects {
  constructor({ canvas, onShake = () => {} }) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('Effects requires a canvas element.');
    }
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onShake = onShake;
    this.intensity = 'pop';
    this.theme = 'classic';
    this.soundEnabled = false;
    this.particles = [];
    this.audioNodes = new Set();
    this.audioContext = null;
    this.masterGain = null;
    this.warningBuffer = null;
    this.rafId = null;
    this.lastFrame = null;
    this.destroyed = false;
    this.audioRequest = 0;
    this.audioUnlockPending = false;
    this.pendingSound = null;
    this.activeSound = null;
    this.audioBusyUntil = 0;
    this.motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.reducedMotion = Boolean(this.motionQuery?.matches);
    this.handleResize = () => this.resize();
    this.handleMotion = (event) => {
      this.reducedMotion = event.matches;
      this.clear();
    };
    this.frame = (time) => this.render(time);
    window.addEventListener('resize', this.handleResize, { passive: true });
    if (this.motionQuery?.addEventListener) {
      this.motionQuery.addEventListener('change', this.handleMotion);
    } else {
      this.motionQuery?.addListener?.(this.handleMotion);
    }
    this.canvas.style.pointerEvents = 'none';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.resize();
  }

  resize() {
    if (this.destroyed) return;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setIntensity(value) {
    if (!['off', 'pop', 'max'].includes(value)) {
      throw new TypeError('Intensity must be off, pop, or max.');
    }
    this.intensity = value;
    if (value === 'off') this.clear();
    if (value === 'pop' && this.particles.length > 100) this.particles.splice(0, this.particles.length - 100);
  }

  setTheme(value) {
    if (!['classic', 'fever'].includes(value)) {
      throw new TypeError('Theme must be classic or fever.');
    }
    if (value === this.theme) return;
    this.clear();
    this.theme = value;
  }

  async setSound(enabled) {
    const request = ++this.audioRequest;
    this.soundEnabled = Boolean(enabled) && !this.destroyed;
    if (!this.soundEnabled) {
      this.audioUnlockPending = false;
      this.stopAudio();
      return false;
    }
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        this.soundEnabled = false;
        this.pendingSound = null;
        return false;
      }
      if (!this.audioContext || this.audioContext.state === 'closed') {
        this.audioContext = new AudioContextClass();
        this.warningBuffer = null;
        this.masterGain = this.audioContext.createGain();
        this.masterGain.gain.value = 0.09;
        this.masterGain.connect(this.audioContext.destination);
      }
      if (this.audioContext.state !== 'running') {
        this.audioUnlockPending = true;
        await this.audioContext.resume();
      }
      if (request !== this.audioRequest || this.destroyed) return false;
      this.audioUnlockPending = false;
      this.soundEnabled = this.audioContext.state === 'running';
      const pending = this.pendingSound;
      this.pendingSound = null;
      if (this.soundEnabled && pending) this.playSound(pending);
      return this.soundEnabled;
    } catch {
      if (request === this.audioRequest) {
        this.soundEnabled = false;
        this.audioUnlockPending = false;
        this.pendingSound = null;
      }
      return false;
    }
  }

  fire(type, { x = this.width / 2, y = this.height * 0.43, level = 1, audible = true } = {}) {
    if (this.destroyed || !VALID_TYPES.has(type)) return;
    if (type === 'pause' || type === 'break' || type === 'detect') this.clear({ audio: false });
    if (audible) this.playSound(type);
    if (this.intensity === 'off' || !this.ctx) return;
    x = Number.isFinite(x) ? clamp(x, 0, this.width) : this.width / 2;
    y = Number.isFinite(y) ? clamp(y, 0, this.height) : this.height * 0.43;
    level = Number.isFinite(level) ? clamp(level, 1, 3) : 1;
    const max = this.intensity === 'max';

    if (this.reducedMotion) {
      // A stationary, brief outline acknowledges the action without travel or flashing.
      this.add({ kind: 'ring', x, y, color: type === 'detect' ? '#FFB83D' : '#52E6F4', radius: 30, life: 0.18,
        duration: 0.18, static: true, width: 2 });
      this.startFrames();
      return;
    }

    if (type === 'detect') {
      this.fireDetection({ x, y });
      this.startFrames();
      return;
    }

    if (type === 'press') {
      this.firePress({ x, y, level });
      this.startFrames();
      return;
    }

    if (type === 'tap' && (this.theme === 'fever' || level > 1)) {
      this.fireTap({ x, y, level });
      this.startFrames();
      return;
    }

    if (this.theme === 'fever' && max && ['start', 'milestone', 'complete'].includes(type)) {
      this.fireFever(type, { x, y, level });
      this.startFrames();
      return;
    }

    if (type === 'notify') {
      // Returning to work is a gentle nudge, never a reward for detection.
      this.add({ kind: 'ring', x, y, color: '#52E6F4', radius: 18, expand: 42,
        life: 0.65, duration: 0.65, width: 2 });
    } else if (type === 'pause') {
      this.add({ kind: 'ring', x, y, color: '#A279FF', radius: 16, expand: 24,
        life: 0.4, duration: 0.4, width: 2 });
    } else if (type === 'break') {
      const count = max ? 22 : 12;
      for (let i = 0; i < count; i++) {
        const duration = random(0.65, 1.2);
        this.add({ kind: 'bubble', x: x + random(-85, 85), y: y + random(-12, 30),
          vx: random(-18, 18), vy: random(-100, -35), gravity: -8,
          radius: random(3, 10), color: ['#52E6F4', '#B2F9F1', '#B99FFF', '#86F0BF'][i % 4],
          life: duration, duration, width: 1.6 });
      }
      this.add({ kind: 'ring', x, y, color: '#52E6F4', radius: 12, expand: 62,
        life: 0.85, duration: 0.85, width: 2 });
      this.add({ kind: 'ring', x, y, color: '#B99FFF', radius: 5, expand: 45,
        life: 1.05, duration: 1.05, width: 1.4 });
    } else {
      const base = { tap: 10, start: 58, resume: 28, milestone: 70, complete: 105 }[type];
      const count = Math.min(max ? 205 : 96, Math.round(base * (max ? 1.65 : 0.75) * (1 + (level - 1) * 0.12)));
      const tap = type === 'tap';
      for (let i = 0; i < count; i++) {
        const angle = random(-Math.PI, 0) + (tap ? random(-0.8, 0.8) : 0);
        const speed = random(tap ? 30 : 90, tap ? 115 : max ? 450 : 320);
        const duration = random(tap ? 0.3 : 0.65, tap ? 0.6 : 1.65);
        this.add({ kind: i % 8 === 0 ? 'streak' : i % 3 === 0 ? 'star' : 'confetti',
          x: x + random(-8, 8), y: y + random(-5, 5),
          vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          gravity: tap ? 115 : 260, drag: 0.35,
          radius: random(tap ? 2 : 3, tap ? 4 : 7),
          angle: random(0, TAU), spin: random(-8, 8),
          color: COLORS[i % COLORS.length], life: duration, duration });
      }
      this.add({ kind: 'ring', x, y, color: type === 'resume' ? '#52E6F4' : '#CAFF27',
        radius: tap ? 5 : 20, expand: tap ? 44 : max ? 190 : 115,
        life: tap ? 0.28 : 0.6, duration: tap ? 0.28 : 0.6, width: tap ? 1.5 : 2.5 });
      if (type === 'resume') this.add({ kind: 'ring', x, y, color: '#FF73C7', radius: 8,
        expand: max ? 130 : 85, life: 0.85, duration: 0.85, width: 1.8 });
      if (max && (type === 'start' || type === 'complete')) this.onShake();
    }
    this.startFrames();
  }

  firePress({ x, y, level }) {
    const palette = this.theme === 'fever' ? FEVER_COLORS : COLORS;
    const strength = 1 + (level - 1) * 0.3;
    const count = Math.round((this.intensity === 'max' ? 24 : 14) * strength);
    for (let i = 0; i < count; i++) {
      const angle = i / count * TAU + random(-0.1, 0.1);
      const speed = random(75, 180) * strength;
      const duration = random(0.35, 0.8);
      this.add({ kind: i % 3 === 0 ? 'streak' : 'star', x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 15,
        gravity: 55, drag: 0.5, radius: random(2.5, 5) * Math.sqrt(strength),
        angle, spin: random(-7, 7), color: palette[i % palette.length], life: duration, duration });
    }
    this.add({ kind: 'ring', x, y, color: palette[2], radius: 5,
      expand: 115 * strength, life: 0.45, duration: 0.45, width: 2 });
    if (level >= 3) this.add({ kind: 'ring', x, y, color: palette[0], radius: 2,
      expand: 90 * strength, life: 0.58, duration: 0.58, width: 1.4 });
  }

  fireDetection({ x, y }) {
    const max = this.intensity === 'max';
    const fever = max && this.theme === 'fever';
    const colors = ['#FFB83D', '#FF48BD'];
    const reach = Math.min(this.width, this.height) * (max ? 0.47 : 0.3);
    const count = fever ? 84 : max ? 56 : 28;
    for (let i = 0; i < count; i++) {
      const angle = i / count * TAU + random(-0.05, 0.05);
      const distance = reach * random(0.65, 1.05);
      const duration = random(0.75, max ? 1.8 : 1.2);
      const speed = Math.max(0, distance - 45) / duration;
      this.add({ kind: 'attention-streak',
        x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance,
        vx: -Math.cos(angle) * speed, vy: -Math.sin(angle) * speed,
        radius: max ? 2.5 : 1.7, trail: random(max ? 22 : 12, max ? 50 : 28),
        color: colors[i % colors.length], life: duration, duration });
    }
    const rings = fever ? 7 : max ? 5 : 3;
    for (let i = 0; i < rings; i++) {
      const duration = 1.15 + i * 0.16;
      this.add({ kind: 'ring', x, y, color: colors[i % 2],
        radius: 36 + i * (max ? 23 : 15), expand: max ? 90 + i * 14 : 65 + i * 10,
        life: duration, duration, width: max ? (i % 2 ? 2.3 : 4) : 2 });
    }
    const markers = fever ? 8 : max ? 6 : 4;
    for (let i = 0; i < markers; i++) {
      const angle = i / markers * TAU - Math.PI / 2;
      const distance = Math.max(60, reach * 0.6);
      this.add({ kind: 'attention-marker',
        x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance,
        vx: -Math.cos(angle) * 14, vy: -Math.sin(angle) * 14,
        radius: max ? 16 : 11, color: colors[i % 2],
        life: 1.3, duration: 1.3 });
    }
  }

  fireTap({ x, y, level }) {
    const fever = this.theme === 'fever';
    const palette = fever ? FEVER_COLORS : COLORS;
    const strength = 1 + (level - 1) * 0.4;
    const base = this.intensity === 'max' ? (fever ? 30 : 22) : (fever ? 18 : 14);
    const count = Math.round(base * (1 + (level - 1) * 0.65));
    for (let i = 0; i < count; i++) {
      const angle = random(0, TAU);
      const speed = random(65, 185) * strength;
      const duration = random(0.32, 0.72 + (level - 1) * 0.1);
      this.add({ kind: i % (level >= 3 ? 3 : 4) === 0 ? 'comet' : 'star', x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 30,
        gravity: 100, drag: 0.3, radius: random(2, 5) * Math.sqrt(strength),
        angle, spin: random(-7, 7), color: palette[i % palette.length],
        life: duration, duration, trail: random(12, 24) * strength });
    }
    this.add({ kind: 'ring', x, y, color: fever ? '#FF38DF' : '#CAFF27', radius: 5,
      expand: 135 * strength, life: 0.35, duration: 0.35, width: 2.3 });
    this.add({ kind: 'ring', x, y, color: '#35F3FF', radius: 3,
      expand: 80 * strength, life: 0.4, duration: 0.4, width: 1.3 });
    if (level >= 3) this.add({ kind: 'ring', x, y, color: '#B884FF', radius: 7,
      expand: 110 * strength, life: 0.6, duration: 0.6, width: 2.2 });
  }

  fireFever(type, { x, y, level }) {
    const origins = [
      { x, y },
      { x: this.width * 0.2, y: this.height * 0.3 },
      { x: this.width * 0.8, y: this.height * 0.25 },
      { x: this.width * 0.15, y: this.height * 0.64 },
      { x: this.width * 0.85, y: this.height * 0.59 },
    ].slice(0, type === 'complete' ? 5 : type === 'milestone' ? 4 : 3);
    const baseCount = type === 'complete' ? 64 : 70;
    const count = Math.round(baseCount * (1 + (level - 1) * 0.035));
    origins.forEach((origin, originIndex) => {
      for (let i = 0; i < count; i++) {
        const angle = i / count * TAU + random(-0.09, 0.09);
        const comet = i % 7 === 0;
        const speed = random(comet ? 195 : 90, comet ? 405 : 305);
        const duration = random(comet ? 1.0 : 1.15, comet ? 1.65 : 2.35);
        this.add({ kind: comet ? 'comet' : i % 3 === 0 ? 'star' : 'confetti',
          x: origin.x, y: origin.y, vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 50, gravity: comet ? 80 : 165,
          drag: 0.45, radius: random(comet ? 2.5 : 3, comet ? 4.5 : 7),
          angle, spin: random(-9, 9), color: FEVER_COLORS[(i + originIndex) % FEVER_COLORS.length],
          life: duration, duration, trail: random(25, 50) });
      }
      this.add({ kind: 'ring', ...origin, color: FEVER_COLORS[originIndex],
        radius: 10, expand: 210, life: 0.8, duration: 0.8, width: 3 });
      this.add({ kind: 'ring', ...origin, color: FEVER_COLORS[(originIndex + 1) % FEVER_COLORS.length],
        radius: 5, expand: 145, life: 0.65, duration: 0.65, width: 1.6 });
    });
    if (type === 'start' || type === 'complete') this.onShake();
  }

  add(particle) {
    const cap = this.intensity === 'max' ? (this.theme === 'fever' ? 360 : 220) : 100;
    if (this.particles.length >= cap) this.particles.shift();
    this.particles.push(particle);
  }

  startFrames() {
    if (this.rafId !== null || !this.particles.length || this.destroyed) return;
    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  render(time) {
    this.rafId = null;
    if (this.destroyed || !this.ctx) return;
    const elapsed = Math.max(0, (time - this.lastFrame) / 1000);
    const step = Math.min(elapsed, 0.05);
    this.lastFrame = time;
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.particles = this.particles.filter((particle) => {
      // Full elapsed time expires particles after a background tab resumes.
      particle.life -= elapsed;
      if (particle.life <= 0) return false;
      if (!particle.static) {
        particle.x += (particle.vx || 0) * step;
        particle.y += (particle.vy || 0) * step;
        particle.vy = (particle.vy || 0) + (particle.gravity || 0) * step;
        if (particle.drag) particle.vx *= Math.exp(-particle.drag * step);
        particle.angle = (particle.angle || 0) + (particle.spin || 0) * step;
        particle.radius += (particle.expand || 0) * step;
      }
      this.drawParticle(particle);
      return true;
    });
    if (this.particles.length) this.rafId = requestAnimationFrame(this.frame);
    else this.lastFrame = null;
  }

  drawParticle(p) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = p.static ? 0.55 : Math.min(1, p.life / Math.min(p.duration * 0.55, 0.4));
    ctx.fillStyle = p.color;
    ctx.strokeStyle = p.color;
    if (p.kind === 'ring' || p.kind === 'bubble') {
      ctx.lineWidth = p.width || 2;
      ctx.beginPath();
      ctx.arc(0, 0, p.radius, 0, TAU);
      ctx.stroke();
    } else if (p.kind === 'comet') {
      // Three inexpensive strokes form a luminous tail without shadow-blur passes.
      const speed = Math.hypot(p.vx, p.vy) || 1;
      const tailX = -p.vx / speed * p.trail;
      const tailY = -p.vy / speed * p.trail;
      const alpha = ctx.globalAlpha;
      ctx.lineCap = 'round';
      ctx.globalAlpha = alpha * 0.16;
      ctx.lineWidth = p.radius * 3.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
      ctx.globalAlpha = alpha * 0.65;
      ctx.lineWidth = p.radius * 1.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(tailX * 0.7, tailY * 0.7);
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = Math.max(1, p.radius * 0.45);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(tailX * 0.25, tailY * 0.25);
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(0, 0, p.radius * 0.55, 0, TAU);
      ctx.fill();
    } else if (p.kind === 'attention-marker') {
      ctx.lineWidth = 2.3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(0, -p.radius);
      ctx.lineTo(p.radius, p.radius * 0.8);
      ctx.lineTo(-p.radius, p.radius * 0.8);
      ctx.closePath();
      ctx.stroke();
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, -p.radius * 0.35);
      ctx.lineTo(0, p.radius * 0.15);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, p.radius * 0.46, 1.6, 0, TAU);
      ctx.fill();
    } else if (p.kind === 'streak' || p.kind === 'attention-streak') {
      const speed = Math.hypot(p.vx, p.vy) || 1;
      const length = p.trail || p.radius * 4;
      ctx.lineWidth = p.kind === 'attention-streak' ? p.radius : 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-p.vx / speed * length, -p.vy / speed * length);
      ctx.stroke();
    } else if (p.kind === 'star') {
      ctx.rotate(p.angle);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const radius = i % 2 ? p.radius * 0.3 : p.radius;
        const angle = i * Math.PI / 4;
        if (i === 0) ctx.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
        else ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.rotate(p.angle);
      ctx.fillRect(-p.radius / 2, -p.radius, p.radius, p.radius * 2);
    }
    ctx.restore();
  }

  playSound(type) {
    if (this.destroyed || !this.soundEnabled || (type !== 'detect' && !Object.hasOwn(SOUND_SEQUENCES, type))) return false;
    if (this.audioContext?.state !== 'running') {
      // Retain just one action while the first user gesture unlocks Web Audio.
      if (this.audioUnlockPending && this.pendingSound !== 'detect') this.pendingSound = type;
      return false;
    }
    const context = this.audioContext;
    if (type !== 'detect' && this.activeSound === 'detect' && context.currentTime < this.audioBusyUntil) return false;
    // Replace notes instead of accumulating loud chords. Only alarms preempt alarms.
    this.stopAudio();
    try {
      if (type === 'detect' && !this.warningBuffer) this.warningBuffer = createWarningBuffer(context);
      const now = context.currentTime + 0.008;
      this.activeSound = type;
      if (type === 'detect') {
        const oscillator = context.createBufferSource();
        const envelope = context.createGain();
        oscillator.buffer = this.warningBuffer;
        oscillator.loop = false;
        envelope.gain.value = WARNING_GAIN;
        oscillator.connect(envelope);
        envelope.connect(context.destination);
        const node = { oscillator, envelope };
        this.audioNodes.add(node);
        oscillator.onended = () => {
          oscillator.disconnect();
          envelope.disconnect();
          this.audioNodes.delete(node);
          if (!this.audioNodes.size) {
            this.activeSound = null;
            this.audioBusyUntil = 0;
          }
        };
        this.audioBusyUntil = now + this.warningBuffer.duration;
        oscillator.start(now);
        oscillator.stop(this.audioBusyUntil);
        return true;
      }
      this.audioBusyUntil = now + Math.max(...SOUND_SEQUENCES[type].map(([, offset, duration]) => offset + duration + 0.025));
      for (const [frequency, offset, duration] of SOUND_SEQUENCES[type]) {
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        const start = now + offset;
        oscillator.type = ['notify', 'break', 'end'].includes(type) ? 'sine' : 'triangle';
        oscillator.frequency.value = frequency;
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(type === 'notify' ? 0.34 : 0.65, start + 0.012);
        envelope.gain.exponentialRampToValueAtTime(0.001, start + duration);
        envelope.gain.setValueAtTime(0, start + duration + 0.012);
        oscillator.connect(envelope);
        envelope.connect(this.masterGain);
        const node = { oscillator, envelope };
        this.audioNodes.add(node);
        oscillator.onended = () => {
          oscillator.disconnect();
          envelope.disconnect();
          this.audioNodes.delete(node);
          if (!this.audioNodes.size) {
            this.activeSound = null;
            this.audioBusyUntil = 0;
          }
        };
        oscillator.start(start);
        oscillator.stop(start + duration + 0.025);
      }
      return true;
    } catch {
      this.stopAudio();
      return false;
    }
  }

  stopAudio() {
    this.pendingSound = null;
    this.activeSound = null;
    this.audioBusyUntil = 0;
    for (const { oscillator, envelope } of this.audioNodes) {
      oscillator.onended = null;
      try { oscillator.stop(); } catch { /* Already stopped, or context unavailable. */ }
      try { oscillator.disconnect(); } catch { /* Detached by the audio implementation. */ }
      try { envelope.disconnect(); } catch { /* Detached by the audio implementation. */ }
    }
    this.audioNodes.clear();
  }

  clear({ audio = true } = {}) {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.lastFrame = null;
    this.particles.length = 0;
    this.ctx?.clearRect(0, 0, this.width, this.height);
    if (audio) this.stopAudio();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.soundEnabled = false;
    ++this.audioRequest;
    this.clear();
    window.removeEventListener('resize', this.handleResize);
    if (this.motionQuery?.removeEventListener) {
      this.motionQuery.removeEventListener('change', this.handleMotion);
    } else {
      this.motionQuery?.removeListener?.(this.handleMotion);
    }
    this.masterGain?.disconnect();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { Promise.resolve(this.audioContext.close()).catch(() => {}); } catch { /* Unsupported closure. */ }
    }
  }
}
