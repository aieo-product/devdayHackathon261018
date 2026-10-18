import { FocusClient } from '/focus-client.mjs';
import { RemoteController, createSingleFlightPoll } from '/remote-control.mjs';
const $ = (id) => document.getElementById(id);
const video = $('camera-video');
const canvas = document.createElement('canvas');
let client, stream, mode = 'idle', generation = 0, timer, notificationTimer, nextAt = 0;
let configured = false, started = false, frames = 0, notices = 0, audio;
let remote, remotePoll, remoteDeviceId, devices = [], remoteError = '', closing = false;
const seen = new Set();
const labels = { idle: '待機中', starting: '準備中', running: '確認中', observing: '観察中', suspected: '保持を検知', holding: '保持を検知', cooldown: '通知後の待機', pausing: '停止中', paused: '一時停止', resuming: '再開中', ending: '終了中', ended: '終了', error: 'エラー' };
function log(message) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString('ja-JP')}  ${message}`;
  $('event-log').prepend(item);
  while ($('event-log').children.length > 30) $('event-log').lastChild.remove();
}
function controls() {
  const idle = ['idle', 'ended', 'error'].includes(mode);
  $('start-button').disabled = !configured || !idle;
  $('duration').disabled = !idle;
  $('pause-button').hidden = mode === 'paused';
  $('pause-button').disabled = mode !== 'running';
  $('resume-button').hidden = mode !== 'paused';
  $('resume-button').disabled = mode !== 'paused';
  $('end-button').disabled = idle || mode === 'ending';
  $('state-label').textContent = labels[mode] || mode;
  $('state-label').dataset.state = mode;
}
function stopCamera() {
  clearTimeout(timer); clearTimeout(notificationTimer); nextAt = 0;
  const old = stream; stream = null;
  old?.getTracks().forEach((track) => track.stop());
  video.srcObject = null;
  $('camera-placeholder').hidden = false;
  $('camera-dot').classList.remove('active');
  $('camera-label').textContent = 'カメラはオフ';
  $('capture-label').hidden = true;
}
function render(result) {
  if (!result) return;
  const hold = result.continuous_hold_ms || 0, required = result.required_hold_ms || 2000;
  $('hold-seconds').textContent = (hold / 1000).toFixed(1);
  $('required-seconds').textContent = (required / 1000).toFixed(1);
  $('hold-progress').max = required;
  $('hold-progress').value = hold;
  for (const [id, key] of [['phone-probability', 'phone_probability'], ['observable-probability', 'observable_probability']]) {
    $(id).textContent = Number.isFinite(result[key]) ? `${Math.round(result[key] * 100)}%` : '—';
  }
  $('provider').textContent = result.provider || '—';
  $('reason').textContent = result.reason || '判定待ち';
  if (mode === 'running') {
    $('state-label').textContent = labels[result.state] || result.state;
    $('state-label').dataset.state = result.state;
    $('status-message').textContent = result.state === 'cooldown' ? '通知しました。次の判定まで待機しています。' : result.notify ? `通知しました。続けて判定します。次の通知には新たに${required / 1000}秒の保持が必要です。` : result.reason === 'insufficient_visibility' ? '手元が見えるようにカメラの位置を調整してください。' : '手元を映して、スマホを持つ・置く動作を試してください。';
  }
}
function prepareSound() {
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume().catch(() => {}); } catch {}
}
function beep() {
  if (!$('sound-enabled').checked || !audio) return;
  try {
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.frequency.value = 740;
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.35);
    oscillator.start(); oscillator.stop(audio.currentTime + 0.36);
  } catch {}
}
async function camera(epoch, allowed = () => true) {
  if (!allowed()) return false;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('カメラを利用できません。Chromeでこのlocalhostページを開いてください。');
  const acquired = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
  if (epoch !== generation || document.hidden || !allowed()) { acquired.getTracks().forEach((track) => track.stop()); return false; }
  stream = acquired;
  video.srcObject = stream;
  for (const track of stream.getVideoTracks()) track.onended = () => { if (stream === acquired) fail(new Error('カメラとの接続が切れました。'), epoch); };
  await video.play();
  if (epoch !== generation || !allowed()) return false;
  $('camera-placeholder').hidden = true;
  $('camera-dot').classList.add('active');
  $('camera-label').textContent = 'カメラ起動中';
  $('capture-label').hidden = false;
  return true;
}
async function fail(error, epoch) {
  if (epoch !== generation) return;
  const message = error.name === 'NotAllowedError' ? 'カメラが許可されていません。ブラウザとmacOSのカメラ権限を確認し、もう一度開始してください。' : error.name === 'NotFoundError' ? 'カメラが見つかりません。Macのカメラ接続を確認してください。' : error.name === 'NotReadableError' ? 'カメラを使用できません。他のアプリのカメラを止めてから試してください。' : error.name === 'AbortError' ? 'API応答がタイムアウトしました。もう一度開始してください。' : `確認を停止しました: ${error.message || '接続エラー'}`;
  const endEpoch = generation + 1;
  await end(message);
  if (generation !== endEpoch) return;
  $('error-banner').textContent = message;
  $('error-banner').hidden = false;
  mode = 'error'; controls(); log(message);
}
function schedule(delay = 0) {
  clearTimeout(timer);
  if (mode !== 'running') return;
  const wait = Math.max(30, Number(delay) || 0);
  nextAt = Date.now() + wait;
  $('capture-label').textContent = '次の撮影を待機中';
  timer = setTimeout(() => capture(generation), wait);
}
async function capture(epoch) {
  if (epoch !== generation || mode !== 'running' || !client?.active || document.hidden) return;
  try {
    if (!video.videoWidth || !video.videoHeight) { schedule(100); return; }
    const scale = Math.min(640 / video.videoWidth, 480 / video.videoHeight, 1);
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7));
    if (epoch !== generation) return;
    if (!blob) throw new Error('カメラ画像を作成できませんでした。');
    $('capture-label').textContent = '判定中…'; nextAt = 0;
    const began = performance.now();
    const result = await client.frame(blob);
    if (epoch !== generation || !result) return;
    $('frame-count').textContent = ++frames;
    $('latency').textContent = `${Math.round(performance.now() - began)} ms`;
    render(result);
    log(`画像 ${frames}: ${result.reason || result.state} / 保持 ${((result.continuous_hold_ms || 0) / 1000).toFixed(1)}秒`);
    if (result.notify && result.notification_id && !seen.has(result.notification_id)) {
      seen.add(result.notification_id); $('notification-count').textContent = ++notices;
      $('notification-detail').textContent = result.message || 'スマホの連続保持を検知しました';
      $('notification').hidden = false; beep(); log('通知: スマホの連続保持を検知');
      clearTimeout(notificationTimer);
      notificationTimer = setTimeout(() => { $('notification').hidden = true; }, 2500);
    }
    if (result.state === 'ended') { await end('確認時間が終了しました。'); return; }
    if (result.state === 'paused') { await pause(); return; }
    if (result.reason === 'provider_error' || result.reason === 'inference_error') throw new Error('画像判定APIでエラーが発生しました。Workerの設定を確認してください。');
    schedule(result.next_capture_after_ms);
  } catch (error) { await fail(error, epoch); }
}
async function start({ allowed = () => true } = {}) {
  if (!configured || !['idle', 'ended', 'error'].includes(mode)) return false;
  const epoch = ++generation;
  client = new FocusClient({ baseUrl: `${location.origin}/api`, token: 'local-preview' });
  started = false; frames = 0; notices = 0; seen.clear();
  $('frame-count').textContent = '0'; $('notification-count').textContent = '0';
  $('notification').hidden = true; $('error-banner').hidden = true;
  mode = 'starting'; controls(); prepareSound();
  $('status-message').textContent = 'カメラの使用を許可してください。';
  try {
    if (!await camera(epoch, allowed)) { if (epoch === generation) await end('開始を取り消しました。カメラはオフです。'); return false; }
    const result = await client.start({ deviceType: 'mac', durationSeconds: Number($('duration').value) });
    if (epoch !== generation || !result) return false;
    if (!allowed()) { await end('遠隔ONの期限が切れたため停止しました。'); return false; }
    started = true; mode = 'running'; controls(); render(result); log('確認を開始しました'); schedule();
    return true;
  } catch (error) { await fail(error, epoch); return false; }
}
async function pause() {
  if (!['running', 'resuming'].includes(mode)) return;
  const epoch = ++generation; stopCamera(); mode = 'pausing'; controls();
  $('notification').hidden = true;
  $('status-message').textContent = 'カメラと画像送信を停止しました。';
  try {
    const result = await client.pause();
    if (epoch !== generation) return;
    mode = 'paused'; controls(); render(result); log('一時停止: カメラはオフ');
  } catch (error) { await fail(error, epoch); }
}
async function resume({ allowed = () => true } = {}) {
  if (mode !== 'paused') return false;
  const epoch = ++generation; mode = 'resuming'; controls(); prepareSound();
  try {
    if (!await camera(epoch, allowed)) { if (epoch === generation) await end('開始を取り消しました。カメラはオフです。'); return false; }
    const result = await client.resume();
    if (epoch !== generation) return false;
    if (!allowed()) { await end('遠隔ONの期限が切れたため停止しました。'); return false; }
    if (!result || !client.active) { await end('確認時間が終了しました。'); return false; }
    mode = 'running'; controls(); render(result); log('確認を再開しました'); schedule();
    return true;
  } catch (error) { await fail(error, epoch); return false; }
}
async function end(message = '確認を終了しました。カメラはオフです。') {
  const epoch = ++generation, previous = client;
  stopCamera(); mode = 'ending'; started = false; controls(); $('notification').hidden = true;
  $('status-message').textContent = message;
  try { await previous?.end(); } catch { log('終了通知の通信に失敗しました。カメラと送信は停止済みです。'); }
  if (epoch !== generation) return;
  render(previous?.snapshot); mode = 'ended'; controls(); log('終了: カメラはオフ');
}
$('start-button').addEventListener('click', start);
$('pause-button').addEventListener('click', () => { remote?.localStop(); void pause(); });
$('resume-button').addEventListener('click', resume);
$('end-button').addEventListener('click', () => { remote?.localStop(); void end(); refreshRemote(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (remote?.state.armed || remote?.state.arming) { remote.hidden(); refreshRemote(); return; }
  remote?.localStop();
  if (mode === 'starting') void end('画面を離れたため停止しました。');
  else if (['running', 'resuming'].includes(mode)) void pause();
});
window.addEventListener('pagehide', () => {
  closing = true;
  remotePoll?.stop();
  if (remote) {
    remote.dispose();
    void fetch('/devices/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(remote.heartbeat()), keepalive: true }).catch(() => {});
  }
  ++generation; stopCamera();
  const id = client?.snapshot?.session_id;
  if (id) void fetch(`/api/v1/sessions/${encodeURIComponent(id)}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'end' }), keepalive: true }).catch(() => {});
});
setInterval(() => {
  const remaining = started ? client.remainingMs : ['idle', 'error'].includes(mode) ? Number($('duration').value) * 1000 : 0;
  const seconds = Math.ceil(remaining / 1000);
  $('remaining-time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  $('next-capture').textContent = nextAt ? `${Math.max(0, (nextAt - Date.now()) / 1000).toFixed(1)} 秒` : '—';
  if (started && remaining <= 0 && !['ending', 'ended'].includes(mode)) void end('確認時間が終了しました。');
}, 250);

async function remoteRequest(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000), cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) {
    const messages = { device_offline: '端末がオフラインです。対象の確認画面を開いてください。', remote_disabled: '対象端末で遠隔操作を許可してください。', device_not_found: '端末が見つかりません。', future_revision: '端末情報を更新して、もう一度操作してください。', device_capacity: '登録できる端末数の上限に達しました。' };
    throw new Error(messages[result.error?.code] || '端末制御APIへの接続に失敗しました。');
  }
  return result;
}
function renderRemote() {
  if (!remote) return;
  const state = remote.state;
  $('remote-arm-button').disabled = state.armed || state.arming;
  $('remote-disarm-button').disabled = !state.armed && !state.arming;
  $('remote-status').textContent = remoteError || state.error || (state.arming ? 'カメラ権限を確認中です。許可した映像は直ちに停止します。' : state.pending ? '遠隔ONを開始しています。' : state.armed ? '遠隔操作を許可しました。新しいON指示を待っています。画面を表示したままにしてください。' : '遠隔操作は未許可です。このMacで許可するまで遠隔ONでは撮影しません。');
  const list = $('remote-devices');
  list.replaceChildren();
  for (const device of devices) {
    const item = document.createElement('li');
    const detail = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = device.device_id === remoteDeviceId ? 'このMac' : String(device.name || device.device_id || '端末');
    const status = document.createElement('p'); status.className = 'reason';
    const states = { on: 'ON', off: 'OFF', blocked: '開始待ち・許可確認', error: 'エラー' };
    status.textContent = `${device.type || 'device'} / ${device.online ? 'オンライン' : 'オフライン'} / 要求: ${device.desired_state === 'on' ? 'ON' : 'OFF'} / 実状態: ${states[device.observed_state] || '未確認'} / ${device.remote_enabled ? '遠隔操作を許可済み' : '遠隔操作は未許可'}`;
    detail.append(name, status);
    const actions = document.createElement('div'); actions.className = 'control-buttons';
    for (const enabled of [true, false]) {
      const button = document.createElement('button');
      button.className = `button ${enabled ? 'button-secondary' : 'button-quiet'}`;
      button.textContent = enabled ? 'ON' : 'OFF';
      button.dataset.deviceId = device.device_id;
      button.dataset.enabled = String(enabled);
      button.setAttribute('aria-label', `${name.textContent}を${enabled ? 'ON' : 'OFF'}`);
      button.disabled = enabled && (device.online !== true || device.remote_enabled !== true);
      button.addEventListener('click', async () => {
        button.disabled = true; remoteError = '';
        if (!enabled && device.device_id === remoteDeviceId) { remote.localStop(); void end('OFFを押したため停止しました。カメラはオフです。'); }
        try {
          const result = await remoteRequest('/devices/control', { device_id: device.device_id, enabled });
          const updated = result.device || result;
          devices = devices.map(value => value.device_id === updated.device_id ? updated : value);
          if (updated.device_id === remoteDeviceId) remote.observe(updated);
        } catch (error) { remoteError = error.name === 'TimeoutError' ? '端末への操作がタイムアウトしました。状態を確認してください。' : error.message; }
        renderRemote(); refreshRemote();
      });
      actions.append(button);
    }
    item.append(detail, actions); list.append(item);
  }
}
function refreshRemote() {
  if (!remotePoll || closing) return;
  // A change during an in-flight heartbeat must be sent by the following request.
  void remotePoll.run().finally(() => { if (!closing) void remotePoll.run(); });
}
function initRemote(events) {
  if (!events?.configured || !events.device_id) return;
  remoteDeviceId = events.device_id;
  $('remote-panel').hidden = false;
  remote = new RemoteController({
    start: ({ isCurrent }) => mode === 'running' ? true : mode === 'paused' ? resume({ allowed: isCurrent }) : start({ allowed: isCurrent }),
    stop: () => end('遠隔操作を停止しました。カメラはオフです。'),
    permission: () => navigator.mediaDevices.getUserMedia({ video: true, audio: false }),
    visible: () => !document.hidden,
    observed: () => ({ observed_state: stream?.getVideoTracks().some(track => track.readyState === 'live') ? 'on' : mode === 'error' ? 'error' : 'off', session_id: started ? client?.snapshot?.session_id : null }),
    onChange: renderRemote,
  });
  remotePoll = createSingleFlightPoll({
    task: async () => {
      const result = await remoteRequest('/devices/heartbeat', remote.heartbeat());
      if (closing) return;
      remote.observe(result.device || result);
      const listing = await remoteRequest('/devices/list', {});
      if (closing) return;
      devices = Array.isArray(listing.devices) ? listing.devices : [];
      remoteError = ''; renderRemote();
    },
    onError: () => { if (!closing) { remoteError = '端末の接続状態を取得できません。ローカルサーバーとMCP Eventsの設定を確認してください。'; renderRemote(); } },
  });
  $('remote-arm-button').addEventListener('click', () => {
    remoteError = ''; prepareSound();
    void remote.arm().then(refreshRemote);
  });
  $('remote-disarm-button').addEventListener('click', () => { remote.unarm(); refreshRemote(); });
  renderRemote(); void remotePoll.start();
}
async function init() {
  controls();
  try {
    const response = await fetch('/config', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('ローカル設定を取得できませんでした。');
    const config = await response.json();
    $('endpoint').textContent = config.api_url || 'API未設定';
    $('mcp-setup-link').hidden = !config.events?.configured;
    if (!config.configured) throw new Error('FOCUS_API_URLとFOCUS_API_TOKENを設定してサーバーを起動してください。');
    const health = await fetch('/api/health', { signal: AbortSignal.timeout(10000) });
    if (!health.ok) throw new Error('Workerに接続できませんでした。');
    configured = true; controls();
    initRemote(config.events);
    $('status-message').textContent = 'APIに接続できました。「確認開始」でカメラを許可してください。';
    log('Worker接続OK。開始するまでカメラはオフです。');
  } catch (error) {
    $('error-banner').textContent = error.message; $('error-banner').hidden = false;
    $('status-message').textContent = '接続設定を確認し、ページを再読み込みしてください。';
  }
}
void init();
