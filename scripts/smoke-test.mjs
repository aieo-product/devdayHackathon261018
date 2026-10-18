import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { FocusClient } from '../clients/focus-client.mjs';

const args = process.argv.slice(2);
const flags = new Set(['--allow-live', '--expect-notify', '--image']);
let imagePath;
for (let i = 0; i < args.length; i += 1) {
  if (!flags.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] === '--image') {
    imagePath = args[++i];
    if (!imagePath || imagePath.startsWith('--')) throw new Error('--image requires a path');
  }
}
const baseUrl = (process.env.FOCUS_API_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const token = process.env.FOCUS_API_TOKEN;
if (!token) throw new Error('Set FOCUS_API_TOKEN (or api/.env).');
const healthResponse = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(5000), redirect: 'error' });
assert.equal(healthResponse.status, 200, 'health HTTP status');
const health = await healthResponse.json();
assert.ok(['mock', 'openai'].includes(health.provider), 'known provider');
assert.equal(health.configured, true, 'provider must be configured');
if (health.provider === 'openai' && (!args.includes('--allow-live') || !imagePath)) {
  throw new Error('Live calls send your image to OpenAI and incur API usage. Supply --allow-live --image /path/test.jpg intentionally.');
}
const bytes = imagePath ? await readFile(imagePath) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jyaUAAAAASUVORK5CYII=', 'base64');
const mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/png';
const image = new Blob([bytes], { type: mime });
const client = new FocusClient({ baseUrl, token });
let started = false;
let notifications = 0;
try {
  await client.start({ deviceType: 'cores3', durationSeconds: 120 });
  started = true;
  console.log(`provider=${health.provider}; session created; ${imagePath ? 'supplied image' : 'synthetic fixture (MOCK only)'}`);
  let waitMs = 0;
  for (let i = 1; i <= 3; i += 1) {
    await sleep(waitMs);
    const result = await client.frame(image, { frameId: `smoke-${i}` });
    assert.ok(result, 'frame result');
    assert.equal(result.provider, health.provider, 'provider stays explicit');
    if (result.notify) notifications += 1;
    console.log(`frame ${i}: ${result.state}, notify=${result.notify}, reason=${result.reason}`);
    waitMs = Math.max(3000, result.next_capture_after_ms) + 50;
  }
  if (args.includes('--expect-notify')) assert.equal(notifications, 1, 'exactly one notification after 3 positive frames');
  const duplicate = await client.frame(image, { frameId: 'smoke-3' });
  assert.equal(duplicate.notify, false, 'duplicate frame cannot notify again');
  assert.equal((await client.pause()).state, 'paused');
  assert.equal(await client.frame(image), null, 'paused client sends no image');
  assert.ok(await client.resume());
  assert.equal((await client.end()).state, 'ended');
  started = false;
  console.log('PASS: create → 3 frames → duplicate → pause → resume → end');
} finally {
  if (started) await client.end().catch(() => {});
}
