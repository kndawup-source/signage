(async function () {
  'use strict';
  const { db, qs, qsa, esc, toast, formatBytes, formatDuration, isOnline, titleFromPath } = Signage;
  await Signage.requireAuth('admin');
  qs('#signOut').addEventListener('click', Signage.signOut);

  const AGE_OPTIONS=[['teen','10대 이하'],['20-30','20~30대'],['40-50','40~50대'],['60+','60대 이상']];
  const GENDER_OPTIONS=[['female','여성'],['male','남성']];
  const TREATMENT_OPTIONS=[['minish','미니쉬'],['implant','임플란트'],['whitening','미백'],['orthodontics','교정'],['checkup','검진'],['aftercare','수술 후 관리'],['general','일반 진료']];
  const GROUP_KINDS=[['floor','층'],['consultation','상담실'],['waiting','대기실'],['vip','VIP'],['other','기타']];
  const ROOM_MODES=[['treatment','진료실'],['consultation','상담실'],['waiting','대기실'],['other','기타']];
  const MAX_EMERGENCY_BYTES=250*1024*1024;

  let tab='dashboard', storageHealth=null, loadSeq=0, uploadBusy=false;
  let state={rooms:[],videos:[],playlists:[],playlistItems:[],groups:[],groupBroadcasts:[],schedules:[],history:[],broadcast:null,settings:{emergency_video_id:null}};

  qsa('.nav-btn').forEach((b)=>b.addEventListener('click',()=>{tab=b.dataset.tab;qsa('.nav-btn').forEach((x)=>x.classList.toggle('active',x===b));render();}));

  async function load(){
    const seq=++loadSeq;
    const [rooms,videos,playlists,playlistItems,groups,groupBroadcasts,schedules,history,broadcast,settings]=await Promise.all([
      db.from('rooms').select('*').order('sort_order').order('created_at'),
      db.from('videos').select('*').order('created_at',{ascending:false}),
      db.from('playlists').select('*').order('sort_order').order('created_at'),
      db.from('playlist_items').select('*').order('sort_order').order('created_at'),
      db.from('signage_groups').select('*').order('sort_order').order('created_at'),
      db.from('group_broadcasts').select('*'),
      db.from('broadcast_schedules').select('*').order('starts_at',{ascending:true}),
      db.from('control_history').select('*').order('created_at',{ascending:false}).limit(20),
      db.from('broadcast').select('*').eq('id',1).maybeSingle(),
      db.from('app_settings').select('*').eq('id',1).maybeSingle()
    ]);
    const errors=[rooms.error,videos.error,playlists.error,playlistItems.error,groups.error,groupBroadcasts.error,schedules.error,history.error,broadcast.error,settings.error].filter(Boolean);
    if(errors.length)throw errors[0]; if(seq!==loadSeq)return;
    state={rooms:rooms.data||[],videos:videos.data||[],playlists:playlists.data||[],playlistItems:playlistItems.data||[],groups:groups.data||[],groupBroadcasts:groupBroadcasts.data||[],schedules:schedules.data||[],history:history.data||[],broadcast:broadcast.data||{id:1,active:false,video_ids:[]},settings:settings.data||{emergency_video_id:null}};
    render();
  }

  function apiHeaders(){
    const session=Signage.getPinSession?.();
    return {'content-type':'application/json',...(session?.token?{'x-signage-session':session.token}:{})};
  }
  async function apiJson(path,options={}){
    const response=await fetch(path,{...options,headers:{...apiHeaders(),...(options.headers||{})}});
    const text=await response.text();
    let data={};
    try{data=text?JSON.parse(text):{};}catch{data={error:text||`HTTP ${response.status}`};}
    if(!response.ok)throw new Error(data.error||data.message||`HTTP ${response.status}`);
    return data;
  }
  function uploadByXhr(url,file,onProgress){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open('PUT',url,true);
      xhr.setRequestHeader('Content-Type',file.type||'application/octet-stream');
      xhr.upload.onprogress=(e)=>{if(e.lengthComputable)onProgress?.(Math.round((e.loaded/e.total)*100));};
      xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error(`R2 업로드 실패 · HTTP ${xhr.status}`));
      xhr.onerror=()=>reject(new Error('R2 업로드 네트워크 오류'));
      xhr.send(file);
    });
  }

  const activeVideos=()=>state.videos.filter((v)=>v.active&&v.available!==false);
  const groupById=(id)=>state.groups.find((g)=>g.id===id)||null;
  const groupBroadcast=(id)=>state.groupBroadcasts.find((g)=>g.group_id===id)||{group_id:id,active:false,video_ids:[],notice_text:null};
  const kindLabel=(v)=>GROUP_KINDS.find(([id])=>id===v)?.[1]||'기타';
  const roomModeLabel=(v)=>ROOM_MODES.find(([id])=>id===v)?.[1]||'기타';
  const modeLabel=(m)=>({broadcast:'전체',broadcast_schedule:'전체 예약',manual:'개별',group:'그룹',group_schedule:'그룹 예약',patient:'맞춤',session:'맞춤',default:'기본',emergency:'비상'})[m]||m||'기본';
  const playbackLabel=(v)=>({playing:'재생 중',paused:'일시정지',loading:'불러오는 중',error:'오류',connected:'연결됨'})[String(v||'').toLowerCase()]||'연결됨';
  function playlistInfo(st={}){
    const titles=Array.isArray(st.playlist_titles)?st.playlist_titles.filter(Boolean):[];
    const total=Number(st.playlist_count||titles.length||0);
    const current=Math.max(0,Number(st.current_index||0));
    return {titles,total,current,next:st.next_title||''};
  }
  function playlistHtml(st={}){
    const p=playlistInfo(st);
    if(!p.total&&!p.titles.length)return '<span class="playlist-empty">재생 목록 없음</span>';
    const visible=p.titles.length?p.titles:['현재 영상'];
    return `<div class="playlist-line">${visible.map((title,i)=>`<span class="playlist-item ${i===p.current?'now':''}"><i>${i+1}</i><b>${esc(title)}</b>${i===p.current?'<em>지금</em>':''}</span>`).join('<span class="playlist-arrow">→</span>')}${p.total>visible.length?`<span class="playlist-more">+${p.total-visible.length}</span>`:''}</div>`;
  }
  const playlistById=(id)=>state.playlists.find(p=>p.id===id)||null;
  const playlistItems=(id)=>state.playlistItems.filter(x=>x.playlist_id===id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  const playlistVideo=(item)=>state.videos.find(v=>v.id===item.video_id)||null;
  function optionChips(kind,selected=[],options=[]){const allLabel=kind==='target_treatment'?'공통':'전체';return `<button type="button" class="chip ${!selected.length?'on':''}" data-target-kind="${kind}" data-target-value="">${allLabel}</button>${options.map(([v,l])=>`<button type="button" class="chip ${selected.includes(v)?'on':''}" data-target-kind="${kind}" data-target-value="${v}">${esc(l)}</button>`).join('')}`;}
  const videoOptions=(selected='')=>`<option value="">영상 선택</option>${activeVideos().map(v=>`<option value="${v.id}" ${selected===v.id?'selected':''}>${esc(v.title)}</option>`).join('')}`;
  function render(){if(tab==='dashboard')renderDashboard();else if(tab==='videos')renderVideos();else renderSettings();}

  function operationalAlerts(){
    const alerts=[];
    if(storageHealth===false)alerts.push({type:'danger',text:'영상 저장소 설정을 확인하세요.'});
    const offline=state.rooms.filter(r=>!isOnline(r)); if(offline.length)alerts.push({type:'warn',text:`오프라인 ${offline.length}곳: ${offline.slice(0,6).map(r=>r.name).join(', ')}${offline.length>6?' 외':''}`});
    const errors=state.rooms.filter(r=>r.player_status?.error); if(errors.length)alerts.push({type:'warn',text:`재생 오류 ${errors.length}곳: ${errors.slice(0,4).map(r=>r.name).join(', ')}${errors.length>4?' 외':''}`});
    const oldVersion=state.rooms.filter(r=>r.player_status?.app_version&&r.player_status.app_version!=='2.14'); if(oldVersion.length)alerts.push({type:'warn',text:`플레이어 버전 확인 ${oldVersion.length}곳: ${oldVersion.slice(0,4).map(r=>r.name).join(', ')}`});
    return alerts;
  }
  function alertsHtml(){return `<div id="opsAlerts" class="ops-alerts">${operationalAlerts().map(x=>`<div class="ops-alert ${x.type}">${esc(x.text)}</div>`).join('')}</div>`;}
  function paintAlerts(){const el=qs('#opsAlerts');if(el)el.innerHTML=operationalAlerts().map(x=>`<div class="ops-alert ${x.type}">${esc(x.text)}</div>`).join('');}

  function renderDashboard(){
    const videos=activeVideos(),selected=state.broadcast?.video_ids||[],online=state.rooms.filter(isOnline).length;
    const grouped=[...state.groups.map(g=>({group:g,rooms:state.rooms.filter(r=>r.group_id===g.id)})),{group:null,rooms:state.rooms.filter(r=>!r.group_id)}].filter(x=>x.rooms.length||x.group);
    const errors=state.rooms.filter(r=>r.player_status?.error).length;
    const paused=state.rooms.filter(r=>r.paused).length;
    const activeGroups=state.groupBroadcasts.filter(g=>g.active).length;
    const storageState=storageHealth===false?'설정 필요':(storageHealth?.ok?'정상':'확인 중');
    const selectedTitles=selected.map(id=>state.videos.find(v=>v.id===id)?.title).filter(Boolean);
    const broadcastText=selectedTitles.length?selectedTitles.slice(0,2).join(' · ')+(selectedTitles.length>2?` 외 ${selectedTitles.length-2}개`:''):'기본 영상';
    qs('#adminRoot').innerHTML=`
      <div class="monitor-head"><div><span class="eyebrow">MONITOR</span><h1>송출 현황</h1></div><div class="monitor-clock-meta"><b id="onlineStat">${online}/${state.rooms.length}</b><span>온라인</span></div></div>
      <div class="monitor-status-strip">
        <div><span>온라인</span><b>${online}/${state.rooms.length}</b></div>
        <div><span>오류</span><b class="${errors?'danger-text':''}">${errors}</b></div>
        <div><span>일시정지</span><b>${paused}</b></div>
        <div><span>그룹 송출</span><b>${activeGroups}</b></div>
        <div><span>저장소</span><b class="${storageHealth===false?'danger-text':''}">${storageState}</b></div>
      </div>
      ${alertsHtml()}
      <section class="monitor-broadcast-strip ${state.broadcast?.active?'is-live':''}">
        <div class="monitor-broadcast-copy"><span>전체 송출</span><b>${state.broadcast?.active?'송출 중':'기본 상태'}</b><em>${esc(broadcastText)}</em></div>
        <div class="monitor-broadcast-actions"><details><summary>전체 송출 설정</summary><div class="monitor-broadcast-panel"><div id="broadcastPicks" class="pick-list">${videos.map(v=>`<button class="pick ${selected.includes(v.id)?'on':''}" data-video-id="${v.id}">${selected.includes(v.id)?`<span>${selected.indexOf(v.id)+1}</span>`:''}${esc(v.title)}</button>`).join('')||'<span class="muted">사용 가능한 영상이 없습니다.</span>'}</div><div class="inline top-gap"><input id="notice" class="grow" placeholder="공지 문구" value="${esc(state.broadcast?.notice_text||'')}"><button id="noticeSave" class="btn">공지 저장</button></div></div></details><button class="btn" data-undo-scope="hospital">되돌리기</button>${state.broadcast?.active?'<select id="broadcastResume"><option value="previous">종료 후 이전 상태</option><option value="default">종료 후 기본 영상</option></select>':''}<button id="broadcastToggle" class="btn ${state.broadcast?.active?'danger':'primary'}" ${!state.broadcast?.active&&!selected.length?'disabled':''}>${state.broadcast?.active?'전체 중지':'전체 시작'}</button></div>
      </section>
      <div class="monitor-groups">${grouped.map(({group,rooms})=>groupSection(group,rooms,videos)).join('')}</div>
      <details class="monitor-batch"><summary>여러 공간 한 번에 바꾸기</summary><div class="monitor-batch-body"><select id="batchVideo" class="grow">${videoOptions()}</select><button id="batchSend" class="btn primary">보내기</button><button id="batchAuto" class="btn">기본으로</button><button id="clearRoomChecks" class="btn">선택 해제</button></div></details>
      <div class="dashboard-secondary-grid">
        <details class="dashboard-secondary"><summary><span><b>예약 송출</b><small>정해진 시간에 전체 또는 그룹 영상 송출</small></span><em>${state.schedules.filter(s=>new Date(s.ends_at)>new Date()).length}건</em></summary><div class="dashboard-secondary-body">${schedulePanel(videos)}</div></details>
        <details class="dashboard-secondary"><summary><span><b>송출 기록</b><small>최근 변경 확인 및 되돌리기</small></span><em>${state.history.length}건</em></summary><div class="dashboard-secondary-body">${historyPanel()}</div></details>
      </div>`;
    bindDashboard();
  }

  function groupSection(group,rooms,videos){
    const gid=group?.id||'',gb=group?groupBroadcast(gid):null,online=rooms.filter(isOnline).length,selectedId=gb?.video_ids?.[0]||'';
    const errorCount=rooms.filter(r=>r.player_status?.error).length;
    const currentVideo=state.videos.find(v=>v.id===selectedId)?.title||'';
    return `<section class="monitor-group"><div class="monitor-group-head"><div><h2>${esc(group?.name||'미분류')}</h2><p>${group?esc(kindLabel(group.kind)):'기타'} · ${online}/${rooms.length} 온라인${errorCount?` · 오류 ${errorCount}`:''}${gb?.active&&currentVideo?` · ${esc(currentVideo)}`:''}</p></div>${group?`<details class="monitor-group-control"><summary>그룹 송출</summary><div><select data-group-video="${gid}">${videoOptions(selectedId)}</select><button class="btn primary" data-group-apply="${gid}">${gb.active?'변경':'보내기'}</button>${gb.active?`<button class="btn danger-outline" data-group-stop="${gid}">중지</button>`:''}<button class="btn" data-undo-group="${gid}">되돌리기</button></div></details>`:''}</div><div class="monitor-room-grid">${rooms.map(r=>roomCard(r,videos)).join('')||'<p class="muted">등록된 공간이 없습니다.</p>'}</div></section>`;
  }

  function roomCard(r,videos){
    const on=isOnline(r),st=r.player_status||{},progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'',manual=r.manual_active&&r.manual_video_ids?.length,manualId=manual?r.manual_video_ids[0]:'';
    const p=playlistInfo(st),currentTitle=r.paused?'일시정지':(st.title||'대기 중'),nextTitle=p.next||((p.titles.length>1)?p.titles[(p.current+1)%p.titles.length]:'');
    const bad=!!st.error;
    return `<details class="monitor-room ${!on?'is-offline':''} ${bad?'is-error':''} ${on&&String(st.playback_state||'').toLowerCase()==='playing'?'is-playing':''}" data-room-card="${r.id}"><summary><div class="monitor-room-top"><div class="monitor-room-name"><label class="room-check" onclick="event.stopPropagation()"><input type="checkbox" data-room-check="${r.id}"></label><span data-live-dot class="dot ${on?'on':''}"></span><b>${esc(r.name)}</b></div><span data-live-mode class="monitor-mode">${esc(modeLabel(st.mode))}</span></div><div class="monitor-now"><span>지금 재생</span><b data-live-title>${esc(currentTitle)}</b><small data-live-detail>${on?`${esc(playbackLabel(st.playback_state))}${progress?` · ${progress}`:''}${st.muted?' · 음소거':''}${st.error?` · ${esc(st.error)}`:''}`:'오프라인'}</small></div><div class="monitor-next"><span>다음</span><b data-live-next>${esc(nextTitle||'—')}</b></div><div class="monitor-playlist"><span>플레이리스트</span><div data-live-playlist>${playlistHtml(st)}</div></div><div class="monitor-manage-label">설정</div></summary><div class="monitor-room-controls"><div class="inline"><select data-room-video="${r.id}" class="grow">${videoOptions(manualId)}</select><button class="btn small primary" data-room-send="${r.id}">보내기</button><button class="btn small" data-room-auto="${r.id}" ${manual?'':'disabled'}>기본으로</button></div><div class="inline monitor-secondary-controls"><button class="btn small" data-room-action="pause" data-room-id="${r.id}">${r.paused?'재생':'일시정지'}</button><button class="btn small" data-room-action="reload" data-room-id="${r.id}">새로고침</button><span class="section-label">음량 ${r.volume}${r.force_mute?' · 항상 음소거':''}</span><input data-volume="${r.id}" type="range" min="0" max="100" value="${r.volume}"></div><div class="inline"><input class="grow" data-overlay="${r.id}" placeholder="화면 문구" value="${esc(r.overlay_text||'')}"><button class="btn small" data-overlay-save="${r.id}">문구 적용</button></div></div></details>`;
  }

  function schedulePanel(videos){
    const now=new Date(), future=state.schedules.filter(s=>new Date(s.ends_at)>now);
    return `<section class="panel"><div class="panel-head"><div><h2>예약</h2></div></div><div class="schedule-form"><select id="scheduleScope"><option value="hospital">전체 병원</option>${state.groups.map(g=>`<option value="group:${g.id}">${esc(g.name)}</option>`).join('')}</select><select id="scheduleVideo">${videoOptions()}</select><input id="scheduleStart" type="datetime-local"><input id="scheduleEnd" type="datetime-local"><input id="scheduleNotice" placeholder="공지 자막(선택)"><button id="addSchedule" class="btn primary">예약 추가</button></div><div class="schedule-list">${future.map(s=>{const g=groupById(s.group_id);const v=state.videos.find(x=>x.id===s.video_ids?.[0]);return `<div class="schedule-row"><b>${s.scope_type==='hospital'?'전체 병원':esc(g?.name||'그룹')}</b><span>${esc(v?.title||'영상')} · ${new Date(s.starts_at).toLocaleString('ko-KR')} → ${new Date(s.ends_at).toLocaleString('ko-KR')}</span><button class="btn small danger-outline" data-delete-schedule="${s.id}">삭제</button></div>`;}).join('')||'<p class="muted">예정된 예약이 없습니다.</p>'}</div></section>`;
  }
  function historyPanel(){return `<section class="panel"><div class="panel-head"><div><h2>기록</h2></div></div><div class="history-list">${state.history.slice(0,15).map(h=>`<div class="history-row"><span><b>${esc(h.label||h.scope_type)}</b><small>${esc(h.action)} · ${new Date(h.created_at).toLocaleString('ko-KR')}</small></span>${h.before_state&&['hospital','group','rooms'].includes(h.scope_type)?`<button class="btn small" data-undo-history="${h.id}">되돌리기</button>`:''}</div>`).join('')||'<p class="muted">이력이 없습니다.</p>'}</div></section>`;}

  function renderOperations(){
    const videos=activeVideos();
    qs('#adminRoot').innerHTML=`<div class="page-head"><div><h1>운영</h1></div><div class="stat">예약 ${state.schedules.filter(s=>new Date(s.ends_at)>new Date()).length}건</div></div>${schedulePanel(videos)}${historyPanel()}`;
    bindOperations();
  }
  function bindOperations(){
    qs('#addSchedule')?.addEventListener('click',addSchedule);
    qsa('[data-delete-schedule]').forEach(b=>b.addEventListener('click',()=>deleteSchedule(b.dataset.deleteSchedule)));
    qsa('[data-undo-history]').forEach(b=>b.addEventListener('click',()=>undoHistory(Number(b.dataset.undoHistory))));
  }

  function bindDashboard(){
    qs('#broadcastPicks')?.addEventListener('click',async(e)=>{const b=e.target.closest('[data-video-id]');if(!b)return;let ids=[...(state.broadcast.video_ids||[])],id=b.dataset.videoId;ids=ids.includes(id)?ids.filter(x=>x!==id):[...ids,id];const result=state.broadcast.active?await db.rpc('admin_set_broadcast',{p_active:ids.length>0,p_video_ids:ids,p_notice:state.broadcast.notice_text||null,p_delay_ms:3000}):await db.from('broadcast').update({video_ids:ids,updated_at:new Date().toISOString()}).eq('id',1);if(result.error)return toast(result.error.message,'error');await load();});
    qs('#broadcastToggle')?.addEventListener('click',async()=>{const next=!state.broadcast.active;if(next&&!state.broadcast.video_ids?.length)return;const result=next?await db.rpc('admin_set_broadcast',{p_active:true,p_video_ids:state.broadcast.video_ids||[],p_notice:state.broadcast.notice_text||null,p_delay_ms:3000}):await db.rpc('admin_stop_broadcast',{p_resume:qs('#broadcastResume')?.value||'previous'});if(result.error)return toast(result.error.message,'error');toast(next?'3초 후 전체 동기 송출 시작':'전체 송출 종료');await load();});
    qs('#noticeSave')?.addEventListener('click',async()=>{const {error}=await db.from('broadcast').update({notice_text:qs('#notice').value.trim()||null,updated_at:new Date().toISOString()}).eq('id',1);if(error)toast(error.message,'error');else{toast('공지 적용 완료');await load();}});
    qsa('[data-group-apply]').forEach(b=>b.addEventListener('click',()=>applyGroup(b.dataset.groupApply)));qsa('[data-group-stop]').forEach(b=>b.addEventListener('click',()=>stopGroup(b.dataset.groupStop)));
    qsa('[data-room-send]').forEach(b=>b.addEventListener('click',()=>sendRoomVideo(b.dataset.roomSend)));
    qsa('[data-room-auto]').forEach(b=>b.addEventListener('click',()=>clearRoomVideo(b.dataset.roomAuto)));
    qsa('[data-volume]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.volume,{volume:Number(i.value)})));
    qsa('[data-room-action]').forEach(b=>b.addEventListener('click',()=>roomAction(b)));
    qsa('[data-overlay-save]').forEach(b=>b.addEventListener('click',()=>updateRoom(b.dataset.overlaySave,{overlay_text:qs(`[data-overlay="${b.dataset.overlaySave}"]`).value.trim()||null})));
    qs('#clearRoomChecks')?.addEventListener('click',()=>qsa('[data-room-check]').forEach(i=>i.checked=false));
    qs('#batchSend')?.addEventListener('click',()=>batchRooms(true)); qs('#batchAuto')?.addEventListener('click',()=>batchRooms(false));
    qs('[data-undo-scope="hospital"]')?.addEventListener('click',()=>undoLatest('hospital',null)); qsa('[data-undo-group]').forEach(b=>b.addEventListener('click',()=>undoLatest('group',b.dataset.undoGroup)));
    qs('#addSchedule')?.addEventListener('click',addSchedule);
    qsa('[data-delete-schedule]').forEach(b=>b.addEventListener('click',()=>deleteSchedule(b.dataset.deleteSchedule)));
    qsa('[data-undo-history]').forEach(b=>b.addEventListener('click',()=>undoHistory(Number(b.dataset.undoHistory))));
  }

  async function applyGroup(groupId){const sel=qs(`[data-group-video="${groupId}"]`),notice=qs(`[data-group-notice="${groupId}"]`)?.value.trim()||null,id=sel?.value;if(!id)return toast('그룹에 송출할 영상을 선택하세요.','error');const {error}=await db.rpc('admin_set_group_broadcast',{p_group:groupId,p_active:true,p_video_ids:[id],p_notice:notice,p_delay_ms:2000});if(error)toast(error.message,'error');else{toast(groupBroadcast(groupId).active?'그룹 송출 변경':'그룹 송출 시작');await load();}}
  async function stopGroup(groupId){const gb=groupBroadcast(groupId);const {error}=await db.rpc('admin_set_group_broadcast',{p_group:groupId,p_active:false,p_video_ids:gb.video_ids||[],p_notice:gb.notice_text||null,p_delay_ms:0});if(error)toast(error.message,'error');else{toast('그룹 송출 종료');await load();}}
  async function sendRoomVideo(id){const v=qs(`[data-room-video="${id}"]`)?.value;if(!v)return toast('송출할 영상을 선택하세요.','error');const {error}=await db.rpc('admin_set_rooms_manual',{p_rooms:[id],p_video_ids:[v],p_active:true});if(error)toast(error.message,'error');else{toast('개별 송출 시작');await load();}}
  async function clearRoomVideo(id){const {error}=await db.rpc('admin_set_rooms_manual',{p_rooms:[id],p_video_ids:[],p_active:false});if(error)toast(error.message,'error');else{toast('자동 송출로 복귀');await load();}}
  async function batchRooms(active){const ids=qsa('[data-room-check]:checked').map(i=>i.dataset.roomCheck);if(!ids.length)return toast('공간을 선택하세요.','error');const video=qs('#batchVideo')?.value;if(active&&!video)return toast('영상을 선택하세요.','error');const {error}=await db.rpc('admin_set_rooms_manual',{p_rooms:ids,p_video_ids:active?[video]:[],p_active:active});if(error)toast(error.message,'error');else{toast(`${ids.length}곳 ${active?'송출 시작':'기본으로 변경'}`);await load();}}
  async function roomAction(b){const r=state.rooms.find(x=>x.id===b.dataset.roomId);if(!r)return;await updateRoom(r.id,b.dataset.roomAction==='pause'?{paused:!r.paused}:{reload_nonce:(r.reload_nonce||0)+1});}
  async function updateRoom(id,patch){const {error}=await db.from('rooms').update(patch).eq('id',id);if(error)toast(error.message,'error');else await load();}
  async function addSchedule(){const scope=qs('#scheduleScope').value,video=qs('#scheduleVideo').value,start=qs('#scheduleStart').value,end=qs('#scheduleEnd').value;if(!video||!start||!end)return toast('영상과 시작/종료 시각을 입력하세요.','error');const isGroup=scope.startsWith('group:'),group=isGroup?scope.slice(6):null;const {error}=await db.rpc('admin_create_schedule',{p_scope_type:isGroup?'group':'hospital',p_group:group,p_video_ids:[video],p_notice:qs('#scheduleNotice').value.trim()||null,p_starts_at:new Date(start).toISOString(),p_ends_at:new Date(end).toISOString()});if(error)toast(error.message,'error');else{toast('예약 송출 추가');await load();}}
  async function deleteSchedule(id){if(!confirm('예약을 삭제할까요?'))return;const {error}=await db.rpc('admin_delete_schedule',{p_id:id});if(error)toast(error.message,'error');else await load();}
  async function undoHistory(id){const {error}=await db.rpc('admin_undo_control',{p_history:id});if(error)toast(error.message,'error');else{toast('되돌렸습니다');await load();}}
  async function undoLatest(type,id){const h=state.history.find(x=>x.scope_type===type&&(!id||x.scope_id===id)&&x.before_state);if(!h)return toast('복귀 가능한 이전 상태가 없습니다.','error');await undoHistory(h.id);}

  function renderVideos(){
    const ready=storageHealth?.ok===true;
    qs('#adminRoot').innerHTML=`<div class="page-head"><div><span class="eyebrow">MEDIA</span><h1>영상</h1><p class="page-intro">영상 보관함과 실제 재생 순서를 분리해서 관리합니다.</p></div><div class="stat">영상 ${state.videos.length} · 플레이리스트 ${state.playlists.length}</div></div>
    <section class="panel upload-panel"><div class="panel-head"><div><h2>영상 업로드</h2><p>업로드한 영상은 보관함에 들어갑니다. 재생 순서는 플레이리스트에서 정합니다.</p></div><label class="btn primary ${ready?'':'disabled'}">파일 선택<input id="videoUpload" type="file" accept="video/mp4,video/webm" multiple hidden ${ready?'':'disabled'}></label></div><div id="uploadQueue" class="upload-queue"></div><div class="storage-line"><span class="dot ${ready?'on':''}"></span><b>영상 저장소</b><span>${ready?'연결됨':'설정 필요'}</span></div></section>
    <section class="panel playlist-manager"><div class="panel-head"><div><span class="eyebrow">PLAYLISTS</span><h2>플레이리스트</h2><p>용도별 묶음 안에서 영상과 순서를 관리합니다.</p></div></div><div class="playlist-create"><input id="newPlaylistName" placeholder="플레이리스트 이름"><select id="newPlaylistKind"><option value="default">기본 재생</option><option value="patient">환자 맞춤</option></select><select id="newPlaylistTreatment"><option value="">공통</option>${TREATMENT_OPTIONS.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><button id="addPlaylist" class="btn primary">만들기</button></div>${playlistGroupsHtml()}</section>
    <section class="panel"><div class="panel-head"><div><span class="eyebrow">LIBRARY</span><h2>영상 보관함</h2><p>영상의 제목과 사용 여부만 관리합니다.</p></div></div><div class="media-list">${state.videos.map(videoRow).join('')||'<p class="muted">등록된 영상이 없습니다.</p>'}</div></section>`;
    qs('#videoUpload')?.addEventListener('change',e=>uploadVideos([...e.target.files]));
    qs('#addPlaylist')?.addEventListener('click',addPlaylist);
    qsa('[data-playlist-delete]').forEach(b=>b.addEventListener('click',()=>deletePlaylist(b.dataset.playlistDelete)));
    qsa('[data-playlist-add]').forEach(b=>b.addEventListener('click',()=>addPlaylistItem(b.dataset.playlistAdd)));
    qsa('[data-playlist-remove]').forEach(b=>b.addEventListener('click',()=>removePlaylistItem(b.dataset.playlistRemove,b.dataset.videoId)));
    qsa('[data-playlist-move]').forEach(b=>b.addEventListener('click',()=>movePlaylistItem(b.dataset.playlistMove,b.dataset.videoId,Number(b.dataset.dir))));
    qsa('[data-playlist-name]').forEach(i=>i.addEventListener('change',()=>updatePlaylist(i.dataset.playlistName,{name:i.value.trim()||'플레이리스트'})));
    qsa('[data-playlist-active]').forEach(i=>i.addEventListener('change',()=>updatePlaylist(i.dataset.playlistActive,{active:i.checked})));
    qsa('[data-playlist-treatment]').forEach(i=>i.addEventListener('change',()=>updatePlaylist(i.dataset.playlistTreatment,{target_treatment:i.value?[i.value]:[]})));
    qsa('[data-playlist-age]').forEach(i=>i.addEventListener('change',()=>updatePlaylist(i.dataset.playlistAge,{target_age:i.value?[i.value]:[]})));
    qsa('[data-playlist-gender]').forEach(i=>i.addEventListener('change',()=>updatePlaylist(i.dataset.playlistGender,{target_gender:i.value?[i.value]:[]})));
    qsa('[data-video-active]').forEach(i=>i.addEventListener('change',()=>updateVideo(i.dataset.videoActive,{active:i.checked})));
    qsa('[data-title-edit]').forEach(b=>b.addEventListener('click',()=>toggleTitleEdit(b.dataset.titleEdit,true)));
    qsa('[data-title-input]').forEach(i=>{i.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();saveTitle(i.dataset.titleInput);}else if(e.key==='Escape'){e.preventDefault();toggleTitleEdit(i.dataset.titleInput,false);}});i.addEventListener('blur',()=>{if(!i.closest('[data-title-form]')?.classList.contains('hidden'))saveTitle(i.dataset.titleInput);});});
    qsa('[data-delete-video]').forEach(b=>b.addEventListener('click',()=>deleteVideo(b.dataset.deleteVideo)));
  }
  function playlistGroupsHtml(){
    const groups=[
      {kind:'default',title:'기본 플레이리스트',desc:'환자가 배정되지 않았을 때 공간에서 반복 재생합니다.'},
      {kind:'patient',title:'환자 맞춤 플레이리스트',desc:'리셉션에서 선택한 진료유형·연령·성별 조건에 맞춰 자동 재생합니다.'}
    ];
    return `<div class="playlist-groups">${groups.map(g=>{const list=state.playlists.filter(p=>p.kind===g.kind);return `<section class="playlist-group"><div class="playlist-group-head"><div><h3>${g.title}</h3><p>${g.desc}</p></div><span>${list.length}개</span></div><div class="playlist-admin-grid">${list.map(playlistCard).join('')||'<div class="playlist-group-empty">아직 플레이리스트가 없습니다.</div>'}</div></section>`;}).join('')}</div>`;
  }
  function playlistCard(p){
    const items=playlistItems(p.id), treatment=(p.target_treatment||[])[0], label=p.kind==='default'?'기본 재생':(treatment?TREATMENT_OPTIONS.find(([v])=>v===treatment)?.[1]||treatment:'환자 공통');
    const candidates=activeVideos().filter(v=>!items.some(i=>i.video_id===v.id));
    return `<article class="playlist-admin-card"><div class="playlist-admin-head"><div><input class="playlist-name-input" data-playlist-name="${p.id}" value="${esc(p.name)}"><span>${esc(label)} · ${items.length}개 영상</span></div><div class="inline"><label class="toggle"><input type="checkbox" data-playlist-active="${p.id}" ${p.active?'checked':''}><span>사용</span></label><button class="text-action danger-text" data-playlist-delete="${p.id}">삭제</button></div></div>${p.kind==='patient'?`<details class="playlist-target-details"><summary>맞춤 조건 <span>${esc(label)}</span></summary><div class="playlist-target-grid"><label class="field"><span>진료유형</span><select data-playlist-treatment="${p.id}"><option value="">공통</option>${TREATMENT_OPTIONS.map(([v,l])=>`<option value="${v}" ${(p.target_treatment||[])[0]===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="field"><span>연령</span><select data-playlist-age="${p.id}"><option value="">전체</option>${AGE_OPTIONS.map(([v,l])=>`<option value="${v}" ${(p.target_age||[])[0]===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="field"><span>성별</span><select data-playlist-gender="${p.id}"><option value="">전체</option>${GENDER_OPTIONS.map(([v,l])=>`<option value="${v}" ${(p.target_gender||[])[0]===v?'selected':''}>${l}</option>`).join('')}</select></label></div></details>`:''}<div class="playlist-item-list">${items.map((it,idx)=>{const v=playlistVideo(it);return `<div class="playlist-admin-item"><span class="playlist-index">${String(idx+1).padStart(2,'0')}</span><b>${esc(v?.title||'삭제된 영상')}</b><div class="playlist-order-actions"><button data-playlist-move="${p.id}" data-video-id="${it.video_id}" data-dir="-1" ${idx===0?'disabled':''}>↑</button><button data-playlist-move="${p.id}" data-video-id="${it.video_id}" data-dir="1" ${idx===items.length-1?'disabled':''}>↓</button><button data-playlist-remove="${p.id}" data-video-id="${it.video_id}">제거</button></div></div>`;}).join('')||'<div class="playlist-empty-row">영상을 추가하세요.</div>'}</div><div class="playlist-add-row"><select data-playlist-video="${p.id}"><option value="">영상 선택</option>${candidates.map(v=>`<option value="${v.id}">${esc(v.title)}</option>`).join('')}</select><button class="btn" data-playlist-add="${p.id}">영상 추가</button></div></article>`;
  }
  function videoRow(v){
    const isR2=v.source==='r2';
    return `<article class="media-row ${v.active?'':'inactive'}"><div class="grow"><div class="media-title-view" data-title-view="${v.id}"><button type="button" class="media-title-button" data-title-edit="${v.id}" title="제목 수정">${esc(v.title)}</button></div><div class="media-title-edit hidden" data-title-form="${v.id}"><input data-title-input="${v.id}" value="${esc(v.title)}" aria-label="영상 제목"></div><div class="meta">${formatBytes(v.size_bytes)} · ${isR2?'Cloudflare R2':'기존 영상'}${v.url?` · <a href="${esc(v.url)}" target="_blank" rel="noopener">재생 확인</a>`:''}</div></div><div class="media-actions"><label class="toggle"><input type="checkbox" data-video-active="${v.id}" ${v.active?'checked':''}><span>사용</span></label><button class="text-action danger-text" data-delete-video="${v.id}">삭제</button></div></article>`;
  }
  function toggleTitleEdit(id,on){
    const view=qs(`[data-title-view="${id}"]`),form=qs(`[data-title-form="${id}"]`),input=qs(`[data-title-input="${id}"]`),video=state.videos.find(v=>v.id===id);
    view?.classList.toggle('hidden',on);form?.classList.toggle('hidden',!on);
    if(on){if(input){input.value=video?.title||input.value;requestAnimationFrame(()=>{input.focus();input.select();});}}
    else if(input&&video)input.value=video.title;
  }
  async function saveTitle(id){
    const input=qs(`[data-title-input="${id}"]`),video=state.videos.find(v=>v.id===id),title=input?.value.trim();
    if(!title){if(input&&video)input.value=video.title;return toggleTitleEdit(id,false);}
    if(video?.title===title)return toggleTitleEdit(id,false);
    const {error}=await db.from('videos').update({title}).eq('id',id);
    if(error){toast(error.message,'error');if(input&&video)input.value=video.title;return;}
    if(video)video.title=title;
    const button=qs(`[data-title-edit="${id}"]`);if(button)button.textContent=title;
    toggleTitleEdit(id,false);toast('제목을 저장했습니다.');
  }
  async function addPlaylist(){const name=qs('#newPlaylistName').value.trim(),kind=qs('#newPlaylistKind').value,t=qs('#newPlaylistTreatment').value;if(!name)return toast('플레이리스트 이름을 입력하세요.','error');const max=state.playlists.reduce((m,p)=>Math.max(m,Number(p.sort_order)||0),0);const {error}=await db.from('playlists').insert({name,kind,target_treatment:kind==='patient'&&t?[t]:[],sort_order:max+10});if(error)return toast(error.message,'error');toast('플레이리스트를 만들었습니다.');await load();}
  async function updatePlaylist(id,patch){const {error}=await db.from('playlists').update({...patch,updated_at:new Date().toISOString()}).eq('id',id);if(error)toast(error.message,'error');else await load();}
  async function deletePlaylist(id){if(!confirm('플레이리스트를 삭제할까요? 영상 파일은 삭제되지 않습니다.'))return;const {error}=await db.from('playlists').delete().eq('id',id);if(error)toast(error.message,'error');else await load();}
  async function addPlaylistItem(id){const video=qs(`[data-playlist-video="${id}"]`)?.value;if(!video)return toast('추가할 영상을 선택하세요.','error');const items=playlistItems(id),max=items.reduce((m,x)=>Math.max(m,Number(x.sort_order)||0),0);const {error}=await db.from('playlist_items').insert({playlist_id:id,video_id:video,sort_order:max+10});if(error)toast(error.message,'error');else await load();}
  async function removePlaylistItem(id,video){const {error}=await db.from('playlist_items').delete().eq('playlist_id',id).eq('video_id',video);if(error)toast(error.message,'error');else await load();}
  async function movePlaylistItem(id,video,dir){const items=playlistItems(id),from=items.findIndex(x=>x.video_id===video),to=from+dir;if(from<0||to<0||to>=items.length)return;[items[from],items[to]]=[items[to],items[from]];const updates=items.map((x,i)=>db.from('playlist_items').update({sort_order:(i+1)*10}).eq('playlist_id',id).eq('video_id',x.video_id));const results=await Promise.all(updates);const error=results.find(x=>x.error)?.error;if(error)toast(error.message,'error');else await load();}
  async function uploadVideos(files){
    if(uploadBusy||!files.length)return;
    const allowed=new Set(['video/mp4','video/webm']);
    const invalid=files.find(f=>!allowed.has(f.type));
    if(invalid)return toast('MP4 또는 WebM 영상만 업로드할 수 있습니다.','error');
    uploadBusy=true;
    const queue=qs('#uploadQueue');
    try{
      for(const file of files){
        const row=document.createElement('div');row.className='upload-row';row.innerHTML=`<span>${esc(file.name)}</span><div><i></i></div><b>0%</b>`;queue?.appendChild(row);
        const info=await apiJson('/api/r2-presign',{method:'POST',body:JSON.stringify({filename:file.name,contentType:file.type,size:file.size})});
        await uploadByXhr(info.uploadUrl,file,pct=>{const bar=row.querySelector('i'),label=row.querySelector('b');if(bar)bar.style.width=`${pct}%`;if(label)label.textContent=`${pct}%`;});
        const max=state.videos.reduce((m,v)=>Math.max(m,Number(v.sort_order)||0),0);
        const {error}=await db.from('videos').insert({title:titleFromPath(file.name)||file.name,source:'r2',storage_path:info.key,url:info.publicUrl,size_bytes:file.size,available:true,active:true,sort_order:max+10,tags:[],target_age:[],target_gender:[],target_treatment:[]});
        if(error){await apiJson('/api/r2-delete',{method:'POST',body:JSON.stringify({key:info.key})}).catch(()=>{});throw error;}
        row.classList.add('done');row.querySelector('b').textContent='완료';
        state.videos.push({id:'pending',sort_order:max+10});
      }
      toast(`${files.length}개 영상 업로드 완료`);await load();
    }catch(e){toast(e.message||String(e),'error');}
    finally{uploadBusy=false;}
  }

  function groupAdminRow(g){return `<div class="group-admin-row"><input data-group-name="${g.id}" value="${esc(g.name)}"><select data-group-kind="${g.id}">${GROUP_KINDS.map(([v,l])=>`<option value="${v}" ${g.kind===v?'selected':''}>${l}</option>`).join('')}</select><span class="muted">${state.rooms.filter(r=>r.group_id===g.id).length}곳</span><button class="btn small danger-outline" data-delete-group="${g.id}">삭제</button></div>`;}
  function roomAdminRow(r){return `<details class="panel room-admin room-admin-compact"><summary><span class="room-admin-name"><span class="dot ${isOnline(r)?'on':''}"></span><b>${esc(r.name)}</b><em>${esc(groupById(r.group_id)?.name||'미분류')} · ${esc(roomModeLabel(r.room_mode))}</em></span><span class="status-text">${isOnline(r)?'온라인':'오프라인'}</span></summary><div class="room-admin-body"><div class="inline"><div class="order"><button data-move-room="${r.id}" data-dir="-1">↑</button><button data-move-room="${r.id}" data-dir="1">↓</button></div><input class="title-input grow" data-room-name="${r.id}" value="${esc(r.name)}"></div><div class="grid-2"><label class="field"><span>그룹</span><select data-room-group="${r.id}"><option value="">미분류</option>${state.groups.map(g=>`<option value="${g.id}" ${r.group_id===g.id?'selected':''}>${esc(g.name)}</option>`).join('')}</select></label><label class="field"><span>공간 유형</span><select data-room-mode="${r.id}">${ROOM_MODES.map(([v,l])=>`<option value="${v}" ${r.room_mode===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="field"><span>기본 플레이리스트</span><select data-room-playlist="${r.id}"><option value="">자동 선택</option>${state.playlists.filter(p=>p.kind==='default'&&p.active).map(p=>`<option value="${p.id}" ${r.default_playlist_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label class="field"><span>맞춤 자동 종료(분)</span><input data-timeout="${r.id}" type="number" min="0" value="${r.session_timeout_min}"></label><label class="toggle room-mute-toggle"><input data-force-mute="${r.id}" type="checkbox" ${r.force_mute?'checked':''}><span>항상 음소거</span></label></div><div class="inline top-gap"><button class="btn small" data-copy-player="${r.id}">진료실 플레이어 링크</button><button class="btn small danger-outline" data-delete-room="${r.id}">삭제</button></div></div></details>`;}
  async function addGroup(){const name=qs('#newGroup').value.trim();if(!name)return;const max=state.groups.reduce((m,g)=>Math.max(m,g.sort_order||0),0);const {error}=await db.from('signage_groups').insert({name,kind:qs('#newGroupKind').value,sort_order:max+10});if(error)toast(error.message,'error');else await load();}
  async function updateGroup(id,patch){if(!patch.name&&Object.hasOwn(patch,'name'))return toast('그룹 이름을 입력하세요.','error');const {error}=await db.from('signage_groups').update(patch).eq('id',id);if(error)toast(error.message,'error');else await load();}
  async function deleteGroup(id){const g=groupById(id),count=state.rooms.filter(r=>r.group_id===id).length;if(!confirm(`${g?.name||'그룹'}을 삭제할까요?${count?` 소속 ${count}곳은 미분류로 이동합니다.`:''}`))return;const {error}=await db.from('signage_groups').delete().eq('id',id);if(error)toast(error.message,'error');else await load();}
  async function addRoom(){const name=qs('#newRoom').value.trim();if(!name)return;const max=state.rooms.reduce((m,r)=>Math.max(m,r.sort_order||0),0);const {error}=await db.from('rooms').insert({name,group_id:qs('#newRoomGroup').value||null,room_mode:qs('#newRoomMode').value,sort_order:max+10});if(error)toast(error.message,'error');else await load();}
  async function moveRoom(id,dir){const list=[...state.rooms],from=list.findIndex(x=>x.id===id),to=from+dir;if(from<0||to<0||to>=list.length)return;[list[from],list[to]]=[list[to],list[from]];const {error}=await db.rpc('admin_reorder_rooms',{p_ids:list.map(x=>x.id)});if(error)toast(error.message,'error');else await load();}
  async function copyLink(type,id){const r=state.rooms.find(x=>x.id===id);const u=`${location.origin}/player.html?key=${encodeURIComponent(r.player_key)}`;await navigator.clipboard.writeText(u);toast('진료실 플레이어 링크 복사됨');}

  async function updateVideo(id,patch){const {error}=await db.from('videos').update(patch).eq('id',id);if(error)toast(error.message,'error');else await load();}
  async function deleteVideo(id){const v=state.videos.find(x=>x.id===id);if(!v)return;if(!confirm(`'${v.title}' 영상을 삭제할까요?`))return;const {error}=await db.rpc('admin_delete_video',{p_id:id});if(error)return toast(error.message,'error');if(v.source==='r2'&&v.storage_path)await apiJson('/api/r2-delete',{method:'POST',body:JSON.stringify({key:v.storage_path})}).catch(()=>toast('DB에서는 삭제됐지만 R2 파일 정리가 실패했습니다.','error'));toast('영상 삭제 완료');await load();}

  function roomSettingsMarkup(){
    return `<section class="settings-section"><div class="settings-section-head"><div><span class="eyebrow">SPACE</span><h2>공간 관리</h2><p>진료실과 그룹은 처음 설정하거나 구조가 바뀔 때만 관리합니다.</p></div><div class="settings-count">${state.rooms.length}곳 · ${state.groups.length}그룹</div></div><div class="settings-split"><div class="settings-card"><h3>그룹</h3><div class="inline"><input id="newGroup" placeholder="그룹 이름"><select id="newGroupKind">${GROUP_KINDS.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><button id="addGroup" class="btn primary">추가</button></div><div class="group-admin-list top-gap">${state.groups.map(groupAdminRow).join('')||'<span class="muted">등록된 그룹이 없습니다.</span>'}</div></div><div class="settings-card"><h3>공간 추가</h3><div class="settings-add-room"><input id="newRoom" placeholder="공간 이름"><select id="newRoomGroup"><option value="">미분류</option>${state.groups.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select><select id="newRoomMode">${ROOM_MODES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><button id="addRoom" class="btn primary">공간 추가</button></div></div></div><div class="room-admin-list settings-room-list">${state.rooms.map(roomAdminRow).join('')}</div></section>`;
  }

  function bindRoomSettings(){
    qs('#addGroup')?.addEventListener('click',addGroup); qs('#addRoom')?.addEventListener('click',addRoom);
    qsa('[data-group-name]').forEach(i=>i.addEventListener('change',()=>updateGroup(i.dataset.groupName,{name:i.value.trim()})));qsa('[data-group-kind]').forEach(i=>i.addEventListener('change',()=>updateGroup(i.dataset.groupKind,{kind:i.value})));qsa('[data-delete-group]').forEach(b=>b.addEventListener('click',()=>deleteGroup(b.dataset.deleteGroup)));
    qsa('[data-room-name]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.roomName,{name:i.value.trim()})));qsa('[data-room-group]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.roomGroup,{group_id:i.value||null})));qsa('[data-room-mode]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.roomMode,{room_mode:i.value})));qsa('[data-force-mute]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.forceMute,{force_mute:i.checked})));qsa('[data-timeout]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.timeout,{session_timeout_min:Math.max(0,Number(i.value)||0)})));qsa('[data-room-playlist]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.roomPlaylist,{default_playlist_id:i.value||null})));qsa('[data-delete-room]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('공간을 삭제할까요?'))return;const {error}=await db.from('rooms').delete().eq('id',b.dataset.deleteRoom);if(error)toast(error.message,'error');else await load();}));qsa('[data-move-room]').forEach(b=>b.addEventListener('click',()=>moveRoom(b.dataset.moveRoom,Number(b.dataset.dir))));qsa('[data-copy-player]').forEach(b=>b.addEventListener('click',()=>copyLink('player',b.dataset.copyPlayer)));
  }

  function renderSettings(){
    const emergencyVideos=state.videos.filter(v=>v.active&&v.available!==false&&v.url);
    const ready=storageHealth?.ok===true;
    qs('#adminRoot').innerHTML=`<div class="page-head"><div><span class="eyebrow">SETTINGS</span><h1>설정</h1><p class="page-intro">공간과 플레이어, 비상 영상, PIN처럼 자주 바꾸지 않는 항목만 모았습니다.</p></div></div>${roomSettingsMarkup()}<section class="settings-section"><div class="settings-section-head"><div><span class="eyebrow">SYSTEM</span><h2>시스템</h2></div></div><div class="settings-system-grid"><div class="settings-card"><h3>영상 저장소</h3><div class="storage-status"><span class="dot ${ready?'on':''}"></span><div><b>${ready?'연결됨':'설정 필요'}</b><p>Cloudflare R2 영상 저장 상태</p></div></div><button id="testStorage" class="btn">연결 확인</button></div><div class="settings-card"><h3>비상 영상</h3><label class="field"><span>재생할 영상</span><select id="emergencyVideo"><option value="">사용 안 함</option>${emergencyVideos.map(v=>`<option value="${v.id}" ${state.settings.emergency_video_id===v.id?'selected':''}>${esc(v.title)} · ${formatBytes(v.size_bytes)}</option>`).join('')}</select></label><button id="saveEmergency" class="btn primary">저장</button></div><div class="settings-card"><h3>PIN</h3><label class="field"><span>관리자 PIN · 6자리</span><input id="newAdminPin" type="password" inputmode="numeric" maxlength="6"></label><button id="changeAdminPin" class="btn">관리자 PIN 변경</button><label class="field top-gap"><span>스텝 PIN · 4~6자리</span><input id="newStaffPin" type="password" inputmode="numeric" maxlength="6"></label><button id="changeStaffPin" class="btn">스텝 PIN 변경</button></div></div></section>`;
    bindRoomSettings();
    qs('#testStorage')?.addEventListener('click',async()=>{await checkStorageHealth(true);renderSettings();});qs('#saveEmergency')?.addEventListener('click',saveEmergency);qs('#changeAdminPin')?.addEventListener('click',()=>changePin('admin'));qs('#changeStaffPin')?.addEventListener('click',()=>changePin('staff'));qsa('#newAdminPin,#newStaffPin').forEach(i=>i.addEventListener('input',()=>{i.value=i.value.replace(/\D/g,'').slice(0,6);}));
  }
  async function changePin(role){const input=qs(role==='admin'?'#newAdminPin':'#newStaffPin'),pin=input.value.replace(/\D/g,'');if(role==='admin'&&pin.length!==6)return toast('관리자 PIN은 6자리입니다.','error');if(role==='staff'&&(pin.length<4||pin.length>6))return toast('스텝 PIN은 4~6자리입니다.','error');if(!confirm(`${role==='admin'?'관리자':'스텝'} PIN을 변경할까요?`))return;const {error}=await db.rpc('admin_change_pin',{p_role:role,p_pin:pin});if(error)return toast(error.message,'error');input.value='';if(role==='admin'){Signage.clearPinSession();location.replace('/');}else toast('스텝 PIN 변경 완료');}
  async function saveEmergency(){const id=qs('#emergencyVideo').value||null;if(id){const v=state.videos.find(x=>x.id===id);if(Number(v?.size_bytes||0)>MAX_EMERGENCY_BYTES)return toast('비상영상은 250MB 이하로 선택하세요.','error');}const {error}=await db.from('app_settings').update({emergency_video_id:id,updated_at:new Date().toISOString()}).eq('id',1);if(error)toast(error.message,'error');else{toast('비상영상 저장 완료');await load();}}
  async function checkStorageHealth(showToast=false){
    try{storageHealth=await apiJson('/api/r2-status',{method:'GET'});if(showToast)toast('영상 저장소 연결 정상');}
    catch(e){storageHealth=false;if(showToast)toast(e.message||'R2 연결 실패','error');}
    if(tab==='dashboard')paintAlerts();
    if(tab==='videos')renderVideos();
  }

  function mergeRealtimeRoom(next){const i=state.rooms.findIndex(r=>r.id===next.id);if(i<0)return;state.rooms[i]={...state.rooms[i],...next};if(tab==='dashboard'){paintLiveRoom(state.rooms[i]);paintAlerts();}if(tab==='settings'){const el=qs(`[data-room-name="${next.id}"]`)?.closest('.room-admin')?.querySelector('.status-text');if(el)el.textContent=isOnline(state.rooms[i])?'온라인':'오프라인';}const stat=qs('#onlineStat');if(stat)stat.innerHTML=`<b>${state.rooms.filter(isOnline).length}</b> / ${state.rooms.length} 온라인`;}
  function paintLiveRoom(r){const card=qs(`[data-room-card="${r.id}"]`);if(!card)return;const st=r.player_status||{},on=isOnline(r),progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'',p=playlistInfo(st);qs('[data-live-dot]',card)?.classList.toggle('on',on);const mode=qs('[data-live-mode]',card);if(mode)mode.textContent=modeLabel(st.mode);const title=qs('[data-live-title]',card);if(title)title.textContent=r.paused?'일시정지':(st.title||'대기 중');const next=qs('[data-live-next]',card);if(next)next.textContent=p.next||((p.titles.length>1)?p.titles[(p.current+1)%p.titles.length]:'—');const playlist=qs('[data-live-playlist]',card);if(playlist)playlist.innerHTML=playlistHtml(st);const detail=qs('[data-live-detail]',card);if(detail)detail.textContent=on?`${playbackLabel(st.playback_state)}${progress?` · ${progress}`:''}${st.muted?' · 음소거':''}${st.error?` · ${st.error}`:''}`:'오프라인';}

  try{await load();}catch(e){qs('#adminRoot').innerHTML=`<p class="error">${esc(e.message||e)}</p>`;}
  let liveRefreshBusy=false;async function refreshLiveRooms(){if(liveRefreshBusy)return;liveRefreshBusy=true;try{const {data}=await db.from('rooms').select('id,last_seen_at,player_status,paused,reload_nonce');(data||[]).forEach(mergeRealtimeRoom);}catch{}finally{liveRefreshBusy=false;}}
  refreshLiveRooms();setInterval(refreshLiveRooms,5000);checkStorageHealth();setInterval(checkStorageHealth,60000);setInterval(()=>{if(tab==='dashboard'){state.rooms.forEach(paintLiveRoom);paintAlerts();}},5000);
})();
