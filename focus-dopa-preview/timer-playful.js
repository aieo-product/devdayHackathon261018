const SVG_NS = 'http://www.w3.org/2000/svg';
const clamp = (number, low, high) => Math.max(low, Math.min(high, number));

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgElement(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

/** A decorative view of the existing countdown. It owns no clock or intervals. */
export class PlayfulTimer {
  constructor(stageElement) {
    this.stage = stageElement;
    this.timer = stageElement?.querySelector('#timer');
    if (!this.timer) throw new TypeError('PlayfulTimer needs a stage containing #timer.');
    this.animations = new Set();
    this.digitAnimations = new Map();
    this.lastSecond = null;
    this.stage.classList.add('pt-stage');
    this.stage.dataset.ptMotion = 'off';
    this.timer.classList.add('pt-clock');
    this.timer.setAttribute('role', 'timer');
    this.timer.setAttribute('aria-live', 'off');

    this.minuteGroup = element('span', 'pt-number-group pt-minutes');
    this.secondGroup = element('span', 'pt-number-group pt-seconds');
    const colon = element('span', 'pt-colon');
    colon.append(element('i', 'pt-colon-dot'), element('i', 'pt-colon-dot'));
    for (const node of [this.minuteGroup, colon, this.secondGroup]) node.setAttribute('aria-hidden', 'true');
    this.digits = [];
    for (let index = 0; index < 5; index++) {
      const slot = element('span', `pt-digit${index === 0 ? ' pt-leading' : ''}`);
      const glyph = element('span', 'pt-digit-glyph', '0');
      slot.append(glyph);
      (index < 3 ? this.minuteGroup : this.secondGroup).append(slot);
      this.digits.push({ slot, glyph });
    }
    this.digits[0].slot.hidden = true;
    this.timer.replaceChildren(this.minuteGroup, colon, this.secondGroup);

    const texture = element('div', 'pt-inner-texture');
    texture.setAttribute('aria-hidden', 'true');
    this.tag = element('span', 'pt-tag', 'YOUR TIME. YOUR PACE.');
    this.tag.setAttribute('aria-hidden', 'true');
    const dial = svgElement('svg', { class: 'pt-dial', viewBox: '0 0 440 440', 'aria-hidden': 'true' });
    const ticks = svgElement('g', { class: 'pt-ticks' });
    for (let index = 0; index < 60; index++) {
      const major = index % 5 === 0;
      const angle = index / 60 * Math.PI * 2 - Math.PI / 2;
      const inner = major ? 207 : 211;
      ticks.append(svgElement('line', {
        class: major ? 'pt-tick pt-tick-major' : 'pt-tick pt-tick-minor',
        x1: 220 + inner * Math.cos(angle), y1: 220 + inner * Math.sin(angle),
        x2: 220 + 217 * Math.cos(angle), y2: 220 + 217 * Math.sin(angle),
      }));
    }
    this.marker = svgElement('g', { class: 'pt-marker' });
    this.marker.append(
      svgElement('circle', { class: 'pt-marker-base', r: 13 }),
      svgElement('path', { class: 'pt-marker-star', d: 'M0-8.5 2.4-2.4 8.5 0 2.4 2.4 0 8.5-2.4 2.4-8.5 0-2.4-2.4Z' }),
      svgElement('path', { class: 'pt-marker-bolt', d: 'M1.5-9-6 1H-1L-2.5 9 6-2H1Z' }),
    );
    dial.append(ticks, this.marker);
    this.stage.append(texture, dial, this.tag);
  }

  update({ remaining, ratio, status, duration, intensity = 'pop', reduced = false }) {
    const maximum = Number.isFinite(duration) ? Math.max(0, duration) : Infinity;
    const time = Number.isFinite(remaining) ? clamp(remaining, 0, maximum) : 0;
    const second = Math.ceil(time);
    const fraction = Number.isFinite(ratio) ? clamp(ratio, 0, 1) : (maximum > 0 ? time / maximum : 0);
    const canAnimate = status === 'running' && intensity !== 'off' && !reduced && !document.hidden;
    const mode = canAnimate ? 'on' : 'off';
    if (this.stage.dataset.ptMotion !== mode) this.stage.dataset.ptMotion = mode;
    if (this.stage.dataset.ptState !== status) this.stage.dataset.ptState = status;
    if (!canAnimate) this.clear();

    if (second !== this.lastSecond) {
      const minutes = Math.floor(second / 60);
      const seconds = second % 60;
      const characters = `${minutes.toString().padStart(3, '0')}${seconds.toString().padStart(2, '0')}`;
      this.digits[0].slot.hidden = minutes < 100;
      this.timer.classList.toggle('pt-clock-long', minutes >= 100);
      this.timer.setAttribute('aria-label', `残り ${minutes} 分 ${seconds} 秒`);
      this.digits.forEach(({ glyph, slot }, index) => {
        if (glyph.textContent === characters[index]) return;
        glyph.textContent = characters[index];
        if (canAnimate && this.lastSecond !== null && !slot.hidden && typeof glyph.animate === 'function') {
          this.digitAnimations.get(glyph)?.cancel();
          const lift = intensity === 'max' ? 3 : 2;
          const animation = glyph.animate([
            { transform: `translateY(${lift}px) scale(.98)`, opacity: 0.76 },
            { transform: 'translateY(-.5px) scale(1.01)', opacity: 1, offset: 0.62 },
            { transform: 'translateY(0) scale(1)', opacity: 1 },
          ], { duration: 220, easing: 'cubic-bezier(.2,.8,.3,1)' });
          this.animations.add(animation);
          this.digitAnimations.set(glyph, animation);
          animation.finished.catch(() => {}).finally(() => {
            this.animations.delete(animation);
            if (this.digitAnimations.get(glyph) === animation) this.digitAnimations.delete(glyph);
          });
        }
      });
      this.lastSecond = second;
    }

    // The same 192-unit radius and twelve-o'clock origin as the app's own ring.
    const angle = fraction * Math.PI * 2 - Math.PI / 2;
    this.marker.setAttribute('transform', `translate(${220 + 192 * Math.cos(angle)} ${220 + 192 * Math.sin(angle)})`);
    this.marker.setAttribute('visibility', fraction > 0 ? 'visible' : 'hidden');
    const tag = {
      ready: 'READY, SET, FOCUS!', running: 'YOUR TIME. YOUR PACE.',
      paused: 'TAKE YOUR TIME.', break: 'A LITTLE BREATH.',
      ended: 'SEE YOU NEXT TIME.', completed: 'YOU SHOWED UP!',
    }[status] || 'YOUR TIME. YOUR PACE.';
    if (this.tag.textContent !== tag) this.tag.textContent = tag;
  }

  clear() {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    this.digitAnimations.clear();
  }
}
