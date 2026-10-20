(function () {
  'use strict';
  const { db, qs, esc } = Signage;
  const key = new URLSearchParams(location.search).get('key');
  const root = qs('#playerRoot');
  const savedKey = `clinic-signage:last-state:${key || 'none'}`;
  const EMERGENCY_CACHE = 'clinic-signage-emergency-v1';

  let state = null;
  let index = 0;
  let lastStateSig = '';
  let lastPlaylistSig = '';
  let lastNonce = null;
  let lastError = null;
  let retryTimer = null;
  let expireTimer = null;
  let wakeLock = null;
  let cycleFailures = 0;
  let recoveryTimer = null;
  let heartbeatTimer = null;
  let lastHeartbeatAt = 0;
  let emergencyObjectUrl = null;
  let emergencyPlaying = false;
  let serverClockOffsetMs = 0;
  let fetchInFlight = false;
  let fetchQueued = false;
  let heartbeatInFlight = false;
  let heartbeatQueued = false;
  let syncStartTimer = null;
  let transitionTimer = null;
  const MAX_EMERGENCY_CACHE_BYTES = 250 * 1024 * 1024;

  if (!key) { root.innerHTML = '<div class="player-message">플레이어 키가 없습니다.</div>'; return; }

  function playlistSignature(s) {
    return `${s?.mode||''}|${s?.sync_revision||s?.broadcast_revision||0}|${(s?.playlist||[]).map(v=>`${v.id}:${v.url||''}`).join(',')}`;
  }
  function stateSignature(s) {
    const r=s?.room||{};
    return `${playlistSignature(s)}|${r.volume}|${r.paused}|${r.overlay_text||''}|${s?.notice_text||''}`;
  }
  function current(){ const list=state?.playlist||[]; return list.length?list[index%list.length]:null; }
  function mediaUrl(v){
    return v?.url ? String(v.url) : '';
  }
  function emergencyUrl(){ return mediaUrl(state?.emergency_video); }
  function saveState(){ try{localStorage.setItem(savedKey,JSON.stringify(state));}catch(_){} }
  function loadSaved(){ try{const saved=JSON.parse(localStorage.getItem(savedKey)||'null'); if(saved?.playlist){state=saved;lastPlaylistSig=playlistSignature(saved);lastStateSig=stateSignature(saved);renderFull();}}catch(_){} }
  function updateServerClock(serverTime,requestStarted,requestEnded){ if(serverTime){const t=new Date(serverTime).getTime();const midpoint=(Number(requestStarted)+Number(requestEnded))/2;if(Number.isFinite(t)&&Number.isFinite(midpoint))serverClockOffsetMs=t-midpoint;} }
  function serverNow(){ return Date.now()+serverClockOffsetMs; }

  async function fetchState(){
    if(fetchInFlight){ fetchQueued=true; return; }
    if(!db){ if(!state)root.innerHTML='<div class="player-message">중앙 서버 연결 없음<br><small>저장된 재생 정보가 없습니다.</small></div>'; return; }
    fetchInFlight=true;
    const requestStarted=Date.now();
    try{
      const {data,error}=await db.rpc('player_get_state',{p_key:key});
      if(error)throw error;
      if(!data){root.innerHTML='<div class="player-message">등록되지 않은 플레이어입니다.</div>';return;}
      updateServerClock(data.server_time,requestStarted,Date.now());
      if(lastNonce===null)lastNonce=data.room.reload_nonce;
      else if(data.room.reload_nonce!==lastNonce){location.reload();return;}

      const newPlaylistSig=playlistSignature(data);
      const newStateSig=stateSignature(data);
      const playlistChanged=newPlaylistSig!==lastPlaylistSig;
      const stateChanged=newStateSig!==lastStateSig;

      state=data;
      if(!emergencyPlaying)lastError=null;
      saveState(); scheduleExpiry(); scheduleTransition(); cacheEmergency().catch(()=>{});
      if(playlistChanged){ lastPlaylistSig=newPlaylistSig; index=0; cycleFailures=0; emergencyPlaying=false; renderFull(); }
      else if(stateChanged){ applyLiveControls(); renderBarsOnly(); }
      lastStateSig=newStateSig;
    }catch(e){
      lastError=e?.message||String(e);
      queueHeartbeat(true);
      if(!state)root.innerHTML='<div class="player-message">중앙 서버에 연결할 수 없습니다.</div>';
    }finally{
      fetchInFlight=false;
      if(fetchQueued){ fetchQueued=false; queueMicrotask(fetchState); }
    }
  }

  function bars(){ const texts=[state?.room?.overlay_text,state?.notice_text].filter(Boolean); return texts.length?`<div id="playerBar" class="player-bar"><div class="player-bar-static">${esc(texts.join(' · '))}</div></div>`:''; }
  function renderBarsOnly(){
    const old=qs('#playerBar'); if(old)old.remove();
    if(!state)return;
    const html=bars(); if(html)root.insertAdjacentHTML('beforeend',html);
  }
  function clearEmergencyObjectUrl(){ if(emergencyObjectUrl){URL.revokeObjectURL(emergencyObjectUrl);emergencyObjectUrl=null;} }
  function renderFull(){
    if(!state)return;
    clearTimeout(retryTimer); clearTimeout(recoveryTimer); clearTimeout(syncStartTimer); clearEmergencyObjectUrl(); emergencyPlaying=false;
    const v=current();
    if(!v||!mediaUrl(v)){
      root.innerHTML=`<div class="player-idle"><div class="player-idle-name">${esc(state.room?.name||'')}</div><div id="clock" class="player-clock"></div><div class="player-idle-sub">재생할 영상이 없습니다.</div></div>${bars()}`;
      updateClock(); queueHeartbeat(true); return;
    }
    root.innerHTML=`<video id="screenVideo" class="player-video" playsinline preload="auto"></video>${bars()}<button id="unmute" class="player-unmute hidden">화면을 눌러 소리 켜기</button>`;
    const el=qs('#screenVideo');
    el.volume=Math.max(0,Math.min(1,Number(state.room.volume||0)/100));
    el.muted=Boolean(state.room.force_mute);
    el.addEventListener('ended',()=>{cycleFailures=0;queueHeartbeat(true);next();});
    el.addEventListener('error',()=>handleMediaFailure(v));
    el.addEventListener('playing',()=>{lastError=null;cycleFailures=0;queueHeartbeat(true);});
    el.addEventListener('pause',()=>queueHeartbeat(true));
    el.addEventListener('canplay',()=>{lastError=null;});
    el.addEventListener('loadedmetadata',()=>startWithBroadcastSync(el));
    el.src=mediaUrl(v);
    if(state.room.paused)el.pause();
    root.onclick=enableSound;
  }
  async function startWithBroadcastSync(el){
    if(state?.room?.paused)return;
    const effective=state?.sync_effective_at?new Date(state.sync_effective_at).getTime():0;
    if(!effective){await play(el);return;}
    const delay=effective-serverNow();
    if(delay>40){syncStartTimer=setTimeout(()=>{if(el.isConnected&&!state?.room?.paused)play(el);},delay);return;}
    if(delay< -500 && Number.isFinite(el.duration) && el.duration>1){
      const elapsed=Math.max(0,(-delay)/1000);
      try{el.currentTime=elapsed%el.duration;}catch(_){}
    }
    await play(el);
  }
  function applyLiveControls(){
    const el=qs('#screenVideo'); if(!el||!state)return;
    const vol=Math.max(0,Math.min(1,Number(state.room.volume||0)/100));
    if(Math.abs(el.volume-vol)>0.01)el.volume=vol;
    if(state.room.force_mute&&!el.muted)el.muted=true;
    if(state.room.paused){ if(!el.paused)el.pause(); }
    else if(el.paused&&!el.ended)play(el);
    queueHeartbeat(true);
  }
  async function play(el){
    try{await el.play();}
    catch(_){
      el.muted=true;
      try{await el.play();qs('#unmute')?.classList.remove('hidden');}catch(e){lastError='자동재생 차단';queueHeartbeat(true);}
    }
  }
  function enableSound(){ const el=qs('#screenVideo'); if(el&&!state?.room?.force_mute){el.muted=false;play(el);} qs('#unmute')?.classList.add('hidden'); document.documentElement.requestFullscreen?.().catch(()=>{}); }
  function next(){ const list=state?.playlist||[]; if(!list.length)return; index=(index+1)%list.length; renderFull(); }

  async function cacheEmergency(){
    const url=emergencyUrl();
    if(!('caches' in window))return false;
    if(!url){await caches.delete(EMERGENCY_CACHE);return false;}
    const size=Number(state?.emergency_video?.size||0);
    if(size>MAX_EMERGENCY_CACHE_BYTES)return false;
    const cache=await caches.open(EMERGENCY_CACHE);
    const existing=await cache.match(url);
    if(existing)return true;
    const response=await fetch(url,{cache:'no-store'});
    if(!response.ok)throw new Error(`emergency_http_${response.status}`);
    await cache.put(url,response.clone());
    const keys=await cache.keys();
    await Promise.all(keys.filter((r)=>r.url!==new URL(url,location.href).href).map((r)=>cache.delete(r)));
    return true;
  }
  async function playEmergencyCached(){
    const url=emergencyUrl();
    if(!url||!('caches' in window))return false;
    try{
      const cache=await caches.open(EMERGENCY_CACHE);
      const response=await cache.match(url);
      if(!response)return false;
      const blob=await response.blob();
      clearEmergencyObjectUrl(); emergencyObjectUrl=URL.createObjectURL(blob); emergencyPlaying=true;
      const ev=state?.emergency_video;
      root.innerHTML=`<video id="screenVideo" class="player-video" playsinline autoplay loop></video>${bars()}<div class="player-emergency-badge">비상 재생</div><button id="unmute" class="player-unmute hidden">화면을 눌러 소리 켜기</button>`;
      const el=qs('#screenVideo');el.src=emergencyObjectUrl;el.volume=Math.max(0,Math.min(1,Number(state.room.volume||0)/100));el.muted=Boolean(state.room.force_mute);
      el.addEventListener('playing',()=>queueHeartbeat(true));el.addEventListener('error',()=>{lastError='비상영상 재생 실패';queueHeartbeat(true);});
      await play(el); root.onclick=enableSound; lastError='네트워크 장애 · 비상영상 재생 중'; queueHeartbeat(true); scheduleRecovery();
      return true;
    }catch(_){return false;}
  }
  async function probeMedia(){
    const url=mediaUrl(current()); if(!url)return false;
    try{const r=await fetch(url,{method:'GET',headers:{Range:'bytes=0-0'},cache:'no-store'});return r.ok||r.status===206;}catch(_){return false;}
  }
  function scheduleRecovery(){
    clearTimeout(recoveryTimer);
    recoveryTimer=setTimeout(async()=>{
      await fetchState();
      if(await probeMedia()){emergencyPlaying=false;renderFull();}
      else scheduleRecovery();
    },15000);
  }
  async function handleMediaFailure(v){
    lastError=`재생 실패: ${v?.title||v?.file_path||''}`;
    cycleFailures++;
    queueHeartbeat(true);
    const list=state?.playlist||[];
    clearTimeout(retryTimer); clearTimeout(recoveryTimer);
    if(list.length>1 && cycleFailures<list.length){ retryTimer=setTimeout(next,2500); return; }
    cycleFailures=0;
    if(await playEmergencyCached())return;
    root.innerHTML=`<div class="player-message">영상 연결을 확인하는 중…<br><small>${esc(lastError)}</small></div>${bars()}`;
    scheduleRecovery();
  }

  function updateClock(){const el=qs('#clock');if(el)el.textContent=new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});}
  setInterval(updateClock,1000);
  function scheduleExpiry(){clearTimeout(expireTimer);if(!state?.session_expires_at)return;const ms=new Date(state.session_expires_at).getTime()-serverNow();if(ms>0)expireTimer=setTimeout(fetchState,ms+1200);}
  function scheduleTransition(){clearTimeout(transitionTimer);if(!state?.next_transition_at)return;const ms=new Date(state.next_transition_at).getTime()-serverNow();if(ms>0)transitionTimer=setTimeout(fetchState,ms+500);}

  function playbackState(){
    const el=qs('#screenVideo');
    if(!el)return state?.playlist?.length?'loading':'idle';
    if(lastError&&!emergencyPlaying)return 'error';
    if(el.ended)return 'ended';
    if(el.paused)return 'paused';
    if(el.readyState<3)return 'loading';
    return emergencyPlaying?'emergency':'playing';
  }
  async function heartbeat(){
    if(heartbeatInFlight){ heartbeatQueued=true; return; }
    if(!db||!state?.room)return;
    heartbeatInFlight=true;
    const el=qs('#screenVideo'),v=emergencyPlaying?state?.emergency_video:current();
    const list=state?.playlist||[];
    const currentIndex=list.length?(index%list.length):0;
    const nextVideo=list.length>1?list[(currentIndex+1)%list.length]:null;
    const status={
      video_id:v?.id||null,
      title:v?.title||null,
      mode:emergencyPlaying?'emergency':state.mode,
      playback_state:playbackState(),
      current_time:el&&Number.isFinite(el.currentTime)?Math.round(el.currentTime):0,
      duration:el&&Number.isFinite(el.duration)?Math.round(el.duration):0,
      muted:Boolean(el?.muted),
      volume:el?Math.round(el.volume*100):Number(state.room.volume||0),
      online:navigator.onLine,
      error:lastError,
      source:emergencyPlaying?'emergency-cache':'cloud-r2',
      playlist_titles:emergencyPlaying?(v?.title?[v.title]:[]):list.slice(0,12).map(item=>String(item.title||'영상').slice(0,120)),
      playlist_count:emergencyPlaying?(v?1:0):list.length,
      current_index:emergencyPlaying?0:currentIndex,
      next_title:emergencyPlaying?null:(nextVideo?.title||null),
      app_version:'2.10',
      reported_at:new Date().toISOString()
    };
    try{await db.rpc('player_heartbeat',{p_key:key,p_status:status});lastHeartbeatAt=Date.now();}
    catch(_){}
    finally{
      heartbeatInFlight=false;
      if(heartbeatQueued){heartbeatQueued=false;queueMicrotask(heartbeat);}
    }
  }
  function queueHeartbeat(immediate=false){
    clearTimeout(heartbeatTimer);
    const wait=immediate?Math.max(0,1200-(Date.now()-lastHeartbeatAt)):1200;
    heartbeatTimer=setTimeout(heartbeat,wait);
  }
  async function acquireWake(){ try{if(navigator.wakeLock&&document.visibilityState==='visible'){try{await wakeLock?.release();}catch(_){} wakeLock=await navigator.wakeLock.request('screen');}}catch(_){} }

  loadSaved(); acquireWake(); document.addEventListener('visibilitychange',acquireWake);
  fetchState();
  setInterval(fetchState,Signage.cfg.pollMs||30000);
  setInterval(heartbeat,Signage.cfg.heartbeatMs||10000);
  window.addEventListener('online',fetchState);
  window.addEventListener('beforeunload',clearEmergencyObjectUrl);
  if(db){const channel=db.channel(`room:${key}`).on('broadcast',{event:'refresh'},()=>setTimeout(fetchState,120)).subscribe();window.addEventListener('beforeunload',()=>db.removeChannel(channel));}
})();
