/** One replaceable, cancellable notification; API deduplication stays in the client. */
export class NotificationToast {
  constructor(element) {
    this.element = element;
    this.animations = new Set();
    this.timer = null;
    this.generation = 0;
    element.querySelector('#close-toast').addEventListener('click', () => this.hide());
  }

  animate(element, frames, options) {
    const animation = element.animate(frames, options);
    this.animations.add(animation);
    animation.finished.catch(() => {}).finally(() => this.animations.delete(animation));
    return animation;
  }

  show({ message, profile, kind = 'detect', source = '', motion = true }) {
    this.hide({ immediate: true });
    const generation = this.generation;
    const el = this.element;
    this.motion = motion;
    el.querySelector('#toast-character-image').src = profile.asset;
    el.querySelector('#toast-title').textContent = kind === 'test' ? 'ここでも、見守ってるよ！' : 'いまの作業に戻ろう！';
    el.querySelector('#toast-kicker').textContent = kind === 'test' ? 'FOCUS! / TOAST TEST' : 'FOCUS! / BACK TO YOUR TASK';
    el.querySelector('#toast-message').textContent = message;
    el.querySelector('#toast-source').textContent = source;
    el.style.setProperty('--toast-accent', profile.color);
    el.style.setProperty('--toast-duration', '8000ms');
    el.dataset.kind = kind;
    el.dataset.motion = motion ? 'on' : 'off';
    el.hidden = false;
    document.body.dataset.toast = 'visible';
    if (motion) {
      this.animate(el, [
        { opacity: 0, transform: 'translate(65px,24px) scale(.84)' },
        { opacity: 1, transform: 'translate(-9px,-5px) scale(1.03)', offset: .7 },
        { opacity: 1, transform: 'translate(0,0) scale(1)' }
      ], { duration: 560, easing: 'cubic-bezier(.2,.7,.3,1)' });
      this.animate(el.querySelector('.toast-character'), [
        { transform: 'translateY(0) rotate(0)' },
        { transform: 'translateY(-12px) rotate(-10deg)', offset: .28 },
        { transform: 'translateY(0) rotate(8deg)', offset: .55 },
        { transform: 'translateY(-6px) rotate(-4deg)', offset: .78 },
        { transform: 'translateY(0) rotate(0)' }
      ], { duration: 1250, iterations: 3, easing: 'ease-in-out' });
    }
    this.timer = setTimeout(() => {
      if (generation === this.generation) this.hide();
    }, 8000);
  }

  hide({ immediate = false } = {}) {
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.timer = null;
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    const finish = () => {
      if (generation !== this.generation) return;
      this.element.hidden = true;
      delete this.element.dataset.leaving;
      delete document.body.dataset.toast;
    };
    if (immediate || this.element.hidden || !this.motion) { finish(); return; }
    this.element.dataset.leaving = 'true';
    const exit = this.animate(this.element, [
      { opacity: 1, transform: 'translateX(0)' },
      { opacity: 0, transform: 'translateX(45px)' }
    ], { duration: 200, easing: 'ease-in', fill: 'forwards' });
    exit.finished.then(() => { finish(); exit.cancel(); }).catch(() => {});
  }
}
