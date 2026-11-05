(function () {
  'use strict';
  const { db, qs, esc } = Signage;
  const key = new URLSearchParams(location.search).get('key');
  /* preview=1: staff "실제 화면 보기" tab. It plays the same state but must never report as the
     TV (status/heartbeat/"stopped" on close), download the playlist into the staff PC cache,
     or install the kiosk service worker. */
  const PREVIEW = new URLSearchParams(location.search).get('preview') === '1';
  let intentionalNavigation = false;
  const root = qs('#playerRoot');
  const savedKey = `clinic-signage:last-state:${key || 'none'}`;
  const EMERGENCY_CACHE = 'clinic-signage-emergency-v1';
  const MAX_EMERGENCY_CACHE_BYTES = 250 * 1024 * 1024;
  const PLAYLIST_MEDIA_CACHE = 'clinic-signage-playlist-media-v1';
  const OFFLINE_READY_KEY = `clinic-signage:offline-ready:${key || 'none'}`;
  const OFFLINE_CACHE_META_KEY = `clinic-signage:offline-cache-meta:${key || 'none'}`;
  const OFFLINE_CACHE_USAGE_RATIO = 0.82;
  const OFFLINE_CACHE_START_DELAY_MS = 30000;
  const APP_VERSION = String(window.CLINIC_SIGNAGE_VERSION || '2.34.11');
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
  let soundUnlocked = false; // set after user gesture; kiosk may autoplay audio without a gesture
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
  // A confirmed player failure gets one immediate full-page recovery. Persist the
  // retry budget across page loads to avoid an infinite reload loop on a bad MP4.
  const RELOAD_HISTORY_KEY=`clinic-signage:failure-reloads:${key||'none'}`;
  const RELOAD_WINDOW_MS=5*60*1000,MAX_RELOADS_PER_WINDOW=2;
  function reloadAfterPlaybackFailure(reason){
    if(intentionalNavigation||!state||state.mode==='closed'||state.room?.paused)return false;
    let recent=[];
    try{recent=JSON.parse(sessionStorage.getItem(RELOAD_HISTORY_KEY)||'[]');if(!Array.isArray(recent))recent=[];}catch(_){recent=[];}
    const now=Date.now();recent=recent.filter(t=>Number.isFinite(t)&&now-t<RELOAD_WINDOW_MS&&now>=t);
    if(recent.length>=MAX_RELOADS_PER_WINDOW){
      console.warn('[Clinic Signage] reload budget exceeded, using video fallback:',reason);
      return false;
    }
    recent.push(now);
    try{sessionStorage.setItem(RELOAD_HISTORY_KEY,JSON.stringify(recent));}catch(_){}
    console.warn('[Clinic Signage] playback failure, reloading player:',reason);
    intentionalNavigation=true; // do not send a false 'stopped' report on internal reload
    try{location.reload();}catch(_){intentionalNavigation=false;return false;}
    return true;
  }
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
    if(token!==offlineCacheSyncToken){try{await response.body?.cancel();}catch(_){}return false;}
    /* Store the response directly. response.clone() tees the body and the unread branch
       buffers the whole video in memory (hundreds of MB on a kiosk). */
    await cache.put(url,response);
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
      const forceRefresh=false; // Cache is keyed by exact media URL; playlist edits must not redownload unchanged video files.
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
    if(PREVIEW)return;
    clearTimeout(offlineCacheTimer);
    if(!navigator.onLine||!state?.playlist?.length||state?.mode==='closed')return;
    const meta=readJsonStorage(OFFLINE_CACHE_META_KEY);
    if(!force&&meta?.ready&&meta?.playlist_signature===playlistSignature(state)){
      offlineCacheReady=true;offlineCacheCount=Number(meta.count||0);offlineCacheTotal=Number(meta.total||0);offlineCacheUpdatedAt=meta.updated_at||null;return;
    }
    offlineCacheTimer=setTimeout(()=>{if(confirmedPlaybackState!=='playing'||transitionInProgress){scheduleOfflinePlaylistCache(false);return;}void syncOfflinePlaylistCache();},OFFLINE_CACHE_START_DELAY_MS);
  }
  function playlistSignature(s) {
    return `${s?.mode||''}|${s?.sync_revision||s?.broadcast_revision||0}|${(s?.playlist||[]).map(v=>`${v.id}:${v.url||''}:${v.file_modified_at||''}:${v.size||0}`).join(',')}`;
  }
  function stateSignature(s) {
    const r=s?.room||{};
    return `${playlistSignature(s)}|${r.volume}|${r.paused}|${r.overlay_text||''}|${s?.notice_text||''}`;
  }
  // Browser tab title follows the configured display name. No extra database request.
  function updatePlayerTabTitle(s){
    const configuredName=typeof s?.room?.name==='string'?s.room.name.trim():'';
    const name=configuredName.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,80);
    const next=name?`${name} · Clinic Signage`:'Clinic Signage · Patient Display';
    if(document.title!==next)document.title=next;
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
    intentionalNavigation=true;
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
    const existingA=qs('#screenVideoA'),existingB=qs('#screenVideoB');
    if(existingA&&existingB){
      slots=[existingA,existingB];
      activeSlot=existingB.classList.contains('is-active')?1:0;
      const html=bars();if(html&&!qs('#playerBar'))root.insertAdjacentHTML('beforeend',html);
    }else{
      root.innerHTML=`<video id="screenVideoA" class="player-video is-active" muted playsinline preload="auto"></video><video id="screenVideoB" class="player-video" muted playsinline preload="auto"></video>${bars()}`;
      slots=[qs('#screenVideoA'),qs('#screenVideoB')];
      activeSlot=0;
    }
    slots.forEach((el,slotIndex)=>{
      if(el.dataset.playerBound==='1')return;
      el.dataset.playerBound='1';
      el.addEventListener('ended',()=>{if(slotIndex===activeSlot&&!emergencyPlaying){confirmedPlaybackState='ended';if(updatePendingVersion){reloadForUpdate();return;}advanceSeamless();}});
      el.addEventListener('playing',()=>{if(slotIndex===activeSlot){clearTimeout(pauseConfirmTimer);/* The switch owner clears transitionInProgress only after slot commit. */confirmedPlaybackState=emergencyPlaying?'emergency':'playing';lastError=null;cycleFailures=0;const played=current();if(played?.id)mediaFailures.delete(String(played.id));lastProgressAt=Date.now();lastProgressTime=el.currentTime||0;watchForPreroll(el,slotIndex);pushLiveStatusNow();queueHeartbeat(true);}});
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
      el.addEventListener('error',()=>{if(slotIndex===activeSlot&&!emergencyPlaying){confirmedPlaybackState='error';pushLiveStatusNow();if(!transitionInProgress&&!reloadAfterPlaybackFailure('video-error'))void handleMediaFailure(current());else if(transitionInProgress)void handleMediaFailure(current());}});
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
    el.muted=Boolean(state.room.force_mute);
  }
  function slotMatches(el,v){return Boolean(el&&v&&el.dataset.videoId===String(v.id||'')&&el.dataset.mediaUrl===mediaUrl(v));}
  function resetSlot(el){
    if(!el)return;
    try{el.pause();}catch(_){}
    el.loop=false;el.removeAttribute('src');el.dataset.videoId='';el.dataset.mediaUrl='';el.dataset.videoIndex='';el.dataset.prerolled='';
    try{el.load();}catch(_){}
  }
  function loadSlot(el,v,videoIndex,preloadMode='auto'){
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
  // Edge may leave HTMLVideoElement.play() pending indefinitely while a source is
  // buffering. A bounded attempt lets the playlist skip that clip instead of
  // leaving transitionInProgress set forever.
  function playWithDeadline(el,timeoutMs=6000){
    let timer;
    const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);});
    return Promise.race([Promise.resolve().then(()=>el.play()).then(()=>true,()=>false),deadline])
      .finally(()=>clearTimeout(timer));
  }
  async function playElement(el){
    if(!el)return false;
    if(state?.room?.paused)return true;
    const forceMute=Boolean(state?.room?.force_mute);
    const targetVolume=Math.max(0,Math.min(1,Number(state?.room?.volume||0)/100));
    el.volume=targetVolume;
    /* Kiosk Chrome may permit unmuted autoplay, but ordinary Edge can reject it. */
    el.muted=forceMute;
    if(await playWithDeadline(el)){
      lastError=null;
      return true;
    }
    /* Keep video running silently rather than getting stuck on an audio policy. */
    if(!el.muted){
      el.muted=true;
      if(await playWithDeadline(el,4000)){
        lastError=null;
        return true;
      }
    }
    lastError='영상 재생 시작 실패 또는 시간 초과';
    queueHeartbeat(true);
    return false;
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
    // requestAnimationFrame may pause in a covered Edge window. Always settle.
    return new Promise(resolve=>{
      let done=false;
      const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve(token===switchToken&&el.readyState>=2);};
      const timer=setTimeout(finish,timeoutMs);
      requestAnimationFrame(()=>requestAnimationFrame(finish));
    });
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
    if(prerollBusy||transitionInProgress||emergencyPlaying||state?.room?.paused||state?.mode==='closed')return false;
    const items=list();if(items.length<2)return false;
    const targetIndex=nextPlayableIndex();
    if(targetIndex===index%items.length)return false;
    if(prerolledIndex===targetIndex&&prerolledSlot===inactiveSlotIndex())return true;
    const v=items[targetIndex],slot=inactiveSlotIndex(),el=slots[slot];
    if(!v||!mediaUrl(v)||!el)return false;
    prerollBusy=true;
    // Preroll must NEVER invalidate the actual video switch token.
    const token=switchToken,sourceActiveSlot=activeSlot;
    const stillInactive=()=>token===switchToken&&sourceActiveSlot===activeSlot&&slot===inactiveSlotIndex()&&!transitionInProgress;
    try{
      loadSlot(el,v,targetIndex,'auto');
      if(!(await waitUntilPlayable(el,token,5000))||!stillInactive())return false;
      const desiredMuted=el.muted,desiredVolume=el.volume;
      el.muted=true;el.volume=0;
      let started=false;
      try{await el.play();started=true;}catch(_){}
      if(!started||!stillInactive())return false;
      if(!(await waitForRenderedFrame(el,token,1200))||!stillInactive())return false;
      // Never pause a slot after it has become the active display.
      if(!stillInactive())return false;
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
  async function switchToIndex(targetIndex,{sync=false,force=false}={}){
    const items=list(); if(!items.length){blankPlayer();return false;}
    const normalized=((targetIndex%items.length)+items.length)%items.length;
    const v=items[normalized];
    ensureSurface();
    const currentEl=activeVideoEl();
    if(!force&&slotMatches(currentEl,v)){
      index=normalized;
      if(currentEl.ended){try{currentEl.currentTime=0;}catch(_){}if(!state?.room?.paused&&!(await playElement(currentEl)))return false;}
      applyLiveControls();prepareNext();return true;
    }

    const targetSlot=inactiveSlotIndex(),nextEl=slots[targetSlot];
    const readyPreroll=prerolledIndex===normalized&&prerolledSlot===targetSlot&&nextEl?.dataset.prerolled==='1'&&slotMatches(nextEl,v);
    // Any pending preroll is now stale; invalidate it before awaiting play().
    const token=++switchToken;

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
      if(!started||token!==switchToken){transitionInProgress=false;return false;}
      confirmedPlaybackState=emergencyPlaying?'emergency':'playing';
      /* A hidden Edge window may suspend requestAnimationFrame indefinitely.
         Finalize the successful switch now, rather than leaving the player locked. */
      if(currentEl&&currentEl!==nextEl){try{currentEl.pause();currentEl.currentTime=0;}catch(_){}}
      transitionInProgress=false;prepareNext();queueHeartbeat(true);pushLiveStatusNow();
      return true;
    }

    transitionInProgress=true;
    loadSlot(nextEl,v,normalized,'auto');

    /* Cold start must be visible immediately. The previous implementation played
       the hidden slot first and waited up to four seconds for a rendered-frame
       callback before making it visible. On startup that created an artificial
       delay even when Chromium had already begun decoding the video. */
    const coldStart=!currentEl?.dataset?.videoId;
    if(coldStart){
      nextEl.classList.add('is-active');
      currentEl?.classList.remove('is-active');
      activeSlot=targetSlot;index=normalized;emergencyPlaying=false;lastError=null;cycleFailures=0;
    }

    const started=sync?await startWithBroadcastSync(nextEl):await playElement(nextEl);
    if(!started||token!==switchToken){
      if(coldStart){nextEl.classList.remove('is-active');currentEl?.classList.add('is-active');activeSlot=targetSlot===0?1:0;}
      // A timed-out source must never keep playing invisibly after a later switch.
      if(token===switchToken){try{nextEl.pause();}catch(_){}}
      transitionInProgress=false;
      if(token===switchToken){confirmedPlaybackState='error';lastProgressAt=Math.min(lastProgressAt,Date.now()-15000);scheduleReport(0);}
      return false;
    }

    if(!coldStart){
      /* During an actual video-to-video transition, wait only briefly for the first
         decoded frame so we keep the seamless swap without delaying startup. */
      await waitForRenderedFrame(nextEl,token,700);
      if(token!==switchToken){transitionInProgress=false;return false;}
      nextEl.classList.add('is-active');
      activeSlot=targetSlot;index=normalized;emergencyPlaying=false;lastError=null;cycleFailures=0;
      currentEl?.classList.remove('is-active');
    }
    confirmedPlaybackState='playing';
    /* Do not depend on a rendering callback when the TV is behind another window. */
    if(currentEl&&currentEl!==nextEl){try{currentEl.pause();currentEl.currentTime=0;}catch(_){}}
    transitionInProgress=false;prepareNext();queueHeartbeat(true);pushLiveStatusNow();
    return true;
  }
  function prepareNext(){
    if(emergencyPlaying)return;
    const items=list(); if(items.length<2)return;
    const nextIndex=nextPlayableIndex(),nextVideo=items[nextIndex],el=slots[inactiveSlotIndex()];
    if(nextIndex===index%items.length||!nextVideo||!mediaUrl(nextVideo))return;
    /* Signage favors instant switching over bandwidth savings: keep the next item hot. */
    loadSlot(el,nextVideo,nextIndex,'auto');
  }
  /* A video that already failed MEDIA_FAILURE_LIMIT times is skipped for the cooldown period.
     Previously only the failure handler honoured the block list, so every natural advance
     retried the broken file: one failed load, an error report and a status flip per cycle. */
  function mediaBlocked(v,now=Date.now()){const f=mediaFailures.get(String(v?.id||mediaUrl(v)||'unknown'));return !!(f&&f.count>=MEDIA_FAILURE_LIMIT&&now-f.lastAt<MEDIA_FAILURE_COOLDOWN_MS);}
  function nextPlayableIndex(){
    const items=list();if(!items.length)return 0;const now=Date.now();
    for(let step=1;step<=items.length;step++){const i=(index+step)%items.length;if(!mediaBlocked(items[i],now))return i;}
    return (index+1)%items.length;
  }
  let playlistAdvanceBusy=false;
  async function advanceSeamless(){
    // A duplicated ended/transition event must not start two competing switches.
    if(playlistAdvanceBusy)return;
    const items=list();if(!items.length)return;
    playlistAdvanceBusy=true;
    try{
      const target=nextPlayableIndex();
      const ok=await switchToIndex(target);
      if(!ok)await handleMediaFailure(items[target]);
    }catch(e){
      console.warn('[Clinic Signage] playlist advance failed:',e?.message||e);
      await handleMediaFailure(items[nextPlayableIndex()]);
    }finally{
      playlistAdvanceBusy=false;
    }
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

  /* fromPoll=true only for the fallback timer. A fallback poll that finds nothing new must not
     rewrite synced_at or push a status write: that used to change the status fingerprint every
     poll, which turned the admin delta query into a full-table read and doubled DB writes. */
  async function fetchState(opts){
    const fromPoll=opts?.fromPoll===true;
    if(fetchInFlight){ fetchQueued=true; if(!fromPoll)fetchQueuedUrgent=true; return; }
    if(!db)return;
    fetchInFlight=true;const requestStarted=Date.now();
    try{
      let {data,error}=await db.rpc(stateRpc,{p_key:key});
      if(error&&stateRpc!=='player_get_state'&&Signage.isMissingFunction(error)){stateRpc='player_get_state';({data,error}=await db.rpc(stateRpc,{p_key:key}));}
      if(error)throw error;
      if(!data){if(!state){root.innerHTML='<div class="player-message">등록되지 않은 플레이어 주소입니다. 관리자 화면에서 링크를 다시 복사하세요.</div>';slots=[];}return;}
      updateServerClock(data.server_time,requestStarted,Date.now());
      if(lastNonce===null)lastNonce=data.room.reload_nonce;
      else if(data.room.reload_nonce!==lastNonce){intentionalNavigation=true;try{const u=new URL(location.href);u.searchParams.set('_remote_reload',String(Date.now()));location.replace(u.toString());}catch(_){location.reload();}return;}
      const newPlaylistSig=playlistSignature(data),newStateSig=stateSignature(data),playlistChanged=newPlaylistSig!==lastPlaylistSig,stateChanged=newStateSig!==lastStateSig;
      state=data;updatePlayerTabTitle(state);if(!emergencyPlaying)lastError=null;saveState();scheduleExpiry();scheduleTransition();if(state.mode!=='closed'){cacheEmergency().catch(()=>{});scheduleOfflinePlaylistCache(playlistChanged);}else{clearTimeout(offlineCacheTimer);offlineCacheSyncToken++;}subscribePlayerRealtime();
      const fetchedAt=data.server_time||null;
      lastStateSig=newStateSig;
      const meaningful=!fromPoll||playlistChanged||stateChanged||!syncedAt;
      if(playlistChanged||state?.mode==='closed'){lastPlaylistSig=newPlaylistSig;index=0;cycleFailures=0;recoveryAttempts=0;recoveryStage=0;lastProgressAt=Date.now();emergencyPlaying=false;await renderFull();if(meaningful)syncedAt=fetchedAt;queueHeartbeat(true);}
      else{if(stateChanged){applyLiveControls();renderBarsOnly();queueHeartbeat(true);}if(meaningful)syncedAt=fetchedAt;}
      if(meaningful)reportNow();
    }catch(e){lastError=e?.message||String(e);if(state?.mode!=='closed'&&!navigator.onLine){const cached=offlineReadyState();if(cached?.playlist?.length){state=cached;updatePlayerTabTitle(state);lastPlaylistSig=playlistSignature(cached);lastStateSig=stateSignature(cached);index=0;lastError=null;await renderFull();}}queueHeartbeat(true);}
    finally{fetchInFlight=false;scheduleStatePoll();if(fetchQueued){const urgent=fetchQueuedUrgent;fetchQueued=false;fetchQueuedUrgent=false;queueMicrotask(()=>fetchState({fromPoll:!urgent}));}}
  }
  function loadSaved(){
    try{
      const saved=readJsonStorage(savedKey),offline=offlineReadyState();
      const initial=(!navigator.onLine&&offline)||saved||offline;
      if(initial?.playlist){state=initial;updatePlayerTabTitle(state);lastPlaylistSig=playlistSignature(initial);lastStateSig=stateSignature(initial);renderFull();}
    }catch(_){}
  }

  async function cacheEmergency(){
    if(PREVIEW)return false;
    const url=emergencyUrl();if(!('caches' in window))return false;
    if(state?.mode==='closed')return false;if(!url){await caches.delete(EMERGENCY_CACHE);return false;}
    const size=Number(state?.emergency_video?.size||0);if(size>MAX_EMERGENCY_CACHE_BYTES)return false;
    const cache=await caches.open(EMERGENCY_CACHE),existing=await cache.match(url);if(existing)return true;
    const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error(`emergency_http_${response.status}`);
    await cache.put(url,response);const keys=await cache.keys();await Promise.all(keys.filter(r=>r.url!==new URL(url,location.href).href).map(r=>cache.delete(r)));return true;
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
  /* The active slot's 'error' event and the caller of a failed switch can both report the same
     failure. Only one recovery pass runs at a time so failures are not double-counted. */
  let mediaFailureBusy=false;
  async function handleMediaFailure(v){
    if(state?.mode==='closed'||mediaFailureBusy)return;
    mediaFailureBusy=true;
    try{await handleMediaFailureOnce(v);}finally{mediaFailureBusy=false;}
  }
  async function handleMediaFailureOnce(v){
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
  function playbackState(){if(state?.mode==='closed')return 'closed';const el=activeVideoEl();if(!el)return list().length?'loading':'idle';if(lastError&&!emergencyPlaying)return 'error';if(state?.room?.paused)return 'paused';if(transitionInProgress)return confirmedPlaybackState==='playing'?'playing':'loading';if(emergencyPlaying)return 'emergency';if(el.ended)return 'ended';if(el.paused)return 'paused';if(el.readyState<3)return 'loading';if(confirmedPlaybackState==='playing')return 'playing';return 'playing';}
  function buildLiveStatus(){
    const el=activeVideoEl(),v=emergencyPlaying?state?.emergency_video:current(),items=list(),currentIndex=items.length?(index%items.length):0,nextVideo=items.length>1?items[(currentIndex+1)%items.length]:null;
    return {video_id:v?.id||null,title:v?.title||null,mode:emergencyPlaying?'emergency':state?.mode,playback_state:playbackState(),current_time:el&&Number.isFinite(el.currentTime)?Math.round(el.currentTime):0,duration:el&&Number.isFinite(el.duration)?Math.round(el.duration):0,muted:Boolean(el?.muted),volume:el?Math.round(el.volume*100):Number(state?.room?.volume||0),online:navigator.onLine,error:lastError,source:emergencyPlaying?'emergency-cache':(!navigator.onLine&&offlineCacheReady?'offline-playlist-cache':'cloud-r2'),recovery_stage:recoveryStage||null,synced_at:syncedAt,sync_revision:state?.sync_revision?String(state.sync_revision).slice(0,160):null,playlist_video_ids:emergencyPlaying?(v?.id?[v.id]:[]):items.slice(0,20).map(item=>item.id).filter(Boolean),playlist_titles:emergencyPlaying?(v?.title?[v.title]:[]):items.slice(0,8).map(item=>String(item.title||'영상').slice(0,120)),playlist_count:emergencyPlaying?(v?1:0):items.length,current_index:emergencyPlaying?0:currentIndex,next_title:emergencyPlaying?null:(nextVideo?.title||null),offline_cache_ready:offlineCacheReady,offline_cache_count:offlineCacheCount,offline_cache_total:offlineCacheTotal,offline_cache_error:offlineCacheError,operating_active:state?.operating?.active!==false,priority:state?.priority||state?.mode||'default',update_pending_version:updatePendingVersion,update_error:updateError||null,failed_video_count:[...mediaFailures.values()].filter(x=>x.count>=MEDIA_FAILURE_LIMIT).length,app_version:APP_VERSION,reported_at:new Date().toISOString()};
  }
  /* Live status report: meaningful changes wake admin/staff immediately; presence stays low-frequency. */
  /* Status class: what an admin card can actually show differently. Video-to-video transitions
     inside one playlist stay "active" so they do not wake every admin tab or write analytics. */
  function statusClassKey(st){
    const p=String(st?.playback_state||'');
    // Initial loading -> first real video frame must wake the admin immediately.
    // A playing-to-playing playlist transition keeps the same key, avoiding per-video wake-ups.
    const c=p==='emergency'?'playing':p;
    return `${c}|${st?.mode||''}|${st?.error?1:0}|${st?.recovery_stage||0}|${st?.update_pending_version||''}|${st?.offline_cache_error?1:0}|${Number(st?.failed_video_count||0)>0?1:0}`;
  }
  let lastWakeKey=null,lastWakeAt=0,lastHeartbeatKey=null,wakeRetryTimer=null;
  function notifyAdminOnStatusChange(wakeKey){
    if(wakeKey===lastWakeKey){clearTimeout(wakeRetryTimer);wakeRetryTimer=null;return;}
    clearTimeout(wakeRetryTimer);wakeRetryTimer=null;
    const isFirstPlayback=wakeKey.startsWith('playing|')&&!String(lastWakeKey||'').startsWith('playing|');
    const delay=isFirstPlayback?0:Math.max(0,10000-(Date.now()-lastWakeAt));
    const send=()=>{
      wakeRetryTimer=null;
      // Confirm the current state before waking: never send a stale 'playing' notification.
      const latest=statusClassKey(buildLiveStatus());
      if(latest===lastWakeKey)return;
      lastWakeKey=latest;lastWakeAt=Date.now();void broadcastStatusWake();
    };
    if(delay)wakeRetryTimer=setTimeout(send,delay);else send();
  }
  /* Admin wake-up goes out through the Realtime REST endpoint. Players no longer join the
     site status channel, so one player's wake is not fanned out to every other player
     in the hospital (Realtime bills per delivered message). */
  async function broadcastStatusWake(){
    const cfg=Signage.cfg,site=state?.room?.site_id;
    if(!state?.room?.id||!site||!cfg?.supabaseUrl)return false;
    try{
      const r=await fetch(`${String(cfg.supabaseUrl).replace(/\/+$/,'')}/realtime/v1/api/broadcast`,{
        method:'POST',cache:'no-store',keepalive:true,
        headers:{apikey:cfg.supabaseAnonKey,Authorization:`Bearer ${cfg.supabaseAnonKey}`,'Content-Type':'application/json'},
        body:JSON.stringify({messages:[{topic:`clinic-signage-status:${site}`,event:'changed',payload:{room_id:state.room.id,at:new Date().toISOString()},private:false}]})
      });
      return r.ok;
    }catch(_){return false;}
  }
  async function reportLive({wake=false}={}){
    if(PREVIEW)return;
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
      const wakeKey=statusClassKey(status);
      /* Wake as soon as playback first succeeds. If another wake happened within
         10 seconds, defer (rather than drop) this transition notification. */
      if(shouldWake)notifyAdminOnStatusChange(wakeKey);
    }catch(e){console.warn('Clinic Signage live report failed:',e?.message||e);if(shouldWake)reportWakePending=true;}
    finally{reportInFlight=false;if(reportQueued){reportQueued=false;scheduleReport(250,reportWakePending);}}
  }
  /* Coalesce bursts (playing + heartbeat + transition) into one write. */
  function scheduleReport(delay=250,wake=true){if(wake)reportWakePending=true;if(reportTimer)return;reportTimer=setTimeout(()=>{reportTimer=null;void reportLive({wake:reportWakePending});},delay);}
  function reportNow(){clearTimeout(reportTimer);reportTimer=null;void reportLive({wake:true});}
  function pushLiveStatusNow(){scheduleReport(100,true);}
  /* limit must be shorter than the interval. With limit==interval the tick fires a few ms
     "early" relative to lastReportAt (set after the RPC returns), skips, and an idle/paused/closed
     TV ends up reporting every 2x interval (600s) — exactly the 10-min offline threshold. */
  function presenceTick(){const limit=(state?.mode==='closed'?5*60*1000:LIVE_PRESENCE_MS)*0.8;if(Date.now()-lastReportAt>=limit)void reportLive({wake:false});}
  async function heartbeat(){
    if(PREVIEW)return;
    if(heartbeatInFlight){heartbeatQueued=true;return;}if(!db||!state?.room)return;if(state?.mode==='closed'&&Date.now()-lastHeartbeatAt<5*60*1000)return;heartbeatInFlight=true;
    try{
      const status=buildLiveStatus();
      const {error}=await db.rpc('player_heartbeat',{p_key:key,p_status:status});
      if(error)throw error;
      lastHeartbeatAt=Date.now();lastHeartbeatKey=statusClassKey(status);
    }catch(e){
      console.warn('Clinic Signage heartbeat failed:',e?.message||e);
      /* Live presence must never depend on the heavier analytics heartbeat. */
      scheduleReport();
    }finally{heartbeatInFlight=false;if(heartbeatQueued){heartbeatQueued=false;queueMicrotask(heartbeat);}}
  }

  async function playbackWatchdog(){
    /* Detect a stopped video AND a failed transition that left the previous video on
       screen. Checking only !paused && readyState >= 2 missed both failure modes. */
    if(!state||state.mode==='closed'||state.room?.paused||emergencyPlaying||!list().length||stallRecovering)return;
    const el=activeVideoEl(),desired=current();
    const mismatched=!slotMatches(el,desired);
    const stopped=!el||el.paused||el.ended||el.error||el.readyState<2;
    const stalled=Date.now()-lastProgressAt>=12000;
    if(!mismatched&&!stopped&&!stalled)return;
    /* Allow normal video switches and temporary buffering to finish before treating
       a lack of frame progress as a confirmed stall. */
    if(Date.now()-lastProgressAt<12000)return;
    if(reloadAfterPlaybackFailure(mismatched?'video-mismatch':stopped?'video-stopped':'no-frame-progress'))return;
    stallRecovering=true;
    recoveryAttempts++;
    recoveryStage=Math.min(5,recoveryAttempts);
    lastError=`재생 자동 복구 ${recoveryStage}단계`;
    queueHeartbeat(true);scheduleReport(0);
    try{
      let recovered=false;
      if(recoveryStage===1&&el&&!mismatched&&!el.error){
        if(el.ended){try{el.currentTime=0;}catch(_){}}
        if(el.readyState<2){try{el.load();}catch(_){}}
        recovered=await playElement(el);
      }else if(recoveryStage===2||recoveryStage===3){
        cancelPreroll();
        resetSlot(slots[inactiveSlotIndex()]);
        recovered=await switchToIndex(index,{force:true});
      }else if(recoveryStage===4){
        await fetchState();
        if(state?.mode==='closed'||state?.room?.paused)return;
        cancelPreroll();resetSlot(slots[inactiveSlotIndex()]);
        recovered=await switchToIndex(index,{force:true});
      }else{
        intentionalNavigation=true;
        location.reload();
        return;
      }
      /* play() resolving is not proof of frame progress. The next timeupdate will
         reset attempts. If frames remain stuck, escalate instead of retrying forever. */
      if(!recovered&&recoveryStage>=2)void handleMediaFailure(desired);
    }catch(e){console.warn('Clinic Signage playback recovery failed:',e?.message||e);if(recoveryStage>=2)void handleMediaFailure(desired);}
    finally{lastProgressAt=Date.now();stallRecovering=false;}
  }
  function pushHeartbeatNow(){clearTimeout(heartbeatTimer);heartbeatTimer=null;void heartbeat();}
  /* The analytics heartbeat (row lock on rooms + daily upsert + event insert) runs on its
     60s interval. An early heartbeat is sent only when the status class changed
     (playing -> paused/error/closed/mode change), not on every video transition. */
  function queueHeartbeat(immediate=false){
    if(immediate&&lastHeartbeatKey!==null&&state?.room&&statusClassKey(buildLiveStatus())===lastHeartbeatKey)return;
    /* Early heartbeats are spaced at least 10s apart so a flapping state cannot hammer the
       analytics write path; the latest status is what gets sent when the timer fires. */
    clearTimeout(heartbeatTimer);const wait=immediate?Math.max(0,10000-(Date.now()-lastHeartbeatAt)):1200;heartbeatTimer=setTimeout(heartbeat,wait);
  }
  async function acquireWake(){try{if(navigator.wakeLock&&document.visibilityState==='visible'){try{await wakeLock?.release();}catch(_){}wakeLock=await navigator.wakeLock.request('screen');}}catch(_){}}

  let realtimeRoomId=null,realtimeDbChannel=null,roomBroadcastChannel=null,realtimeFetchTimer=null,statePollTimer=null,realtimeControlReady=false,realtimeControlWasReady=false;
  let reportWakePending=false,fetchQueuedUrgent=false;
  function requestRealtimeState(){
    clearTimeout(realtimeFetchTimer);
    /* room:{key} and player_control_signals can fire for one action; 150ms coalesces
       them into a single player_get_state call. */
    realtimeFetchTimer=setTimeout(()=>fetchState(),150);
  }
  function subscribePlayerRealtime(){
    if(!db)return;
    const roomId=state?.room?.id||null;
    if(!roomBroadcastChannel){
      roomBroadcastChannel=db.channel(`room:${key}`).on('broadcast',{event:'refresh'},requestRealtimeState).subscribe();
    }
    if(!roomId||realtimeRoomId===roomId)return;
    if(realtimeDbChannel)db.removeChannel(realtimeDbChannel);
    realtimeRoomId=roomId;realtimeControlReady=false;
    // Canonical control wake-up channel. This table has a public SELECT policy by design,
    // so anonymous player screens can receive its Realtime UPDATE even though rooms and
    // other admin tables remain protected by RLS.
    realtimeDbChannel=db.channel(`clinic-player-control-${roomId}`)
      .on('postgres_changes',{event:'*',schema:'public',table:'player_control_signals',filter:`room_id=eq.${roomId}`},requestRealtimeState)
      .subscribe(status=>{
        const ready=status==='SUBSCRIBED';
        if(ready===realtimeControlReady)return;
        const reconnected=ready&&realtimeControlWasReady;
        realtimeControlReady=ready;if(ready)realtimeControlWasReady=true;
        /* Reconnected: catch up on anything missed while the socket was down. */
        if(reconnected)requestRealtimeState();else if(!ready)scheduleStatePoll();
      });
  }


  const PLAYER_FALLBACK_MS=Math.max(15000,Number(Signage.cfg.pollMs)||20000);
  const LIVE_PRESENCE_MS=Math.max(30000,Number(Signage.cfg.livePresenceMs)||300000);
  /* Admin (common.js) marks a room "delayed" after 7 min and offline after onlineThresholdMs
     (10 min) and polls every 60s, so a ~5-min presence write leaves one missed report of margin. */
  const PLAYBACK_PRESENCE_STALE_MS=Math.max(25000,LIVE_PRESENCE_MS-5000);
  const PLAYBACK_PRESENCE_RETRY_MS=10000;
  const ANALYTICS_HEARTBEAT_MS=Math.max(60000,Number(Signage.cfg.heartbeatMs)||300000);
  const CLOSED_FALLBACK_MS=10*60*1000;
  /* While the Realtime control channel is subscribed it is the primary path, so the
     full-state fallback poll backs off. If the socket drops, the short interval returns. */
  const PLAYER_REALTIME_FALLBACK_MS=Math.max(PLAYER_FALLBACK_MS,Number(Signage.cfg.pollMsRealtime)||60000);
  function scheduleStatePoll(){
    clearTimeout(statePollTimer);
    const wait=state?.mode==='closed'?CLOSED_FALLBACK_MS:(realtimeControlReady?PLAYER_REALTIME_FALLBACK_MS:PLAYER_FALLBACK_MS);
    statePollTimer=setTimeout(()=>void fetchState({fromPoll:true}),wait);
  }

  ensureSurface();if(!PREVIEW)void registerPlayerServiceWorker();loadSaved();acquireWake();fetchState();
  document.addEventListener('visibilitychange',()=>{acquireWake();if(document.visibilityState==='visible'){scheduleReport();void checkForPlayerUpdate(true);}});
  window.addEventListener('focus',()=>{scheduleReport();void checkForPlayerUpdate();});
  window.addEventListener('online',()=>{fetchState();scheduleOfflinePlaylistCache(true);void checkForPlayerUpdate(true);});
  window.addEventListener('offline',()=>{const cached=offlineReadyState();if(state?.mode!=='closed'&&cached&&playlistSignature(cached)!==playlistSignature(state)){state=cached;lastPlaylistSig=playlistSignature(cached);lastStateSig=stateSignature(cached);index=0;void renderFull();}});
  // Best-effort shutdown notice. A covered/background window does not trigger pagehide.
  // The browser may drop requests during a crash/power loss; server-side TTL is still authoritative.
  window.addEventListener('pagehide',()=>{
    /* Skip for our own reloads (update/remote reload/stall recovery): the new page reports
       within seconds, and a late keepalive "stopped" could overwrite that fresh status. */
    if(PREVIEW||intentionalNavigation||!state?.room?.id||!db)return;
    try{
      const cfg=Signage.cfg;
      const url=`${String(cfg.supabaseUrl).replace(/\/+$/,'')}/rest/v1/rpc/player_report`;
      const payload={p_key:key,p_status:{...buildLiveStatus(),playback_state:'stopped',online:false}};
      void fetch(url,{method:'POST',keepalive:true,cache:'no-store',headers:{apikey:cfg.supabaseAnonKey,Authorization:`Bearer ${cfg.supabaseAnonKey}`,'Content-Type':'application/json'},body:JSON.stringify(payload)}).catch(()=>{});
    }catch(_){}
  });
  window.addEventListener('beforeunload',()=>{clearTimeout(wakeRetryTimer);clearEmergencyObjectUrl();clearTimeout(realtimeFetchTimer);clearTimeout(statePollTimer);clearTimeout(reportTimer);clearTimeout(offlineCacheTimer);[realtimeDbChannel,roomBroadcastChannel].forEach(ch=>{if(ch)db?.removeChannel(ch);});});
  setTimeout(()=>void checkForPlayerUpdate(true),8000);
  /* Fallback only: Realtime wake-ups are primary. Closed rooms back off to 10 minutes. */
  scheduleStatePoll();
  /* Presence: skipped when an event-driven report already went out recently. */
  setInterval(presenceTick,LIVE_PRESENCE_MS);
  /* Analytics heartbeat (재생률 통계). Not the source of online truth. */
  setInterval(heartbeat,ANALYTICS_HEARTBEAT_MS);
  setInterval(playbackWatchdog,3000);
  setInterval(()=>{void checkForPlayerUpdate();if(updatePendingVersion)updateAtSafePoint();},60000);
})();
