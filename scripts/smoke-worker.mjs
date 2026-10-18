import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

// One live inference: the duplicate uses the same ID; the other image is sent only after pause succeeds.
function grayPng() {
  const chunk = (type, bytes) => {
    const payload = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256, 0);
  header.writeUInt32BE(256, 4);
  header[8] = 8; // Grayscale, eight bits per pixel.
  const pixels = Buffer.alloc(257 * 256, 128);
  for (let row = 0; row < 256; row++) pixels[row * 257] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const states = new Set(['observing', 'suspected', 'cooldown', 'unknown', 'paused', 'ended']);
const decisionReasons = new Set(['phone_use_not_detected', 'phone_use_suspected', 'insufficient_visibility']);
let failures = 0;
function report(label, ok, started, data, reason) {
  if (!ok) failures++;
  const safeReason = /^[a-z_]{1,80}$/.test(reason || data?.reason || '') ? reason || data.reason : 'invalid_reason';
  const values = ['phone_probability', 'observable_probability']
    .filter(key => probability(data?.[key])).map(key => `${key}=${data[key]}`).join(' ');
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} elapsed_ms=${Date.now() - started} reason=${safeReason}${values ? ` ${values}` : ''}`);
}

async function main() {
  let url;
  try { url = new URL(process.env.FOCUS_API_URL); } catch { throw new Error('invalid_api_url'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid_api_url');
  }
  const token = process.env.FOCUS_API_TOKEN;
  if (!token?.trim()) throw new Error('missing_api_token');
  const base = url.href.replace(/\/$/, '');
  let bytes;
  try { bytes = process.env.FOCUS_SMOKE_IMAGE_PATH ? await readFile(process.env.FOCUS_SMOKE_IMAGE_PATH) : grayPng(); }
  catch { throw new Error('image_read_failed'); }
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if ((!png && !jpeg) || bytes.length > 1048576) throw new Error('invalid_image');
  const frameId = `smoke-${randomUUID()}`;
  const imageOptions = id => ({ method: 'POST', body: bytes, headers: {
    'Content-Type': png ? 'image/png' : 'image/jpeg', 'X-Frame-Id': id,
  } });
  const jsonOptions = body => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  async function request(path, options = {}, expected = 200) {
    let response;
    try { response = await fetch(base + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { ...options.headers, ...(path === '/health' ? {} : { Authorization: `Bearer ${token}` }) } }); }
    catch { throw new Error('network_or_timeout'); }
    if (response.status !== expected) throw new Error('unexpected_http_status');
    try { return await response.json(); } catch { throw new Error('invalid_json'); }
  }
  async function check(label, action, validate, successReason) {
    const started = Date.now();
    try {
      const data = await action();
      const ok = Boolean(validate(data));
      report(label, ok, started, data, successReason);
      return { data, ok };
    } catch (error) { report(label, false, started, null, error.message); return null; }
  }
  const health = await check('health', () => request('/health'), data => data?.configured === true && data.provider === 'openai', 'provider_configuration');
  if (!health?.ok) return;
  let sessionPath;
  try {
    const created = await check('create', () => request('/v1/sessions', jsonOptions({ device_type: 'web', duration_seconds: 60 }), 201),
      data => /^[a-zA-Z0-9-]{1,80}$/.test(data?.session_id || '') && data.state === 'observing' && data.notify === false);
    if (/^[a-zA-Z0-9-]{1,80}$/.test(created?.data?.session_id || '')) sessionPath = `/v1/sessions/${created.data.session_id}`;
    if (!created?.ok) return;
    const frame = await check('inference', () => request(`${sessionPath}/frames`, imageOptions(frameId)), data =>
      data?.provider === 'openai' && states.has(data.state) && decisionReasons.has(data.reason) && data.notify === false &&
      probability(data.phone_probability) && probability(data.observable_probability));
    await check('get', () => request(sessionPath), data => states.has(data?.state) && data.notify === false &&
      (!frame?.data || data.state === frame.data.state));
    // Missing probabilities fail inference but do not prevent lifecycle verification.
    if (frame?.data) await check('duplicate', () => request(`${sessionPath}/frames`, imageOptions(frameId)),
      data => data?.reason === 'duplicate_frame' && data.notify === false);
    const paused = await check('pause', () => request(`${sessionPath}/control`, jsonOptions({ action: 'pause' })),
      data => data?.state === 'paused' && data.notify === false);
    if (paused?.ok) await check('paused_frame', () => request(`${sessionPath}/frames`, imageOptions(`${frameId}-paused`)),
      data => data?.state === 'paused' && data.reason === 'session_paused' && data.notify === false);
    await check('resume', () => request(`${sessionPath}/control`, jsonOptions({ action: 'resume' })),
      data => data?.state === 'observing' && data.notify === false);
  } finally {
    if (sessionPath) await check('end', () => request(`${sessionPath}/control`, jsonOptions({ action: 'end' })),
      data => data?.state === 'ended' && data.notify === false);
  }
}

await main().catch(error => report('setup', false, Date.now(), null, error.message));
console.log(`${failures ? 'FAIL' : 'PASS'} smoke failures=${failures}`);
process.exitCode = failures ? 1 : 0;
