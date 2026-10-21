(async function () {
  'use strict';
  const { db, qs, qsa, esc, toast, formatDuration } = Signage;
  await Signage.requireAuth();
  qs('#signOut').addEventListener('click', Signage.signOut);

  const AGE_OPTIONS=[['','전체'],['teen','10대 이하'],['20-30','20~30대'],['40-50','40~50대'],['60+','60대 이상']];
  const GENDER_OPTIONS=[['','전체'],['female','여성'],['male','남성']];
  const TREATMENTS=[['minish','미니쉬'],['implant','임플란트'],['whitening','미백'],['orthodontics','교정'],['checkup','검진'],['aftercare','수술 후 관리'],['general','일반 진료']];
  let state={patients:[],rooms:[],playlists:[],videos:[],playlistItems:[],roomRules:[],broadcast:{active:false}}, busy=false, liveChannel=null, signalChannel=null;
  const LIVE_DELAY_MS=70000, LIVE_OFFLINE_MS=180000;
  async function signalRoom(room){try{await db.rpc('signal_signage_rooms',{p_room_ids:[room],p_group:null,p_all:false});}catch(_){}}
  async function refreshRoomLiveStatus(room){
    if(!room)return;
    try{const {data,error}=await db.from('player_live_status').select('room_id,last_seen_at,player_status,updated_at').eq('room_id',room).maybeSingle();if(!error&&data)mergePlayerLiveStatus(data);}catch(_){}
  }
  function scheduleRoomLiveAck(room){[120,350,800,1600,3000].forEach(delay=>window.setTimeout(()=>refreshRoomLiveStatus(room),delay));}

  const treatmentLabel=(v)=>TREATMENTS.find(([id])=>id===v)?.[1]||v||'일반 진료';
  const ageLabel=(v)=>AGE_OPTIONS.find(([id])=>id===v)?.[1]||'전체';
  const genderLabel=(v)=>GENDER_OPTIONS.find(([id])=>id===v)?.[1]||'전체';
  const roomById=(id)=>state.rooms.find(r=>r.id===id)||null;
  const playlistById=(id)=>state.playlists.find(p=>p.id===id)||null;
  const roomTypeLabel=(v)=>({treatment:'진료실',consultation:'상담실',waiting:'대기실',lobby:'로비',vip:'VIP',other:'기타'})[v]||'공간';
  const isPatientRoom=(r)=>['treatment','consultation'].includes(r.room_mode);
  const playlistOptions=(selected='')=>`<option value="">플레이리스트 선택</option>${state.playlists.filter(p=>p.active!==false).map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}${p.kind==='patient'?' · 맞춤':''}</option>`).join('')}`;
  const videoOptions=()=>`<option value="">영상 선택</option>${state.videos.filter(v=>v.active!==false).map(v=>`<option value="${v.id}">${esc(v.title)}</option>`).join('')}`;
  const roomRules=(room)=>state.roomRules.filter(x=>x.room_id===room);
  function staffPatientPlaylist(r){const matches=state.playlists.filter(p=>p.active!==false&&p.kind==='patient'&&(!(p.target_treatment||[]).length||(r.session_treatment&&(p.target_treatment||[]).includes(r.session_treatment)))&&(!(p.target_age||[]).length||(r.session_age_group&&(p.target_age||[]).includes(r.session_age_group)))&&(!(p.target_gender||[]).length||(r.session_gender&&(p.target_gender||[]).includes(r.session_gender))));return matches.sort((a,b)=>(((b.target_treatment||[]).length?100:0)+((b.target_age||[]).length?10:0)+((b.target_gender||[]).length?5:0))-(((a.target_treatment||[]).length?100:0)+((a.target_age||[]).length?10:0)+((a.target_gender||[]).length?5:0))||(a.sort_order||0)-(b.sort_order||0))[0]||null;}
  function staffBaseIds(r){const mode=String(r.player_status?.mode||'');if(['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(mode)){const live=Array.isArray(r.player_status?.playlist_video_ids)?r.player_status.playlist_video_ids.filter(Boolean):[];if(live.length)return live;}if(r.manual_active&&r.manual_video_ids?.length)return r.manual_video_ids;if(mode==='patient'){const pp=staffPatientPlaylist(r);if(pp)return state.playlistItems.filter(x=>x.playlist_id===pp.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(x=>x.video_id);}const fallback=r.default_playlist_id||state.playlists.filter(p=>p.active!==false&&p.kind==='default').sort((a,b)=>(a.sort_order||0)-(b.sort_order||0))[0]?.id;return state.playlistItems.filter(x=>x.playlist_id===fallback).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(x=>x.video_id);}
  function staffRoomOutputItems(r){const ids=staffBaseIds(r),rules=new Map(roomRules(r.id).map(x=>[x.video_id,x]));return ids.map((id,idx)=>({id,video:state.videos.find(v=>v.id===id),rule:rules.get(id),idx})).filter(x=>x.video).sort((a,b)=>(a.rule?.sort_order??((a.idx+1)*10))-(b.rule?.sort_order??((b.idx+1)*10)));}
  function staffThumb(v){return v?.thumbnail_data_url?`<img loading="lazy" decoding="async" src="${esc(v.thumbnail_data_url)}" alt="">`:`<span>${esc((v?.title||'VIDEO').slice(0,2))}</span>`;}
  function staffOutputList(r){const items=staffRoomOutputItems(r);return `<div class="staff-output-list">${items.map((x,i)=>`<div class="staff-output-item ${x.rule?.enabled===false?'is-disabled':''}"><div class="staff-output-thumb">${staffThumb(x.video)}</div><b>${esc(x.video.title)}</b><label class="switch"><input type="checkbox" data-staff-video-toggle="${r.id}" data-video-id="${x.id}" ${x.rule?.enabled===false?'':'checked'} ${['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(String(r.player_status?.mode||''))?'disabled':''}><i></i></label><div><button data-staff-video-move="${r.id}" data-video-id="${x.id}" data-dir="-1" ${i===0?'disabled':''}>↑</button><button data-staff-video-move="${r.id}" data-video-id="${x.id}" data-dir="1" ${i===items.length-1?'disabled':''}>↓</button></div></div>`).join('')||'<span class="muted">재생 가능한 영상이 없습니다.</span>'}</div>`;}
  function roomAgeMs(r){const ts=r?.last_seen_at?new Date(r.last_seen_at).getTime():0;return ts>0?Math.max(0,Date.now()-ts):Infinity;}
  function roomHealth(r){
    const st=r.player_status||{},age=roomAgeMs(r);
    if(age>LIVE_OFFLINE_MS)return 'offline';
    if(st.error||String(st.playback_state||'').toLowerCase()==='error')return 'error';
    if(st.recovery_stage)return 'recovering';
    if(age>LIVE_DELAY_MS)return 'delayed';
    return 'normal';
  }
  const staffIsOnline=(r)=>roomHealth(r)!=='offline';
  function roomDisplayStatus(r){
    const h=roomHealth(r),st=r.player_status||{},play=String(st.playback_state||'').toLowerCase();
    if(h==='offline')return {key:'offline',label:'오프라인'};
    if(h==='error')return {key:'error',label:'오류'};
    if(h==='recovering')return {key:'recovering',label:'복구 중'};
    if(h==='delayed')return {key:'delayed',label:'확인 중'};
    if(play==='paused')return {key:'paused',label:'일시정지'};
    if(['playing','emergency'].includes(play))return {key:'live',label:'송출 중'};
    return {key:'idle',label:'대기'};
  }
  function groupStatusSummary(rooms){
    const statuses=rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length;
    const issues=statuses.filter(x=>['error','recovering','delayed'].includes(x.key)).length,online=rooms.length-offline;
    let key='idle',label='대기';
    if(!rooms.length){label='공간 없음';}
    else if(offline===rooms.length){key='offline';label='오프라인';}
    else if(issues>0){key='issue';label='확인 필요';}
    else if(live>0){key='live';label='송출 중';}
    return {live,offline,issues,online,total:rooms.length,key,label};
  }
  function groupDisplayName(name){const n=String(name||'미분류').trim();return /^\d+$/.test(n)?`${n}층`:n;}
  const currentVideoForRoom=(r)=>state.videos.find(v=>v.id===r.player_status?.video_id)||null;
  const playbackLabel=(v)=>({playing:'재생 중',paused:'일시정지',loading:'불러오는 중',error:'오류',connected:'연결됨'})[String(v||'').toLowerCase()]||'연결됨';
  const activePatients=()=>state.patients.filter(p=>['waiting','assigned','in_progress'].includes(p.status));
  const elapsedMinutes=(start,end=Date.now())=>start?Math.max(0,Math.floor((new Date(end).getTime()-new Date(start).getTime())/60000)):0;
  const waitText=(p)=>`${elapsedMinutes(p.waiting_started_at||p.created_at,p.assigned_at||Date.now())}분 대기`;
  const patientForRoom=(id)=>activePatients().find(x=>x.room_id===id)||null;
  const isQuickSession=(r)=>!!r.session_treatment&&!patientForRoom(r.id);
  const roomModeText=(r)=>{
    const p=patientForRoom(r.id);
    if(p)return p.status==='in_progress'?'진료 중':'환자 배정';
    if(r.session_treatment)return `빠른 맞춤 · ${treatmentLabel(r.session_treatment)}`;
    return '기본 영상';
  };

  async function load({background=false}={}){
    const [reception,liveStatuses]=await Promise.all([
      db.rpc('staff_reception_state'),
      db.from('player_live_status').select('*')
    ]);
    if(reception.error)throw reception.error;
    if(liveStatuses.error)throw liveStatuses.error;
    const data=reception.data||{},liveByRoom=new Map((liveStatuses.data||[]).map(x=>[x.room_id,x]));
    const rooms=(data.rooms||[]).map(r=>{const live=liveByRoom.get(r.id);return live?{...r,last_seen_at:live.last_seen_at||r.last_seen_at,player_status:live.player_status||r.player_status,__live_verified_at:Date.now()}:r;});
    state={patients:data.patients||[],rooms,playlists:data.playlists||[],videos:data.videos||[],playlistItems:data.playlist_items||[],roomRules:data.room_video_rules||[],broadcast:data.broadcast||{active:false}};
    if(background&&isInteracting())return;
    renderPreservingUi(background);
  }
  function isInteracting(){
    const a=document.activeElement,root=qs('#staffRoot');
    return !!(a&&root&&root.contains(a)&&['INPUT','SELECT','TEXTAREA'].includes(a.tagName));
  }
  function uiKey(el){
    const card=el.closest('[data-room-card]')?.dataset.roomCard||el.closest('[data-staff-group]')?.dataset.staffGroup||el.closest('[data-patient]')?.dataset.patient||'';
    return `${card}|${el.className}`;
  }
  function renderPreservingUi(keepInputs=true){
    const root=qs('#staffRoot');
    const openDetails=new Set(qsa('details[open]',root).map(uiKey));
    const openQuick=keepInputs?qsa('[data-quick-panel]:not(.hidden)',root).map(x=>x.dataset.quickPanel):[];
    const formOpen=keepInputs&&!!qs('#patientForm:not(.hidden)',root);
    const dirty=!keepInputs?[]:qsa('select[data-dirty="1"],#patientForm input,#patientForm select',root).map(el=>{const attr=[...el.attributes].find(a=>a.name.startsWith('data-')&&a.name!=='data-dirty');return {sel:el.id?`#${el.id}`:attr?`[${attr.name}="${attr.value}"]`:null,value:el.value};}).filter(x=>x.sel);
    const scrollY=window.scrollY;
    render();
    qsa('details',root).forEach(d=>{if(openDetails.has(uiKey(d)))d.open=true;});
    openQuick.forEach(id=>qs(`[data-quick-panel="${id}"]`,root)?.classList.remove('hidden'));
    if(formOpen)qs('#patientForm',root)?.classList.remove('hidden');
    dirty.forEach(({sel,value})=>{const el=qs(sel,root);if(!el)return;if(el.tagName==='SELECT'&&![...el.options].some(o=>o.value===value))return;el.value=value;if(el.tagName==='SELECT')el.dataset.dirty='1';});
    window.scrollTo(0,scrollY);
  }

  function groupedRooms(){
    const map=new Map(),order=[];
    for(const r of state.rooms){const key=r.group_id||'ungrouped';if(!map.has(key)){map.set(key,{id:key,name:r.group_name||'미분류',rooms:[]});order.push(key);}map.get(key).rooms.push(r);}
    return order.map(k=>map.get(k));
  }

  function render(){
    const waiting=state.patients.filter(p=>p.status==='waiting');
    const assigned=state.patients.filter(p=>p.status==='assigned');
    const inProgress=state.patients.filter(p=>p.status==='in_progress');
    const completed=state.patients.filter(p=>p.status==='completed');
    const statuses=state.rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length;
    const issues=statuses.filter(x=>['error','recovering','delayed'].includes(x.key)).length,online=state.rooms.length-offline;
    const quick=state.rooms.filter(isQuickSession).length,custom=state.rooms.filter(r=>r.session_treatment).length;
    const groups=groupedRooms();
    qs('#staffRoot').innerHTML=`
      ${state.broadcast?.active?'<div class="broadcast-strip">전체 송출 중 · 맞춤 설정은 저장되며 전체 송출 종료 후 자동 적용됩니다.</div>':''}
      <div class="reception-head reception-head-board"><div><span class="eyebrow">RECEPTION</span><h1>송출 현황</h1><p>어드민과 같은 기준으로 실제 송출 상태를 확인하고 각 공간의 플레이리스트와 영상을 관리합니다.</p></div><button id="staffStatusRefresh" class="btn">상태 새로고침</button></div>
      <div class="monitor-status-strip monitor-status-primary staff-status-primary">
        <div><span>전체 공간</span><b data-staff-stat-total>${state.rooms.length}</b></div>
        <div class="status-live"><span>송출 중</span><b data-staff-stat-live>${live}</b></div>
        <div class="${issues?'status-issue':''}"><span>확인 필요</span><b data-staff-stat-issues>${issues}</b></div>
        <div class="${offline?'status-offline':''}"><span>오프라인</span><b data-staff-stat-offline>${offline}</b></div>
      </div>
      <div class="monitor-status-secondary staff-status-secondary"><span>온라인 <b data-staff-stat-online>${online}</b></span><span>맞춤 송출 <b>${custom}</b></span><span>빠른 설정 <b>${quick}</b></span><span>등록 환자 <b>${assigned.length+inProgress.length}</b></span><span>대기 <b>${waiting.length}</b></span></div>

      <section class="reception-rooms reception-rooms-first staff-space-status">
        <div class="reception-section-head"><div><span class="eyebrow">SPACE STATUS</span><h2>층 · 구역별 현황</h2></div><b>${live}곳 송출 중</b></div>
        <div class="staff-monitor-groups">${groups.map(groupCard).join('')}</div>
      </section>

      <details class="patient-management">
        <summary><span><b>환자 관리</b><small>필요한 경우에만 대기·배정·진료 기록을 사용합니다.</small></span><em>${waiting.length+assigned.length+inProgress.length}</em></summary>
        <div class="patient-management-body">
          <div class="patient-management-toolbar"><div><span class="eyebrow">OPTIONAL</span><h2>대기 · 배정 관리</h2></div><button id="openPatientForm" class="btn primary">환자 추가</button></div>
          <section id="patientForm" class="reception-create hidden">
            <div class="reception-create-head"><div><span class="eyebrow">NEW PATIENT</span><h2>환자 추가</h2></div><button id="closePatientForm" class="text-btn dark">닫기</button></div>
            <div class="reception-form-grid">
              <label class="field"><span>표시 이름 · 선택</span><input id="patientLabel" maxlength="24" placeholder="예: 23번 / 김○○"></label>
              <label class="field"><span>진료유형</span><select id="patientTreatment">${TREATMENTS.map(([v,l])=>`<option value="${v}" ${v==='minish'?'selected':''}>${l}</option>`).join('')}</select></label>
              <label class="field"><span>연령 · 선택</span><select id="patientAge">${AGE_OPTIONS.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label>
              <label class="field"><span>성별 · 선택</span><select id="patientGender">${GENDER_OPTIONS.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label>
            </div><button id="createPatient" class="btn primary">대기 등록</button>
          </section>
          <div class="reception-layout">
            <section class="reception-column"><div class="reception-section-head"><div><span class="eyebrow">WAITING</span><h2>대기 환자</h2></div><b>${waiting.length}</b></div><div class="patient-stack">${waiting.map(patientCard).join('')||'<div class="empty-card">대기 중인 환자가 없습니다.</div>'}</div></section>
            <section class="reception-column"><div class="reception-section-head"><div><span class="eyebrow">IN ROOMS</span><h2>배정 · 진료</h2></div><b>${assigned.length+inProgress.length}</b></div><div class="patient-stack">${[...inProgress,...assigned].map(patientCard).join('')||'<div class="empty-card">배정된 환자가 없습니다.</div>'}</div></section>
          </div>
          <div class="patient-completed-note">오늘 완료 ${completed.length}명</div>
        </div>
      </details>`;
    bind();
  }

  function groupCard(group){
    const summary=groupStatusSummary(group.rooms),nowText=summary.key==='live'?`${summary.live}곳 송출 중`:summary.key==='issue'?`확인 필요한 공간 ${summary.issues}곳`:summary.key==='offline'?'모든 공간 연결 끊김':summary.key==='idle'?'현재 재생 대기':'현재 상태 확인';
    return `<details class="monitor-group staff-monitor-group group-state-${summary.key}" data-staff-group="${esc(group.id)}"><summary class="monitor-group-summary"><div class="monitor-group-overview"><div class="monitor-group-title-row"><h2>${esc(groupDisplayName(group.name))}</h2><span class="group-status-badge status-${summary.key}" data-staff-group-status>${esc(summary.label)}</span></div><div class="group-metric-row"><span>공간 <b data-staff-group-total>${summary.total}</b></span><span>송출 <b data-staff-group-live>${summary.live}</b></span><span>온라인 <b data-staff-group-online>${summary.online}</b></span><span>확인 <b data-staff-group-issues>${summary.issues}</b></span></div><p data-staff-group-summary>${esc(nowText)}</p></div><span class="group-detail-link">상세보기</span></summary><div class="monitor-group-body"><div class="monitor-room-grid staff-monitor-room-grid">${group.rooms.map(roomCard).join('')}</div></div></details>`;
  }

  function roomCard(r){
    const p=patientForRoom(r.id),quick=isQuickSession(r),st=r.player_status||{},display=roomDisplayStatus(r),health=roomHealth(r),current=st.title||'대기 중',next=st.next_title||'',activeTreatment=p?.treatment||r.session_treatment||'';
    const audience=[p?.age_group||r.session_age_group,p?.gender||r.session_gender].filter(Boolean).map((v,i)=>i===0?ageLabel(v):genderLabel(v)).filter(x=>x!=='전체').join(' · '),manual=!!r.manual_active&&Array.isArray(r.manual_video_ids)&&r.manual_video_ids.length>0,defaultPlaylist=playlistById(r.default_playlist_id),currentVideo=currentVideoForRoom(r),on=staffIsOnline(r);
    const progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'';
    return `<details class="monitor-room staff-monitor-room health-${health}" data-room-card="${r.id}" data-health="${health}"><summary><div class="monitor-room-top"><div class="monitor-room-name"><span data-staff-live-dot class="dot ${on?'on':''}"></span><b>${esc(r.name)}</b></div><span class="room-status-badge status-${display.key}" data-staff-room-status>${esc(display.label)}</span></div><div class="monitor-current-thumb" data-staff-live-thumb>${staffThumb(currentVideo)}</div><div class="monitor-now"><span>지금 재생 · ${esc(roomModeText(r))}</span><b data-staff-live-title>${esc(current)}</b><small data-staff-live-detail>${on?`${esc(playbackLabel(st.playback_state))}${progress?` · ${progress}`:''}${st.error?` · ${esc(st.error)}`:''}`:'오프라인'}</small></div><div class="monitor-next"><span>다음</span><b data-staff-live-next>${esc(next||'—')}</b></div><div class="monitor-card-foot"><span>${esc(roomTypeLabel(r.room_mode))}${manual?' · 개별 영상':activeTreatment?` · ${esc(treatmentLabel(activeTreatment))}`:defaultPlaylist?` · ${esc(defaultPlaylist.name)}`:''}</span><b>관리</b></div></summary><div class="monitor-room-controls staff-room-control-body">
      ${audience?`<div class="room-output-note">맞춤 대상 · ${esc(audience)}</div>`:''}
      <details class="staff-output-details"><summary>송출 영상 목록</summary>${staffOutputList(r)}</details>
      <div class="staff-output-controls">
        <div class="staff-output-row"><span>플레이리스트</span><select data-staff-playlist="${r.id}">${playlistOptions(r.default_playlist_id||'')}</select><button class="btn primary" data-staff-playlist-apply="${r.id}">변경</button></div>
        <div class="staff-output-row"><span>영상 추가</span><select data-staff-video="${r.id}">${videoOptions()}</select><button class="btn" data-staff-video-add="${r.id}">추가</button>${manual?`<button class="btn" data-staff-manual-clear="${r.id}">기본으로</button>`:''}</div>
      </div>
      ${p?`<div class="room-patient compact"><b>${esc(p.label||`대기 ${p.queue_no}`)}</b><span>${esc(waitText(p))}</span></div>`:''}
      ${isPatientRoom(r)?`<div class="room-card-actions">${!p?`<button class="btn" data-open-quick="${r.id}">${quick?'맞춤 변경':'환자 맞춤'}</button>${quick?`<button class="btn" data-quick-clear="${r.id}">맞춤 해제</button>`:''}`:'<span class="room-managed-note">환자 관리에서 변경</span>'}</div>${!p?quickPanel(r):''}`:''}
    </div></details>`;
  }

  function quickPanel(r){
    return `<div class="quick-room-panel hidden" data-quick-panel="${r.id}">
      <div class="quick-room-head"><b>맞춤 영상</b><button class="text-btn dark" data-close-quick="${r.id}">닫기</button></div>
      <div class="quick-treatment-grid">${TREATMENTS.map(([v,l])=>`<button class="quick-treatment ${r.session_treatment===v?'on':''}" data-quick-treatment="${v}" data-room="${r.id}">${l}</button>`).join('')}</div>
      <details class="quick-detail"><summary>연령·성별도 설정</summary><div class="quick-detail-grid"><label class="field"><span>연령</span><select data-quick-age="${r.id}">${AGE_OPTIONS.map(([v,l])=>`<option value="${v}" ${r.session_age_group===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="field"><span>성별</span><select data-quick-gender="${r.id}">${GENDER_OPTIONS.map(([v,l])=>`<option value="${v}" ${r.session_gender===v?'selected':''}>${l}</option>`).join('')}</select></label></div><p>연령·성별을 선택한 뒤 진료유형을 누르면 함께 적용됩니다.</p></details>
    </div>`;
  }

  function patientCard(p){
    const room=roomById(p.room_id), waiting=p.status==='waiting';
    const status=p.status==='waiting'?'대기':p.status==='assigned'?'배정됨':'진료 중';
    const audience=[ageLabel(p.age_group),genderLabel(p.gender)].filter(x=>x!=='전체').join(' · ')||'전체 환자';
    const available=state.rooms.filter(r=>['treatment','consultation'].includes(r.room_mode)&&!activePatients().some(x=>x.room_id===r.id&&x.id!==p.id)&&!isQuickSession(r));
    return `<article class="patient-card status-${p.status}" data-patient="${p.id}">
      <div class="patient-card-top"><div><span class="patient-status">${status}</span><h3>${esc(p.label||`대기 ${p.queue_no}`)}</h3></div><strong>${esc(waitText(p))}</strong></div>
      <div class="patient-profile"><b>${esc(treatmentLabel(p.treatment))}</b><span>${esc(audience)}</span></div>
      ${room?`<div class="patient-room"><span>진료실</span><b>${esc(room.name)}</b><small>${esc(room.player_status?.title||'영상 준비 중')}</small></div>`:''}
      <div class="patient-actions">${waiting?`<select data-room-select="${p.id}"><option value="">진료실 선택</option>${available.map(r=>`<option value="${r.id}">${esc(r.group_name?`${r.group_name} · `:'')}${esc(r.name)}${staffIsOnline(r)?'':' · 오프라인'}</option>`).join('')}</select><button class="btn primary" data-assign="${p.id}">배정</button>`:`${p.status==='assigned'?`<button class="btn primary" data-start="${p.id}">진료 시작</button>`:''}<button class="btn" data-unassign="${p.id}">배정 변경</button><button class="btn" data-complete="${p.id}">종료</button>`}<button class="text-action danger-text" data-cancel="${p.id}">취소</button></div>
    </article>`;
  }

  function bind(){
    qs('#staffStatusRefresh')?.addEventListener('click',()=>load().catch(e=>toast(e.message||String(e),'error')));
    qsa('#staffRoot select').forEach(el=>el.addEventListener('change',()=>{el.dataset.dirty='1';}));
    qsa('[data-staff-playlist-apply]').forEach(b=>b.addEventListener('click',()=>setRoomPlaylist(b.dataset.staffPlaylistApply)));
    qsa('[data-staff-video-add]').forEach(b=>b.addEventListener('click',()=>addRoomVideo(b.dataset.staffVideoAdd)));
    qsa('[data-staff-manual-clear]').forEach(b=>b.addEventListener('click',()=>clearRoomManual(b.dataset.staffManualClear)));
    qsa('[data-staff-video-toggle]').forEach(i=>i.addEventListener('change',()=>staffToggleVideo(i.dataset.staffVideoToggle,i.dataset.videoId,i.checked)));
    qsa('[data-staff-video-move]').forEach(b=>b.addEventListener('click',()=>staffMoveVideo(b.dataset.staffVideoMove,b.dataset.videoId,Number(b.dataset.dir))));
    qsa('[data-open-quick]').forEach(b=>b.addEventListener('click',()=>qs(`[data-quick-panel="${b.dataset.openQuick}"]`)?.classList.remove('hidden')));
    qsa('[data-close-quick]').forEach(b=>b.addEventListener('click',()=>qs(`[data-quick-panel="${b.dataset.closeQuick}"]`)?.classList.add('hidden')));
    qsa('[data-quick-treatment]').forEach(b=>b.addEventListener('click',()=>quickSet(b.dataset.room,b.dataset.quickTreatment)));
    qsa('[data-quick-clear]').forEach(b=>b.addEventListener('click',()=>quickClear(b.dataset.quickClear)));
    qs('#openPatientForm')?.addEventListener('click',()=>qs('#patientForm').classList.remove('hidden'));
    qs('#closePatientForm')?.addEventListener('click',()=>qs('#patientForm').classList.add('hidden'));
    qs('#createPatient')?.addEventListener('click',createPatient);
    qsa('[data-assign]').forEach(b=>b.addEventListener('click',()=>assignPatient(b.dataset.assign)));
    qsa('[data-start]').forEach(b=>b.addEventListener('click',()=>action('staff_start_patient',b.dataset.start,'진료를 시작했습니다.')));
    qsa('[data-complete]').forEach(b=>b.addEventListener('click',()=>action('staff_complete_patient',b.dataset.complete,'환자 영상을 종료했습니다.')));
    qsa('[data-unassign]').forEach(b=>b.addEventListener('click',()=>action('staff_unassign_patient',b.dataset.unassign,'배정을 해제했습니다.')));
    qsa('[data-cancel]').forEach(b=>b.addEventListener('click',()=>{if(confirm('이 환자 대기를 취소할까요?'))action('staff_cancel_patient',b.dataset.cancel,'취소했습니다.');}));
  }

  async function setRoomPlaylist(room){
    if(busy)return; const playlist=qs(`[data-staff-playlist="${room}"]`)?.value; if(!playlist)return toast('플레이리스트를 선택하세요.','error');
    busy=true; const {error}=await db.rpc('staff_set_room_playlist',{p_room:room,p_playlist:playlist}); busy=false;
    if(error)return toast(error.message,'error'); await signalRoom(room); toast('공간 플레이리스트를 변경했습니다.'); await load();
  }
  async function addRoomVideo(room){
    if(busy)return; const video=qs(`[data-staff-video="${room}"]`)?.value; if(!video)return toast('추가할 영상을 선택하세요.','error');
    busy=true; const {error}=await db.rpc('staff_add_room_video',{p_room:room,p_video:video}); busy=false;
    if(error)return toast(error.message,'error'); await signalRoom(room); toast('이 공간에 영상 1개를 추가했습니다.'); await load();
  }
  async function clearRoomManual(room){
    if(busy)return; busy=true; const {error}=await db.rpc('staff_clear_room_manual',{p_room:room}); busy=false;
    if(error)return toast(error.message,'error'); await signalRoom(room); toast('선택한 기본 플레이리스트로 돌아갑니다.'); await load();
  }

  async function staffToggleVideo(room,video,enabled){const r=state.rooms.find(x=>x.id===room);if(['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(String(r?.player_status?.mode||'')))return toast('전체/그룹 송출 중에는 개별 영상을 변경할 수 없습니다.','error');if(busy)return;busy=true;const {error}=await db.rpc('staff_set_room_video_rule',{p_room:room,p_video:video,p_enabled:enabled});busy=false;if(error)return toast(error.message,'error');await signalRoom(room);await load();scheduleRoomLiveAck(room);}
  async function staffMoveVideo(room,video,dir){const r=state.rooms.find(x=>x.id===room),items=staffRoomOutputItems(r||{});if(['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(String(r?.player_status?.mode||'')))return toast('전체/그룹 송출 중에는 순서를 바꿀 수 없습니다.','error');const from=items.findIndex(x=>x.id===video),to=from+dir;if(from<0||to<0||to>=items.length)return;[items[from],items[to]]=[items[to],items[from]];const {error}=await db.rpc('staff_set_room_video_order',{p_room:room,p_video_ids:items.map(x=>x.id)});if(error)return toast(error.message,'error');await signalRoom(room);await load();scheduleRoomLiveAck(room);}

  async function quickSet(room,treatment){
    if(busy)return; busy=true;
    const age=qs(`[data-quick-age="${room}"]`)?.value||null;
    const gender=qs(`[data-quick-gender="${room}"]`)?.value||null;
    const {error}=await db.rpc('staff_quick_set_room',{p_room:room,p_treatment:treatment,p_age_group:age,p_gender:gender});
    busy=false; if(error)return toast(error.message,'error'); toast(`${treatmentLabel(treatment)} 맞춤 영상을 적용했습니다.`); await load();
  }
  async function quickClear(room){
    if(busy)return; busy=true;
    const {error}=await db.rpc('staff_quick_clear_room',{p_room:room});
    busy=false; if(error)return toast(error.message,'error'); toast('기본 영상으로 돌아갑니다.'); await load();
  }
  async function createPatient(){
    if(busy)return; busy=true;
    const {error}=await db.rpc('staff_create_patient',{p_label:qs('#patientLabel').value.trim()||null,p_age_group:qs('#patientAge').value||null,p_gender:qs('#patientGender').value||null,p_treatment:qs('#patientTreatment').value});
    busy=false; if(error)return toast(error.message,'error'); toast('대기 환자를 등록했습니다.'); await load();
  }
  async function assignPatient(id){
    const room=qs(`[data-room-select="${id}"]`)?.value; if(!room)return toast('진료실을 선택하세요.','error');
    const {error}=await db.rpc('staff_assign_patient',{p_patient:id,p_room:room}); if(error)return toast(error.message,'error'); toast('진료실에 배정했습니다.'); await load();
  }
  async function action(fn,id,msg){const {error}=await db.rpc(fn,{p_patient:id});if(error)return toast(error.message,'error');toast(msg);await load();}

  function updateStaffRoomDom(r){
    const card=qs(`[data-room-card="${r.id}"]`);if(!card)return;
    const health=roomHealth(r),display=roomDisplayStatus(r),st=r.player_status||{},on=staffIsOnline(r),video=currentVideoForRoom(r),progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'';
    card.dataset.health=health;card.className=`monitor-room staff-monitor-room health-${health}`;
    const dot=qs('[data-staff-live-dot]',card);if(dot)dot.classList.toggle('on',on);
    const status=qs('[data-staff-room-status]',card);if(status){status.className=`room-status-badge status-${display.key}`;status.textContent=display.label;}
    const thumb=qs('[data-staff-live-thumb]',card);if(thumb)thumb.innerHTML=staffThumb(video);
    const title=qs('[data-staff-live-title]',card);if(title)title.textContent=st.title||'대기 중';
    const next=qs('[data-staff-live-next]',card);if(next)next.textContent=st.next_title||'—';
    const detail=qs('[data-staff-live-detail]',card);if(detail)detail.textContent=on?`${playbackLabel(st.playback_state)}${progress?` · ${progress}`:''}${st.error?` · ${st.error}`:''}`:'오프라인';
  }
  function paintStaffSummary(){
    const statuses=state.rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length,issues=statuses.filter(x=>['error','recovering','delayed'].includes(x.key)).length;
    const set=(sel,val)=>{const el=qs(sel);if(el)el.textContent=String(val);};set('[data-staff-stat-total]',state.rooms.length);set('[data-staff-stat-live]',live);set('[data-staff-stat-issues]',issues);set('[data-staff-stat-offline]',offline);set('[data-staff-stat-online]',state.rooms.length-offline);
    groupedRooms().forEach(g=>paintStaffGroup(g));
  }
  function paintStaffGroup(group){
    const card=qs(`[data-staff-group="${group.id}"]`);if(!card)return;const x=groupStatusSummary(group.rooms),set=(sel,val)=>{const el=qs(sel,card);if(el)el.textContent=String(val);};
    card.className=`monitor-group staff-monitor-group group-state-${x.key}`;const badge=qs('[data-staff-group-status]',card);if(badge){badge.className=`group-status-badge status-${x.key}`;badge.textContent=x.label;}set('[data-staff-group-total]',x.total);set('[data-staff-group-live]',x.live);set('[data-staff-group-online]',x.online);set('[data-staff-group-issues]',x.issues);const p=qs('[data-staff-group-summary]',card);if(p)p.textContent=x.key==='live'?`${x.live}곳 송출 중`:x.key==='issue'?`확인 필요한 공간 ${x.issues}곳`:x.key==='offline'?'모든 공간 연결 끊김':'현재 재생 대기';
  }
  function mergePlayerLiveStatus(live){
    if(!live?.room_id)return;const idx=state.rooms.findIndex(r=>r.id===live.room_id);if(idx<0)return;state.rooms[idx]={...state.rooms[idx],last_seen_at:live.last_seen_at||state.rooms[idx].last_seen_at,player_status:live.player_status||state.rooms[idx].player_status,__live_verified_at:Date.now()};updateStaffRoomDom(state.rooms[idx]);paintStaffSummary();
  }
  const staleVerifyMeta=new Map();let staleVerifyBusy=false;
  async function verifyStaleLiveStatuses(){
    if(staleVerifyBusy||document.hidden)return;const now=Date.now(),ids=[];
    for(const r of state.rooms){const age=roomAgeMs(r);if(age<LIVE_DELAY_MS-5000)continue;const seen=String(r.last_seen_at||''),meta=staleVerifyMeta.get(r.id)||{};if(meta.seen!==seen){meta.seen=seen;meta.checkedAt=0;}if(now-Number(meta.checkedAt||0)<60000)continue;meta.checkedAt=now;staleVerifyMeta.set(r.id,meta);ids.push(r.id);}
    if(!ids.length)return;staleVerifyBusy=true;try{const {data,error}=await db.from('player_live_status').select('room_id,last_seen_at,player_status').in('room_id',ids);if(!error)(data||[]).forEach(mergePlayerLiveStatus);}catch(_){}finally{staleVerifyBusy=false;}
  }
  let stateReloadTimer=null;
  function scheduleStaffStateReload(){clearTimeout(stateReloadTimer);stateReloadTimer=setTimeout(()=>{if(!document.hidden&&!busy)load({background:true}).catch(()=>{});},250);}
  function startRealtime(){
    try{
      liveChannel=db.channel('clinic-staff-live-v2223').on('postgres_changes',{event:'INSERT',schema:'public',table:'player_live_status'},p=>mergePlayerLiveStatus(p.new||{})).on('postgres_changes',{event:'UPDATE',schema:'public',table:'player_live_status'},p=>mergePlayerLiveStatus(p.new||{})).subscribe();
      signalChannel=db.channel('clinic-staff-signal-v2223').on('postgres_changes',{event:'*',schema:'public',table:'player_control_signals'},scheduleStaffStateReload).subscribe();
    }catch(_){}
  }

  try{await load();startRealtime();}catch(e){qs('#staffRoot').innerHTML=`<p class="error">${esc(e.message||e)}</p>`;}
  let tick=0;const uiTimer=setInterval(()=>{if(document.hidden)return;state.rooms.forEach(updateStaffRoomDom);paintStaffSummary();if(++tick%5===0)verifyStaleLiveStatuses();},1000);
  window.addEventListener('beforeunload',()=>{clearInterval(uiTimer);clearTimeout(stateReloadTimer);try{if(liveChannel)db.removeChannel(liveChannel);if(signalChannel)db.removeChannel(signalChannel);}catch(_){}});
})();
