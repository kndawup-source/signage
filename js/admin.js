(async function () {
  'use strict';
  const { db, qs, qsa, esc, toast, formatBytes, formatDuration, isOnline, joinMediaUrl, titleFromPath } = Signage;
  await Signage.requireAuth('admin');
  qs('#signOut').addEventListener('click', Signage.signOut);

  const AGE_OPTIONS=[['teen','10대 이하'],['20-30','20~30대'],['40-50','40~50대'],['60+','60대 이상']];
  const GENDER_OPTIONS=[['female','여성'],['male','남성']];
  const TREATMENT_OPTIONS=[['implant','임플란트'],['veneer','라미네이트'],['whitening','미백'],['orthodontics','교정'],['checkup','검진'],['aftercare','수술 후 관리'],['general','일반 진료']];

  let tab='dashboard';
  let state={rooms:[],videos:[],tags:[],broadcast:null,settings:{media_server_url:'',emergency_video_id:null,disk_warning_gb:20}};
  let serverHealth=null;
  let roomRealtimeChannel=null;
  let loadSeq=0;
  const MAX_EMERGENCY_BYTES=250*1024*1024;

  qsa('.nav-btn').forEach((b)=>b.addEventListener('click',()=>{
    tab=b.dataset.tab;
    qsa('.nav-btn').forEach((x)=>x.classList.toggle('active',x===b));
    render();
  }));

  async function load(){
    const seq=++loadSeq;
    const [rooms,videos,tags,broadcast,settings]=await Promise.all([
      db.from('rooms').select('*').order('sort_order').order('created_at'),
      db.from('videos').select('*').order('sort_order').order('created_at'),
      db.from('tags').select('*').order('sort_order').order('name'),
      db.from('broadcast').select('*').eq('id',1).maybeSingle(),
      db.from('app_settings').select('*').eq('id',1).maybeSingle()
    ]);
    const errors=[rooms.error,videos.error,tags.error,broadcast.error,settings.error].filter(Boolean);
    if(errors.length)throw errors[0];
    if(seq!==loadSeq)return;
    state={
      rooms:rooms.data||[],videos:videos.data||[],tags:tags.data||[],
      broadcast:broadcast.data||{id:1,active:false,video_ids:[],notice_text:null},
      settings:settings.data||{media_server_url:'',emergency_video_id:null,disk_warning_gb:20}
    };
    render();
  }

  const chips=(selected=[],interactive=true)=>state.tags.map((t)=>`<button type="button" class="chip ${selected.includes(t.name)?'on':''}" ${interactive?'':'disabled'} data-tag="${esc(t.name)}">${esc(t.name)}</button>`).join('');
  function optionChips(kind,selected=[],options=[]){
    const allLabel=kind==='target_treatment'?'공통':'전체';
    return `<button type="button" class="chip ${!selected.length?'on':''}" data-target-kind="${kind}" data-target-value="">${allLabel}</button>${options.map(([value,label])=>`<button type="button" class="chip ${selected.includes(value)?'on':''}" data-target-kind="${kind}" data-target-value="${value}">${esc(label)}</button>`).join('')}`;
  }
  function modeLabel(mode){return ({broadcast:'전체',manual:'개별',patient:'맞춤',session:'맞춤',default:'기본',emergency:'비상'})[mode]||mode||'기본';}
  function render(){ if(tab==='dashboard')renderDashboard(); else if(tab==='videos')renderVideos(); else if(tab==='rooms')renderRooms(); else renderSettings(); }

  function operationalAlerts(){
    const alerts=[];
    if(state.settings.media_server_url){
      if(serverHealth===false)alerts.push({type:'danger',text:'내부 영상 서버에 연결할 수 없습니다.'});
      else if(serverHealth?.free_bytes!=null){const limit=(Number(state.settings.disk_warning_gb)||20)*1024**3;if(serverHealth.free_bytes<limit)alerts.push({type:'danger',text:`영상 서버 디스크 여유 ${formatBytes(serverHealth.free_bytes)} · 기준 ${state.settings.disk_warning_gb||20}GB 이하`});}
    }
    const offline=state.rooms.filter((r)=>!isOnline(r));
    if(offline.length)alerts.push({type:'warn',text:`오프라인 진료실 ${offline.length}곳: ${offline.slice(0,6).map(r=>r.name).join(', ')}${offline.length>6?' 외':''}`});
    const errors=state.rooms.filter((r)=>r.player_status?.error);
    if(errors.length)alerts.push({type:'warn',text:`재생 오류 ${errors.length}곳: ${errors.slice(0,4).map(r=>r.name).join(', ')}${errors.length>4?' 외':''}`});
    return alerts;
  }
  function alertsHtml(){const a=operationalAlerts();return `<div id="opsAlerts" class="ops-alerts">${a.map(x=>`<div class="ops-alert ${x.type}">${esc(x.text)}</div>`).join('')}</div>`;}
  function paintAlerts(){const el=qs('#opsAlerts');if(!el)return;const a=operationalAlerts();el.innerHTML=a.map(x=>`<div class="ops-alert ${x.type}">${esc(x.text)}</div>`).join('');}

  function renderDashboard(){
    const activeVideos=state.videos.filter((v)=>v.active&&v.available!==false);
    const selected=state.broadcast?.video_ids||[];
    const online=state.rooms.filter(isOnline).length;
    qs('#adminRoot').innerHTML=`
      <div class="page-head"><div><div class="eyebrow">CONTROL</div><h1>송출 제어</h1></div><div id="onlineStat" class="stat">온라인 <b>${online}</b> / ${state.rooms.length}</div></div>
      ${alertsHtml()}
      <section class="panel ${state.broadcast?.active?'broadcast-on':''}">
        <div class="panel-head"><div><h2>전체 송출</h2><p>30개 진료실 전체에 우선 송출합니다. 전체 송출 중에는 개별·맞춤보다 이 영상이 우선됩니다.</p></div>
        <button id="broadcastToggle" class="btn ${state.broadcast?.active?'danger':'primary'}" ${!state.broadcast?.active&&!selected.length?'disabled':''}>${state.broadcast?.active?'전체 송출 중지':`전체 송출 시작 (${selected.length})`}</button></div>
        <div id="broadcastPicks" class="pick-list">${activeVideos.length?activeVideos.map((v)=>`<button class="pick ${selected.includes(v.id)?'on':''}" data-video-id="${v.id}">${selected.includes(v.id)?`<span>${selected.indexOf(v.id)+1}</span>`:''}${esc(v.title)}</button>`).join(''):'<span class="muted">사용 가능한 영상이 없습니다.</span>'}</div>
        <div class="inline top-gap"><input id="notice" class="grow" placeholder="전체 공지 자막" value="${esc(state.broadcast?.notice_text||'')}"><button id="noticeSave" class="btn">공지 적용</button></div>
      </section>
      <div class="room-grid room-grid-control">${state.rooms.map((r)=>roomCard(r,activeVideos)).join('')||'<section class="panel"><p class="muted">등록된 진료실이 없습니다.</p></section>'}</div>`;

    qs('#broadcastPicks')?.addEventListener('click',async(e)=>{
      const b=e.target.closest('[data-video-id]');if(!b)return;
      const id=b.dataset.videoId;let ids=[...(state.broadcast.video_ids||[])];
      ids=ids.includes(id)?ids.filter((x)=>x!==id):[...ids,id];
      const result=state.broadcast.active
        ? await db.rpc('admin_set_broadcast',{p_active:ids.length>0,p_video_ids:ids,p_notice:state.broadcast.notice_text||null,p_delay_ms:3000})
        : await db.from('broadcast').update({video_ids:ids,updated_at:new Date().toISOString()}).eq('id',1);
      if(result.error)return toast(result.error.message,'error');await load();
    });
    qs('#broadcastToggle')?.addEventListener('click',async()=>{
      const next=!state.broadcast.active;if(next&&!(state.broadcast.video_ids||[]).length)return;
      const {error}=await db.rpc('admin_set_broadcast',{p_active:next,p_video_ids:state.broadcast.video_ids||[],p_notice:state.broadcast.notice_text||null,p_delay_ms:next?3000:0});
      if(error)return toast(error.message,'error');if(next)toast('3초 후 전체 동기 송출 시작');await load();
    });
    qs('#noticeSave')?.addEventListener('click',async()=>{
      const notice=qs('#notice').value.trim()||null;
      const {error}=await db.from('broadcast').update({notice_text:notice,updated_at:new Date().toISOString()}).eq('id',1);
      if(error)return toast(error.message,'error');toast('공지 적용 완료');await load();
    });
    qsa('[data-room-action]').forEach((b)=>b.addEventListener('click',()=>roomAction(b)));
    qsa('[data-volume]').forEach((r)=>r.addEventListener('change',()=>updateRoom(r.dataset.volume,{volume:Number(r.value)})));
    qsa('[data-room-send]').forEach((b)=>b.addEventListener('click',()=>sendRoomVideo(b.dataset.roomSend)));
    qsa('[data-room-auto]').forEach((b)=>b.addEventListener('click',()=>clearRoomVideo(b.dataset.roomAuto)));
    qsa('[data-overlay-save]').forEach((b)=>b.addEventListener('click',()=>{
      const id=b.dataset.overlaySave;updateRoom(id,{overlay_text:qs(`[data-overlay="${id}"]`).value.trim()||null});
    }));
  }

  function roomCard(r,activeVideos){
    const on=isOnline(r),st=r.player_status||{};
    const actualTitle=st.title||'대기 중';
    const progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'';
    const playback=(st.playback_state||'').toUpperCase();
    const manual=r.manual_active&&Array.isArray(r.manual_video_ids)&&r.manual_video_ids.length;
    const manualId=manual?r.manual_video_ids[0]:'';
    return `<section class="panel room-card" data-room-card="${r.id}">
      <div class="room-title"><span data-live-dot class="dot ${on?'on':''}"></span><h3>${esc(r.name)}</h3><span data-live-mode class="badge">${esc(modeLabel(st.mode))}</span></div>
      <div class="now-playing"><b data-live-title>${r.paused?'일시정지':esc(actualTitle)}</b><span data-live-detail>${on?`${esc(playback||'CONNECTED')}${progress?` · ${progress}`:''}${st.muted?' · 음소거':''}${st.error?` · ${esc(st.error)}`:''}`:'오프라인'}</span></div>
      <div class="room-command"><div class="section-label">개별 즉시 송출</div><div class="inline"><select data-room-video="${r.id}" ${state.broadcast?.active?'disabled':''}><option value="">영상 선택</option>${activeVideos.map((v)=>`<option value="${v.id}" ${manualId===v.id?'selected':''}>${esc(v.title)}</option>`).join('')}</select><button class="btn small primary" data-room-send="${r.id}" ${state.broadcast?.active?'disabled':''}>즉시 송출</button><button class="btn small" data-room-auto="${r.id}" ${manual?'':'disabled'}>자동 복귀</button></div>${state.broadcast?.active?'<div class="control-note">전체 송출 중에는 개별 송출이 적용되지 않습니다.</div>':''}</div>
      <div class="section"><div class="section-label">음량 <span data-volume-label>${r.volume}</span></div><input data-volume="${r.id}" type="range" min="0" max="100" value="${r.volume}"></div>
      <div class="inline"><button class="btn small" data-room-action="pause" data-room-id="${r.id}">${r.paused?'재생':'일시정지'}</button><button class="btn small" data-room-action="reload" data-room-id="${r.id}">플레이어 새로고침</button></div>
      <div class="inline"><input class="grow" data-overlay="${r.id}" placeholder="진료실 자막" value="${esc(r.overlay_text||'')}"><button class="btn small" data-overlay-save="${r.id}">적용</button></div>
    </section>`;
  }

  async function sendRoomVideo(roomId){
    if(state.broadcast?.active)return toast('전체 송출 중에는 개별 송출을 변경할 수 없습니다.','error');
    const sel=qs(`[data-room-video="${roomId}"]`);const videoId=sel?.value;if(!videoId)return toast('송출할 영상을 선택하세요.','error');
    const {error}=await db.rpc('admin_set_room_manual',{p_room:roomId,p_video_ids:[videoId],p_active:true});
    if(error)toast(error.message,'error');else{toast('개별 송출 명령 전송');await load();}
  }
  async function clearRoomVideo(roomId){
    const {error}=await db.rpc('admin_set_room_manual',{p_room:roomId,p_video_ids:[],p_active:false});
    if(error)toast(error.message,'error');else{toast('자동 송출로 복귀');await load();}
  }
  async function roomAction(b){const r=state.rooms.find((x)=>x.id===b.dataset.roomId);if(!r)return;if(b.dataset.roomAction==='pause')await updateRoom(r.id,{paused:!r.paused});else await updateRoom(r.id,{reload_nonce:(r.reload_nonce||0)+1});}
  async function updateRoom(id,patch){const {error}=await db.from('rooms').update(patch).eq('id',id);if(error)toast(error.message,'error');else await load();}

  function renderVideos(){
    const server=state.settings.media_server_url||'';
    qs('#adminRoot').innerHTML=`
      <div class="page-head"><div><div class="eyebrow">MEDIA</div><h1>영상 관리</h1></div><div class="stat">등록 ${state.videos.length}개</div></div>
      <section class="panel"><div class="panel-head"><div><h2>내부 서버 영상</h2><p>서버 PC 폴더를 스캔해 파일 메타데이터만 동기화합니다. 영상 파일은 Supabase에 업로드하지 않습니다.</p></div><button id="syncMedia" class="btn primary" ${server?'':'disabled'}>서버 영상 동기화</button></div><div class="server-line"><code>${esc(server||'설정에서 내부 영상 서버 주소를 먼저 입력하세요.')}</code></div></section>
      <section class="panel"><div class="panel-head"><div><h2>기본 재생 그룹</h2><p>환자 맞춤 조건과 별개로 진료실 기본 재생 목록에 사용합니다.</p></div></div><div class="inline"><input id="newTag" placeholder="새 기본 그룹"><button id="addTag" class="btn">추가</button></div><div class="tag-admin">${state.tags.map((t)=>`<span class="tag-item">${esc(t.name)}${t.name!=='기본'?`<button data-delete-tag="${esc(t.name)}">×</button>`:''}</span>`).join('')}</div></section>
      <section class="panel"><div class="panel-head"><div><h2>영상 목록</h2><p>각 영상에 대상과 진료유형을 미리 지정하면 스텝 선택에 따라 자동 송출됩니다. 비워두면 전체/공통입니다.</p></div></div><div class="media-list">${state.videos.map(videoRow).join('')||'<p class="muted">동기화된 영상이 없습니다.</p>'}</div></section>`;

    qs('#syncMedia')?.addEventListener('click',syncMedia);qs('#addTag')?.addEventListener('click',addTag);
    qsa('[data-delete-tag]').forEach((b)=>b.addEventListener('click',()=>deleteTag(b.dataset.deleteTag)));
    qsa('[data-video-active]').forEach((i)=>i.addEventListener('change',()=>updateVideo(i.dataset.videoActive,{active:i.checked})));
    qsa('[data-video-title]').forEach((i)=>i.addEventListener('change',()=>updateVideo(i.dataset.videoTitle,{title:i.value.trim()||titleFromPath(i.dataset.path)})));
    qsa('[data-video-tags]').forEach((wrap)=>wrap.addEventListener('click',async(e)=>{
      const b=e.target.closest('[data-tag]');if(!b)return;const id=wrap.dataset.videoTags,v=state.videos.find((x)=>x.id===id);if(!v)return;
      let tags=[...(v.tags||[])];tags=tags.includes(b.dataset.tag)?tags.filter((x)=>x!==b.dataset.tag):[...tags,b.dataset.tag];await updateVideo(id,{tags});
    }));
    qsa('[data-target-wrap]').forEach((wrap)=>wrap.addEventListener('click',async(e)=>{
      const b=e.target.closest('[data-target-kind]');if(!b)return;const id=wrap.dataset.targetWrap,v=state.videos.find((x)=>x.id===id);if(!v)return;
      const kind=b.dataset.targetKind,value=b.dataset.targetValue;let arr=[...(v[kind]||[])];
      if(!value)arr=[];else arr=arr.includes(value)?arr.filter((x)=>x!==value):[...arr,value];
      await updateVideo(id,{[kind]:arr});
    }));
    qsa('[data-move-video]').forEach((b)=>b.addEventListener('click',()=>moveVideo(b.dataset.moveVideo,Number(b.dataset.dir))));
  }

  function videoRow(v){
    const url=state.settings.media_server_url&&v.file_path?joinMediaUrl(state.settings.media_server_url,v.file_path,v.file_modified_at||''):'';
    return `<article class="media-row ${v.active?'':'inactive'}"><div class="order"><button data-move-video="${v.id}" data-dir="-1">↑</button><button data-move-video="${v.id}" data-dir="1">↓</button></div><div class="grow"><input class="title-input" data-video-title="${v.id}" data-path="${esc(v.file_path||'')}" value="${esc(v.title)}"><div class="meta">${formatBytes(v.size_bytes)} · ${v.available===false?'<b class="error">폴더에서 찾을 수 없음</b>':esc(v.file_path||'기존 외부 영상')}${url?` · <a href="${esc(url)}" target="_blank">재생 확인</a>`:''}</div>
      <div class="targeting" data-target-wrap="${v.id}"><div><div class="section-label">연령</div><div class="chips">${optionChips('target_age',v.target_age||[],AGE_OPTIONS)}</div></div><div><div class="section-label">성별</div><div class="chips">${optionChips('target_gender',v.target_gender||[],GENDER_OPTIONS)}</div></div><div><div class="section-label">진료유형</div><div class="chips">${optionChips('target_treatment',v.target_treatment||[],TREATMENT_OPTIONS)}</div></div></div>
      <div class="section top-gap"><div class="section-label">기본 재생 그룹</div><div class="chips" data-video-tags="${v.id}">${chips(v.tags||[])}</div></div></div><label class="toggle"><input type="checkbox" data-video-active="${v.id}" ${v.active?'checked':''} ${v.available===false?'disabled':''}><span>사용</span></label></article>`;
  }

  async function syncMedia(){const base=state.settings.media_server_url.replace(/\/+$/,'');const btn=qs('#syncMedia');btn.disabled=true;btn.textContent='동기화 중…';try{const res=await fetch(`${base}/api/files?refresh=1`,{cache:'no-store'});if(!res.ok)throw new Error(`미디어 서버 응답 ${res.status}`);const payload=await res.json();const files=(payload.files||[]).map((f)=>({path:f.path,size:Number(f.size||0),modified_at:f.modified_at||null}));const {error}=await db.rpc('admin_sync_local_videos',{p_files:files});if(error)throw error;toast(`${files.length}개 파일 동기화 완료`);await load();}catch(e){toast(`동기화 실패: ${e.message||e}`,'error');}finally{if(btn){btn.disabled=false;btn.textContent='서버 영상 동기화';}}}
  async function addTag(){const name=qs('#newTag').value.trim();if(!name)return;const max=state.tags.reduce((m,t)=>Math.max(m,t.sort_order||0),0);const {error}=await db.from('tags').insert({name,sort_order:max+10});if(error)toast(error.message,'error');else await load();}
  async function deleteTag(name){if(!confirm(`'${name}' 그룹을 삭제할까요?`))return;const {error}=await db.rpc('admin_delete_tag',{p_name:name});if(error)toast(error.message,'error');else await load();}
  async function updateVideo(id,patch){const {error}=await db.from('videos').update(patch).eq('id',id);if(error)toast(error.message,'error');else await load();}
  async function moveVideo(id,dir){const list=[...state.videos],from=list.findIndex((x)=>x.id===id),to=from+dir;if(from<0||to<0||to>=list.length)return;[list[from],list[to]]=[list[to],list[from]];const {error}=await db.rpc('admin_reorder_videos',{p_ids:list.map((x)=>x.id)});if(error)toast(error.message,'error');else await load();}

  function renderRooms(){
    qs('#adminRoot').innerHTML=`<div class="page-head"><div><div class="eyebrow">ROOMS</div><h1>진료실</h1></div><div class="stat">${state.rooms.length}곳</div></div><section class="panel"><div class="inline"><input id="newRoom" placeholder="진료실 이름"><button id="addRoom" class="btn primary">추가</button></div></section><div class="room-admin-list">${state.rooms.map(roomAdminRow).join('')}</div>`;
    qs('#addRoom').addEventListener('click',addRoom);
    qsa('[data-room-name]').forEach((i)=>i.addEventListener('change',()=>updateRoom(i.dataset.roomName,{name:i.value.trim()})));
    qsa('[data-timeout]').forEach((i)=>i.addEventListener('change',()=>updateRoom(i.dataset.timeout,{session_timeout_min:Math.max(0,Number(i.value)||0)})));
    qsa('[data-room-tags]').forEach((wrap)=>wrap.addEventListener('click',async(e)=>{const b=e.target.closest('[data-tag]');if(!b)return;const r=state.rooms.find((x)=>x.id===wrap.dataset.roomTags);if(!r)return;let tags=[...(r.default_tags||[])];tags=tags.includes(b.dataset.tag)?tags.filter((x)=>x!==b.dataset.tag):[...tags,b.dataset.tag];await updateRoom(r.id,{default_tags:tags});}));
    qsa('[data-delete-room]').forEach((b)=>b.addEventListener('click',async()=>{if(!confirm('진료실을 삭제할까요?'))return;const {error}=await db.from('rooms').delete().eq('id',b.dataset.deleteRoom);if(error)toast(error.message,'error');else await load();}));
    qsa('[data-move-room]').forEach((b)=>b.addEventListener('click',()=>moveRoom(b.dataset.moveRoom,Number(b.dataset.dir))));
    qsa('[data-copy-player]').forEach((b)=>b.addEventListener('click',async()=>{const r=state.rooms.find((x)=>x.id===b.dataset.copyPlayer);const u=`${location.origin}/player.html?key=${encodeURIComponent(r.player_key)}`;await navigator.clipboard.writeText(u);toast('환자 화면 링크 복사됨');}));
    qsa('[data-copy-staff]').forEach((b)=>b.addEventListener('click',async()=>{const r=state.rooms.find((x)=>x.id===b.dataset.copyStaff);const u=`${location.origin}/staff.html?room=${encodeURIComponent(r.id)}`;await navigator.clipboard.writeText(u);toast('진료실 고정 스텝 링크 복사됨');}));
  }
  function roomAdminRow(r){return `<section class="panel room-admin"><div class="order"><button data-move-room="${r.id}" data-dir="-1">↑</button><button data-move-room="${r.id}" data-dir="1">↓</button></div><div class="grow"><div class="inline"><input class="title-input" data-room-name="${r.id}" value="${esc(r.name)}"><span class="status-text">${isOnline(r)?'ONLINE':'OFFLINE'}</span></div><div class="grid-2"><div><div class="section-label">기본 재생 그룹</div><div class="chips" data-room-tags="${r.id}">${chips(r.default_tags||[])}</div></div><label class="field"><span>맞춤 자동 종료(분)</span><input data-timeout="${r.id}" type="number" min="0" value="${r.session_timeout_min}"></label></div><div class="inline top-gap"><button class="btn small" data-copy-player="${r.id}">환자 화면 링크</button><button class="btn small" data-copy-staff="${r.id}">스텝 고정 링크</button><button class="btn small danger-outline" data-delete-room="${r.id}">삭제</button></div></div></section>`;}
  async function addRoom(){const name=qs('#newRoom').value.trim();if(!name)return;const max=state.rooms.reduce((m,r)=>Math.max(m,r.sort_order||0),0);const {error}=await db.from('rooms').insert({name,sort_order:max+10});if(error)toast(error.message,'error');else await load();}
  async function moveRoom(id,dir){const list=[...state.rooms],from=list.findIndex((x)=>x.id===id),to=from+dir;if(from<0||to<0||to>=list.length)return;[list[from],list[to]]=[list[to],list[from]];const {error}=await db.rpc('admin_reorder_rooms',{p_ids:list.map((x)=>x.id)});if(error)toast(error.message,'error');else await load();}

  function renderSettings(){
    const activeVideos=state.videos.filter((v)=>v.active&&v.available!==false&&v.source==='local'&&v.file_path);
    qs('#adminRoot').innerHTML=`<div class="page-head"><div><div class="eyebrow">SYSTEM</div><h1>설정</h1></div></div>
      <section class="panel narrow-panel"><h2>내부 영상 서버</h2><p class="muted">서버 PC에서 media-server.js가 실행 중인 주소입니다.</p><label class="field"><span>서버 주소</span><input id="mediaServerUrl" placeholder="http://12F-MSO0:8080" value="${esc(state.settings.media_server_url||'')}"></label><label class="field"><span>디스크 경고 기준(GB)</span><input id="diskWarningGb" type="number" min="1" max="1000" value="${Number(state.settings.disk_warning_gb||20)}"></label><div class="inline top-gap"><button id="testServer" class="btn">연결 테스트</button><button id="saveServer" class="btn primary">저장</button></div><div id="serverResult" class="server-result"></div></section>
      <section class="panel narrow-panel"><h2>비상 로컬 영상</h2><p class="muted">평상시 각 환자 화면이 이 영상 1개를 로컬 캐시합니다. 내부 영상 서버 장애 시 자동 재생하고 서버 복구 후 정상 송출로 돌아옵니다.</p><label class="field"><span>비상 영상</span><select id="emergencyVideo"><option value="">사용 안 함</option>${activeVideos.map(v=>`<option value="${v.id}" ${state.settings.emergency_video_id===v.id?'selected':''}>${esc(v.title)} · ${formatBytes(v.size_bytes)}</option>`).join('')}</select></label><p class="muted">권장: 짧은 H.264 MP4, 약 50~200MB. 250MB를 넘는 파일은 비상영상으로 지정할 수 없습니다.</p><button id="saveEmergency" class="btn primary">비상영상 저장</button></section>
      <section class="panel narrow-panel"><h2>영상 폴더</h2><p>서버 PC 자체에 영상이 있다면 로컬 경로 사용을 권장합니다.</p><pre>C:\\Users\\Public\\Videos</pre><p class="muted">다른 PC에서는 \\12F-MSO0\Users\Public\Videos 로 파일을 복사할 수 있습니다.</p></section>`;
    qs('#testServer').addEventListener('click',testServer);qs('#saveServer').addEventListener('click',saveServer);qs('#saveEmergency').addEventListener('click',saveEmergency);
  }
  async function testServer(){const u=qs('#mediaServerUrl').value.trim().replace(/\/+$/,'');const out=qs('#serverResult');out.textContent='확인 중…';try{const r=await fetch(`${u}/health`,{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);const j=await r.json();serverHealth=j;out.innerHTML=`<span class="ok">연결됨</span> · ${esc(j.host||'')} · 영상 ${Number(j.files||0)}개${j.free_bytes!=null?` · 여유 ${formatBytes(j.free_bytes)}`:''}${j.active_streams!=null?` · 현재 스트림 ${Number(j.active_streams)}`:''} · APP ${esc(j.app_version||'확인불가')} · Supabase JS ${esc(j.supabase_version||'확인불가')}`;}catch(e){serverHealth=false;out.innerHTML=`<span class="error">연결 실패</span> · ${esc(e.message||e)}`;}}
  async function saveServer(){const url=qs('#mediaServerUrl').value.trim().replace(/\/+$/,'');if(!/^https?:\/\//i.test(url))return toast('http:// 또는 https:// 로 시작하는 주소를 입력하세요.','error');const disk=Math.max(1,Math.min(1000,Number(qs('#diskWarningGb').value)||20));const {error}=await db.from('app_settings').update({media_server_url:url,disk_warning_gb:disk,updated_at:new Date().toISOString()}).eq('id',1);if(error)toast(error.message,'error');else{toast('서버 설정 저장 완료');await load();checkServerHealth();}}
  async function saveEmergency(){
    const id=qs('#emergencyVideo').value||null;
    if(id){const video=state.videos.find((v)=>v.id===id);if(Number(video?.size_bytes||0)>MAX_EMERGENCY_BYTES)return toast('비상영상은 250MB 이하로 선택하세요.','error');}
    const {error}=await db.from('app_settings').update({emergency_video_id:id,updated_at:new Date().toISOString()}).eq('id',1);
    if(error)toast(error.message,'error');else{toast('비상영상 저장 완료');await load();}
  }
  async function checkServerHealth(){const u=(state.settings.media_server_url||'').replace(/\/+$/,'');if(!u){serverHealth=null;return;}try{const r=await fetch(`${u}/health`,{cache:'no-store'});if(!r.ok)throw new Error();serverHealth=await r.json();}catch(_){serverHealth=false;}if(tab==='dashboard')paintAlerts();}

  function mergeRealtimeRoom(next){
    const i=state.rooms.findIndex((r)=>r.id===next.id);if(i<0)return;
    state.rooms[i]={...state.rooms[i],...next};
    if(tab==='dashboard'){paintLiveRoom(state.rooms[i]);paintAlerts();}
    if(tab==='rooms'){const el=qs(`[data-room-name="${next.id}"]`)?.closest('.room-admin')?.querySelector('.status-text');if(el)el.textContent=isOnline(state.rooms[i])?'ONLINE':'OFFLINE';}
    const stat=qs('#onlineStat');if(stat)stat.innerHTML=`온라인 <b>${state.rooms.filter(isOnline).length}</b> / ${state.rooms.length}`;
  }
  function paintLiveRoom(r){
    const card=qs(`[data-room-card="${r.id}"]`);if(!card)return;const st=r.player_status||{},on=isOnline(r),progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'';
    const dot=qs('[data-live-dot]',card);if(dot)dot.classList.toggle('on',on);
    const mode=qs('[data-live-mode]',card);if(mode)mode.textContent=modeLabel(st.mode);
    const title=qs('[data-live-title]',card);if(title)title.textContent=r.paused?'일시정지':(st.title||'대기 중');
    const detail=qs('[data-live-detail]',card);if(detail)detail.textContent=on?`${String(st.playback_state||'CONNECTED').toUpperCase()}${progress?` · ${progress}`:''}${st.muted?' · 음소거':''}${st.error?` · ${st.error}`:''}`:'오프라인';
  }

  try{await load();}catch(e){qs('#adminRoot').innerHTML=`<p class="error">${esc(e.message||e)}</p>`;}

  roomRealtimeChannel=db.channel('admin-live-v2-4')
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'rooms'},(payload)=>mergeRealtimeRoom(payload.new))
    .on('postgres_changes',{event:'*',schema:'public',table:'broadcast'},()=>load())
    .subscribe();
  checkServerHealth();
  setInterval(checkServerHealth,30000);
  setInterval(()=>{if(tab==='dashboard'){state.rooms.forEach(paintLiveRoom);paintAlerts();const stat=qs('#onlineStat');if(stat)stat.innerHTML=`온라인 <b>${state.rooms.filter(isOnline).length}</b> / ${state.rooms.length}`;}},5000);
  window.addEventListener('beforeunload',()=>{if(roomRealtimeChannel)db.removeChannel(roomRealtimeChannel);});
})();
