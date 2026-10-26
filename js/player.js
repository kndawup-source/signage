(function () {
  'use strict';
  const { db, qs, esc } = Signage;
  const key = new URLSearchParams(location.search).get('key');
  const root = qs('#playerRoot');
  const savedKey = `clinic-signage:last-state:${key || 'none'}`;
  const EMERGENCY_CACHE = 'clinic-signage-emergency-v1';
  const MAX_EMERGENCY_CACHE_BYTES = 250 * 1024 * 1024;
  const PLAYLIST_MEDIA_CACHE = 'clinic-signage-playlist-media-v1';
  const OFFLINE_READY_KEY = `clinic-signage:offline-ready:${key || 'none'}`;
  const OFFLINE_CACHE_META_KEY = `clinic-signage:offline-cache-meta:${key || 'none'}`;
  const OFFLINE_CACHE_USAGE_RATIO = 0.82;
  const OFFLINE_CACHE_START_DELAY_MS = 5000;
  const APP_VERSION = String(window.CLINIC_SIGNAGE_VERSION || '2.33.26');
  const RELEASE_URL='/player-release.json';
  const UPDATE_CHECK_MS=10*60*1000;
  const UPDATE_FORCE_MS=30*60*1000;
  let updatePendingVersion=null,updateDetectedAt=0,lastUpdateCheckAt=0,updateCheckBusy=false,updateError=null;

  let state = null;
  let index = 0;
  let lastStateSig = '';
  let lastPlaylistSig = '';
  let lastNonce = null;
  let lastError = null;
  let soundUnlocked = false;
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
  let reportInFlight = false;
  let reportQueued = false;
  let reportTimer = null;
  let lastReportAt = 0;
  // Server time (player_get_state.server_time) of the state that is actually on screen.
  // Admin/staff compare this against the moment a control was issued to confirm delivery.
  let syncedAt = null;
  let renderSeq = 0;
  let stateRpc = 'player_get_state_lite';
  let reportRpc = 'player_report';
  let lastPlaybackPresenceAttemptAt=0;
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
  let offlineCacheTimer=null,offlineCacheSyncToken=0,offlineCacheBusy=false;
  let offlineCacheReady=false,offlineCacheCount=0,offlineCacheTotal=0,offlineCacheUpdatedAt=null,offlineCacheError=null;
  const mediaFailures=new Map();
  const MEDIA_FAILURE_LIMIT=2,MEDIA_FAILURE_COOLDOWN_MS=10*60*1000;

  if (!key) { console.error('Clinic Signage: missing player key'); if(root)root.innerHTML='<div class="player-message">플레이어 주소에 key가 없습니다. 관리자 화면의 공간 플레이어 링크를 사용하세요.</div>'; return; }

  async function registerPlayerServiceWorker(){
    if(!('serviceWorker' in navigator))return null;
    try{
      const reg=await navigator.serviceWorker.register('/player-sw.js',{scope:'/'});
      try{await reg.update();}catch(_){}
      await navigator.serviceWorker.ready;
      return reg;
    }catch(e){console.warn('Clinic Signage service worker unavailable:',e?.message||e);return null;}
  }
  function readJsonStorage(storageKey){try{return JSON.parse(localStorage.getItem(storageKey)||'null');}catch(_){return null;}}
  function writeJsonStorage(storageKey,value){try{localStorage.setItem(storageKey,JSON.stringify(value));return true;}catch(_){return false;}}
  function offlineReadyState(){const value=readJsonStorage(OFFLINE_READY_KEY);return value?.playlist?.length?value:null;}
  function cacheablePlaylistItems(s=state){return (s?.playlist||[]).filter(v=>v?.url&&/^https?:\/\//i.test(String(v.url)));}
  async function storageHasRoomFor(sizeBytes){
    if(!navigator.storage?.estimate)return true;
    try{
      const {quota=0,usage=0}=await navigator.storage.estimate();
      const need=Math.max(0,Number(sizeBytes||0));
      if(!quota)return true;
      return usage+need < quota*OFFLINE_CACHE_USAGE_RATIO;
    }catch(_){return true;}
  }
  async function cachedMediaIsComplete(cache,v){
    const url=mediaUrl(v);if(!url)return false;
    const hit=await cache.match(url);if(!hit)return false;
    const expected=Number(v?.size||0),actual=Number(hit.headers.get('content-length')||0);
    return !(expected>0&&actual>0&&Math.abs(expected-actual)>1);
  }
  async function cacheOnePlaylistVideo(cache,v,token,forceRefresh=false){
    if(token!==offlineCacheSyncToken)return false;
    const url=mediaUrl(v);if(!url)return false;
    if(!forceRefresh&&await cachedMediaIsComplete(cache,v))return true;
    const size=Number(v?.size||0);
    if(!(await storageHasRoomFor(size)))throw new Error('offline_cache_quota');
    const response=await fetch(url,{method:'GET',mode:'cors',credentials:'omit',cache:'no-store'});
    if(!response.ok)throw new Error(`offline_cache_http_${response.status}`);
    if(token!==offlineCacheSyncToken)return false;
    await cache.put(url,response.clone());
    return true;
  }
  async function prunePlaylistCache(cache,keepUrls){
    const keys=await cache.keys();
    await Promise.all(keys.filter(req=>!keepUrls.has(req.url)).map(req=>cache.delete(req)));
  }
  async function syncOfflinePlaylistCache(){
    if(offlineCacheBusy||!('caches' in window)||!state?.playlist?.length||!navigator.onLine||state?.mode==='closed')return false;
    offlineCacheBusy=true;const token=++offlineCacheSyncToken;
    const snapshot=JSON.parse(JSON.stringify(state));
    const items=cacheablePlaylistItems(snapshot),total=items.length;
    offlineCacheTotal=total;offlineCacheCount=0;offlineCacheReady=false;offlineCacheError=null;
    try{
      try{await navigator.storage?.persist?.();}catch(_){}
      const cache=await caches.open(PLAYLIST_MEDIA_CACHE);
      const signature=playlistSignature(snapshot),previousMeta=readJsonStorage(OFFLINE_CACHE_META_KEY);
      const forceRefresh=Boolean(previousMeta?.playlist_signature&&previousMeta.playlist_signature!==signature);
      let complete=0;
      for(const v of items){
        if(token!==offlineCacheSyncToken)return false;
        try{if(await cacheOnePlaylistVideo(cache,v,token,forceRefresh))complete++;}
        catch(e){offlineCacheError=e?.message||String(e);console.warn('Clinic Signage offline cache item failed:',v?.title||v?.id,offlineCacheError);}
        offlineCacheCount=complete;
        await new Promise(r=>setTimeout(r,120));
      }
      const allReady=total>0&&complete===total;
      if(allReady&&token===offlineCacheSyncToken){
        const keep=new Set(items.map(v=>new URL(mediaUrl(v),location.href).href));
        await prunePlaylistCache(cache,keep);
        writeJsonStorage(OFFLINE_READY_KEY,snapshot);
        offlineCacheReady=true;offlineCacheUpdatedAt=new Date().toISOString();
        writeJsonStorage(OFFLINE_CACHE_META_KEY,{ready:true,count:complete,total,updated_at:offlineCacheUpdatedAt,playlist_signature:playlistSignature(snapshot)});scheduleReport(0);
        return true;
      }
      writeJsonStorage(OFFLINE_CACHE_META_KEY,{ready:false,count:complete,total,updated_at:new Date().toISOString(),playlist_signature:playlistSignature(snapshot)});scheduleReport(0);
      return false;
    }catch(e){
      offlineCacheError=e?.message||String(e);console.warn('Clinic Signage offline playlist cache failed:',offlineCacheError);scheduleReport(0);
      return false;
    }finally{offlineCacheBusy=false;}
  }
  function scheduleOfflinePlaylistCache(force=false){
    clearTimeout(offlineCacheTimer);
    if(!navigator.onLine||!state?.playlist?.length||state?.mode==='closed')return;
    const meta=readJsonStorage(OFFLINE_CACHE_META_KEY);
    if(!force&&meta?.ready&&meta?.playlist_signature===playlistSignature(state)){
      offlineCacheReady=true;offlineCacheCount=Number(meta.count||0);offlineCacheTotal=Number(meta.total||0);offlineCacheUpdatedAt=meta.updated_at||null;return;
    }
    offlineCacheTimer=setTimeout(()=>void syncOfflinePlaylistCache(),force?250:OFFLINE_CACHE_START_DELAY_MS);
  }
  function playlistSignature(s) {
    return `${s?.mode||''}|${s?.sync_revision||s?.broadcast_revision||0}|${(s?.playlist||[]).map(v=>`${v.id}:${v.url||''}:${v.file_modified_at||''}:${v.size||0}`).join(',')}`;
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
      const r=await fetch(`${RELEASE_URL}?t=${now}`,{cache:'no-store'});if(!r.ok)throw new Error(`release_http_${r.status}`);
      const data=await r.json(),latest=String(data?.version||'').trim();if(!latest)return;
      updateError=null;if(versionCompare(latest,APP_VERSION)>0){if(updatePendingVersion!==latest){updatePendingVersion=latest;updateDetectedAt=Date.now();scheduleReport(0);}updateAtSafePoint();}
    }catch(e){updateError=e?.message||String(e);scheduleReport(0);}finally{updateCheckBusy=false;}
  }

  function maybeReportPlaybackPresence(){
    const now=Date.now();
    /* Actual decoded frame progress is the strongest proof that this player is alive.
       Report only when the last successful presence is getting stale, and retry at most
       every 10 seconds if the network/RPC is temporarily failing. */
    if(now-lastReportAt<PLAYBACK_PRESENCE_STALE_MS)return;
    if(now-lastPlaybackPresenceAttemptAt<PLAYBACK_PRESENCE_RETRY_MS)return;
    lastPlaybackPresenceAttemptAt=now;
    scheduleReport(0);
  }

  function ensureSurface(){
    if(slots.length===2 && slots.every(el=>el.isConnected))return;
    root.innerHTML=`<video id="screenVideoA" class="player-video is-active" muted playsinline preload="metadata"></video><video id="screenVideoB" class="player-video" muted playsinline preload="metadata"></video>${bars()}`;
    slots=[qs('#screenVideoA'),qs('#screenVideoB')];
    activeSlot=0;
    slots.forEach((el,slotIndex)=>{
      el.addEventListener('ended',()=>{if(slotIndex===activeSlot&&!emergencyPlaying){confirmedPlaybackState='ended';if(updatePendingVersion){reloadForUpdate();return;}advanceSeamless();}});
      el.addEventListener('playing',()=>{if(slotIndex===activeSlot){clearTimeout(pauseConfirmTimer);transitionInProgress=false;confirmedPlaybackState=emergencyPlaying?'emergency':'playing';lastError=null;cycleFailures=0;const played=current();if(played?.id)mediaFailures.delete(String(played.id));lastProgressAt=Date.now();lastProgressTime=el.currentTime||0;watchForPreroll(el,slotIndex);pushLiveStatusNow();queueHeartbeat(true);}});
      el.addEventListener('timeupdate',()=>{if(slotIndex===activeSlot&&Math.abs((el.currentTime||0)-lastProgressTime)>.15){confirmedPlaybackState=emergencyPlaying?'emergency':'playing';lastProgressTime=el.currentTime||0;lastProgressAt=Date.now();recoveryStage=0;recoveryAttempts=0;if(lastError&&String(lastError).startsWith('재생 정체 자동 복구'))lastError=null;maybeReportPlaybackPresence();}});
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
    /* Unattended displays must start muted so Chromium autoplay is deterministic.
       Sound is restored only after a real user gesture, unless force_mute keeps it off. */
    el.muted=Boolean(state.room.force_mute)||!soundUnlocked;
  }
  function slotMatches(el,v){return Boolean(el&&v&&el.dataset.videoId===String(v.id||'')&&el.dataset.mediaUrl===mediaUrl(v));}
  function resetSlot(el){
    if(!el)return;
    try{el.pause();}catch(_){}
    el.loop=false;el.removeAttribute('src');el.dataset.videoId='';el.dataset.mediaUrl='';el.dataset.videoIndex='';el.dataset.prerolled='';
    try{el.load();}catch(_){}
  }
  function loadSlot(el,v,videoIndex,preloadMode='metadata'){
    const url=mediaUrl(v); if(!el||!url)return false;
    const preload=preloadMode==='auto'?'auto':'metadata';
    if(slotMatches(el,v)){
      el.dataset.videoIndex=String(videoIndex);el.preload=preload;applyAudio(el);return true;
    }
    try{el.pause();}catch(_){}
    el.loop=false;el.preload=preload;el.dataset.videoId=String(v.id||'');el.dataset.mediaUrl=url;el.dataset.videoIndex=String(videoIndex);el.src=url;applyAudio(el);el.load();return true;
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
    const forceMute=Boolean(state?.room?.force_mute);
    const targetVolume=Math.max(0,Math.min(1,Number(state?.room?.volume||0)/100));
    el.volume=targetVolume;
    /* Chromium guarantees muted autoplay. Do not try audible autoplay first: on
       unattended Windows displays it can leave the decoded first frame visible
       while playback never starts. */
    el.muted=forceMute||!soundUnlocked;
    try{
      await el.play();
      lastError=null;
      return true;
    }catch(firstError){
      /* Even after an operator enabled sound, fall back to muted playback rather
         than sacrificing video output. */
      if(!el.muted){
        el.muted=true;
        try{await el.play();lastError=null;return true;}catch(_){}
      }
      lastError='자동재생 차단';
      queueHeartbeat(true);
      return false;
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
    if(prerollBusy||emergencyPlaying||state?.room?.paused||state?.mode==='closed')return false;
    const items=list();if(items.length<2)return false;
    const targetIndex=(index+1)%items.length;
    if(prerolledIndex===targetIndex&&prerolledSlot===inactiveSlotIndex())return true;
    const v=items[targetIndex],slot=inactiveSlotIndex(),el=slots[slot];
    if(!v||!mediaUrl(v)||!el)return false;
    prerollBusy=true;
    const token=++switchToken;
    try{
      loadSlot(el,v,targetIndex,'auto');
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
      maybeReportPlaybackPresence();
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
        transitionInProgress=false;prepareNext();queueHeartbeat(true);pushLiveStatusNow();
      });
      return true;
    }

    transitionInProgress=true;
    const token=++switchToken;
    /* Start immediately. Waiting for canplay/loadeddata before calling play() added
       several seconds on large R2 MP4 files and made slow-start files look frozen.
       The play() promise already waits until Chromium can actually begin playback. */
    loadSlot(nextEl,v,normalized,'auto');
    const started=sync?await startWithBroadcastSync(nextEl):await playElement(nextEl);
    if(!started||token!==switchToken){transitionInProgress=false;return false;}
    if(!(await waitForRenderedFrame(nextEl,token,4000))||token!==switchToken){transitionInProgress=false;return false;}
    nextEl.classList.add('is-active');
    activeSlot=targetSlot;index=normalized;emergencyPlaying=false;lastError=null;cycleFailures=0;confirmedPlaybackState='playing';
    currentEl?.classList.remove('is-active');
    requestAnimationFrame(()=>{
      if(currentEl&&currentEl!==nextEl){try{currentEl.pause();currentEl.currentTime=0;}catch(_){}}
      transitionInProgress=false;prepareNext();queueHeartbeat(true);pushLiveStatusNow();
    });
    return true;
  }
  function prepareNext(){
    if(emergencyPlaying)return;
    const items=list(); if(items.length<2)return;
    const nextIndex=(index+1)%items.length,nextVideo=items[nextIndex],el=slots[inactiveSlotIndex()];
    if(!nextVideo||!mediaUrl(nextVideo))return;
    /* Keep the next item lightweight until it is close to transition. */
    loadSlot(el,nextVideo,nextIndex,'metadata');
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
    if(state.mode==='closed'){clearTimeout(offlineCacheTimer);offlineCacheSyncToken++;blankPlayer();root.classList.add('is-closed');qs('#playerBar')?.remove();return true;}
    root.classList.remove('is-closed');
    const v=current();
    if(!v||!mediaUrl(v)){blankPlayer();renderBarsOnly();return;}
    ensureSurface();renderBarsOnly();
    const mySeq=++renderSeq;
    const ok=await switchToIndex(index,{sync:true});
    if(!ok&&mySeq===renderSeq&&!emergencyPlaying&&!state?.room?.paused)await handleMediaFailure(current());
    return ok;
  }
  function enableSound(){
    if(state?.room?.force_mute)return;
    soundUnlocked=true;
    slots.forEach(el=>{if(el&&el.src){el.muted=false;applyAudio(el);}});
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
      let {data,error}=await db.rpc(stateRpc,{p_key:key});
      if(error&&stateRpc!=='player_get_state'&&Signage.isMissingFunction(error)){stateRpc='player_get_state';({data,error}=await db.rpc(stateRpc,{p_key:key}));}
      if(error)throw error;
      if(!data){if(!state){root.innerHTML='<div class="player-message">등록되지 않은 플레이어 주소입니다. 관리자 화면에서 링크를 다시 복사하세요.</div>';slots=[];}return;}
      updateServerClock(data.server_time,requestStarted,Date.now());
      if(lastNonce===null)lastNonce=data.room.reload_nonce;
      else if(data.room.reload_nonce!==lastNonce){try{const u=new URL(location.href);u.searchParams.set('_remote_reload',String(Date.now()));location.replace(u.toString());}catch(_){location.reload();}return;}
      const newPlaylistSig=playlistSignature(data),newStateSig=stateSignature(data),playlistChanged=newPlaylistSig!==lastPlaylistSig,stateChanged=newStateSig!==lastStateSig;
      state=data;if(!emergencyPlaying)lastError=null;saveState();scheduleExpiry();scheduleTransition();if(state.mode!=='closed'){cacheEmergency().catch(()=>{});scheduleOfflinePlaylistCache(playlistChanged);}else{clearTimeout(offlineCacheTimer);offlineCacheSyncToken++;}subscribePlayerRealtime();
      const fetchedAt=data.server_time||null;
      lastStateSig=newStateSig;
      if(playlistChanged||state?.mode==='closed'){lastPlaylistSig=newPlaylistSig;index=0;cycleFailures=0;emergencyPlaying=false;await renderFull();syncedAt=fetchedAt;queueHeartbeat(true);}
      else{if(stateChanged){applyLiveControls();renderBarsOnly();queueHeartbeat(true);}syncedAt=fetchedAt;}
      reportNow();
    }catch(e){lastError=e?.message||String(e);if(state?.mode!=='closed'&&!navigator.onLine){const cached=offlineReadyState();if(cached?.playlist?.length){state=cached;lastPlaylistSig=playlistSignature(cached);lastStateSig=stateSignature(cached);index=0;lastError=null;await renderFull();}}queueHeartbeat(true);}
    finally{fetchInFlight=false;scheduleStatePoll();if(fetchQueued){fetchQueued=false;queueMicrotask(fetchState);}}
  }
  function loadSaved(){
    try{
      const saved=readJsonStorage(savedKey),offline=offlineReadyState();
      const initial=(!navigator.onLine&&offline)||saved||offline;
      if(initial?.playlist){state=initial;lastPlaylistSig=playlistSignature(initial);lastStateSig=stateSignature(initial);renderFull();}
    }catch(_){}
  }

  async function cacheEmergency(){
    const url=emergencyUrl();if(!('caches' in window))return false;
    if(state?.mode==='closed')return false;if(!url){await caches.delete(EMERGENCY_CACHE);return false;}
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
      nextEl.classList.add('is-active');currentEl?.classList.remove('is-active');activeSlot=target;emergencyPlaying=true;transitionInProgress=false;confirmedPlaybackState='emergency';lastError='네트워크 장애 · 비상영상 재생 중';pushHeartbeatNow();pushLiveStatusNow();scheduleRecovery();return true;
    }catch(_){return false;}
  }
  async function probeMedia(){
    const url=mediaUrl(current());if(!url)return false;
    try{const r=await fetch(url,{method:'GET',headers:{Range:'bytes=0-0'},cache:'no-store'});return r.ok||r.status===206;}
    catch(_){try{await fetch(url,{method:'HEAD',mode:'no-cors',cache:'no-store'});return true;}catch(__){return false;}}
  }
  function scheduleRecovery(){clearTimeout(recoveryTimer);recoveryTimer=setTimeout(async()=>{await fetchState();if(await probeMedia()){emergencyPlaying=false;await renderFull();}else scheduleRecovery();},15000);}
  async function handleMediaFailure(v){
    if(state?.mode==='closed')return;
    const id=String(v?.id||mediaUrl(v)||'unknown'),prev=mediaFailures.get(id)||{count:0,lastAt:0};
    const nextFailure={count:prev.count+1,lastAt:Date.now()};mediaFailures.set(id,nextFailure);
    lastError=`재생 실패: ${v?.title||'영상'}`;cycleFailures++;queueHeartbeat(true);scheduleReport(0);
    const items=list(),now=Date.now();
    for(let step=1;step<=items.length;step++){
      const candidateIndex=(index+step)%items.length,candidate=items[candidateIndex],key=String(candidate?.id||mediaUrl(candidate)||'unknown'),f=mediaFailures.get(key);
      const blocked=f&&f.count>=MEDIA_FAILURE_LIMIT&&now-f.lastAt<MEDIA_FAILURE_COOLDOWN_MS;
      if(candidate&&candidate!==v&&!blocked){const ok=await switchToIndex(candidateIndex);if(ok)return;}
    }
    cycleFailures=0;if(await playEmergencyCached())return;scheduleRecovery();
  }

  function scheduleExpiry(){clearTimeout(expireTimer);if(!state?.session_expires_at)return;const ms=new Date(state.session_expires_at).getTime()-serverNow();if(ms>0)expireTimer=setTimeout(fetchState,ms+1200);}
  function scheduleTransition(){clearTimeout(transitionTimer);if(!state?.next_transition_at)return;const ms=new Date(state.next_transition_at).getTime()-serverNow();if(ms>0)transitionTimer=setTimeout(fetchState,ms+500);}
  function playbackState(){if(state?.mode==='closed')return 'closed';const el=activeVideoEl();if(!el)return list().length?'loading':'idle';if(lastError&&!emergencyPlaying)return 'error';if(state?.room?.paused)return 'paused';if(transitionInProgress)return confirmedPlaybackState==='playing'?'playing':'loading';if(emergencyPlaying)return 'emergency';if(confirmedPlaybackState==='playing'&&!el.ended)return 'playing';if(el.ended)return 'ended';if(el.paused)return confirmedPlaybackState==='playing'?'playing':'paused';if(el.readyState<3)return 'loading';return 'playing';}
  function buildLiveStatus(){
    const el=activeVideoEl(),v=emergencyPlaying?state?.emergency_video:current(),items=list(),currentIndex=items.length?(index%items.length):0,nextVideo=items.length>1?items[(currentIndex+1)%items.length]:null;
    return {video_id:v?.id||null,title:v?.title||null,mode:emergencyPlaying?'emergency':state?.mode,playback_state:playbackState(),current_time:el&&Number.isFinite(el.currentTime)?Math.round(el.currentTime):0,duration:el&&Number.isFinite(el.duration)?Math.round(el.duration):0,muted:Boolean(el?.muted),volume:el?Math.round(el.volume*100):Number(state?.room?.volume||0),online:navigator.onLine,error:lastError,source:emergencyPlaying?'emergency-cache':(!navigator.onLine&&offlineCacheReady?'offline-playlist-cache':'cloud-r2'),recovery_stage:recoveryStage||null,synced_at:syncedAt,sync_revision:state?.sync_revision?String(state.sync_revision).slice(0,160):null,playlist_video_ids:emergencyPlaying?(v?.id?[v.id]:[]):items.slice(0,20).map(item=>item.id).filter(Boolean),playlist_titles:emergencyPlaying?(v?.title?[v.title]:[]):items.slice(0,8).map(item=>String(item.title||'영상').slice(0,120)),playlist_count:emergencyPlaying?(v?1:0):items.length,current_index:emergencyPlaying?0:currentIndex,next_title:emergencyPlaying?null:(nextVideo?.title||null),offline_cache_ready:offlineCacheReady,offline_cache_count:offlineCacheCount,offline_cache_total:offlineCacheTotal,offline_cache_error:offlineCacheError,operating_active:state?.operating?.active!==false,priority:state?.priority||state?.mode||'default',update_pending_version:updatePendingVersion,update_error:updateError||null,failed_video_count:[...mediaFailures.values()].filter(x=>x.count>=MEDIA_FAILURE_LIMIT).length,app_version:APP_VERSION,reported_at:new Date().toISOString()};
  }
  /* Live status report: meaningful changes wake admin/staff immediately; presence stays low-frequency. */
  async function broadcastStatusWake(){
    if(!statusBroadcastChannel||!statusBroadcastReady||!state?.room?.id)return false;
    try{
      const result=await statusBroadcastChannel.send({type:'broadcast',event:'changed',payload:{room_id:state.room.id,at:new Date().toISOString()}});
      return result==='ok'||result===true||result===undefined;
    }catch(_){return false;}
  }
  async function reportLive({wake=false}={}){
    if(wake)reportWakePending=true;
    if(reportInFlight){reportQueued=true;return;}if(!db||!state?.room)return;reportInFlight=true;
    clearTimeout(reportTimer);reportTimer=null;
    const shouldWake=reportWakePending;reportWakePending=false;
    try{
      const status=buildLiveStatus();
      let {error}=await db.rpc(reportRpc,{p_key:key,p_status:status});
      if(error&&reportRpc!=='player_live_ping'&&Signage.isMissingFunction(error)){reportRpc='player_live_ping';({error}=await db.rpc(reportRpc,{p_key:key,p_status:status}));}
      if(error)throw error;
      lastReportAt=Date.now();
      if(shouldWake)void broadcastStatusWake();
    }catch(e){console.warn('Clinic Signage live report failed:',e?.message||e);if(shouldWake)reportWakePending=true;}
    finally{reportInFlight=false;if(reportQueued){reportQueued=false;scheduleReport(250,reportWakePending);}}
  }
  /* Coalesce bursts (playing + heartbeat + transition) into one write. */
  function scheduleReport(delay=250,wake=true){if(wake)reportWakePending=true;if(reportTimer)return;reportTimer=setTimeout(()=>{reportTimer=null;void reportLive({wake:reportWakePending});},delay);}
  function reportNow(){clearTimeout(reportTimer);reportTimer=null;void reportLive({wake:true});}
  function pushLiveStatusNow(){scheduleReport(100,true);}
  function presenceTick(){const limit=state?.mode==='closed'?5*60*1000:LIVE_PRESENCE_MS*0.8;if(Date.now()-lastReportAt>=limit)void reportLive({wake:false});}
  async function heartbeat(){
    if(heartbeatInFlight){heartbeatQueued=true;return;}if(!db||!state?.room)return;if(state?.mode==='closed'&&Date.now()-lastHeartbeatAt<5*60*1000)return;heartbeatInFlight=true;
    try{
      const {error}=await db.rpc('player_heartbeat',{p_key:key,p_status:buildLiveStatus()});
      if(error)throw error;
      lastHeartbeatAt=Date.now();
    }catch(e){
      console.warn('Clinic Signage heartbeat failed:',e?.message||e);
      /* Live presence must never depend on the heavier analytics heartbeat. */
      scheduleReport();
    }finally{heartbeatInFlight=false;if(heartbeatQueued){heartbeatQueued=false;queueMicrotask(heartbeat);}}
  }

  async function playbackWatchdog(){
    const el=activeVideoEl();if(state?.mode==='closed')return;if(!el||!state||state.room?.paused||emergencyPlaying||document.hidden)return;
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

  let realtimeRoomId=null,realtimeDbChannel=null,roomBroadcastChannel=null,controlBroadcastChannel=null,statusBroadcastChannel=null,statusBroadcastReady=false,realtimeFetchTimer=null,statePollTimer=null;
  let reportWakePending=false;
  function requestRealtimeState(){
    clearTimeout(realtimeFetchTimer);
    /* room:{key} trigger, player_control_signals and the control broadcast can all fire
       for one action; 150ms coalesces them into a single player_get_state call. */
    realtimeFetchTimer=setTimeout(()=>fetchState(),150);
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
    if(!statusBroadcastChannel){
      statusBroadcastChannel=db.channel('clinic-signage-status',{config:{broadcast:{ack:false}}});
      statusBroadcastChannel.subscribe(status=>{statusBroadcastReady=status==='SUBSCRIBED';});
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


  const PLAYER_FALLBACK_MS=Math.max(60000,Number(Signage.cfg.pollMs)||0);
  const LIVE_PRESENCE_MS=Math.max(60000,Number(Signage.cfg.livePresenceMs)||60000);
  const PLAYBACK_PRESENCE_STALE_MS=25000;
  const PLAYBACK_PRESENCE_RETRY_MS=10000;
  const ANALYTICS_HEARTBEAT_MS=Math.max(60000,Number(Signage.cfg.heartbeatMs)||60000);
  const CLOSED_FALLBACK_MS=10*60*1000;
  function scheduleStatePoll(){
    clearTimeout(statePollTimer);
    const wait=state?.mode==='closed'?CLOSED_FALLBACK_MS:PLAYER_FALLBACK_MS;
    statePollTimer=setTimeout(()=>void fetchState(),wait);
  }

  ensureSurface();void registerPlayerServiceWorker();loadSaved();acquireWake();fetchState();
  document.addEventListener('visibilitychange',()=>{acquireWake();if(document.visibilityState==='visible'){scheduleReport();void checkForPlayerUpdate(true);}});
  window.addEventListener('focus',()=>{scheduleReport();void checkForPlayerUpdate();});
  window.addEventListener('online',()=>{fetchState();scheduleOfflinePlaylistCache(true);void checkForPlayerUpdate(true);});
  window.addEventListener('offline',()=>{const cached=offlineReadyState();if(state?.mode!=='closed'&&cached&&playlistSignature(cached)!==playlistSignature(state)){state=cached;lastPlaylistSig=playlistSignature(cached);lastStateSig=stateSignature(cached);index=0;void renderFull();}});
  window.addEventListener('beforeunload',()=>{clearEmergencyObjectUrl();clearTimeout(realtimeFetchTimer);clearTimeout(statePollTimer);clearTimeout(reportTimer);clearTimeout(offlineCacheTimer);[realtimeDbChannel,roomBroadcastChannel,controlBroadcastChannel,statusBroadcastChannel].forEach(ch=>{if(ch)db?.removeChannel(ch);});});
  setTimeout(()=>void checkForPlayerUpdate(true),8000);
  /* Fallback only: Realtime wake-ups are primary. Closed rooms back off to 10 minutes. */
  scheduleStatePoll();
  /* Presence: skipped when an event-driven report already went out recently. */
  setInterval(presenceTick,LIVE_PRESENCE_MS);
  /* Analytics heartbeat (재생률 통계). Not the source of online truth. */
  setInterval(heartbeat,ANALYTICS_HEARTBEAT_MS);
  setInterval(playbackWatchdog,10000);
  setInterval(()=>{void checkForPlayerUpdate();if(updatePendingVersion)updateAtSafePoint();},60000);
})();
