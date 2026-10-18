/** Plays a cancellable sequence of presentation cues without changing session state. */
export class ActionShowcase {
  constructor({ onStep = () => {}, onFinish = () => {}, setTimer = globalThis.setTimeout.bind(globalThis), clearTimer = globalThis.clearTimeout.bind(globalThis) } = {}) {
    this.onStep = onStep;
    this.onFinish = onFinish;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.active = false;
    this.timer = null;
    this.generation = 0;
    this.index = -1;
  }

  play(steps) {
    this.stop();
    const generation = this.generation;
    const sequence = [...steps];
    this.active = true;

    const advance = (index) => {
      if (!this.active || generation !== this.generation) return;
      this.timer = null;
      this.index = index;
      if (index === sequence.length) {
        this.active = false;
        this.onFinish();
        return;
      }

      const step = sequence[index];
      this.onStep(step, index, sequence.length);
      // A cue callback can stop the tour or start a new one synchronously.
      if (!this.active || generation !== this.generation) return;
      this.timer = this.setTimer(() => {
        if (this.index !== index) return;
        advance(index + 1);
      }, Math.max(0, Number(step.duration) || 0));
    };

    advance(0);
  }

  stop() {
    this.generation += 1;
    this.active = false;
    this.index = -1;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
