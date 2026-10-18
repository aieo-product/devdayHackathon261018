import { Effects } from './effects.js';
import { Session } from './session.js';
import { LyricMotion } from './lyric-motion.js';
import { PlayfulTimer } from './timer-playful.js';
import { FocusApiClient } from './focus-api-client.js';
import { setupCharacterPicker } from './character-profiles.js';
import { NotificationToast } from './notification-toast.js';
import { MiniMonitor } from './mini-monitor.js';
import { DetectionReplay } from './detection-replay.js';
import { DesktopOverlayClient } from './desktop-overlay-client.js';
import { ActionShowcase } from './action-showcase.js';
const $=id=>document.getElementById(id);
const showcaseView=new URL(location.href).searchParams.get('showcase')==='1';
if(showcaseView){document.body.dataset.showcaseView='true';$('api-mode').value='demo';$('auto-mini').checked=false;$('desktop-overlay-enabled').checked=false;}
const profiles={
 bounce:{title:'NEON BOUNCE',caption:'弾むリアクション × ネオンの波紋',slogan:'ぷにっと、いこう！',duration:850},
 rush:{title:'ARCADE RUSH',caption:'ためて跳ぶ × スピードライン × ゲージ点火',slogan:'よーし、スタート！',duration:680},
 orbit:{title:'ORBIT FLOW',caption:'ふわりと旋回 × 光のリング × やさしい余韻',slogan:'自分のペースで。',duration:1250},
 fever:{title:'DOPA FEVER',caption:'連続ジャンプ × カラフルな流星 × 光のフィナーレ',slogan:'さあ、いっしょに全開！',duration:1350}
};
let pattern='bounce',intensity='max',cueTimers=[],animations=new Set(),log=[],lastMilestone=0,sound=false,videoRun=0;
let tapLevel=0,lastTapAt=-Infinity,desiredSound=true,audioUnlock=null,soundContext=null;
let characterProfile=null;
const reactionMarks=new Set();
const reduce=matchMedia('(prefers-reduced-motion: reduce)');
const session=new Session();
const lyric=new LyricMotion($('lyric-stage'));
const playfulTimer=new PlayfulTimer($('timer-stage'));
const api=new FocusApiClient();
const toast=new NotificationToast($('toast'));
const detectionReplay=new DetectionReplay();
const desktopOverlay=new DesktopOverlayClient();
let notificationGeneration=0,desktopTestTimer=null,desktopStatusBusy=false;
let desktopNotice=null,lastFrameAt=null,miniOpenedAt=0;
const mini=new MiniMonitor({
 onToggle:()=>toggleMain(),
 onEnd:()=>endSession(),
 onOpenMain:()=>{$('session-tab').click();replayDetection();},
 onChange:({active})=>{
  if(active){miniOpenedAt=Date.now();document.body.dataset.mini='visible';hideToast();}
  else{delete document.body.dataset.mini;$('mini-status').textContent=Date.now()-miniOpenedAt<1500?'このブラウザでは小窓を維持できません。Chromeでこのページを開いて「小窓で表示」を押してください。':'小窓を閉じました。セッションはメイン画面で続いています。';}
 }
});
let apiMode=$('api-mode')?.value||'connected',apiState='ready',apiStatus='checking',apiError='',apiDetail='',apiOperation=null,apiNotificationCount=0;
let cameraStream=null,frameCapture=null,cameraPending=false,cameraGeneration=0,captureTimer=null,captureBusy=false,cameraMessage='カメラは停止中です。利用する場合はカメラを有効にしてください。';
const captureCanvas=document.createElement('canvas');
const captureContext=captureCanvas.getContext('2d');
function currentView(){
 if(apiMode==='demo')return {status:session.status,duration:session.duration,remaining:session.remaining,elapsed:session.elapsed,ratio:session.ratio,notificationCount:session.notificationCount};
 const duration=api.startedAt===null?session.duration:api.durationSeconds;
 const remaining=api.startedAt===null?duration:api.remainingMs/1000;
 return {status:apiState,duration,remaining,elapsed:Math.max(0,duration-remaining),ratio:duration?remaining/duration:0,notificationCount:apiNotificationCount};
}

const effects=new Effects({canvas:$('effects'),onShake:()=>motion($('app-window'),[{transform:'translateX(0)'},{transform:'translateX(-2px)'},{transform:'translateX(2px)'},{transform:'translateX(0)'}],{duration:220})});
effects.setIntensity(intensity);
const showcaseSteps=[
 {kind:'toast',label:'動くDOTSのトースト ＋ お知らせ音',duration:6500},
 {kind:'start',label:'開始 ＋ リリックモーション',duration:4700},
 {kind:'tap',label:'DOTSのジャンプ ＋ ポップ音',duration:1900},
 {kind:'pause',label:'一時停止',duration:1300},
 {kind:'resume',label:'再開',duration:2100},
 {kind:'break',label:'休憩',duration:1800},
 {kind:'milestone',label:'ひと区切り ＋ 達成音',duration:2000},
 {kind:'detect',label:'警告音 ＋ 全画面リリック ＋ トースト',duration:6500},
 {kind:'complete',label:'完了 ＋ フィナーレ',duration:4900},
 {kind:'end',label:'終了のサウンド',duration:1600}
];
const showcase=new ActionShowcase({
 onStep:(step,index,total)=>{
  $('action-showcase-status').textContent=`${index+1} / ${total} · ${step.label}`;
  $('action-showcase-progress').max=total;$('action-showcase-progress').value=index+1;
  document.body.dataset.showcaseStep=step.kind;
  if(step.kind==='toast'){
   clearCue();effects.playSound('notify');
  }else if(step.kind==='end'){
   clearCue();effects.playSound('end');mascotMotion('pause');speak('また一緒に！','SEE YOU NEXT SESSION.');
  }else cue(step.kind,{demo:true,source:'test',message:'表示デモです。スマホから目を離して、いまの一歩へ。'});
  if(['toast','detect'].includes(step.kind))toast.show({
   profile:characterProfile,kind:step.kind==='toast'?'test':'detect',
   message:step.kind==='toast'?'DOTSが動いてお知らせ。右下から、そっと呼びかけるよ。':'警告音と全画面モーションで、いまの作業に戻ろう！',
   source:'演出デモ · 実際の検知ではありません',motion:!reduce.matches&&intensity!=='off'
  });
 },
 onFinish:()=>stopShowcase({message:'再生完了。気になる演出は何度でも試せます。'})
});
function stopShowcase({clear=true,message='デモを停止しました。'}={}){
 const wasActive=showcase.active||document.body.dataset.showcase==='playing';
 showcase.stop();delete document.body.dataset.showcase;delete document.body.dataset.showcaseStep;
 $('stop-action-showcase').disabled=true;$('play-action-showcase').textContent='▶ 音つきで一通り再生';
 if(wasActive){$('action-showcase-status').textContent=message;if(clear){clearCue();effects.stopAudio();stateSpeech();}}
}
function playShowcase(steps=showcaseSteps){
 stopShowcase();clearCue();effects.stopAudio();
 desiredSound=true;void unlockSound();
 document.body.dataset.showcase='playing';
 $('stop-action-showcase').disabled=false;$('play-action-showcase').textContent='↻ はじめから再生';
 $('action-showcase').scrollIntoView({behavior:'instant',block:'start'});
 showcase.play(steps);
}
$('play-action-showcase').addEventListener('click',()=>playShowcase());
$('preview-toast-only').addEventListener('click',()=>playShowcase([showcaseSteps[0]]));
$('preview-alert-toast').addEventListener('click',()=>playShowcase([showcaseSteps[7]]));
$('stop-action-showcase').addEventListener('click',()=>stopShowcase());
// A real action or notification takes over; a stopped tour never resumes later.
document.addEventListener('click',event=>{
 if(showcase.active&&event.target.closest('button,input,select,a')&&!event.target.closest('#action-showcase,#sound-button,#close-toast'))stopShowcase();
},{capture:true});
document.addEventListener('change',event=>{if(showcase.active&&!event.target.closest('#action-showcase'))stopShowcase();},{capture:true});
document.addEventListener('keydown',event=>{if(event.key==='Escape')stopShowcase();},{capture:true});
function motion(el,frames,options={}){if(reduce.matches||intensity==='off')return null;const a=el.animate(frames,{duration:500,easing:'cubic-bezier(.22,.7,.25,1)',...options});animations.add(a);a.finished.catch(()=>{}).finally(()=>animations.delete(a));return a;}
function later(fn,delay){const id=setTimeout(()=>{cueTimers=cueTimers.filter(v=>v!==id);fn();},delay);cueTimers.push(id);}
function stopVideo(){videoRun++;const video=$('mascot-video');video.pause();$('mascot').classList.remove('video-playing');}
function playVideo(type='tap'){const video=$('mascot-video');if(characterProfile||!video.getAttribute('src')||reduce.matches||intensity==='off')return false;const run=++videoRun;video.currentTime=type==='detect'?6:0;video.play().then(()=>{if(run!==videoRun){if(!$('mascot').classList.contains('video-playing'))video.pause();return;}$('mascot').classList.add('video-playing');}).catch(()=>{if(run===videoRun)stopVideo();});return true;}
$('mascot-video').addEventListener('ended',stopVideo);
$('mascot-video').addEventListener('error',stopVideo);
function clearCue({preserveToast=false}={}){playfulTimer.clear();$('lyric-preview-status').textContent='開始前でも再生できます · 約5秒';lyric.clear();if(!preserveToast)hideToast();stopVideo();delete document.body.dataset.detection;$('detection-alert').hidden=true;cueTimers.forEach(clearTimeout);cueTimers=[];animations.forEach(a=>a.cancel());animations.clear();reactionMarks.forEach(el=>el.remove());reactionMarks.clear();effects.clear({audio:false});$('milestone-ribbon').style.opacity='0';}
function speak(text,sub='ONE STEP AT A TIME.'){const el=$('speech');el.replaceChildren(document.createTextNode(text));const s=document.createElement('span');s.textContent=sub;el.append(s);}
function stateSpeech(){const labels={ready:['一緒に始めよう',"LET'S DO THIS."],running:['一緒に進めよう','YOU SET THE PACE.'],paused:['ここで、ひと息。','PAUSED. TAKE YOUR TIME.'],break:['ひと休みしよう','BREATHE IN. BREATHE OUT.'],ended:['また一緒に！','SEE YOU NEXT SESSION.'],completed:['やりきったね！','SESSION COMPLETE.']};speak(...(labels[currentView().status]||['状態を確認しよう','CAMERA IS STOPPED.']));}
function mascotMotion(type){const power=intensity==='max'?1:.65;const distance=Math.min(innerWidth<650?28:40,type==='complete'?40:type==='tap'?26:34)*power;let frames;
 if(type==='detect')frames=[{transform:'scale(1)'},{transform:'translateY(-20px) rotate(-12deg) scale(1.05)',offset:.25},{transform:'translateX(12px) rotate(10deg) scale(1.08)',offset:.5},{transform:'translateX(-10px) rotate(-6deg)',offset:.75},{transform:'scale(1)'}];
 else if(pattern==='fever'&&!['pause','break'].includes(type))frames=[{transform:'scale(1)'},{transform:'scale(1.18,.8)',offset:.12},{transform:`translateY(-${distance}px) rotate(-12deg) scale(.94,1.08)`,offset:.3},{transform:'scale(1.12,.88)',offset:.47},{transform:`translate(10px,-${distance*.8}px) rotate(15deg)`,offset:.7},{transform:'scale(1.06,.94)',offset:.87},{transform:'scale(1)'}];
 else if(type==='pause')frames=[{transform:'scale(1)'},{transform:'scale(1.08,.92)'},{transform:'scale(1)'}];
 else if(type==='break')frames=[{transform:'rotate(0)'},{transform:'translateY(8px) rotate(-12deg) scale(1.02,.93)'},{transform:'rotate(-5deg)'},{transform:'rotate(0)'}];
 else if(pattern==='rush')frames=[{transform:'translateX(0) scale(1)'},{transform:'translateX(-12px) skewX(9deg) scale(1.12,.84)',offset:.25},{transform:`translate(28px,-${distance}px) rotate(10deg) scale(.94,1.08)`,offset:.5},{transform:'translateX(-4px) scale(1.1,.9)',offset:.8},{transform:'translateX(0) scale(1)'}];
 else if(pattern==='orbit')frames=[{transform:'translate(0,0) rotate(0)'},{transform:`translate(16px,-${distance*.7}px) rotate(13deg)`},{transform:`translate(-12px,-${distance}px) rotate(-10deg)`},{transform:'translate(0,0) rotate(0)'}];
 else frames=[{transform:'scale(1)'},{transform:'scale(1.16,.81)',offset:.18},{transform:`translateY(-${distance}px) scale(.92,1.1) rotate(-5deg)`,offset:.46},{transform:'scale(1.1,.89)',offset:.78},{transform:'scale(1)'}];
 motion($('mascot'),frames,{duration:type==='pause'?450:profiles[pattern].duration});
}
function center(el){const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height*.6};}
function reactionSticker(text,el,{level=1,tone='lime'}={}){
 if(reduce.matches||intensity==='off')return;
 const r=el.getBoundingClientRect(),mark=document.createElement('span');
 mark.className=`reaction-sticker reaction-${tone}`;mark.textContent=text;mark.setAttribute('aria-hidden','true');
 mark.style.left=`${Math.max(90,Math.min(innerWidth-90,r.x+r.width*.55))}px`;
 mark.style.top=`${Math.max(45,Math.min(innerHeight-45,r.y+r.height*.24))}px`;
 mark.style.setProperty('--reaction-scale',String(1+(level-1)*.12));
 document.body.append(mark);reactionMarks.add(mark);
 const animation=motion(mark,[
  {opacity:0,transform:'translate(-50%,18px) rotate(-14deg) scale(.4)'},
  {opacity:1,transform:'translate(-50%,-8px) rotate(-6deg) scale(1.12)',offset:.2},
  {opacity:1,transform:'translate(-50%,-16px) rotate(-6deg) scale(1)',offset:.6},
  {opacity:0,transform:'translate(-50%,-48px) rotate(1deg) scale(.94)'}
 ],{duration:intensity==='max'?1150:750});
 animation?.finished.catch(()=>{}).finally(()=>{mark.remove();reactionMarks.delete(mark);});
}
function normalReaction(type,level=1){
 if(!['tap','start','resume','milestone','break','complete'].includes(type)||reduce.matches||intensity==='off')return;
 const color=type==='break'?'#43dcea':type==='resume'?'#ff55c8':'#c5fc29';
 motion(document.querySelector('.hero'),[
  {boxShadow:'inset 0 0 0 transparent'},
  {boxShadow:`inset 0 0 48px ${color}40, 0 0 26px ${color}66`,offset:.22},
  {boxShadow:'inset 0 0 0 transparent'}
 ],{duration:1100});
 if(type==='tap'){
  reactionSticker(['POP!','BOUNCE!','BOOM!'][level-1],$('mascot'),{level});
  motion($('speech'),[{transform:'rotate(-7deg) scale(1)'},{transform:'rotate(3deg) scale(1.12)',offset:.3},{transform:'rotate(-9deg) scale(.98)',offset:.65},{transform:'rotate(-7deg) scale(1)'}],{duration:600});
  // The container also reacts while the single video character is playing.
  if(pattern==='fever')motion($('mascot-float'),[{transform:'translateY(0)'},{transform:`translateY(-${12*level}px) rotate(-4deg)`,offset:.35},{transform:'translateY(0)'}],{duration:650});
 }else if(type==='break')reactionSticker('BREATHE.',$('mascot'),{tone:'cyan'});
 else if(type==='resume')reactionSticker('WELCOME BACK!',$('mascot'),{tone:'pink'});
}
function showLyric(kind){const played=lyric.play({kind,reduced:reduce.matches,intensity});$('lyric-preview-status').textContent=played?'全画面で再生中…':reduce.matches?'OSの動きを減らす設定により停止中です。':'演出量がOFFです。下部の演出量をPOPまたはMAXにしてください。';if(played)later(()=>{$('lyric-preview-status').textContent='もう一度再生できます · 約5秒';},4600);return played;}
function cue(type,{demo=false,lyricKind='start',actionLevel,source='demo',message='スマホから目を離して、いまの一歩へ。',silent=false,replay=false,preserveToast=false}={}){clearCue({preserveToast});const lyricPreview=type==='lyric';if(lyricPreview)type=lyricKind;if(type==='video'&&characterProfile){cue('tap',{demo:true,actionLevel:3});return;}if(type==='video'){if(!playVideo()){$('demo-caption').textContent=intensity==='off'||reduce.matches?'動きを抑える設定のため、動画を停止しています。':'動画を準備中です。';return;}speak('動くDOTS、登場！','GENERATED WITH RUNWAY.');$('demo-caption').textContent='Runway生成動画：1体のDOTSのリアクション';later(stateSpeech,10500);return;}const loc=center(type==='complete'||type==='milestone'?$('timer-stage'):$('mascot'));
 const level=actionLevel??(['rush','fever'].includes(pattern)?3:2);
 effects.fire(type,{...loc,level,audible:!silent});
 normalReaction(type,level);
 if(!(pattern==='fever'&&['start','tap','complete','detect'].includes(type)&&playVideo(type)))mascotMotion(type);
 const copy={start:[profiles[pattern].slogan,'READY. SET. FOCUS.'],resume:['おかえり！','BACK TO YOUR OWN PACE.'],tap:[pattern==='rush'?'まかせて！':pattern==='orbit'?'そばにいるよ。':'呼んだ？','YOUR LITTLE COMPANION.'],milestone:['ひと区切り！','ONE MORE STEP.'],break:['ひと休みしよう','BREATHE IN. BREATHE OUT.'],pause:['ここで、ひと息。','PAUSE IS PART OF THE PLAN.'],complete:['やりきったね！','YOU SHOWED UP. WELL DONE.'],notify:['いまの作業に戻ろう','GENTLE REMINDER.'],detect:['いまの作業に戻ろう','BACK TO YOUR TASK.']};speak(...copy[type]);
 if(type==='detect'){showLyric('detect');document.body.dataset.detection='active';$('detection-alert').hidden=false;$('detection-kicker').textContent=(replay?'直近の通知 / ':'')+(source==='test'?'DISPLAY TEST / 表示テスト':source==='api'?(api.snapshot?.provider==='mock'?'MOCK API / 模擬判定の通知':'API / スマホ保持の通知'):demo?'DETECTION ACTION / 演出プレビュー':'PHONE ACTIVITY / 検知シミュレーション');$('detection-alert').querySelector('p').textContent=message;
 motion($('detection-alert'),[{opacity:0,transform:'translateY(-24px) scale(.94)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:450});
 motion($('timer-stage'),[{filter:'drop-shadow(0 0 0 transparent)'},{filter:'drop-shadow(0 0 24px #ff934c)',offset:.3},{filter:'drop-shadow(0 0 0 transparent)'}],{duration:1700});
 if(intensity==='max'&&!reduce.matches)later(()=>effects.fire('detect',{...center($('timer-stage')),audible:false}),950);
 later(()=>{delete document.body.dataset.detection;$('detection-alert').hidden=true;stopVideo();stateSpeech();},4600);
 }
 if(type!=='detect'&&(lyricPreview||(pattern==='fever'&&['start','complete'].includes(type))))showLyric(type);
 if(['start','resume','milestone','complete'].includes(type)){
  motion($('timer-stage'),[{filter:'brightness(1)'},{filter:'brightness(1.4)',offset:.25},{filter:'brightness(1)'}],{duration:1000});
  const ribbon=$('milestone-ribbon');ribbon.textContent=type==='complete'?'SESSION COMPLETE!':type==='milestone'?'NICE STEP!':type==='resume'?'WELCOME BACK!':'LET’S FOCUS!';
  motion(ribbon,[{opacity:0,transform:'translateY(10px) scale(.88)'},{opacity:1,transform:'translateY(0) scale(1)',offset:.2},{opacity:1,offset:.76},{opacity:0,transform:'translateY(-9px)'}],{duration:1900});
  if(pattern==='fever'&&type==='complete'&&intensity==='max'&&!reduce.matches)later(()=>effects.fire('complete',{...center($('timer-stage')),level:3,audible:false}),750);
  if(pattern==='rush')motion($('companion-stage'),[{filter:'drop-shadow(0 0 0 transparent)'},{filter:'drop-shadow(-12px 0 0 #bbff2630) drop-shadow(15px 0 0 #9c55ff25)'},{filter:'drop-shadow(0 0 0 transparent)'}],{duration:750});
  if(pattern==='orbit')motion(document.querySelector('.companion-orbit'),[{transform:'rotate(-25deg) scale(.7)',opacity:0},{transform:'rotate(125deg) scale(1.15)',opacity:1},{transform:'rotate(300deg) scale(1)',opacity:.4}],{duration:1500});
 }
 if(demo)$('demo-caption').textContent=`${profiles[pattern].title}：${{tap:'通常リアクション',start:'開始',pause:'一時停止',resume:'再開',milestone:'節目',break:'休憩',complete:'完了',detect:'検知アクション'}[type]}の演出プレビュー（タイマーは変更しません）`;
 if(type!=='detect')later(stateSpeech,2500);
}
function format(s){const n=Math.max(0,Math.ceil(s));return `${Math.floor(n/60).toString().padStart(2,'0')}:${(n%60).toString().padStart(2,'0')}`;}
function render(){
 const view=currentView(),state=view.status,busy=Boolean(apiOperation||api.busy);
 document.body.dataset.state=state;
 playfulTimer.update({...view,intensity,reduced:reduce.matches});
 $('elapsed').textContent=format(Math.floor(view.elapsed));$('percent').innerHTML=`${Math.round(view.ratio*100)}<span>%</span>`;
 $('duration-label').textContent=`${view.duration/60}分セッション`;
 document.querySelectorAll('.ring-value').forEach(el=>el.style.strokeDasharray=`${view.ratio*100} 100`);
 document.querySelectorAll('.ring-segments path').forEach((path,i)=>{const start=i/36*100+.22;const end=Math.min((i+1)/36*100-.22,view.ratio*100);if(end<=start){path.setAttribute('d','');return;}const a=start/100*Math.PI*2,b=end/100*Math.PI*2;path.setAttribute('d',`M ${220+192*Math.cos(a)} ${220+192*Math.sin(a)} A 192 192 0 0 1 ${220+192*Math.cos(b)} ${220+192*Math.sin(b)}`);});
 const angle=view.ratio*Math.PI*2;$('ring-tip').setAttribute('cx',220+192*Math.cos(angle));$('ring-tip').setAttribute('cy',220+192*Math.sin(angle));$('ring-tip').style.opacity=view.ratio>0?'1':'0';
 const active=state==='running',stopped=['paused','break','ended','completed','unknown'].includes(state);
 $('session-status').textContent={ready:'READY',running:'IN SESSION',paused:'PAUSED',break:'ON A BREAK',ended:'SESSION ENDED',completed:'COMPLETE',unknown:'STATE UNCONFIRMED'}[state];
 $('remaining-label').textContent={paused:'一時停止中',break:'休憩中',ended:'セッション終了',completed:'完了！',unknown:'API状態未確認'}[state]||'残り時間';
 const main=$('main-action');main.querySelector('span').textContent=busy?'確認中…':state==='unknown'?'再確認':active?'一時停止':['paused','break'].includes(state)?'再開':['ended','completed'].includes(state)?'もう一度':'はじめる';main.querySelector('use').setAttribute('href',active?'#i-pause':'#i-play');
 const canStart=apiMode==='demo'||apiStatus==='ready';
 main.disabled=busy||(!active&&!['paused','break','unknown'].includes(state)&&!canStart);
 $('break-action').disabled=busy||!['running','paused'].includes(state);$('end-action').disabled=busy||!['running','paused','break','unknown'].includes(state);
 $('camera-paused').hidden=apiMode==='connected'?Boolean(cameraStream):!stopped;
 $('camera-status').textContent=cameraStream?(apiMode==='connected'&&api.active?'カメラ有効':'ローカルプレビュー'):apiMode==='demo'?'デモ映像':'カメラ停止';
 $('simulate-detection').disabled=apiMode!=='demo'||!active||!session.notificationEnabled;
 $('test-notification').disabled=!session.notificationEnabled;$('test-desktop-overlay').disabled=!session.notificationEnabled||!$('desktop-overlay-enabled').checked;$('notification-count').textContent=view.notificationCount;
 const locked=busy||['running','paused','break','unknown'].includes(state);
 $('duration-select').disabled=locked;$('duration-help').textContent=locked?'時間の変更はセッション終了後にできます。':apiMode==='connected'?'APIでは一時停止中もセッションの期限が進みます。':'次に始めるセッションの時間を選べます。';
 if($('api-mode'))$('api-mode').disabled=locked;
 renderApi();
 renderMonitor();
}
function renderMonitor(){
 const view=currentView();
 const cameraState=!cameraStream?'カメラ停止中':apiMode==='demo'?'ローカルプレビュー':apiState!=='running'?'撮影待ち':api.snapshot?.state==='unknown'?'判定できません · 手元を確認':api.snapshot?.state==='suspected'?'スマホ保持を確認中':'カメラ有効 · API判定中';
 const freshness=cameraStream&&lastFrameAt?` · ${Math.max(0,Math.floor((Date.now()-lastFrameAt)/1000))}秒前` : '';
 mini.update({status:view.status,remaining:format(view.remaining),profile:characterProfile,cameraText:cameraState+freshness,notificationCount:view.notificationCount,notificationEnabled:session.notificationEnabled,motion:!reduce.matches&&intensity!=='off',disabled:$('main-action').disabled});
 document.title=`${format(view.remaining)} · ${{running:'集中中',paused:'一時停止',break:'休憩中',completed:'完了',ended:'終了',unknown:'接続を確認'}[view.status]||'FOCUS!'} — FOCUS!`;
 const supported='Notification' in window;
 const permission=supported?Notification.permission:'unsupported';
 $('desktop-notification-status').textContent={granted:'デスクトップ通知：許可済み',denied:'通知はブラウザのサイト設定から許可できます',default:'デスクトップ通知：未許可',unsupported:'このブラウザはデスクトップ通知に未対応。小窓を利用してください。'}[permission];
 $('enable-desktop-notification').disabled=!supported||permission==='granted';
}
async function openMini(){
 effects.playSound('press');
 const result=await mini.open();
 $('mini-status').textContent=result.message;
 renderMonitor();
 return result;
}
function desktopNotify(message,{test=false,title='FOCUS! 集中サポート'}={}){
 if(!session.notificationEnabled||!('Notification' in window)||Notification.permission!=='granted'||(!document.hidden&&document.hasFocus()&&!test))return;
 try{
  desktopNotice?.close();
  desktopNotice=new Notification(title,{body:message,icon:characterProfile?new URL(characterProfile.asset,location.href).href:undefined,tag:'focus-session-notice',silent:true});
  desktopNotice.onclick=()=>{window.focus();desktopNotice?.close();};
 }catch{$('desktop-notification-status').textContent='デスクトップ通知を表示できませんでした。小窓でお知らせします。';}
}
function detectionContext(){return apiMode==='demo'?`demo:${session.generation}`:`api:${api.sessionId}:${api.generation}`;}
function replayDetection(){
 const notice=detectionReplay.take({context:detectionContext(),enabled:session.notificationEnabled,status:currentView().status,visible:!document.hidden,focused:document.hasFocus()});
 if(!notice)return;
 // Replay visuals only: no API calls, counters, sound, or repeated system/mini notices.
 cue('detect',{source:notice.origin,message:notice.message,silent:true,replay:true,preserveToast:true});
}
function showBrowserDetection(notice){
 detectionReplay.remember(notice,{context:detectionContext(),unseen:document.hidden||!document.hasFocus()});
 if(!document.hidden)cue('detect',{source:notice.origin,message:notice.message,silent:true,preserveToast:true});
}
async function showFocusNotification({message='スマホから目を離して、いまの一歩へ。',source='検知シミュレーション',kind='detect',origin='demo'}={}){
 if(!session.notificationEnabled)return;
 stopShowcase();
 const generation=++notificationGeneration;
 const notice={message,source,kind,origin:kind==='test'?'test':origin};
 clearCue();detectionReplay.clear();
 effects.playSound('detect');
 if(mini.active)mini.notify(message);
 else if(!document.hidden)toast.show({message,profile:characterProfile,kind,source,motion:!reduce.matches&&intensity!=='off'});
 desktopNotify(message,{test:kind==='test'});
 later(stateSpeech,8000);
 if($('desktop-overlay-enabled').checked){
  const delivered=await desktopOverlay.show({character:characterProfile?.id||'green',message,kind,intensity,reduced:reduce.matches});
  if(generation!==notificationGeneration||!session.notificationEnabled)return;
  if(delivered){$('desktop-overlay-status').textContent='Macの画面全体に警告を表示しました';return;}
 }
 showBrowserDetection(notice);
}
function cancelDesktopCue({keepalive=false}={}){
 notificationGeneration++;
 if(desktopTestTimer!==null)clearTimeout(desktopTestTimer);
 desktopTestTimer=null;
 void desktopOverlay.clear({keepalive});
}
async function refreshDesktopStatus(){
 if(desktopStatusBusy)return;
 desktopStatusBusy=true;
 const connected=await desktopOverlay.refresh();
 desktopStatusBusy=false;
 $('desktop-overlay-status').textContent=connected?'接続済み · ほかのアプリの上にも表示できます':'Mac表示アプリを起動すると、デスクトップ全体に表示できます';
 $('test-desktop-overlay').disabled=!session.notificationEnabled||!$('desktop-overlay-enabled').checked;
}

function notifyCompletion(){
 if(document.hidden)effects.playSound('complete');
 if(!session.notificationEnabled)return;
 mini.notify('セッション完了！ひと休みしよう。');
 desktopNotify('セッション完了！ひと休みしよう。');
}
function renderApi(){
 const put=(id,text)=>{if($(id))$(id).textContent=text;};
 const provider=api.snapshot?.provider||api.health?.provider;
 put('api-provider',provider==='mock'?'MOCK · 画像解析なし':provider==='openai'?'OPENAI · 画像判定':'プロバイダー未確認');
 put('api-status',apiMode==='demo'?'演出デモ':apiOperation?'API操作を確認中':apiError?'APIの確認が必要':{checking:'API設定を確認中',ready:'APIへ接続可能',unconfigured:'API未設定',error:'API接続エラー'}[apiStatus]||'API未確認');
 put('api-detail',apiMode==='demo'?'カメラ画像は送信しません。検知は手動シミュレーションです。':apiError||apiDetail||(api.health?.configured?'接続設定を確認しました。カメラの有効化とセッション開始後に、共有APIへ画像を送信して判定します。':'APIの設定を確認してください。'));
 const stateLabels={observing:'見守り中',suspected:'スマホ保持を確認中',cooldown:'通知後の待機',unknown:'判定できません',paused:'一時停止',ended:'終了'};
 const reasons={insufficient_visibility:'人・手元が十分見えません',provider_not_configured:'判定プロバイダーが未設定',provider_error:'判定プロバイダーのエラー',decision_timeout:'判定が時間切れ',decision_refused:'判定が拒否されました',invalid_decision:'判定応答の形式が不正',stale_result:'古い判定結果を破棄',decision_interrupted:'判定が中断されました'};
 const snapshot=api.snapshot;
 const observationLabel=apiState==='running'&&!cameraStream?'撮影待ち':stateLabels[snapshot?.state]||'状態未確認';
 put('api-observation',apiMode==='demo'?'デモモード · API判定なし':snapshot?`${apiState==='unknown'?'API状態未確認 · 前回: ':''}${observationLabel}${reasons[snapshot.reason]?` · ${reasons[snapshot.reason]}`:''} · ${cameraMessage}`:cameraMessage);
 if(apiMode==='connected')put('detection-status','実際の検知は共有APIが判定します。手動シミュレーションは「演出デモ」で利用できます。');
 if($('api-retry'))$('api-retry').disabled=Boolean(apiOperation||api.busy);
 if($('camera-enable'))$('camera-enable').disabled=cameraPending||Boolean(cameraStream)||Boolean(apiOperation);
 if($('camera-disable'))$('camera-disable').disabled=!cameraPending&&!cameraStream&&!captureBusy;
}
function clearCaptureTimer(){if(captureTimer!==null)clearTimeout(captureTimer);captureTimer=null;}
function stopCamera(message='カメラを停止しました。再開時はカメラを有効にしてください。'){
 cameraGeneration++;clearCaptureTimer();api.stopFrames();
 if(cameraStream)cameraStream.getTracks().forEach(track=>track.stop());cameraStream=null;frameCapture=null;cameraPending=false;
 const video=$('live-camera');if(video){video.pause();video.srcObject=null;video.hidden=true;video.closest('.camera-preview')?.classList.remove('is-live');}
 document.body.dataset.camera='off';cameraMessage=message;
}
function canCapture(){return apiMode==='connected'&&apiState==='running'&&api.active&&Boolean(cameraStream);}
function scheduleCapture(delay){
 clearCaptureTimer();if(!canCapture())return;
 const generation=cameraGeneration;
 captureTimer=setTimeout(()=>{captureTimer=null;captureAndSend(generation);},delay);
}
async function captureAndSend(generation){
 if(captureBusy||generation!==cameraGeneration||!canCapture())return;
 captureBusy=true;
 try{
  const video=$('live-camera');
  const track=cameraStream?.getVideoTracks()[0];
  if(!track||track.readyState!=='live'||track.muted||!captureContext)throw new Error('カメラ映像を取得できません。');
  // A live-track frame avoids relying on hidden <video> repainting in supported browsers.
  const bitmap=frameCapture?await frameCapture.grabFrame():null;
  try{
   if(generation!==cameraGeneration||!canCapture())return;
   const width=bitmap?.width||video.videoWidth,height=bitmap?.height||video.videoHeight;
   if(!width||!height||(!bitmap&&video.readyState<2))throw new Error('カメラ映像を取得できません。');
   const factor=Math.min(640/width,480/height,1);captureCanvas.width=Math.max(1,Math.round(width*factor));captureCanvas.height=Math.max(1,Math.round(height*factor));captureContext.drawImage(bitmap||video,0,0,captureCanvas.width,captureCanvas.height);
  }finally{bitmap?.close();}
  const encode=quality=>new Promise((resolve,reject)=>captureCanvas.toBlob(blob=>blob?resolve(blob):reject(new Error('JPEGを作成できません。')),'image/jpeg',quality));
  let blob=await encode(.75);if(blob.size>1048576)blob=await encode(.45);if(blob.size>1048576)throw new Error('画像が1 MiBを超えています。');
  if(generation!==cameraGeneration||!canCapture())return;
  const result=await api.frame(blob);
  if(generation!==cameraGeneration||!result||apiMode!=='connected')return;
  if(result.snapshot.state==='ended'){apiState=result.snapshot.reason==='session_expired'?'completed':'ended';stopCamera('APIセッションが終了したためカメラを停止しました。');stopTransient();if(apiState==='completed'){notifyCompletion();if(!document.hidden)cue('complete');}}
  else if(result.snapshot.state==='paused'){apiState='paused';stopCamera();stopTransient();}
  if(result.notification&&session.notificationEnabled&&apiState==='running'){
   apiNotificationCount++;addLog(`${result.notification.provider==='mock'?'模擬API':'API'}が通知を発行`);showFocusNotification({origin:'api',message:result.notification.message,source:result.notification.provider==='mock'?'MOCK API · 模擬判定':'共有API · スマホ保持を検知'});
  }
  cameraMessage=result.snapshot.state==='unknown'?'画像は送信済みですが、判定できませんでした。':'カメラ有効 · 次の撮影間隔はAPIの指示に従います。';
  lastFrameAt=Date.now();render();scheduleCapture(result.snapshot.next_capture_after_ms);
 }catch(error){
  if(generation!==cameraGeneration)return;
  stopCamera('画像送信に失敗したため、カメラを停止しました。');apiError=`${error.message} 撮影は停止済みです。再確認してください。`;apiState='unknown';stopTransient();addLog('API画像送信エラー · 撮影停止');render();
 }finally{
  captureBusy=false;
  // A resumed session may have tried to capture while an old encode/request was unwinding.
  if(generation!==cameraGeneration&&captureTimer===null&&canCapture())scheduleCapture(api.snapshot?.next_capture_after_ms??0);
 }
}
async function enableCamera(){
 if(cameraPending||cameraStream)return;
 if(!navigator.mediaDevices?.getUserMedia){cameraMessage='このブラウザではカメラを利用できません。';render();return;}
 const generation=++cameraGeneration;cameraPending=true;cameraMessage='カメラの許可を確認中です。';render();
 try{
  const stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480}},audio:false});
  if(generation!==cameraGeneration){stream.getTracks().forEach(track=>track.stop());return;}
  cameraStream=stream;
  if(typeof ImageCapture==='function'){try{frameCapture=new ImageCapture(stream.getVideoTracks()[0]);}catch{frameCapture=null;}}
  const video=$('live-camera');video.srcObject=stream;video.hidden=false;await video.play();
  if(generation!==cameraGeneration){stream.getTracks().forEach(track=>track.stop());return;}
  document.body.dataset.camera='live';video.closest('.camera-preview')?.classList.add('is-live');
  cameraMessage=canCapture()?'カメラ有効 · APIに画像を送信します。':'ローカルプレビューのみ。APIセッション開始後に送信します。';
  for(const track of stream.getVideoTracks())track.addEventListener('ended',()=>{if(stream!==cameraStream)return;stopCamera('カメラ接続が終了しました。');if(apiMode==='connected'&&apiState==='running')runApiAction('pause');render();},{once:true});
  if(canCapture())scheduleCapture(api.snapshot?.next_capture_after_ms??0);
 }catch(error){if(generation!==cameraGeneration)return;stopCamera(error.name==='NotAllowedError'?'カメラの許可がありません。ブラウザの設定を確認してください。':`カメラを開始できません：${error.message}`);}
 finally{if(generation===cameraGeneration)cameraPending=false;render();}
}
function updateApiState(action){
 const snapshot=api.snapshot;if(!snapshot)return;
 apiState=snapshot.state==='ended'?(['session_expired','local_session_expired'].includes(snapshot.reason)?'completed':'ended'):snapshot.state==='paused'?(action==='break'?'break':'paused'):'running';
}
async function runApiAction(action,{keepalive=false,silent=false}={}){
 if(apiOperation||api.busy)return false;
 if(action==='start'&&apiStatus!=='ready')return false;
 if(['pause','break','end'].includes(action))stopCamera();else clearCaptureTimer();
 stopTransient();apiOperation=action;apiError='';render();
 try{
  if(action==='start'){await api.start({durationSeconds:session.duration});apiNotificationCount=0;lastMilestone=0;lastFrameAt=null;log=[];}
  else await api.control(action==='break'?'pause':action,{keepalive});
  updateApiState(action);
  if(apiState==='running'&&!api.active){stopCamera('開始・再開の確認中にカメラが停止されたため、一時停止しました。');await api.control('pause',{keepalive});updateApiState('pause');}
  apiStatus='ready';apiDetail=api.snapshot?.provider==='mock'?'モックAPIです。画像の内容を解析する判定ではありません。':'API状態を確認しました。判定結果は下に表示します。';
  if(!silent&&(document.hidden||(action==='end'&&apiState!=='completed')))effects.playSound(apiState==='completed'?'complete':action==='end'?'end':action);
  addLog(`API: ${{start:'セッション開始',pause:'一時停止',break:'休憩開始',resume:'再開',end:'終了'}[action]}`);
  if(!silent&&!document.hidden){if(apiState==='completed')cue('complete');else if(apiState==='running')cue(action==='start'?'start':'resume');else if(['paused','break'].includes(apiState))cue(apiState==='break'?'break':'pause');else stateSpeech();}
  if(canCapture())scheduleCapture(api.snapshot?.next_capture_after_ms??0);
  return true;
 }catch(error){
  stopCamera('API操作の結果を確認できないため、カメラを停止しました。');apiState=action==='start'&&!api.sessionId?'ready':'unknown';apiError=`${error.message} 撮影は停止済みです。サーバー側の状態は未確認です。`;addLog(`API操作を確認できませんでした (${error.code||'error'})`);return false;
 }finally{apiOperation=null;render();stateSpeech();}
}
async function refreshApi(){
 if(apiOperation||api.busy)return;
 apiOperation='check';apiStatus='checking';apiError='';render();
 try{
  const health=await api.checkHealth();apiStatus=health.configured?'ready':'unconfigured';
  apiDetail=health.configured?(health.provider==='mock'?'モックAPIに接続しています。画像の内容は解析しません。':'接続設定を確認しました。カメラの有効化とセッション開始後に、共有APIへ画像を送信して判定します。'):'判定プロバイダーが未設定です。';
  if(apiState==='unknown'&&api.sessionId){stopCamera();await api.control('pause');updateApiState('pause');apiDetail='API状態を確認して一時停止しました。再開にはカメラの有効化が必要です。';}
  if(apiState==='running'&&!api.active){stopCamera('確認中に撮影が停止されたため、一時停止しました。');await api.control('pause');updateApiState('pause');apiDetail='API状態を確認して一時停止しました。';}
 }catch(error){if(error.code==='session_not_found'){api.reset();apiState='ready';apiStatus=api.health?.configured?'ready':'unconfigured';apiError='前のAPIセッションは失効しました。新しいセッションを開始できます。';}else{apiStatus='error';apiError=`${error.message} (${error.code||'network_error'})`;}}
 finally{apiOperation=null;render();}
}
function addLog(text){log.unshift({text,time:new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'})});log=log.slice(0,60);const list=$('event-log');list.replaceChildren();for(const item of log){const li=document.createElement('li');const time=document.createElement('time');time.textContent=item.time;li.append(time,document.createTextNode(item.text));list.append(li);}}
function hideToast(){toast.hide({immediate:true});}
function stopTransient(){stopShowcase({clear:false});cancelDesktopCue();effects.stopAudio();detectionReplay.clear();clearCue();mini.clearNotice();desktopNotice?.close();}
function toggleMain(){
 if(!['running','unknown'].includes(currentView().status)&&!$('main-action').disabled&&$('auto-mini').checked)void openMini();
 if(apiMode==='connected'){
  if(apiState==='unknown'){refreshApi();return;}
  runApiAction(apiState==='running'?'pause':['paused','break'].includes(apiState)?'resume':'start');return;
 }
 stopTransient();if(session.status==='running'){session.pause();addLog('デモセッションを一時停止');render();cue('pause');}
 else if(['paused','break'].includes(session.status)){session.resume();addLog('デモセッションを再開');render();cue('resume');}
 else{session.start();log=[];lastMilestone=0;addLog('デモセッション開始');render();cue('start');}
}
$('main-action').addEventListener('click',toggleMain);
$('break-action').addEventListener('click',()=>{if(apiMode==='connected'){runApiAction('break');return;}if(!session.takeBreak())return;stopTransient();addLog('デモ休憩');render();cue('break');});
function endSession(){if(apiMode==='connected'){runApiAction('end');return;}if(!session.end())return;stopTransient();effects.playSound('end');addLog('デモセッション終了');render();stateSpeech();}
$('end-action').addEventListener('click',endSession);
$('api-retry')?.addEventListener('click',refreshApi);
$('camera-enable')?.addEventListener('click',enableCamera);
$('camera-disable')?.addEventListener('click',()=>{stopCamera();if(apiMode==='connected'&&apiState==='running')runApiAction('pause');render();});
$('api-mode')?.addEventListener('change',event=>{
 if(apiOperation||['running','paused','break','unknown'].includes(currentView().status)){event.target.value=apiMode;return;}
 stopCamera();stopTransient();apiMode=event.target.value==='demo'?'demo':'connected';
 $('detection-status').textContent=apiMode==='demo'?'デモセッション開始後に手動検知を試せます。':'検知シミュレーションはデモモードで利用できます。API通知はサーバーのnotifyに従います。';
 render();stateSpeech();if(apiMode==='connected')refreshApi();
});
$('mascot').addEventListener('click',()=>{const now=performance.now();tapLevel=now-lastTapAt<1500?Math.min(3,tapLevel+1):1;lastTapAt=now;cue('tap',{actionLevel:tapLevel});});
function setPattern(value,{animate=true}={}){if(!profiles[value])return;cancelDesktopCue();clearCue();pattern=value;effects.setTheme(value==='fever'?'fever':'classic');document.body.dataset.pattern=value;document.querySelectorAll('[data-choice]').forEach(b=>{b.classList.toggle('selected',b.dataset.choice===value);b.setAttribute('aria-pressed',b.dataset.choice===value);});$('pattern-caption').textContent=profiles[value].caption;$('demo-caption').textContent=`${profiles[value].title}：左のDOTSをタップして、動きを試せます。`;const url=new URL(location.href);url.searchParams.set('pattern',value);history.replaceState(null,'',url);if(animate)cue('tap');}
for(const button of document.querySelectorAll('[data-choice]'))button.addEventListener('click',()=>setPattern(button.dataset.choice));
for(const button of document.querySelectorAll('[data-card]'))button.addEventListener('click',()=>cue('lyric',{demo:true,lyricKind:button.dataset.card}));
for(const button of document.querySelectorAll('[data-demo]'))button.addEventListener('click',()=>cue(button.dataset.demo,{demo:true}));
$('intensity').addEventListener('change',e=>{intensity=e.target.value;cancelDesktopCue();document.body.dataset.intensity=intensity;clearCue();effects.setIntensity(intensity);stateSpeech();$('demo-caption').textContent=`演出量：${intensity.toUpperCase()}`;});
function renderSound(){
 if(soundContext!==effects.audioContext){
  soundContext?.removeEventListener('statechange',renderSound);
  soundContext=effects.audioContext;
  soundContext?.addEventListener('statechange',renderSound);
 }
 sound=Boolean(desiredSound&&effects.soundEnabled&&soundContext?.state==='running');
 $('sound-button').setAttribute('aria-pressed',String(sound));
 $('sound-button').querySelector('span').textContent=sound?'音 ON':desiredSound?'音を有効に':'音 OFF';
}
function unlockSound(){
 renderSound();
 if(!desiredSound||(effects.soundEnabled&&effects.audioContext?.state==='running')||audioUnlock)return audioUnlock;
 const pending=effects.setSound(true);
 renderSound();
 audioUnlock=pending.finally(()=>{audioUnlock=null;renderSound();});
 return audioUnlock;
}
$('sound-button').addEventListener('click',async()=>{
 renderSound();
 if(sound){desiredSound=false;sound=false;await effects.setSound(false);renderSound();}
 else{desiredSound=true;await unlockSound();if(sound)effects.playSound('tap');}
});
// Browsers require a user gesture before audio. The first app action unlocks it.
document.addEventListener('pointerdown',event=>{if(!event.target.closest('#sound-button'))void unlockSound();},{capture:true});
document.addEventListener('keydown',event=>{if(!event.target.closest('#sound-button'))void unlockSound();},{capture:true});
renderSound();
$('notification-toggle').addEventListener('change',e=>{session.notificationEnabled=e.target.checked;$('notification-word').textContent=e.target.checked?'ON':'OFF';if(!e.target.checked){stopTransient();stateSpeech();}render();});
$('test-notification').addEventListener('click',()=>{if($('test-notification').disabled)return;showFocusNotification({kind:'test',message:'検知すると、このようにお知らせします。',source:'表示テスト · 全画面＋小窓／トースト'});addLog('全画面リリックと通知をテスト');});
$('simulate-detection').addEventListener('click',()=>{if(apiMode!=='demo')return;const generation=session.generation;if(!session.receiveDetection({generation})){$('detection-status').textContent='連続する通知を抑止しています。試作の間隔は60秒です。';return;}addLog('スマホ操作を検知（シミュレーション）');addLog('通知をアプリ内に表示（シミュレーション）');render();showFocusNotification();$('detection-status').textContent='検知 → 通知 → 専用リアクション。次の通知まで60秒以上空けます。';});
$('desktop-overlay-enabled').addEventListener('change',()=>{if(!$('desktop-overlay-enabled').checked)cancelDesktopCue();refreshDesktopStatus();});
$('test-desktop-overlay').addEventListener('click',()=>{
 if(!session.notificationEnabled||!$('desktop-overlay-enabled').checked)return;
 cancelDesktopCue();
 $('desktop-overlay-status').textContent='5秒後にテスト表示します。ほかのアプリへ切り替えてみてください';
 desktopTestTimer=setTimeout(()=>{desktopTestTimer=null;void showFocusNotification({kind:'test',message:'デスクトップでも、いまの作業に戻ろう！',source:'デスクトップ表示テスト'});},5000);
});
$('open-mini').addEventListener('click',openMini);
$('enable-desktop-notification').addEventListener('click',async()=>{
 if(!('Notification' in window))return;
 try{await Notification.requestPermission();}catch{$('desktop-notification-status').textContent='ブラウザのサイト設定から通知を許可してください。';}
 renderMonitor();
});
$('settings-tab').addEventListener('click',()=>{$('settings-dialog').showModal();});
$('duration-select').addEventListener('change',e=>{if(session.setDuration(Number(e.target.value))){cancelDesktopCue();if(apiMode==='connected'){api.reset();apiState='ready';apiNotificationCount=0;}clearCue();log=[];$('event-log').replaceChildren();const li=document.createElement('li');li.className='empty-log';li.textContent='はじめると、ここにイベントが表示されます。';$('event-log').append(li);render();stateSpeech();}});
$('logs-tab').addEventListener('click',()=>{$('log-panel').scrollIntoView({behavior:reduce.matches?'auto':'smooth',block:'nearest'});$('log-panel').classList.add('highlight');later(()=>$('log-panel').classList.remove('highlight'),1800);});
$('session-tab').addEventListener('click',()=>document.querySelector('.hero').scrollIntoView({behavior:reduce.matches?'auto':'smooth',block:'nearest'}));
$('settings-dialog').addEventListener('click',e=>{if(e.target===$('settings-dialog')){const r=$('settings-dialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('settings-dialog').close();}});
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!e.repeat&&e.target===document.body){e.preventDefault();toggleMain();}});
function suspendForPageExit({keepalive=false}={}){
 stopCamera('ページを閉じたためカメラを停止しました。');stopTransient();mini.close();
 if(apiMode==='connected'){if(apiState==='running'&&!apiOperation)runApiAction('pause',{keepalive,silent:true});}
 else if(session.status==='running'){session.pause();addLog('ページを閉じたためデモを一時停止');}
 render();stateSpeech();
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopShowcase();clearCue();}else{render();stateSpeech();replayDetection();}});
window.addEventListener('focus',replayDetection);
reduce.addEventListener('change',()=>{stopShowcase();cancelDesktopCue();clearCue();render();stateSpeech();});
const tick=setInterval(()=>{
 if(apiMode==='connected'){
  if(api.expire()){apiState='completed';stopCamera('設定時間が終了したためカメラを停止しました。');stopTransient();addLog('APIセッションの端末側期限に到達');render();notifyCompletion();if(!document.hidden)cue('complete');return;}
  if(api.startedAt!==null)render();return;
 }
 if(session.tick()){stopTransient();render();addLog('デモの設定時間が完了');notifyCompletion();if(!document.hidden)cue('complete');return;}
 if(session.status==='running'){const milestone=Math.floor((1-session.ratio)*4);if(milestone>lastMilestone&&milestone<4){lastMilestone=milestone;if(!document.hidden)cue('milestone');else effects.playSound('milestone');addLog(`${Math.round(milestone*25)}%の時間が経過`);}render();}
},250);
window.addEventListener('pagehide',event=>{cancelDesktopCue({keepalive:true});suspendForPageExit({keepalive:true});if(!event.persisted){clearInterval(tick);clearInterval(desktopStatusTick);soundContext?.removeEventListener('statechange',renderSound);effects.destroy();}});
window.addEventListener('pageshow',event=>{if(event.persisted){render();stateSpeech();refreshDesktopStatus();}});
// Each lit segment is clipped by the exact remaining-time ratio.
const svg=document.querySelector('.time-ring');
const segments=document.createElementNS('http://www.w3.org/2000/svg','g');segments.classList.add('ring-segments');
for(let i=0;i<36;i++)segments.append(document.createElementNS('http://www.w3.org/2000/svg','path'));
svg.insertBefore(segments,$('ring-tip'));
document.addEventListener('pointerdown',e=>{const button=e.target.closest('button');if(!button||button.disabled||button.id==='mascot'||reduce.matches||intensity==='off')return;const rect=button.getBoundingClientRect(),ripple=document.createElement('span');ripple.className='button-ripple';const size=Math.max(rect.width,rect.height)*2;ripple.style.cssText=`width:${size}px;height:${size}px;left:${e.clientX-rect.left-size/2}px;top:${e.clientY-rect.top-size/2}px`;button.append(ripple);const a=motion(ripple,[{transform:'scale(0)',opacity:.35},{transform:'scale(1)',opacity:0}],{duration:600});if(a)a.finished.catch(()=>{}).finally(()=>ripple.remove());else ripple.remove();});
document.addEventListener('click',e=>{
 const button=e.target.closest('button');
 if(!button||button.disabled||reduce.matches||intensity==='off'||button.closest('dialog'))return;
 if(button.closest('#action-showcase')||button.matches('#mascot,#main-action,#break-action,#end-action,#close-toast,#simulate-detection,#test-notification,#open-mini,#enable-desktop-notification,#test-desktop-overlay,#sound-button,[data-choice],[data-card],[data-demo]'))return;
 if(['paused','break','ended','completed','unknown'].includes(currentView().status))return;
 effects.fire('press',{...center(button),level:2});
 motion(button,[{transform:'scale(1)'},{transform:'scale(.94)',offset:.2},{transform:'scale(1.06)',offset:.55},{transform:'scale(1)'}],{duration:450});
});
setupCharacterPicker({onChange:profile=>{
 cancelDesktopCue();clearCue();characterProfile=profile;lyric.setCharacter(profile);
 document.body.style.setProperty('--character-accent',profile.color);
 document.querySelectorAll('.dots-type-thumbnail').forEach(el=>{
  el.querySelector('path').setAttribute('d',profile.silhouette);
  el.querySelector('path').setAttribute('fill',el.closest('[data-card]')?.dataset.card==='detect'?'#ffbf38':profile.color);
 });
 $('mascot').setAttribute('aria-label',`${profile.name}をタップしてリアクションを見る`);
 $('video-demo').textContent='▶ DOTSアクション';
 stateSpeech();
}});
const desktopStatusTick=showcaseView?null:setInterval(()=>{if(!document.hidden&&desktopTestTimer===null)refreshDesktopStatus();},3000);
if(!showcaseView)refreshDesktopStatus();
setPattern(new URL(location.href).searchParams.get('pattern')||'bounce',{animate:false});render();stateSpeech();if(!showcaseView)refreshApi();
