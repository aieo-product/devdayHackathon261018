const $ = id => document.getElementById(id);
const states = {idle:'準備できました',running:'集中中',paused:'一時停止中',ended:'終了',completed:'おつかれさまでした'};
const labels = {session_started:'集中を開始',session_paused:'一時停止',session_resumed:'集中を再開',session_ended:'終了',session_completed:'時間になりました',phone_detected:'スマホ操作の連続検出',action_executed:'通知アクション',notification_test:'通知テスト',settings_changed:'設定を更新',observation_failed:'判定をスキップ',action_failed:'通知に失敗',action_cancel_failed:'通知停止の確認が必要'};
const reasons = {unobservable:'手元が見えないため判定を保留',refusal:'判定を保留',authentication:'APIキーを確認してください',permission:'Decisions APIの利用権限を確認してください',rate_limited:'API制限のため待機',timeout:'通信タイムアウト',connection:'接続待ち',invalid_response:'判定応答を確認できません',api_error:'APIエラー',capture_or_action_failed:'カメラまたは通知を確認してください'};
let initialized=false, pending=false, latest=null, imageUrl=null;
async function api(path, body) {
  const response = await fetch('/api/'+path, {cache:'no-store', ...(body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','X-Focus-Control':'1'},body:JSON.stringify(body)})});
  if (!response.ok) { const error=await response.json().catch(()=>({})); throw Error(typeof error.detail === 'string' ? error.detail : '処理に失敗しました。'); }
  return response;
}
function showError(error){$('error').hidden=false;$('error').textContent=error.message;}
function clearPreview(){if(imageUrl){URL.revokeObjectURL(imageUrl);imageUrl=null;}$('frame').removeAttribute('src');$('frame').hidden=true;$('preview-placeholder').hidden=false;}
function render(s){
  latest=s;$('state').textContent=states[s.state]||s.state;
  const seconds=Math.ceil(s.remaining_seconds || s.settings.duration_minutes*60);
  $('timer').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
  if(['ended','completed'].includes(s.state)) $('timer').textContent='00:00';
  const observation=s.observation;
  $('detail').textContent=s.state==='paused' ? '観測と通知を一時停止しています。' : ['ended','completed'].includes(s.state) ? '観測と通知を終了しました。' : s.cooldown_seconds>0 ? `次の声かけまで ${Math.ceil(s.cooldown_seconds)}秒` : observation ? (reasons[observation.reason] || `スマホ操作の推定 ${Math.round((observation.phone_probability||0)*100)}% · 連続 ${s.consecutive}/${s.settings.consecutive_required}回`) : '手元が見える位置で、無理のないペースで。';
  $('count').textContent=`通知 ${s.notification_count}回`;
  const active=['running','paused'].includes(s.state);
  $('start').disabled=pending||active||!s.settings.api_key_configured||!s.capabilities.camera||!$('consent').checked;
  $('pause').disabled=pending||s.state!=='running';$('resume').disabled=pending||s.state!=='paused';$('end').disabled=pending||!active;
  $('preview').disabled=pending||s.state==='running'||s.busy||!s.capabilities.camera;
  $('test').disabled=pending||s.state==='running';
  $('audio').disabled=!s.capabilities.actions.includes('reminder');$('motion').disabled=!s.capabilities.actions.includes('antenna_wiggle');
  $('key-status').textContent=s.settings.api_key_configured?'（保存済み）':'（未設定）';
  $('capabilities').textContent=`カメラ: ${s.capabilities.camera?'利用可能':'未接続'} · 声かけ: ${s.capabilities.actions.includes('reminder')?'利用可能':'未接続'}`;
  if(!initialized){$('minutes').value=s.settings.duration_minutes;$('audio').checked=s.settings.audio_enabled;$('motion').checked=s.settings.motion_enabled;initialized=true;}
  $('events').replaceChildren(...s.events.slice(-30).reverse().map(e=>{const li=document.createElement('li');li.textContent=new Date(e.time*1000).toLocaleTimeString()+' '+(labels[e.event]||e.event)+(e.reason?' · '+(reasons[e.reason]||e.reason):'')+(e.actions?' · '+e.actions.map(a=>a.action+': '+a.status).join(', '):'');return li;}));
  if(s.state==='running')clearPreview();
}
async function action(fn){pending=true;if(latest)render(latest);$('error').hidden=true;try{await fn();}catch(e){showError(e);}finally{pending=false;try{render(await(await api('status')).json());}catch(e){showError(e);}}}
$('consent').addEventListener('change',()=>{if(latest)render(latest);});
document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>action(async()=>{clearPreview();render(await(await api('session/'+b.dataset.action,{consent:$('consent').checked})).json());})));
$('settings').addEventListener('submit',e=>{e.preventDefault();action(async()=>{const body={duration_minutes:Number($('minutes').value),audio_enabled:$('audio').checked,motion_enabled:$('motion').checked};if($('api-key').value)body.api_key=$('api-key').value;render(await(await api('settings',body)).json());$('api-key').value='';});});
$('delete-key').addEventListener('click',()=>action(async()=>{await api('session/end',{});render(await(await api('settings',{api_key:''})).json());$('api-key').value='';}));
$('preview').addEventListener('click',()=>action(async()=>{const blob=await(await api('preview',{})).blob();clearPreview();imageUrl=URL.createObjectURL(blob);$('frame').src=imageUrl;$('frame').hidden=false;$('preview-placeholder').hidden=true;}));
$('test').addEventListener('click',()=>action(async()=>render(await(await api('test-notification',{})).json())));
async function poll(){try{if(!pending)render(await(await api('status')).json());}catch(e){showError(e);$('state').textContent='本体への接続を確認中';document.querySelectorAll('[data-action]').forEach(b=>b.disabled=true);}finally{setTimeout(poll,1000);}}
poll();
