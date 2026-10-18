const viewBox = '0 0 1200 900';
const textSafeArea = Object.freeze({ x: 240, y: 320, width: 720, height: 465 });

/** Broad central silhouettes leave the lyric text area unobstructed. */
export const CHARACTER_PROFILES = Object.freeze([
  Object.freeze({
    id: 'green', name: 'DOTS', label: 'ライム', description: 'ぷにっと弾む、集中の相棒',
    asset: './assets/todd.png', color: '#CEFF34',
    alt: '大きな丸い目と黒い蝶ネクタイのライム色のDOTS', viewBox, textSafeArea,
    silhouette: 'M160 315 C105 290 105 225 175 205 C170 105 225 45 320 45 C420 45 470 105 465 210 C545 185 655 185 735 210 C730 105 780 45 880 45 C975 45 1030 105 1025 205 C1095 225 1095 290 1040 315 C1130 400 1150 505 1120 640 C1090 800 1020 865 890 875 L310 875 C180 865 110 800 80 640 C50 505 70 400 160 315 Z',
  }),
]);

// Old character URLs also return to the original DOTS.
export function getCharacterProfile() {
  return CHARACTER_PROFILES[0];
}

/** Call once the supplied character assets are present. */
export function setupCharacterPicker({ onChange = () => {} } = {}) {
  const container = document.getElementById('character-picker');
  const mascotImage = document.querySelector('#mascot img');
  if (!container || !mascotImage) {
    throw new TypeError('Character picker requires #character-picker and #mascot img.');
  }
  container.classList.add('character-picker');
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', '集中の相棒 DOTS');
  const buttons = new Map();
  const listeners = [];
  let current = null;

  function select(id) {
    const profile = getCharacterProfile(id);
    if (current?.id === profile.id) return profile;
    current = profile;
    document.body.dataset.character = profile.id;
    mascotImage.setAttribute('src', profile.asset);
    mascotImage.setAttribute('alt', profile.alt);
    for (const [buttonId, button] of buttons) {
      const selected = buttonId === profile.id;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    const url = new URL(window.location.href);
    url.searchParams.set('character', profile.id);
    window.history.replaceState(window.history.state, '', url);
    onChange(profile);
    return profile;
  }

  const fragment = document.createDocumentFragment();
  for (const profile of CHARACTER_PROFILES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'character-choice';
    button.dataset.characterChoice = profile.id;
    button.setAttribute('aria-label', `${profile.name}、${profile.label}、${profile.description}を選ぶ`);
    button.setAttribute('aria-pressed', 'false');
    button.style.setProperty('--character-color', profile.color);

    const thumbnail = document.createElement('span');
    thumbnail.className = 'character-thumbnail';
    thumbnail.setAttribute('aria-hidden', 'true');
    const image = document.createElement('img');
    image.src = profile.asset;
    image.alt = '';
    image.decoding = 'async';
    image.draggable = false;
    thumbnail.append(image);

    const copy = document.createElement('span');
    copy.className = 'character-copy';
    const name = document.createElement('strong');
    name.textContent = profile.name;
    const label = document.createElement('small');
    label.textContent = profile.label;
    const detail = document.createElement('span');
    detail.className = 'character-detail';
    detail.textContent = profile.description;
    copy.append(name, label, detail);

    const selected = document.createElement('span');
    selected.className = 'character-check';
    selected.textContent = '✓';
    selected.setAttribute('aria-hidden', 'true');
    button.append(thumbnail, copy, selected);
    const listener = () => select(profile.id);
    button.addEventListener('click', listener);
    listeners.push([button, listener]);
    buttons.set(profile.id, button);
    fragment.append(button);
  }
  container.replaceChildren(fragment);
  select(new URL(window.location.href).searchParams.get('character'));

  return {
    get current() { return current; },
    select,
    destroy() {
      for (const [button, listener] of listeners) button.removeEventListener('click', listener);
    },
  };
}
