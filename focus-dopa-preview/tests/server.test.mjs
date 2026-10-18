import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPreviewServer } from '../server.mjs';

test('video server supports seeking, metadata HEAD requests, and confines file access', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'focus-video-test-'));
  const directory = path.join(temporary, 'public');
  await mkdir(directory);
  await Promise.all([
    writeFile(path.join(directory, 'clip.mp4'), '0123456789'),
    writeFile(path.join(directory, 'clip.webm'), 'webm'),
    writeFile(path.join(directory, 'empty.mp4'), ''),
    writeFile(path.join(directory, 'index.html'), '<h1>Preview</h1>'),
    writeFile(path.join(temporary, 'outside.txt'), 'private'),
  ]);
  await symlink(path.join(temporary, 'outside.txt'), path.join(directory, 'escape.mp4'));
  const server = createPreviewServer({ directory });
  t.after(async () => {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(temporary, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  await t.test('serves correct MIME and full-file metadata without a HEAD body', async () => {
    const mp4 = await fetch(`${base}/clip.mp4`, { method: 'HEAD' });
    assert.equal(mp4.status, 200);
    assert.equal(mp4.headers.get('content-type'), 'video/mp4');
    assert.equal(mp4.headers.get('content-length'), '10');
    assert.equal(mp4.headers.get('accept-ranges'), 'bytes');
    assert.equal(await mp4.text(), '');
    const webm = await fetch(`${base}/clip.webm`);
    assert.equal(webm.headers.get('content-type'), 'video/webm');
    assert.equal(await webm.text(), 'webm');
    const index = await fetch(base);
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await index.text(), '<h1>Preview</h1>');
  });

  await t.test('returns exact, open-ended, suffix, and clamped ranges', async () => {
    for (const [range, contentRange, body] of [
      ['bytes=2-5', 'bytes 2-5/10', '2345'],
      ['bytes=7-', 'bytes 7-9/10', '789'],
      ['bytes=-3', 'bytes 7-9/10', '789'],
      ['bytes=-50', 'bytes 0-9/10', '0123456789'],
      ['bytes=8-50', 'bytes 8-9/10', '89'],
    ]) {
      const response = await fetch(`${base}/clip.mp4`, { headers: { Range: range } });
      assert.equal(response.status, 206, range);
      assert.equal(response.headers.get('content-range'), contentRange, range);
      assert.equal(response.headers.get('content-length'), String(body.length), range);
      assert.equal(await response.text(), body, range);
    }
  });

  await t.test('returns 416 with total size for unsatisfiable or unsupported ranges', async () => {
    for (const range of ['bytes=10-', 'bytes=6-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4']) {
      const response = await fetch(`${base}/clip.mp4`, { headers: { Range: range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get('content-range'), 'bytes */10');
      assert.equal(await response.text(), '');
    }
    const empty = await fetch(`${base}/empty.mp4`, { headers: { Range: 'bytes=0-' } });
    assert.equal(empty.status, 416);
    assert.equal(empty.headers.get('content-range'), 'bytes */0');
  });

  await t.test('ignores Range on HEAD and never returns a response body', async () => {
    const response = await fetch(`${base}/clip.mp4`, { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), '10');
    assert.equal(await response.text(), '');
  });

  await t.test('rejects encoded traversal, escaping symlinks, and malformed paths', async () => {
    assert.equal((await fetch(`${base}/..%2foutside.txt`)).status, 403);
    assert.equal((await fetch(`${base}/escape.mp4`)).status, 403);
    assert.equal((await fetch(`${base}/%ZZ`)).status, 400);
    assert.equal((await fetch(`${base}/%00`)).status, 400);
    assert.equal((await fetch(`${base}/missing.mp4`)).status, 404);
    const post = await fetch(`${base}/clip.mp4`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });
});
