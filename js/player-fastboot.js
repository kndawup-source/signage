(() => {
  'use strict';
  const root=document.getElementById('playerRoot');
  const key=new URLSearchParams(location.search).get('key');
  if(!root||!key)return;
  const savedKey=`clinic-signage:last-state:${key}`;
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
  function show(state){
    if(!canUseSavedState(state))return false;
    const v=Array.isArray(state.playlist)?state.playlist[0]:null;
    const url=String(v?.url||'').trim();
    if(!/^https?:\/\//i.test(url)||url===shownUrl)return false;
    shownUrl=url;
    root.innerHTML=`<video id="screenVideoA" class="player-video is-active" muted playsinline autoplay preload="auto" data-video-id="${escAttr(v?.id||'')}" data-media-url="${escAttr(url)}" data-video-index="0" src="${escAttr(url)}"></video><video id="screenVideoB" class="player-video" muted playsinline preload="auto"></video>`;
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
