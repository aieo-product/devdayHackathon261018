import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveViewMode, applyViewMode } from '../view-mode.js';

test('normal URLs stay in the real API experience unless demo mode is explicitly enabled', () => {
  for (const suffix of ['', '?demo=0', '?demo=true', '?showcase=0', '?pattern=fever', '?next=demo%3D1']) {
    assert.equal(resolveViewMode(`https://focus.example/${suffix}`).demo, false);
  }
});

test('demo and legacy showcase URLs opt into the same isolated presentation', () => {
  for (const query of ['?demo=1', '?showcase=1', '?demo=0&showcase=1']) {
    assert.equal(resolveViewMode(`https://focus.example/${query}`).demo, true);
  }
  assert.equal(resolveViewMode('https://focus.example/?demo=1&showcase=1&pattern=fever#timer').normalHref, '/?pattern=fever#timer');
});

test('mode application hides demo controls on normal pages and real API panels on demo pages', () => {
  const demoElements = [{ hidden: true }, { hidden: true }];
  const liveElements = [{ hidden: false }, { hidden: false }];
  const link = { setAttribute(name, value) { this[name] = value; } };
  const document = {
    body: { dataset: {} },
    querySelectorAll: selector => selector === '[data-demo-only]' ? demoElements : liveElements,
    getElementById: () => link,
  };
  applyViewMode(document, resolveViewMode('https://focus.example/'));
  assert.ok(demoElements.every(element => element.hidden));
  assert.ok(liveElements.every(element => !element.hidden));
  assert.equal(document.body.dataset.demoView, 'false');
  applyViewMode(document, resolveViewMode('https://focus.example/?demo=1'));
  assert.ok(demoElements.every(element => !element.hidden));
  assert.ok(liveElements.every(element => element.hidden));
  assert.equal(document.body.dataset.demoView, 'true');
  assert.equal(link.href, '/');
});

test('all manual demo surfaces are hidden in the initial HTML before JavaScript runs', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['demo-mode-banner', 'action-showcase', 'test-notification', 'test-desktop-overlay', 'simulate-detection']) {
    const openingTag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0];
    assert.ok(openingTag, id);
    assert.match(openingTag, /\bdata-demo-only\b/, id);
    assert.match(openingTag, /\bhidden\b/, id);
  }
  for (const className of ['lyric-showcase', 'fever-banner', 'playground', 'page-footer']) {
    const openingTag = html.match(new RegExp(`<[^>]+class="${className}"[^>]*>`))?.[0];
    assert.match(openingTag, /\bdata-demo-only\b/);
    assert.match(openingTag, /\bhidden\b/);
  }
  assert.match(html, /<label hidden>モード <select id="api-mode"/);
  assert.equal((html.match(/id="intensity"/g) || []).length, 1);
});
