(function () {
  'use strict';
  const { db, qs, esc } = Signage;
  const key = new URLSearchParams(location.search).get('key');
  const root = qs('#playerRoot');
  const savedKey = `clinic-signage:last-state:${key || 'none'}`;
  const EMERGENCY_CACHE = 'clinic-signage-emergency-v1';
  const MAX_EMERGENCY_CACHE_BYTES = 250 * 1024 * 1024;

  let state = null;
  let index = 0;
  let lastStateSig = '';
  let lastPlaylistSig = '';
  let lastNonce = null;
  let lastError = null;
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
  let activeSlot = 0;
  let slots = [];
  let switchToken = 0;
  let lastProgressAt=Date.now(),lastProgressTime=0,stallRecovering=false;

  if (!key) { console.error('Clinic Signage: missing player key'); return; }

  function playlistSignature(s) {
    return `${s?.mode||''}|${s?.sync_revision||s?.broadcast_revision||0}|${(s?.playlist||[]).map(v=>`${v.id}:${v.url||''}`).join(',')}`;
  }
  function stateSignature(s) {
    const r=s?.room||{};
    return `${playlistSignature(s)}|${r.volume}|${r.paused}|${r.overlay_text||''}|${s?.notice_text||''}`;
  }
  function list(){ return state?.playlist||[]; }
  function current(){ const items=list(); return items.length?items[index%items.length]:null; }
  function mediaUrl(v){ return v?.url ? String(v.url) : ''; }
  function emergencyUrl(){ return mediaUrl(state?.emergency_video); }
  function saveState(){ try{localStorage.setItem(savedKey,JSON.stringify(state));}catch(_){} }
  function updateServerClock(serverTime,requestStarted,requestEnded){ if(serverTime){const t=new Date(serverTime).getTime();const midpoint=(Number(requestStarted)+Number(requestEnded))/2;if(Number.isFinite(t)&&Number.isFinite(midpoint))serverClockOffsetMs=t-midpoint;} }
  function serverNow(){ return Date.now()+serverClockOffsetMs; }

  function bars(){
    const texts=[state?.room?.overlay_text,state?.notice_text].filter(Boolean);
    return texts.length?`<div id="playerBar" class="player-bar"><div class="player-bar-static">${esc(texts.join(' · '))}</div></div>`:'';
  }
  function ensureSurface(){
    if(slots.length===2 && slots.every(el=>el.isConnected))return;
    root.innerHTML=`<video id="screenVideoA" class="player-video is-active" playsinline preload="auto"></video><video id="screenVideoB" class="player-video" playsinline preload="auto"></video>${bars()}`;
    slots=[qs('#screenVideoA'),qs('#screenVideoB')];
    activeSlot=0;
    slots.forEach((el,slotIndex)=>{
      el.addEventListener('ended',()=>{if(slotIndex===activeSlot&&!emergencyPlaying)advanceSeamless();});
      el.addEventListener('playing',()=>{if(slotIndex===activeSlot){lastError=null;cycleFailures=0;lastProgressAt=Date.now();lastProgressTime=el.currentTime||0;queueHeartbeat(true);}});
      el.addEventListener('timeupdate',()=>{if(slotIndex===activeSlot&&Math.abs((el.currentTime||0)-lastProgressTime)>.15){lastProgressTime=el.currentTime||0;lastProgressAt=Date.now();}});
      el.addEventListener('pause',()=>{if(slotIndex===activeSlot)queueHeartbeat(true);});
      el.addEventListener('error',()=>{if(slotIndex===activeSlot&&!emergencyPlaying)handleMediaFailure(current());});
    });
    root.onclick=enableSound;
  }
  function renderBarsOnly(){
    ensureSurface();
    qs('#playerBar')?.remove();
    const html=bars(); if(html)root.insertAdjacentHTML('beforeend',html);
  }
  function activeVideoEl(){return slots[activeSlot]||null;}
  function inactiveSlotIndex(){return activeSlot===0?1:0;}
  function clearEmergencyObjectUrl(){ if(emergencyObjectUrl){URL.revokeObjectURL(emergencyObjectUrl);emergencyObjectUrl=null;} }
  function applyAudio(el){
    if(!el||!state?.room)return;
    el.volume=Math.max(0,Math.min(1,Number(state.room.volume||0)/100));
    if(state.room.force_mute)el.muted=true;
  }
  function slotMatches(el,v){return Boolean(el&&v&&el.dataset.videoId===String(v.id||'')&&el.dataset.mediaUrl===mediaUrl(v));}
  function resetSlot(el){
    if(!el)return;
    try{el.pause();}catch(_){}
    el.loop=false;el.removeAttribute('src');el.dataset.videoId='';el.dataset.mediaUrl='';el.dataset.videoIndex='';
    try{el.load();}catch(_){}
  }
  function loadSlot(el,v,videoIndex){
    const url=mediaUrl(v); if(!el||!url)return false;
    if(slotMatches(el,v)){el.dataset.videoIndex=String(videoIndex);applyAudio(el);return true;}
    try{el.pause();}catch(_){}
    el.loop=false;el.dataset.videoId=String(v.id||'');el.dataset.mediaUrl=url;el.dataset.videoIndex=String(videoIndex);el.src=url;applyAudio(el);el.load();return true;
  }
  function waitUntilPlayable(el,token,timeoutMs=12000){
    if(el.readyState>=3)return Promise.resolve(true);
    return new Promise(resolve=>{
      let done=false;
      const finish=(ok)=>{if(done)return;done=true;clearTimeout(timer);el.removeEventListener('canplay',onReady);el.removeEventListener('loadeddata',onReady);el.removeEventListener('error',onError);resolve(ok&&token===switchToken);};
      const onReady=()=>finish(true),onError=()=>finish(false);
      const timer=setTimeout(()=>finish(el.readyState>=2),timeoutMs);
      el.addEventListener('canplay',onReady,{once:true});el.addEventListener('loadeddata',onReady,{once:true});el.addEventListener('error',onError,{once:true});
    });
  }
  async function playElement(el){
    if(!el)return false;
    if(state?.room?.paused)return true;
    try{await el.play();return true;}
    catch(_){
      el.muted=true;
      try{await el.play();return true;}
      catch(e){lastError='자동재생 차단';queueHeartbeat(true);return false;}
    }
  }
  async function waitForRenderedFrame(el,token,timeoutMs=1500){
    if(!el||token!==switchToken)return false;
    if(typeof el.requestVideoFrameCallback==='function'){
      return new Promise(resolve=>{
        let done=false;
        const timer=setTimeout(()=>{if(done)return;done=true;resolve(token===switchToken&&el.readyState>=2);},timeoutMs);
        el.requestVideoFrameCallback(()=>{if(done)return;done=true;clearTimeout(timer);resolve(token===switchToken);});
      });
    }
    return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(token===switchToken&&el.readyState>=2))));
  }
  async function startWithBroadcastSync(el){
    if(state?.room?.paused)return true;
    const effective=state?.sync_effective_at?new Date(state.sync_effective_at).getTime():0;
    if(!effective)return playElement(el);
    const delay=effective-serverNow();
    if(delay>40){return new Promise(resolve=>{clearTimeout(syncStartTimer);syncStartTimer=setTimeout(async()=>resolve(await playElement(el)),delay);});}
    if(delay< -500 && Number.isFinite(el.duration) && el.duration>1){const elapsed=Math.max(0,(-delay)/1000);try{el.currentTime=elapsed%el.duration;}catch(_){}}
    return playElement(el);
  }
  async function switchToIndex(targetIndex,{sync=false}={}){
    const items=list(); if(!items.length){blankPlayer();return false;}
    const normalized=((targetIndex%items.length)+items.length)%items.length;
    const v=items[normalized],token=++switchToken;
    ensureSurface();
    const currentEl=activeVideoEl();
    if(slotMatches(currentEl,v)){
      index=normalized;applyLiveControls();prepareNext();return true;
    }
    const targetSlot=inactiveSlotIndex(),nextEl=slots[targetSlot];
    loadSlot(nextEl,v,normalized);
    if(!(await waitUntilPlayable(nextEl,token))||token!==switchToken)return false;
    const started=sync?await startWithBroadcastSync(nextEl):await playElement(nextEl);
    if(!started||token!==switchToken)return false;
    if(!(await waitForRenderedFrame(nextEl,token))||token!==switchToken)return false;

    /* Swap only after the browser has actually rendered the first frame. */
    nextEl.classList.add('is-active');
    activeSlot=targetSlot;index=normalized;emergencyPlaying=false;lastError=null;cycleFailures=0;
    requestAnimationFrame(()=>currentEl?.classList.remove('is-active'));
    requestAnimationFrame(()=>{
      if(currentEl&&currentEl!==nextEl){try{currentEl.pause();currentEl.currentTime=0;}catch(_){}}
      prepareNext();queueHeartbeat(true);
    });
    return true;
  }
  function prepareNext(){
    if(emergencyPlaying)return;
    const items=list(); if(items.length<2)return;
    const nextIndex=(index+1)%items.length,nextVideo=items[nextIndex],el=slots[inactiveSlotIndex()];
    if(!nextVideo||!mediaUrl(nextVideo))return;
    loadSlot(el,nextVideo,nextIndex);
  }
  async function advanceSeamless(){
    const items=list(); if(!items.length)return;
    const target=(index+1)%items.length;
    const ok=await switchToIndex(target);
    if(!ok)handleMediaFailure(items[target]);
  }
  function blankPlayer(){
    ensureSurface();
    switchToken++;
    slots.forEach(el=>{try{el.pause();}catch(_){}el.classList.remove('is-active');});
    queueHeartbeat(true);
  }
  async function renderFull(){
    if(!state)return;
    clearTimeout(recoveryTimer);clearTimeout(syncStartTimer);clearEmergencyObjectUrl();emergencyPlaying=false;
    const v=current();
    if(!v||!mediaUrl(v)){blankPlayer();renderBarsOnly();return;}
    ensureSurface();renderBarsOnly();
    await switchToIndex(index,{sync:true});
  }
  function enableSound(){
    if(state?.room?.force_mute)return;
    slots.forEach(el=>{if(el&&el.src)el.muted=false;});
    const el=activeVideoEl();if(el&&!state?.room?.paused)playElement(el);
    document.documentElement.requestFullscreen?.().catch(()=>{});
  }
  function applyLiveControls(){
    const el=activeVideoEl(); if(!el||!state)return;
    const vol=Math.max(0,Math.min(1,Number(state.room.volume||0)/100));
    slots.forEach(v=>{if(v){if(Math.abs(v.volume-vol)>0.01)v.volume=vol;if(state.room.force_mute)v.muted=true;}});
    if(state.room.paused){if(!el.paused)el.pause();}
    else if(el.paused&&!el.ended)playElement(el);
    queueHeartbeat(true);
  }

  async function fetchState(){
    if(fetchInFlight){ fetchQueued=true; return; }
    if(!db)return;
    fetchInFlight=true;const requestStarted=Date.now();
    try{
      const {data,error}=await db.rpc('player_get_state',{p_key:key});
      if(error)throw error;if(!data)return;
      updateServerClock(data.server_time,requestStarted,Date.now());
      if(lastNonce===null)lastNonce=data.room.reload_nonce;
      else if(data.room.reload_nonce!==lastNonce){location.reload();return;}
      const newPlaylistSig=playlistSignature(data),newStateSig=stateSignature(data),playlistChanged=newPlaylistSig!==lastPlaylistSig,stateChanged=newStateSig!==lastStateSig;
      state=data;if(!emergencyPlaying)lastError=null;saveState();scheduleExpiry();scheduleTransition();cacheEmergency().catch(()=>{});
      if(playlistChanged){lastPlaylistSig=newPlaylistSig;index=0;cycleFailures=0;emergencyPlaying=false;await renderFull();}
      else if(stateChanged){applyLiveControls();renderBarsOnly();}
      lastStateSig=newStateSig;
    }catch(e){lastError=e?.message||String(e);queueHeartbeat(true);}
    finally{fetchInFlight=false;if(fetchQueued){fetchQueued=false;queueMicrotask(fetchState);}}
  }
  function loadSaved(){
    try{const saved=JSON.parse(localStorage.getItem(savedKey)||'null');if(saved?.playlist){state=saved;lastPlaylistSig=playlistSignature(saved);lastStateSig=stateSignature(saved);renderFull();}}catch(_){}
  }

  async function cacheEmergency(){
    const url=emergencyUrl();if(!('caches' in window))return false;
    if(!url){await caches.delete(EMERGENCY_CACHE);return false;}
    const size=Number(state?.emergency_video?.size||0);if(size>MAX_EMERGENCY_CACHE_BYTES)return false;
    const cache=await caches.open(EMERGENCY_CACHE),existing=await cache.match(url);if(existing)return true;
    const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error(`emergency_http_${response.status}`);
    await cache.put(url,response.clone());const keys=await cache.keys();await Promise.all(keys.filter(r=>r.url!==new URL(url,location.href).href).map(r=>cache.delete(r)));return true;
  }
  async function playEmergencyCached(){
    const url=emergencyUrl();if(!url||!('caches' in window))return false;
    try{
      const cache=await caches.open(EMERGENCY_CACHE),response=await cache.match(url);if(!response)return false;
      const blob=await response.blob();clearEmergencyObjectUrl();emergencyObjectUrl=URL.createObjectURL(blob);ensureSurface();
      const target=inactiveSlotIndex(),nextEl=slots[target],currentEl=activeVideoEl();switchToken++;
      try{nextEl.pause();}catch(_){}nextEl.loop=true;nextEl.dataset.videoId=String(state?.emergency_video?.id||'emergency');nextEl.dataset.mediaUrl=emergencyObjectUrl;nextEl.src=emergencyObjectUrl;applyAudio(nextEl);nextEl.load();
      if(!(await waitUntilPlayable(nextEl,switchToken)))return false;
      if(!(await playElement(nextEl)))return false;
      nextEl.classList.add('is-active');currentEl?.classList.remove('is-active');activeSlot=target;emergencyPlaying=true;lastError='네트워크 장애 · 비상영상 재생 중';queueHeartbeat(true);scheduleRecovery();return true;
    }catch(_){return false;}
  }
  async function probeMedia(){const url=mediaUrl(current());if(!url)return false;try{const r=await fetch(url,{method:'GET',headers:{Range:'bytes=0-0'},cache:'no-store'});return r.ok||r.status===206;}catch(_){return false;}}
  function scheduleRecovery(){clearTimeout(recoveryTimer);recoveryTimer=setTimeout(async()=>{await fetchState();if(await probeMedia()){emergencyPlaying=false;await renderFull();}else scheduleRecovery();},15000);}
  async function handleMediaFailure(v){
    lastError=`재생 실패: ${v?.title||''}`;cycleFailures++;queueHeartbeat(true);const items=list();
    if(items.length>1&&cycleFailures<items.length){await switchToIndex((index+1)%items.length);return;}
    cycleFailures=0;if(await playEmergencyCached())return;scheduleRecovery();
  }

  function scheduleExpiry(){clearTimeout(expireTimer);if(!state?.session_expires_at)return;const ms=new Date(state.session_expires_at).getTime()-serverNow();if(ms>0)expireTimer=setTimeout(fetchState,ms+1200);}
  function scheduleTransition(){clearTimeout(transitionTimer);if(!state?.next_transition_at)return;const ms=new Date(state.next_transition_at).getTime()-serverNow();if(ms>0)transitionTimer=setTimeout(fetchState,ms+500);}
  function playbackState(){const el=activeVideoEl();if(!el)return list().length?'loading':'idle';if(lastError&&!emergencyPlaying)return 'error';if(el.ended)return 'ended';if(el.paused)return 'paused';if(el.readyState<3)return 'loading';return emergencyPlaying?'emergency':'playing';}
  async function heartbeat(){
    if(heartbeatInFlight){heartbeatQueued=true;return;}if(!db||!state?.room)return;heartbeatInFlight=true;
    const el=activeVideoEl(),v=emergencyPlaying?state?.emergency_video:current(),items=list(),currentIndex=items.length?(index%items.length):0,nextVideo=items.length>1?items[(currentIndex+1)%items.length]:null;
    const status={video_id:v?.id||null,title:v?.title||null,mode:emergencyPlaying?'emergency':state.mode,playback_state:playbackState(),current_time:el&&Number.isFinite(el.currentTime)?Math.round(el.currentTime):0,duration:el&&Number.isFinite(el.duration)?Math.round(el.duration):0,muted:Boolean(el?.muted),volume:el?Math.round(el.volume*100):Number(state.room.volume||0),online:navigator.onLine,error:lastError,source:emergencyPlaying?'emergency-cache':'cloud-r2',playlist_titles:emergencyPlaying?(v?.title?[v.title]:[]):items.slice(0,12).map(item=>String(item.title||'영상').slice(0,120)),playlist_count:emergencyPlaying?(v?1:0):items.length,current_index:emergencyPlaying?0:currentIndex,next_title:emergencyPlaying?null:(nextVideo?.title||null),app_version:'2.16.1',reported_at:new Date().toISOString()};
    try{await db.rpc('player_heartbeat',{p_key:key,p_status:status});lastHeartbeatAt=Date.now();}catch(_){}finally{heartbeatInFlight=false;if(heartbeatQueued){heartbeatQueued=false;queueMicrotask(heartbeat);}}
  }

  async function playbackWatchdog(){
    const el=activeVideoEl();if(!el||!state||state.room?.paused||emergencyPlaying||document.hidden)return;
    if(el.paused||el.ended||el.readyState<2)return;
    if(Date.now()-lastProgressAt<25000||stallRecovering)return;
    stallRecovering=true;lastError='재생 정체 자동 복구';queueHeartbeat(true);
    try{const ok=await switchToIndex(index);if(!ok)await advanceSeamless();}catch(_){handleMediaFailure(current());}
    finally{lastProgressAt=Date.now();stallRecovering=false;}
  }
  function queueHeartbeat(immediate=false){clearTimeout(heartbeatTimer);const wait=immediate?Math.max(0,1200-(Date.now()-lastHeartbeatAt)):1200;heartbeatTimer=setTimeout(heartbeat,wait);}
  async function acquireWake(){try{if(navigator.wakeLock&&document.visibilityState==='visible'){try{await wakeLock?.release();}catch(_){}wakeLock=await navigator.wakeLock.request('screen');}}catch(_){}}

  ensureSurface();loadSaved();acquireWake();document.addEventListener('visibilitychange',acquireWake);fetchState();
  setInterval(fetchState,Signage.cfg.pollMs||30000);setInterval(heartbeat,Signage.cfg.heartbeatMs||10000);setInterval(playbackWatchdog,10000);window.addEventListener('online',fetchState);window.addEventListener('beforeunload',clearEmergencyObjectUrl);
  if(db){const channel=db.channel(`room:${key}`).on('broadcast',{event:'refresh'},()=>setTimeout(fetchState,120)).subscribe();window.addEventListener('beforeunload',()=>db.removeChannel(channel));}
})();
