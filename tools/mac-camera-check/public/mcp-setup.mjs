const $ = (id) => document.getElementById(id);
const errorBanner = $('setup-error');
const createButton = $('create-pairing');
let configured = false;
let issuing = false;
let expiresAt = 0;
let expiryTimer;

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = !message;
}

async function requestJson(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function clearCode() {
  clearInterval(expiryTimer);
  expiryTimer = undefined;
  expiresAt = 0;
  $('pairing-code').textContent = '';
  $('pairing-expiry').textContent = '';
  $('pairing-result').hidden = true;
}

function updateExpiry() {
  const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  if (!remaining) {
    clearCode();
    $('pairing-status').textContent = 'コードの有効期限が切れました。必要なら新しく発行してください。';
    return;
  }
  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, '0');
  $('pairing-expiry').textContent = `有効期限まで ${minutes}:${seconds}（1回だけ使用できます）`;
}

async function copyText(sourceId, label) {
  const source = $(sourceId);
  if (!source.textContent || source.textContent === '—') return;
  if (sourceId === 'pairing-code') {
    updateExpiry();
    if (!expiresAt) return;
  }
  try {
    await navigator.clipboard.writeText(source.textContent);
    $('copy-status').textContent = `${label}をコピーしました。`;
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(source);
    selection?.removeAllRanges();
    selection?.addRange(range);
    source.focus();
    $('copy-status').textContent = `自動コピーが使えません。選択された${label}を⌘Cでコピーしてください。`;
  }
}

$('copy-url').addEventListener('click', () => void copyText('mcp-url', 'URL'));
$('copy-code').addEventListener('click', () => void copyText('pairing-code', 'コード'));
$('copy-prompt').addEventListener('click', () => void copyText('dot-prompt', '依頼文'));

createButton.addEventListener('click', async () => {
  if (!configured || issuing) return;
  issuing = true;
  createButton.disabled = true;
  clearCode();
  showError('');
  $('pairing-status').textContent = 'コードを発行しています…';
  try {
    const result = await requestJson('/mcp/pairing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const expiry = Date.parse(result.expires_at);
    if (typeof result.code !== 'string' || !result.code.trim() || result.code.length > 256 || !Number.isFinite(expiry) || expiry <= Date.now()) {
      throw new Error('invalid_response');
    }
    expiresAt = expiry;
    $('pairing-code').textContent = result.code;
    $('pairing-result').hidden = false;
    $('pairing-status').textContent = 'OAuth認証画面にこのコードを入力してください。使用後はこの画面を閉じてかまいません。';
    updateExpiry();
    expiryTimer = setInterval(updateExpiry, 1000);
  } catch (error) {
    clearCode();
    $('pairing-status').textContent = 'コードは表示できませんでした。';
    showError(error.name === 'AbortError'
      ? 'コードの発行がタイムアウトしました。ローカルサーバーとWorkerの接続を確認して、もう一度発行してください。'
      : 'コードを発行できませんでした。MCP Eventsの接続設定とローカルサーバーを確認して、もう一度試してください。');
  } finally {
    issuing = false;
    createButton.disabled = !configured;
  }
});

async function initialize() {
  try {
    const config = await requestJson('/config');
    const events = config.events;
    if (!events?.configured) {
      $('setup-state').textContent = '未設定';
      $('setup-status').textContent = 'ローカルサーバーのMCP Events設定がまだありません。設定後にサーバーを再起動し、この画面を再読み込みしてください。';
      $('pairing-status').textContent = 'MCP Eventsの設定が必要です。';
      return;
    }
    const url = new URL(events.mcp_url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid_url');
    configured = true;
    $('mcp-url').textContent = url.href;
    $('copy-url').disabled = false;
    createButton.disabled = false;
    $('setup-state').textContent = '設定済み';
    $('setup-state').dataset.state = 'observing';
    $('setup-status').textContent = '公開MCPサーバーのURLです。APIキーを入力する必要はありません。';
    $('pairing-status').textContent = 'OAuth認証画面を開いてから、コードを発行してください。';
  } catch {
    $('setup-state').textContent = '接続エラー';
    $('setup-state').dataset.state = 'error';
    $('setup-status').textContent = '接続設定を取得できませんでした。';
    $('pairing-status').textContent = 'ローカルサーバーへの接続が必要です。';
    showError('ローカルサーバーが起動していることを確認し、この画面を再読み込みしてください。');
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && expiresAt) updateExpiry();
});
window.addEventListener('pagehide', clearCode);
void initialize();
