import { LyricMotion } from './lyric-motion.js';
import { getCharacterProfile } from './character-profiles.js';

const lyric = new LyricMotion(document.getElementById('desktop-lyric'));
const banner = document.getElementById('desktop-message');
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
let active = null;
let timer = null;
const native = (name, value) => window.webkit?.messageHandlers?.[name]?.postMessage(value);

function clear() {
  const previous = active;
  active = null;
  clearTimeout(timer);
  timer = null;
  lyric.clear();
  banner.hidden = true;
  if (previous) native('overlayFinished', { sequence: previous.sequence, sourceId: previous.sourceId });
}

window.focusOverlay = Object.freeze({
  clear,
  play(event) {
    clear();
    if (!event || event.action !== 'detect' || event.reduced || reduce.matches || event.intensity === 'off') {
      if (event) native('overlayFinished', { sequence: event.sequence, sourceId: event.sourceId });
      return;
    }
    active = event;
    lyric.setCharacter(getCharacterProfile(event.character));
    document.getElementById('desktop-label').textContent = event.kind === 'test' ? 'FOCUS! / 表示テスト' : 'FOCUS! / 集中に戻ろう';
    document.getElementById('desktop-copy').textContent = String(event.message || 'いまの作業に戻ろう！').slice(0, 500);
    banner.hidden = false;
    lyric.play({ kind: 'detect', intensity: event.intensity === 'pop' ? 'pop' : 'max' });
    timer = setTimeout(clear, event.intensity === 'pop' ? 1900 : 4600);
  },
});
reduce.addEventListener('change', clear);
window.addEventListener('pagehide', clear);
await Promise.all(Object.values(lyric.cards).map(card => card.ready));
native('overlayReady', { ready: true });
