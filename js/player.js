(function () {
  'use strict';
  const { db, qs, esc } = Signage;
  const key = new URLSearchParams(location.search).get('key');
  const root = qs('#playerRoot');
  const savedKey = `clinic-signage:last-state:${key || 'none'}`;
  const EMERGENCY_CACHE = 'clinic-signage-emergency-v1';
  const MAX_EMERGENCY_CACHE_BYTES = 250 * 1024 * 1024;
  const APP_VERSION = '2.23.0';
  const RELEASE_URL='/player-release.json';
  const UPDATE_CHECK_MS=10*60*1000;
  const UPDATE_FORCE_MS=30*60*1000;
  let updatePendingVersion=null,updateDetectedAt=0,lastUpdateCheckAt=0,updateCheckBusy=false;

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
  let livePingInFlight = false;
  let livePingQueued = false;
  let liveFastChannel = null;
  let liveFastReady = false;
  const FRAME_PRESENCE_MS = 15000;
  let lastFramePresenceAt = 0;
  let syncStartTimer = null;
  let transitionTimer = null;
  let activeSlot = 0;
  let slots = [];
  let transitionInProgress = false;
  let confirmedPlaybackState = 'loading';
  let pauseConfirmTimer = null;
  let switchToken = 0;
  let lastProgressAt=Date.now(),lastProgressTime=0,stallRecovering=false,recoveryStage=0,recoveryAttempts=0;
  let prerollBusy=false,prerolledIndex=-1,prerolledSlot=-1,frameWatchToken=0;

  if (!key) { console.error('Clinic Signage: missing player key'); if(root)root.innerHTML='<div class="player-message">플레이어 주소에 key가 없습니다. 관리자 화면의 공간 플레이어 링크를 사용하세요.</div>'; return; }

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
  function versionParts(v){return String(v||'').split('.').map(x=>Number.parseInt(x,10)||0).slice(0,3);}
  function versionCompare(a,b){const aa=versionParts(a),bb=versionParts(b);for(let i=0;i<3;i++){const d=(aa[i]||0)-(bb[i]||0);if(d)return d;}return 0;}
  function reloadForUpdate(){
    if(!updatePendingVersion)return;
    try{const u=new URL(location.href);u.searchParams.set('_player_release',updatePendingVersion);u.searchParams.set('_reload',String(Date.now()));location.replace(u.toString());}
    catch(_){location.reload();}
  }
  function updateAtSafePoint(){
    if(!updatePendingVersion)return false;
    const el=activeVideoEl?.();
    if(!el||el.ended||el.paused||!list().length||state?.room?.paused){reloadForUpdate();return true;}
    if(updateDetectedAt&&Date.now()-updateDetectedAt>=UPDATE_FORCE_MS){reloadForUpdate();return true;}
    return false;
  }
  async function checkForPlayerUpdate(force=false){
    if(updateCheckBusy)return;
    const now=Date.now();if(!force&&now-lastUpdateCheckAt<UPDATE_CHECK_MS)return;
    updateCheckBusy=true;lastUpdateCheckAt=now;
    try{
      const r=await fetch(`${RELEASE_URL}?t=${now}`,{cache:'no-store'});if(!r.ok)return;
      const data=await r.json(),latest=String(data?.version||'').trim();if(!latest)return;
      if(versionCompare(latest,APP_VERSION)>0){if(updatePendingVersion!==latest){updatePendingVersion=latest;updateDetectedAt=Date.now();}updateAtSafePoint();}
    }catch(_){}finally{updateCheckBusy=false;}
  }

  function ensureSurface(){
    if(slots.length===2 && slots.every(el=>el.isConnected))return;
    root.innerHTML=`<video id="screenVideoA" class="player-video is-active" playsinline preload="auto"></video><video id="screenVideoB" class="player-video" playsinline preload="auto"></video>${bars()}`;
    slots=[qs('#screenVideoA'),qs('#screenVideoB')];
    activeSlot=0;
    slots.forEach((el,slotIndex)=>{
      el.addEventListener('ended',()=>{if(slotIndex===activeSlot&&!emergencyPlaying){confirmedPlaybackState='ended';if(updatePendingVersion){reloadForUpdate();return;}advanceSeamless();}});
      el.addEventListener('playing',()=>{if(slotIndex===activeSlot){clearTimeout(pauseConfirmTimer);transitionInProgress=false;confirmedPlaybackState=emergencyPlaying?'emergency':'playing';lastError=null;cycleFailures=0;lastProgressAt=Date.now();lastProgressTime=el.currentTime||0;watchForPreroll(el,slotIndex);pushLiveStatusNow();queueHeartbeat(true);}});
      el.addEventListener('timeupdate',()=>{if(slotIndex===activeSlot&&Math.abs((el.currentTime||0)-lastProgressTime)>.15){confirmedPlaybackState=emergencyPlaying?'emergency':'playing';lastProgressTime=el.currentTime||0;lastProgressAt=Date.now();recoveryStage=0;recoveryAttempts=0;if(lastError&&String(lastError).startsWith('재생 정체 자동 복구'))lastError=null;markRenderedPresence();}});
      el.addEventListener('pause',()=>{
        if(slotIndex!==activeSlot||transitionInProgress)return;
        clearTimeout(pauseConfirmTimer);
        pauseConfirmTimer=setTimeout(()=>{
          if(slotIndex!==activeSlot||transitionInProgress||!el.paused||el.ended)return;
          confirmedPlaybackState='paused';
          pushLiveStatusNow();
          queueHeartbeat(true);
        },180);
      });
      el.addEventListener('stalled',()=>{if(slotIndex===activeSlot&&!transitionInProgress){confirmedPlaybackState='loading';pushLiveStatusNow();queueHeartbeat(true);}});
      el.addEventListener('waiting',()=>{if(slotIndex===activeSlot&&!transitionInProgress&&confirmedPlaybackState!=='playing'){confirmedPlaybackState='loading';pushLiveStatusNow();queueHeartbeat(true);}});
      el.addEventListener('error',()=>{if(slotIndex===activeSlot&&!emergencyPlaying){confirmedPlaybackState='error';pushLiveStatusNow();handleMediaFailure(current());}});
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
    el.loop=false;el.removeAttribute('src');el.dataset.videoId='';el.dataset.mediaUrl='';el.dataset.videoIndex='';el.dataset.prerolled='';
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
  function cancelPreroll(){
    prerollBusy=false;prerolledIndex=-1;prerolledSlot=-1;frameWatchToken++;
    slots.forEach(el=>{if(el)el.dataset.prerolled='';});
  }
  async function prerollNext(){
    if(prerollBusy||emergencyPlaying||state?.room?.paused)return false;
    const items=list();if(items.length<2)return false;
    const targetIndex=(index+1)%items.length;
    if(prerolledIndex===targetIndex&&prerolledSlot===inactiveSlotIndex())return true;
    const v=items[targetIndex],slot=inactiveSlotIndex(),el=slots[slot];
    if(!v||!mediaUrl(v)||!el)return false;
    prerollBusy=true;
    const token=++switchToken;
    try{
      loadSlot(el,v,targetIndex);
      if(!(await waitUntilPlayable(el,token,5000))||token!==switchToken)return false;
      const desiredMuted=el.muted,desiredVolume=el.volume;
      el.muted=true;el.volume=0;
      let started=false;
      try{await el.play();started=true;}catch(_){}
      if(!started||token!==switchToken){transitionInProgress=false;return false;}
      if(!(await waitForRenderedFrame(el,token,1200))||token!==switchToken)return false;
      try{el.pause();}catch(_){}
      /* Keep the decoded first frame resident. Do not seek back to 0 here; seeking can drop the decoded frame. */
      el.dataset.prerolled='1';
      el.dataset.prerollMuted=desiredMuted?'1':'0';
      el.dataset.prerollVolume=String(desiredVolume);
      prerolledIndex=targetIndex;prerolledSlot=slot;
      return true;
    }finally{prerollBusy=false;}
  }
  function watchForPreroll(el,slotIndex){
    const myToken=++frameWatchToken;
    const tick=()=>{
      if(myToken!==frameWatchToken||slotIndex!==activeSlot||!el||el.paused||el.ended||emergencyPlaying)return;
      const duration=Number(el.duration),time=Number(el.currentTime);
      if(Number.isFinite(duration)&&duration>0&&Number.isFinite(time)){
        const remain=duration-time;
        if(remain<=1.25&&remain>0.02){prerollNext();}
      }
      markRenderedPresence();
      if(typeof el.requestVideoFrameCallback==='function')el.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    if(typeof el.requestVideoFrameCallback==='function')el.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }
  async function switchToIndex(targetIndex,{sync=false}={}){
    const items=list(); if(!items.length){blankPlayer();return false;}
    const normalized=((targetIndex%items.length)+items.length)%items.length;
    const v=items[normalized];
    ensureSurface();
    const currentEl=activeVideoEl();
    if(slotMatches(currentEl,v)){
      index=normalized;
      if(currentEl.ended){try{currentEl.currentTime=0;}catch(_){}if(!state?.room?.paused&&!(await playElement(currentEl)))return false;}
      applyLiveControls();prepareNext();return true;
    }

    const targetSlot=inactiveSlotIndex(),nextEl=slots[targetSlot];
    const readyPreroll=prerolledIndex===normalized&&prerolledSlot===targetSlot&&nextEl?.dataset.prerolled==='1'&&slotMatches(nextEl,v);

    if(readyPreroll){
      transitionInProgress=true;
      /* The first frame is already decoded. Put it on screen before asking playback to resume. */
      nextEl.classList.add('is-active');
      activeSlot=targetSlot;index=normalized;emergencyPlaying=false;lastError=null;cycleFailures=0;confirmedPlaybackState='playing';
      currentEl?.classList.remove('is-active');
      const muted=nextEl.dataset.prerollMuted==='1';
      const volume=Number(nextEl.dataset.prerollVolume);
      nextEl.muted=state?.room?.force_mute?true:muted;
      if(Number.isFinite(volume))nextEl.volume=volume;
      nextEl.dataset.prerolled='';prerolledIndex=-1;prerolledSlot=-1;
      const started=sync?await startWithBroadcastSync(nextEl):await playElement(nextEl);
      if(!started){transitionInProgress=false;return false;}
      confirmedPlaybackState=emergencyPlaying?'emergency':'playing';
      requestAnimationFrame(()=>{
        if(currentEl&&currentEl!==nextEl){try{currentEl.pause();currentEl.currentTime=0;}catch(_){}}
        transitionInProgress=false;prepareNext();queueHeartbeat(true);
      });
      return true;
    }

    transitionInProgress=true;
    const token=++switchToken;
    loadSlot(nextEl,v,normalized);
    if(!(await waitUntilPlayable(nextEl,token))||token!==switchToken){transitionInProgress=false;return false;}
    const started=sync?await startWithBroadcastSync(nextEl):await playElement(nextEl);
    if(!started||token!==switchToken){transitionInProgress=false;return false;}
    if(!(await waitForRenderedFrame(nextEl,token))||token!==switchToken){transitionInProgress=false;return false;}
    nextEl.classList.add('is-active');
    activeSlot=targetSlot;index=normalized;emergencyPlaying=false;lastError=null;cycleFailures=0;confirmedPlaybackState='playing';
    currentEl?.classList.remove('is-active');
    requestAnimationFrame(()=>{
      if(currentEl&&currentEl!==nextEl){try{currentEl.pause();currentEl.currentTime=0;}catch(_){}}
      transitionInProgress=false;prepareNext();queueHeartbeat(true);
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
    cancelPreroll();
    switchToken++;
    transitionInProgress=false;confirmedPlaybackState='idle';clearTimeout(pauseConfirmTimer);slots.forEach(el=>{try{el.pause();}catch(_){}el.classList.remove('is-active');});
    queueHeartbeat(true);
  }
  async function renderFull(){
    if(!state)return;
    clearTimeout(recoveryTimer);clearTimeout(syncStartTimer);clearEmergencyObjectUrl();cancelPreroll();emergencyPlaying=false;
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
      if(error)throw error;
      if(!data){if(!state){root.innerHTML='<div class="player-message">등록되지 않은 플레이어 주소입니다. 관리자 화면에서 링크를 다시 복사하세요.</div>';slots=[];}return;}
      updateServerClock(data.server_time,requestStarted,Date.now());
      if(lastNonce===null)lastNonce=data.room.reload_nonce;
      else if(data.room.reload_nonce!==lastNonce){try{const u=new URL(location.href);u.searchParams.set('_remote_reload',String(Date.now()));location.replace(u.toString());}catch(_){location.reload();}return;}
      const newPlaylistSig=playlistSignature(data),newStateSig=stateSignature(data),playlistChanged=newPlaylistSig!==lastPlaylistSig,stateChanged=newStateSig!==lastStateSig;
      state=data;if(!emergencyPlaying)lastError=null;saveState();scheduleExpiry();scheduleTransition();cacheEmergency().catch(()=>{});subscribePlayerRealtime();
      if(playlistChanged){lastPlaylistSig=newPlaylistSig;index=0;cycleFailures=0;emergencyPlaying=false;await renderFull();queueHeartbeat(true);}
      else if(stateChanged){applyLiveControls();renderBarsOnly();queueHeartbeat(true);}
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
      nextEl.classList.add('is-active');currentEl?.classList.remove('is-active');activeSlot=target;emergencyPlaying=true;transitionInProgress=false;confirmedPlaybackState='emergency';lastError='네트워크 장애 · 비상영상 재생 중';pushHeartbeatNow();scheduleRecovery();return true;
    }catch(_){return false;}
  }
  async function probeMedia(){
    const url=mediaUrl(current());if(!url)return false;
    try{const r=await fetch(url,{method:'GET',headers:{Range:'bytes=0-0'},cache:'no-store'});return r.ok||r.status===206;}
    catch(_){try{await fetch(url,{method:'HEAD',mode:'no-cors',cache:'no-store'});return true;}catch(__){return false;}}
  }
  function scheduleRecovery(){clearTimeout(recoveryTimer);recoveryTimer=setTimeout(async()=>{await fetchState();if(await probeMedia()){emergencyPlaying=false;await renderFull();}else scheduleRecovery();},15000);}
  async function handleMediaFailure(v){
    lastError=`재생 실패: ${v?.title||''}`;cycleFailures++;queueHeartbeat(true);const items=list();
    if(items.length>1&&cycleFailures<items.length){await switchToIndex((index+1)%items.length);return;}
    cycleFailures=0;if(await playEmergencyCached())return;scheduleRecovery();
  }

  function scheduleExpiry(){clearTimeout(expireTimer);if(!state?.session_expires_at)return;const ms=new Date(state.session_expires_at).getTime()-serverNow();if(ms>0)expireTimer=setTimeout(fetchState,ms+1200);}
  function scheduleTransition(){clearTimeout(transitionTimer);if(!state?.next_transition_at)return;const ms=new Date(state.next_transition_at).getTime()-serverNow();if(ms>0)transitionTimer=setTimeout(fetchState,ms+500);}
  function playbackState(){const el=activeVideoEl();if(!el)return list().length?'loading':'idle';if(lastError&&!emergencyPlaying)return 'error';if(state?.room?.paused)return 'paused';if(transitionInProgress)return confirmedPlaybackState==='playing'?'playing':'loading';if(emergencyPlaying)return 'emergency';if(confirmedPlaybackState==='playing'&&!el.ended)return 'playing';if(el.ended)return 'ended';if(el.paused)return confirmedPlaybackState==='playing'?'playing':'paused';if(el.readyState<3)return 'loading';return 'playing';}
  function buildLiveStatus(){
    const el=activeVideoEl(),v=emergencyPlaying?state?.emergency_video:current(),items=list(),currentIndex=items.length?(index%items.length):0,nextVideo=items.length>1?items[(currentIndex+1)%items.length]:null;
    return {video_id:v?.id||null,title:v?.title||null,mode:emergencyPlaying?'emergency':state?.mode,playback_state:playbackState(),current_time:el&&Number.isFinite(el.currentTime)?Math.round(el.currentTime):0,duration:el&&Number.isFinite(el.duration)?Math.round(el.duration):0,muted:Boolean(el?.muted),volume:el?Math.round(el.volume*100):Number(state?.room?.volume||0),online:navigator.onLine,error:lastError,source:emergencyPlaying?'emergency-cache':'cloud-r2',thumbnail:v?.thumbnail||null,recovery_stage:recoveryStage||null,playlist_video_ids:emergencyPlaying?(v?.id?[v.id]:[]):items.slice(0,20).map(item=>item.id).filter(Boolean),playlist_titles:emergencyPlaying?(v?.title?[v.title]:[]):items.slice(0,8).map(item=>String(item.title||'영상').slice(0,120)),playlist_count:emergencyPlaying?(v?1:0):items.length,current_index:emergencyPlaying?0:currentIndex,next_title:emergencyPlaying?null:(nextVideo?.title||null),app_version:APP_VERSION,reported_at:new Date().toISOString()};
  }
  async function publishLiveChanged(){
    if(!liveFastChannel||!liveFastReady||!state?.room?.id)return;
    try{await liveFastChannel.send({type:'broadcast',event:'changed',payload:{room_id:state.room.id,at:new Date().toISOString()}});}catch(_){}
  }
  async function fastLivePing(){
    if(livePingInFlight){livePingQueued=true;return;}if(!db||!state?.room)return;livePingInFlight=true;
    try{
      const {error}=await db.rpc('player_live_ping',{p_key:key,p_status:buildLiveStatus()});
      if(error)throw error;
      await publishLiveChanged();
    }catch(e){console.warn('Clinic Signage live status ping failed:',e?.message||e);}
    finally{livePingInFlight=false;if(livePingQueued){livePingQueued=false;queueMicrotask(fastLivePing);}}
  }
  function pushLiveStatusNow(){void fastLivePing();}
  function markRenderedPresence(){
    const now=Date.now();
    if(now-lastFramePresenceAt<FRAME_PRESENCE_MS)return;
    const el=activeVideoEl();
    if(!el||el.paused||el.ended||el.readyState<2||state?.room?.paused)return;
    lastFramePresenceAt=now;
    void fastLivePing();
  }
  async function heartbeat(){
    if(heartbeatInFlight){heartbeatQueued=true;return;}if(!db||!state?.room)return;heartbeatInFlight=true;
    try{
      const {error}=await db.rpc('player_heartbeat',{p_key:key,p_status:buildLiveStatus()});
      if(error)throw error;
      lastHeartbeatAt=Date.now();
    }catch(e){
      console.warn('Clinic Signage heartbeat failed:',e?.message||e);
      /* Live presence must never depend on the heavier analytics heartbeat. */
      void fastLivePing();
    }finally{heartbeatInFlight=false;if(heartbeatQueued){heartbeatQueued=false;queueMicrotask(heartbeat);}}
  }

  async function playbackWatchdog(){
    const el=activeVideoEl();if(!el||!state||state.room?.paused||emergencyPlaying||document.hidden)return;
    if(el.paused||el.ended||el.readyState<2)return;
    if(Date.now()-lastProgressAt<25000||stallRecovering)return;
    stallRecovering=true;recoveryAttempts++;recoveryStage=Math.min(5,recoveryAttempts);lastError=`재생 정체 자동 복구 ${recoveryStage}단계`;queueHeartbeat(true);
    try{
      if(recoveryStage===1){try{el.currentTime=Math.max(0,(el.currentTime||0)-.15);}catch(_){}await playElement(el);}
      else if(recoveryStage===2){await advanceSeamless();}
      else if(recoveryStage===3){const target=inactiveSlotIndex();resetSlot(slots[target]);const ok=await switchToIndex(index);if(!ok)await advanceSeamless();}
      else if(recoveryStage===4){await fetchState();const ok=await switchToIndex(index);if(!ok)await advanceSeamless();}
      else {queueHeartbeat(true);setTimeout(()=>location.reload(),1200);}
    }catch(_){handleMediaFailure(current());}
    finally{lastProgressAt=Date.now();stallRecovering=false;}
  }
  function pushHeartbeatNow(){clearTimeout(heartbeatTimer);heartbeatTimer=null;void heartbeat();}
  function queueHeartbeat(immediate=false){clearTimeout(heartbeatTimer);const wait=immediate?Math.max(0,1200-(Date.now()-lastHeartbeatAt)):1200;heartbeatTimer=setTimeout(heartbeat,wait);}
  async function acquireWake(){try{if(navigator.wakeLock&&document.visibilityState==='visible'){try{await wakeLock?.release();}catch(_){}wakeLock=await navigator.wakeLock.request('screen');}}catch(_){}}

  let realtimeRoomId=null,realtimeDbChannel=null,roomBroadcastChannel=null,controlBroadcastChannel=null,realtimeFetchTimer=null;
  function requestRealtimeState(){
    clearTimeout(realtimeFetchTimer);
    realtimeFetchTimer=setTimeout(()=>fetchState(),25);
  }
  function ensureLiveFastChannel(){
    if(liveFastChannel)return;
    try{
      liveFastChannel=db.channel('clinic-signage-live-fast');
      liveFastChannel.subscribe(status=>{liveFastReady=status==='SUBSCRIBED';});
    }catch(_){}
  }
  function subscribePlayerRealtime(){
    if(!db)return;
    const roomId=state?.room?.id||null;
    if(!roomBroadcastChannel){
      roomBroadcastChannel=db.channel(`room:${key}`).on('broadcast',{event:'refresh'},requestRealtimeState).subscribe();
    }
    if(!controlBroadcastChannel){
      controlBroadcastChannel=db.channel('clinic-signage-control').on('broadcast',{event:'refresh'},requestRealtimeState).subscribe();
    }
    if(!roomId||realtimeRoomId===roomId)return;
    if(realtimeDbChannel)db.removeChannel(realtimeDbChannel);
    realtimeRoomId=roomId;
    // Canonical control wake-up channel. This table has a public SELECT policy by design,
    // so anonymous player screens can receive its Realtime UPDATE even though rooms and
    // other admin tables remain protected by RLS.
    realtimeDbChannel=db.channel(`clinic-player-control-${roomId}`)
      .on('postgres_changes',{event:'*',schema:'public',table:'player_control_signals',filter:`room_id=eq.${roomId}`},requestRealtimeState)
      .subscribe();
  }


  ensureSurface();loadSaved();acquireWake();document.addEventListener('visibilitychange',()=>{acquireWake();if(document.visibilityState==='visible'){void fastLivePing();void checkForPlayerUpdate(true);}});window.addEventListener('focus',()=>{void fastLivePing();void checkForPlayerUpdate();});fetchState();
  ensureLiveFastChannel();
  setTimeout(()=>void checkForPlayerUpdate(true),8000);
  const PLAYER_FALLBACK_MS=Math.max(120000,Number(Signage.cfg.pollMs)||0);
  const LIVE_PRESENCE_MS=Math.max(60000,Number(Signage.cfg.livePresenceMs)||60000);
  const ANALYTICS_HEARTBEAT_MS=Math.max(60000,Number(Signage.cfg.heartbeatMs)||60000);
  setInterval(fetchState,PLAYER_FALLBACK_MS);
  /* Lightweight persisted presence: keeps player_live_status fresh even with no playback state changes. */
  setInterval(fastLivePing,LIVE_PRESENCE_MS);
  /* Heavier stats/event heartbeat runs less often and is no longer the source of online truth. */
  setInterval(heartbeat,ANALYTICS_HEARTBEAT_MS);
  setInterval(playbackWatchdog,10000);
  setInterval(()=>{void checkForPlayerUpdate();if(updatePendingVersion)updateAtSafePoint();},60000);
  window.addEventListener('online',()=>{fetchState();void fastLivePing();void checkForPlayerUpdate(true);});
  window.addEventListener('beforeunload',()=>{clearEmergencyObjectUrl();clearTimeout(realtimeFetchTimer);if(realtimeDbChannel)db?.removeChannel(realtimeDbChannel);if(roomBroadcastChannel)db?.removeChannel(roomBroadcastChannel);if(controlBroadcastChannel)db?.removeChannel(controlBroadcastChannel);if(liveFastChannel)db?.removeChannel(liveFastChannel);});
})();
