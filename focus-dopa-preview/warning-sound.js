const DURATION = 4;
const PERIOD = 0.72;
const TAU = Math.PI * 2;

export const WARNING_GAIN = 1.5;

/** The selected four-second patrol siren, generated locally without an audio download. */
export function createWarningBuffer(context) {
  const rate = context.sampleRate;
  const buffer = context.createBuffer(1, Math.round(rate * DURATION), rate);
  const samples = buffer.getChannelData(0);
  let phase = 0, peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const time = i / rate;
    const high = Math.floor(time / PERIOD) % 2 === 0;
    const target = high ? 960 : 640;
    const previous = high ? 640 : 960;
    const fraction = Math.min(1, (time % PERIOD) / 0.035);
    const transition = fraction * fraction * (3 - 2 * fraction);
    const frequency = previous + (target - previous) * transition;
    phase += TAU * frequency / rate;
    const tone = Math.sin(phase) + 0.20 * Math.sin(3 * phase) + 0.07 * Math.sin(5 * phase);
    const envelope = Math.max(0, Math.min(1, time / 0.03, (DURATION - time) / 0.12));
    samples[i] = tone * envelope;
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  if (peak > 0) {
    const scale = 0.28 / peak;
    for (let i = 0; i < samples.length; i++) samples[i] *= scale;
  }
  return buffer;
}
