import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local dependencies are preferred; global Wrangler installations support offline runs.
const require = createRequire(import.meta.url);
function dependency(name) {
  try { return require(name); } catch {}
  return require(`${process.env.WRANGLER_NODE_MODULES || '/opt/homebrew/lib/node_modules/wrangler/node_modules'}/${name}`);
}
const { Miniflare, convertV4MiniflareOptions } = dependency('miniflare');
const runtimeOptions = options => convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options;
const { build } = dependency('esbuild');
const token = 'integration-test-only-token';
const image = Buffer.from([255, 216, 255, 224, 1, 2, 3]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Workers runtime: authenticated API, SQLite persistence, alerts and lifecycle', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'focus-worker-test-'));
  const bundle = join(directory, 'worker.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/worker.mjs', import.meta.url))], outfile: bundle, bundle: true, format: 'esm', platform: 'neutral', external: ['node:*'], loader: { '.md': 'text', '.yaml': 'text' } });
  const options = { modules: true, script: await readFile(bundle, 'utf8'), compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], durableObjects: { FOCUS_SESSIONS: { className: 'FocusSession', useSQLite: true } }, resourcePersistencePath: join(directory, 'storage'), bindings: { FOCUS_API_TOKEN: token, DECISION_PROVIDER: 'mock', MOCK_PHONE_PROBABILITY: '0.95', ALLOWED_ORIGINS: 'https://focus.example' } };
  let mf = new Miniflare(runtimeOptions(options));
  const call = async (path, { method = 'GET', body, headers = {}, authenticated = true } = {}) => {
    const response = await mf.dispatchFetch(`http://worker.test${path}`, { method, body, headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), ...headers } });
    return { response, value: response.status === 204 ? null : await response.json() };
  };
  const create = async duration => {
    const result = await call('/v1/sessions', { method: 'POST', body: JSON.stringify({ device_type: 'web', duration_seconds: duration }), headers: { 'content-type': 'application/json' } });
    assert.equal(result.response.status, 201);
    return `/v1/sessions/${result.value.session_id}`;
  };
  const control = (path, action) => call(`${path}/control`, { method: 'POST', body: JSON.stringify({ action }), headers: { 'content-type': 'application/json' } });
  const frame = (path, id, body = image) => call(`${path}/frames`, { method: 'POST', body, headers: { 'content-type': 'image/jpeg', 'x-frame-id': id } });
  try {
    assert.equal((await call('/health', { authenticated: false })).value.configured, true);
    assert.equal((await call('/', { authenticated: false })).value.documentation, '/docs');
    const docs = await mf.dispatchFetch('http://worker.test/docs');
    assert.equal(docs.status, 200);
    assert.match(docs.headers.get('content-type'), /text\/plain/);
    const markdown = await docs.text();
    assert.match(markdown, /共通判定API仕様書/);
    assert.equal(markdown.includes(token), false);
    const schema = (await call('/openapi.json', { authenticated: false })).value;
    assert.match(schema.openapi, /^3\.1/);
    assert.ok(schema.paths['/v1/sessions']);
    assert.equal(JSON.stringify(schema).includes(token), false);
    const path = await create(60);
    for (const [endpoint, method] of [['/v1/sessions', 'POST'], [path, 'GET'], [`${path}/frames`, 'POST'], [`${path}/control`, 'POST']]) {
      assert.equal((await call(endpoint, { method, authenticated: false })).response.status, 401);
      assert.equal((await call(endpoint, { method, headers: { authorization: 'Bearer wrong' } })).response.status, 401);
    }
    const cors = await call(path, { headers: { origin: 'https://focus.example' } });
    assert.equal(cors.response.headers.get('access-control-allow-origin'), 'https://focus.example');
    assert.equal((await call(path, { headers: { origin: 'https://focus.example.evil' } })).response.status, 403);
    const preflight = await call(path, { method: 'OPTIONS', authenticated: false, headers: { origin: 'https://focus.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-frame-id' } });
    assert.equal(preflight.response.status, 204);
    assert.equal((await call(path, { method: 'OPTIONS', headers: { 'access-control-request-method': 'DELETE' } })).response.status, 403);
    assert.equal((await frame(path, 'bad', Buffer.from('invalid'))).response.status, 400);
    // Advertise oversize before sending bytes, avoiding a local client EPIPE when
    // workerd correctly rejects an upload before its body is transmitted.
    const { request: httpRequest } = await import('node:http');
    const workerUrl = await mf.ready;
    const oversizedStatus = await new Promise((resolve, reject) => {
      const upload = httpRequest(new URL(`${path}/frames`, workerUrl), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg', 'x-frame-id': 'large', 'content-length': String(1024 * 1024 + 1) } }, response => { response.resume(); resolve(response.statusCode); upload.destroy(); });
      upload.on('error', reject);
      upload.flushHeaders();
    });
    assert.equal(oversizedStatus, 413);
    const samples = [];
    for (let i = 0; i < 6; i++) {
      if (i) await sleep(1010);
      const sample = await frame(path, `positive-${i}`);
      assert.equal(sample.response.status, 200);
      samples.push(sample.value);
    }
    assert.equal(samples.filter(sample => sample.notify).length, 1);
    assert.equal(samples[5].state, 'observing');
    assert.ok(samples[5].continuous_hold_ms >= 5000);
    assert.ok(samples[5].notification_id);
    assert.equal(samples[5].cooldown_remaining_ms, 0);
    assert.ok(samples[5].next_capture_after_ms <= 1000);
    assert.equal((await frame(path, 'positive-5')).value.reason, 'duplicate_frame');
    assert.equal((await call(path)).value.notify, false);
    assert.equal((await call(path)).value.continuous_hold_ms, 0);
    assert.equal((await control(path, 'pause')).value.state, 'paused');
    assert.equal((await frame(path, 'paused')).value.notify, false);
    await mf.dispose();
    const { DatabaseSync } = await import('node:sqlite');
    const files = await readdir(join(directory, 'storage'), { recursive: true });
    const sqliteFile = files.find(file => file.endsWith('.sqlite'));
    assert.ok(sqliteFile, 'Durable Object uses persisted SQLite storage');
    const database = new DatabaseSync(join(directory, 'storage', sqliteFile), { readOnly: true });
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      assert.ok(tables.length, 'SQLite contains persisted Durable Object state');
      const persistedBytes = await readFile(join(directory, 'storage', sqliteFile));
      assert.equal(persistedBytes.includes(Buffer.from(token)), false);
      assert.equal(persistedBytes.includes(image), false);
    } finally { database.close(); }
    mf = new Miniflare(runtimeOptions(options));
    assert.equal((await call(path)).value.state, 'paused');
    assert.equal((await control(path, 'resume')).value.state, 'observing');
    assert.equal((await frame(path, 'positive-5')).value.reason, 'duplicate_frame');
    const nextSamples = [];
    for (let i = 0; i < 6; i++) {
      await sleep(1010);
      nextSamples.push((await frame(path, `next-positive-${i}`)).value);
    }
    assert.equal(nextSamples.filter(sample => sample.notify).length, 1, 'same persisted session can notify again after restart');
    assert.equal(nextSamples[0].continuous_hold_ms, 0);
    assert.equal(nextSamples[5].state, 'observing');
    assert.equal(nextSamples[5].cooldown_remaining_ms, 0);
    assert.ok(nextSamples[5].continuous_hold_ms >= 5000);
    assert.notEqual(nextSamples[5].notification_id, samples[5].notification_id);
    assert.equal((await frame(path, 'next-positive-5')).value.notify, false);
    assert.equal((await control(path, 'end')).value.state, 'ended');
    assert.equal((await control(path, 'resume')).value.state, 'ended');
    assert.equal((await frame(path, 'ended')).value.notify, false);
    const expiring = await create(1);
    await sleep(1100);
    const expired = (await call(expiring)).value;
    assert.equal(expired.state, 'ended');
    assert.equal(expired.reason, 'session_expired');
  } finally {
    await mf.dispose().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
