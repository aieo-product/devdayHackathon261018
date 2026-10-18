import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFocusApiProxy, loadFocusConfig, validLocalHost } from './focus-api-proxy.mjs';
import { createDesktopOverlayBridge } from './desktop-overlay-bridge.mjs';

const defaultRoot = fileURLToPath(new URL('.', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function inside(directory, target) {
  const relative = path.relative(directory, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size === 0 || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
      || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function safeStaticPath(relative) {
  const parts = relative.split(/[\\/]/);
  if (parts.some(part => part.startsWith('.'))) return false;
  const name = parts.at(-1).toLowerCase();
  if (/^(?:server|focus-api-proxy)(?:\.|$)|(?:^|[._-])(?:env|secret|config)(?:[._-]|$)/.test(name)) return false;
  return Object.hasOwn(types, path.extname(name)) && path.extname(name) !== '.json';
}

export function createPreviewServer({ directory = defaultRoot, focusConfig, fetchImpl, timeoutMs, desktopBridge } = {}) {
  const root = path.resolve(directory);
  const bridge = desktopBridge ?? createDesktopOverlayBridge({ token: randomBytes(32).toString('hex') });
  const proxyReady = Promise.resolve(focusConfig ?? loadFocusConfig({ directory: root }))
    .then(config => createFocusApiProxy({ ...config, fetchImpl, timeoutMs })).catch(() => null);
  return http.createServer(async (req, res) => {
    const empty = (status, headers = {}) => res.writeHead(status, { 'Content-Length': 0, 'Cache-Control': 'no-store', ...headers }).end();
    if (!validLocalHost(req)) { empty(403); return; }
    let pathname;
    let search;
    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
      search = url.search;
      if (pathname.includes('\0')) throw new Error('Invalid path');
    } catch {
      empty(400);
      return;
    }
    if (await bridge.handle(req, res, pathname)) return;
    if (pathname === '/api/focus' || pathname.startsWith('/api/focus/')) {
      try { await (await proxyReady)(req, res, pathname, search); }
      catch { res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"error":{"code":"service_not_configured","message":"API設定を確認してください。"}}'); }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { empty(405, { Allow: 'GET, HEAD' }); return; }
    const target = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!inside(root, target) || !safeStaticPath(path.relative(root, target))) {
      empty(403);
      return;
    }
    try {
      const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
      if (!inside(canonicalRoot, canonicalTarget) || !safeStaticPath(path.relative(canonicalRoot, canonicalTarget))) {
        empty(403);
        return;
      }
      const file = await stat(canonicalTarget);
      if (!file.isFile()) {
        empty(404);
        return;
      }
      const headers = {
        'Content-Type': types[path.extname(canonicalTarget).toLowerCase()] || 'application/octet-stream',
        'Content-Length': file.size,
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
      };
      // HTTP ranges apply to GET; HEAD describes the complete representation.
      const rangeHeader = req.method === 'GET' ? req.headers.range : undefined;
      let range;
      if (rangeHeader !== undefined) {
        range = byteRange(rangeHeader, file.size);
        if (!range) {
          empty(416, { 'Content-Range': `bytes */${file.size}`, 'Accept-Ranges': 'bytes' });
          return;
        }
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.size}`;
        headers['Content-Length'] = range.end - range.start + 1;
      }
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD' || file.size === 0) {
        res.end();
        return;
      }
      const stream = createReadStream(canonicalTarget, range || undefined);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) empty(404);
      else res.destroy();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.FOCUS_PREVIEW_PORT || 4327);
  const token = randomBytes(32).toString('hex');
  const desktopBridge = createDesktopOverlayBridge({ token });
  createPreviewServer({ desktopBridge }).listen(port, '127.0.0.1', async () => {
    const bridgePath = path.resolve(defaultRoot, '../.focus-overlay-bridge.json');
    await writeFile(bridgePath, JSON.stringify({ url: `http://127.0.0.1:${port}`, token }), { mode: 0o600 });
    await chmod(bridgePath, 0o600);
    console.log(`Focus motion preview: http://127.0.0.1:${port}`);
  });
}
