(() => {
  'use strict';
  const root=document.getElementById('playerRoot');
  const key=new URLSearchParams(location.search).get('key');
  if(!root||!key)return;
  const savedKey=`clinic-signage:last-state:${key}`;
  const positionKey=`clinic-signage:play-position:${key}`;
  const escAttr=(v)=>String(v??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let shownUrl='';
  function canUseSavedState(state){
    if(!state||state.mode==='closed'||state.room?.paused)return false;
    const op=state.operating||{};
    if(op.active===false)return false;
    const end=Date.parse(op.current_end_at||'');
    if(Number.isFinite(end)&&Date.now()>=end)return false;
    const server=Date.parse(state.server_time||'');
    if(Number.isFinite(server)&&Date.now()-server>15*60*1000&&!Number.isFinite(end))return false;
    return true;
  }
  /* 복구/업데이트 새로고침 직후에는 player.js가 저장한 재생 위치부터 보여 준다.
     위치가 없거나 재생목록이 바뀌었으면 1번 영상. */
  function startIndex(playlist){
    try{
      const p=JSON.parse(sessionStorage.getItem(positionKey)||'null');
      const i=Number(p?.index);
      if(p&&Number.isInteger(i)&&i>=0&&i<playlist.length&&Date.now()-Number(p.at)<30*60*1000&&String(playlist[i]?.id||'')===String(p.video_id||''))return i;
    }catch(_){}
    return 0;
  }
  function show(state){
    // player.js가 이미 화면을 소유했다면 DOM을 교체하지 않는다(재생 중인 슬롯이 끊김).
    if(window.__CLINIC_SIGNAGE_PLAYER_ACTIVE__)return false;
    if(!canUseSavedState(state))return false;
    const playlist=Array.isArray(state.playlist)?state.playlist:[];
    const idx=startIndex(playlist);
    const v=playlist[idx]||null;
    const url=String(v?.url||'').trim();
    if(!/^https?:\/\//i.test(url)||url===shownUrl)return false;
    shownUrl=url;
    /* autoplay 속성은 쓰지 않는다. 이 요소는 player.js가 두 슬롯 중 하나로 재사용하는데,
       autoplay가 남아 있으면 다음 영상을 숨은 슬롯에 미리 로드할 때 저절로 재생된다. */
    root.innerHTML=`<video id="screenVideoA" class="player-video is-active" muted playsinline preload="auto" data-video-id="${escAttr(v?.id||'')}" data-media-url="${escAttr(url)}" data-video-index="${idx}" src="${escAttr(url)}"></video><video id="screenVideoB" class="player-video" muted playsinline preload="auto"></video>`;
    const el=document.getElementById('screenVideoA');
    if(el){
      el.volume=Math.max(0,Math.min(1,Number(state.room?.volume||0)/100));
      el.play().catch(()=>{});
    }
    return true;
  }
  try{show(JSON.parse(localStorage.getItem(savedKey)||'null'));}catch(_){}
  const cfg=window.CLINIC_SIGNAGE_CONFIG;
  if(!cfg?.supabaseUrl||!cfg?.supabaseAnonKey)return;
  fetch(`${String(cfg.supabaseUrl).replace(/\/+$/,'')}/rest/v1/rpc/player_get_state_lite`,{
    method:'POST',cache:'no-store',headers:{apikey:cfg.supabaseAnonKey,Authorization:`Bearer ${cfg.supabaseAnonKey}`,'Content-Type':'application/json'},body:JSON.stringify({p_key:key})
  }).then(r=>r.ok?r.json():Promise.reject(new Error(`state_http_${r.status}`))).then(state=>{
    if(!state)return;
    try{localStorage.setItem(savedKey,JSON.stringify(state));}catch(_){}
    show(state);
  }).catch(()=>{});
})();
