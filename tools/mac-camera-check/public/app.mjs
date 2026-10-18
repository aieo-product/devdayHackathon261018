import { FocusClient } from '/focus-client.mjs';
const $ = (id) => document.getElementById(id);
const video = $('camera-video');
const canvas = document.createElement('canvas');
let client, stream, mode = 'idle', generation = 0, timer, nextAt = 0;
let configured = false, started = false, frames = 0, notices = 0, audio;
const seen = new Set();
const labels = { idle: '待機中', starting: '準備中', running: '確認中', observing: '観察中', holding: '保持を検知', cooldown: '通知後の待機', pausing: '停止中', paused: '一時停止', resuming: '再開中', ending: '終了中', ended: '終了', error: 'エラー' };
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
  clearTimeout(timer); nextAt = 0;
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
  const hold = result.continuous_hold_ms || 0, required = result.required_hold_ms || 5000;
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
    $('status-message').textContent = result.state === 'cooldown' ? '通知しました。次の判定まで待機しています。' : result.reason === 'insufficient_visibility' ? '手元が見えるようにカメラの位置を調整してください。' : '手元を映して、スマホを持つ・置く動作を試してください。';
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
async function camera(epoch) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('カメラを利用できません。Chromeでこのlocalhostページを開いてください。');
  const acquired = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
  if (epoch !== generation || document.hidden) { acquired.getTracks().forEach((track) => track.stop()); return false; }
  stream = acquired;
  video.srcObject = stream;
  for (const track of stream.getVideoTracks()) track.onended = () => { if (stream === acquired) fail(new Error('カメラとの接続が切れました。'), epoch); };
  await video.play();
  if (epoch !== generation) return false;
  $('camera-placeholder').hidden = true;
  $('camera-dot').classList.add('active');
  $('camera-label').textContent = 'カメラ起動中';
  $('capture-label').hidden = false;
  return true;
}
async function fail(error, epoch) {
  if (epoch !== generation) return;
  const message = error.name === 'NotAllowedError' ? 'カメラが許可されていません。ブラウザとmacOSのカメラ権限を確認し、もう一度開始してください。' : error.name === 'NotFoundError' ? 'カメラが見つかりません。Macのカメラ接続を確認してください。' : error.name === 'NotReadableError' ? 'カメラを使用できません。他のアプリのカメラを止めてから試してください。' : error.name === 'AbortError' ? 'API応答がタイムアウトしました。もう一度開始してください。' : `確認を停止しました: ${error.message || '接続エラー'}`;
  await end(message);
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
    }
    if (result.state === 'ended') { await end('確認時間が終了しました。'); return; }
    if (result.state === 'paused') { await pause(); return; }
    if (result.reason === 'provider_error' || result.reason === 'inference_error') throw new Error('画像判定APIでエラーが発生しました。Workerの設定を確認してください。');
    schedule(result.next_capture_after_ms);
  } catch (error) { await fail(error, epoch); }
}
async function start() {
  if (!configured || !['idle', 'ended', 'error'].includes(mode)) return;
  const epoch = ++generation;
  client = new FocusClient({ baseUrl: `${location.origin}/api`, token: 'local-preview' });
  started = false; frames = 0; notices = 0; seen.clear();
  $('frame-count').textContent = '0'; $('notification-count').textContent = '0';
  $('notification').hidden = true; $('error-banner').hidden = true;
  mode = 'starting'; controls(); prepareSound();
  $('status-message').textContent = 'カメラの使用を許可してください。';
  try {
    if (!await camera(epoch)) return;
    const result = await client.start({ deviceType: 'mac', durationSeconds: Number($('duration').value) });
    if (epoch !== generation || !result) return;
    started = true; mode = 'running'; controls(); render(result); log('確認を開始しました'); schedule();
  } catch (error) { await fail(error, epoch); }
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
async function resume() {
  if (mode !== 'paused') return;
  const epoch = ++generation; mode = 'resuming'; controls(); prepareSound();
  try {
    if (!await camera(epoch)) return;
    const result = await client.resume();
    if (epoch !== generation) return;
    if (!result || !client.active) { await end('確認時間が終了しました。'); return; }
    mode = 'running'; controls(); render(result); log('確認を再開しました'); schedule();
  } catch (error) { await fail(error, epoch); }
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
$('pause-button').addEventListener('click', pause);
$('resume-button').addEventListener('click', resume);
$('end-button').addEventListener('click', () => end());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (mode === 'starting') void end('画面を離れたため停止しました。');
  else if (['running', 'resuming'].includes(mode)) void pause();
});
window.addEventListener('pagehide', () => {
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
async function init() {
  controls();
  try {
    const response = await fetch('/config', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('ローカル設定を取得できませんでした。');
    const config = await response.json();
    $('endpoint').textContent = config.api_url || 'API未設定';
    if (!config.configured) throw new Error('FOCUS_API_URLとFOCUS_API_TOKENを設定してサーバーを起動してください。');
    const health = await fetch('/api/health', { signal: AbortSignal.timeout(10000) });
    if (!health.ok) throw new Error('Workerに接続できませんでした。');
    configured = true; controls();
    $('status-message').textContent = 'APIに接続できました。「確認開始」でカメラを許可してください。';
    log('Worker接続OK。開始するまでカメラはオフです。');
  } catch (error) {
    $('error-banner').textContent = error.message; $('error-banner').hidden = false;
    $('status-message').textContent = '接続設定を確認し、ページを再読み込みしてください。';
  }
}
void init();
