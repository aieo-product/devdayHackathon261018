/** Demo UI is opt-in by URL; normal sessions always use the authenticated API. */
export function resolveViewMode(href) {
  const url = new URL(href);
  const demo = url.searchParams.get('demo') === '1' || url.searchParams.get('showcase') === '1';
  url.searchParams.delete('demo');
  url.searchParams.delete('showcase');
  return { demo, normalHref: `${url.pathname}${url.search}${url.hash}` };
}

export function applyViewMode(document, mode) {
  document.body.dataset.demoView = String(mode.demo);
  for (const element of document.querySelectorAll('[data-demo-only]')) element.hidden = !mode.demo;
  for (const element of document.querySelectorAll('[data-live-only]')) element.hidden = mode.demo;
  const returnLink = document.getElementById('demo-return');
  if (returnLink) returnLink.setAttribute('href', mode.normalHref);
}
