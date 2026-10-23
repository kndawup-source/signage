(async function () {
  'use strict';
  const { db, qs, qsa, esc, toast, formatDuration } = Signage;
  await Signage.requireAuth();
  qs('#signOut').addEventListener('click', Signage.signOut);

  const AGE_OPTIONS=[['','전체'],['teen','10대 이하'],['20-30','20~30대'],['40-50','40~50대'],['60+','60대 이상']];
  const GENDER_OPTIONS=[['','전체'],['female','여성'],['male','남성']];
  const TREATMENTS=[['minish','미니쉬'],['implant','임플란트'],['whitening','미백'],['orthodontics','교정'],['checkup','검진'],['aftercare','수술 후 관리'],['general','일반 진료']];
  let state={patients:[],rooms:[],groups:[],playlists:[],videos:[],playlistItems:[],roomRules:[],broadcast:{active:false}}, busy=false, signalChannel=null,statusWakeChannel=null;
  const statusWakeTimers=new Map();
  // roomId -> {status:'pending'|'unconfirmed'|'error', at:issuedAtServerMs}
  const ackState=new Map();
  const monitor=Signage.createLiveMonitor({onUpdate:(res)=>applyLiveResult(res)});
  async function signalRoom(room){try{await db.rpc('signal_signage_rooms',{p_room_ids:[room],p_group:null,p_all:false});}catch(_){}}

  const treatmentLabel=(v)=>TREATMENTS.find(([id])=>id===v)?.[1]||v||'일반 진료';
  const ageLabel=(v)=>AGE_OPTIONS.find(([id])=>id===v)?.[1]||'전체';
  const genderLabel=(v)=>GENDER_OPTIONS.find(([id])=>id===v)?.[1]||'전체';
  const roomById=(id)=>state.rooms.find(r=>r.id===id)||null;
  const playlistById=(id)=>state.playlists.find(p=>p.id===id)||null;
  const roomTypeLabel=(v)=>({treatment:'진료실',consultation:'상담실',waiting:'대기실',lounge:'라운지',reception:'접수/안내',lobby:'로비',public:'공용 모니터',staff:'스탭 공간',vip:'VIP',other:'기타'})[v]||'공간';
  const isPatientRoom=(r)=>['treatment','consultation'].includes(r.room_mode);
  const playlistOptions=(selected='')=>`<option value="">플레이리스트 선택</option>${state.playlists.filter(p=>p.active!==false).map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}${p.kind==='patient'?' · 맞춤':''}</option>`).join('')}`;
  const videoOptions=()=>`<option value="">영상 선택</option>${state.videos.filter(v=>v.active!==false).map(v=>`<option value="${v.id}">${esc(v.title)}</option>`).join('')}`;
  const roomRules=(room)=>state.roomRules.filter(x=>x.room_id===room);
  function staffPatientPlaylist(r){const matches=state.playlists.filter(p=>p.active!==false&&p.kind==='patient'&&(!(p.target_treatment||[]).length||(r.session_treatment&&(p.target_treatment||[]).includes(r.session_treatment)))&&(!(p.target_age||[]).length||(r.session_age_group&&(p.target_age||[]).includes(r.session_age_group)))&&(!(p.target_gender||[]).length||(r.session_gender&&(p.target_gender||[]).includes(r.session_gender))));return matches.sort((a,b)=>(((b.target_treatment||[]).length?100:0)+((b.target_age||[]).length?10:0)+((b.target_gender||[]).length?5:0))-(((a.target_treatment||[]).length?100:0)+((a.target_age||[]).length?10:0)+((a.target_gender||[]).length?5:0))||(a.sort_order||0)-(b.sort_order||0))[0]||null;}
  function staffBaseIds(r){const mode=String(r.player_status?.mode||'');if(['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(mode)){const live=Array.isArray(r.player_status?.playlist_video_ids)?r.player_status.playlist_video_ids.filter(Boolean):[];if(live.length)return live;}if(r.manual_active&&r.manual_video_ids?.length)return r.manual_video_ids;if(mode==='patient'){const pp=staffPatientPlaylist(r);if(pp)return state.playlistItems.filter(x=>x.playlist_id===pp.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(x=>x.video_id);}const fallback=r.default_playlist_id||state.groups.find(g=>g.id===r.group_id)?.default_playlist_id||state.playlists.filter(p=>p.active!==false&&p.kind==='default').sort((a,b)=>(a.sort_order||0)-(b.sort_order||0))[0]?.id;return state.playlistItems.filter(x=>x.playlist_id===fallback).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(x=>x.video_id);}
  function staffRoomOutputItems(r){const ids=staffBaseIds(r),rules=new Map(roomRules(r.id).map(x=>[x.video_id,x]));return ids.map((id,idx)=>({id,video:state.videos.find(v=>v.id===id),rule:rules.get(id),idx})).filter(x=>x.video).sort((a,b)=>(a.rule?.sort_order??((a.idx+1)*10))-(b.rule?.sort_order??((b.idx+1)*10)));}
  function staffThumb(v){return v?.thumbnail_data_url?`<img loading="lazy" decoding="async" src="${esc(v.thumbnail_data_url)}" alt="">`:`<span>${esc((v?.title||'VIDEO').slice(0,2))}</span>`;}
  function staffOutputList(r){const items=staffRoomOutputItems(r);return `<div class="staff-output-list">${items.map((x,i)=>`<div class="staff-output-item ${x.rule?.enabled===false?'is-disabled':''}"><div class="staff-output-thumb">${staffThumb(x.video)}</div><b>${esc(x.video.title)}</b><label class="switch"><input type="checkbox" data-staff-video-toggle="${r.id}" data-video-id="${x.id}" ${x.rule?.enabled===false?'':'checked'} ${['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(String(r.player_status?.mode||''))?'disabled':''}><i></i></label><div><button data-staff-video-move="${r.id}" data-video-id="${x.id}" data-dir="-1" ${i===0?'disabled':''}>↑</button><button data-staff-video-move="${r.id}" data-video-id="${x.id}" data-dir="1" ${i===items.length-1?'disabled':''}>↓</button></div></div>`).join('')||'<span class="muted">재생 가능한 영상이 없습니다.</span>'}</div>`;}
  const roomHealth=(r)=>Signage.roomHealth(r,monitor.serverNow());
  const staffIsOnline=(r)=>roomHealth(r)!=='offline';
  function roomDisplayStatus(r){
    const h=roomHealth(r),st=r.player_status||{},play=String(st.playback_state||'').toLowerCase(),ack=ackState.get(r.id);
    if(h==='offline')return {key:'offline',label:'오프라인'};
    if(st.update_error||st.update_pending_version)return {key:'update',label:'업데이트 필요'};
    if(ack?.status==='error'||ack?.status==='unconfirmed'||h==='error'||h==='recovering'||st.error||st.offline_cache_error||Number(st.failed_video_count||0)>0)return {key:'error',label:'오류'};
    if(st.mode==='closed'||play==='closed'||r.paused||play==='paused'||ack?.status==='pending'||h==='delayed')return {key:'idle',label:'대기'};
    if(['playing','emergency'].includes(play))return {key:'live',label:'송출 중'};
    return {key:'idle',label:'대기'};
  }
  function roomIssueReason(r){const h=roomHealth(r),st=r.player_status||{},ack=ackState.get(r.id);if(h==='offline')return '플레이어 연결 끊김';if(st.update_error||st.update_pending_version)return '업데이트 필요';if(st.offline_cache_error)return '캐시 오류';if(Number(st.failed_video_count||0)>0)return `재생 실패 ${Number(st.failed_video_count||0)}개 건너뜀`;if(st.error)return String(st.error).slice(0,60);if(ack?.status==='error'||ack?.status==='unconfirmed')return '최근 변경 적용 확인 실패';if(st.mode==='closed')return '운영시간 외';return '';}
  const priorityLabel=(v)=>({broadcast:'전체',broadcast_schedule:'예약',manual:'개별',group:'층·구역',group_schedule:'예약',patient:'개별',session:'개별',default:'기본',emergency:'비상',closed:'운영시간 외'})[String(v||'').toLowerCase()]||'기본';
  function roomProblemRank(r){const k=roomDisplayStatus(r).key;return ({error:0,update:1,offline:2,idle:3,live:4})[k]??5;}
  function groupStatusSummary(rooms){
    const statuses=rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length;
    const issues=statuses.filter(x=>['error','update','offline'].includes(x.key)).length,online=rooms.length-offline;
    let key='idle',label='대기';
    if(!rooms.length){label='공간 없음';}
    else if(offline===rooms.length){key='offline';label='오프라인';}
    else if(issues>0){key='issue';label='오류';}
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

  async function load({background=false}={}){
    const [reception,liveStatuses]=await Promise.all([
      db.rpc('staff_reception_state'),
      monitor.loadAll().then(data=>({data,error:null}),error=>({data:null,error}))
    ]);
    if(reception.error)throw reception.error;
    if(liveStatuses.error)throw liveStatuses.error;
    const data=reception.data||{},liveByRoom=new Map((liveStatuses.data?.rows||[]).map(x=>[x.room_id,x]));
    const rooms=(data.rooms||[]).map(r=>{const live=liveByRoom.get(r.id);return live?{...r,last_seen_at:live.last_seen_at||r.last_seen_at,player_status:live.player_status||r.player_status}:r;});
    state={patients:data.patients||[],rooms,groups:data.groups||[],playlists:data.playlists||[],videos:data.videos||[],playlistItems:data.playlist_items||[],roomRules:data.room_video_rules||[],broadcast:data.broadcast||{active:false}};
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

  const careTypeLabel=(v)=>({general:'일반진료',minish:'MINISH',common:'공용',support:'지원',other:'기타'})[v]||'미설정';
  const floorNumber=(g)=>Number(g?.floor_number||String(g?.name||'').match(/(\d+)/)?.[1]||0);
  function groupedRooms(){
    const groups=[...state.groups].sort((a,b)=>(Number(a.sort_order||0)-Number(b.sort_order||0))||(floorNumber(a)-floorNumber(b)));
    if(!groups.length){const map=new Map(),order=[];for(const r of state.rooms){const key=r.group_id||'ungrouped';if(!map.has(key)){map.set(key,{id:key,name:r.group_name||'미분류',rooms:[]});order.push(key);}map.get(key).rooms.push(r);}return order.map(k=>map.get(k));}
    const out=groups.map(g=>({...g,rooms:state.rooms.filter(r=>r.group_id===g.id)}));
    const ungrouped=state.rooms.filter(r=>!r.group_id);if(ungrouped.length)out.push({id:'ungrouped',name:'미분류',rooms:ungrouped});
    return out.filter(g=>g.rooms.length||g.id!=='ungrouped');
  }
  const FLOOR_DEFAULTS={1:{kind:'공용',name:'로비'},2:{kind:'공용',name:'종합안내·대기'},3:{kind:'일반진료',name:'일반진료'},4:{kind:'일반진료',name:'교정·임플란트'},5:{kind:'기타',name:'도면 미등록'},6:{kind:'기타',name:'도면 미등록'},7:{kind:'MINISH',name:'예방·진료'},8:{kind:'MINISH',name:'진료센터 1'},9:{kind:'MINISH',name:'진료센터 2'},10:{kind:'MINISH',name:'진료센터 3'},11:{kind:'지원',name:'의국·사무'},12:{kind:'지원',name:'사무공간'},13:{kind:'공용',name:'식당'},14:{kind:'MINISH',name:'라운지'}};
  function staffBuildingOverview(groups){
    const byFloor=new Map(groups.filter(g=>floorNumber(g)>=1&&floorNumber(g)<=14).map(g=>[floorNumber(g),g]));
    const issueFloors=[...byFloor.values()].filter(g=>groupStatusSummary(g.rooms).issues>0).length;
    const rows=Array.from({length:14},(_,i)=>14-i).map(n=>{const g=byFloor.get(n),def=FLOOR_DEFAULTS[n],st=g?groupStatusSummary(g.rooms):{key:'idle'},y=55+(14-n)*38,kind=g?careTypeLabel(g.care_type):def.kind,purpose=(g?.signage_purpose||def.name).slice(0,22),attr=g?`data-scroll-group="${g.id}" role="button" tabindex="0"`:'aria-hidden="true"';return `<g class="svg-building-floor floor-state-${st.key}${g?'':' is-unmanaged'}" ${attr}><polygon class="svg-building-topline" points="92,${y} 492,${y} 528,${y-15} 128,${y-15}"></polygon><rect class="svg-building-slab" x="92" y="${y}" width="400" height="32" rx="2"></rect><polygon class="svg-building-side" points="492,${y} 528,${y-15} 528,${y+17} 492,${y+32}"></polygon><line class="svg-building-window" x1="155" y1="${y+16}" x2="426" y2="${y+16}"></line><text class="svg-building-floor-no" x="108" y="${y+21}">${n}F</text><text class="svg-building-purpose" x="166" y="${y+21}">${esc(kind)} · ${esc(purpose)}</text><circle class="svg-building-status-dot" cx="468" cy="${y+16}" r="4.5"></circle></g>`;}).join('');
    return `<section class="staff-building-board svg-building-board"><div class="svg-building-head"><div><span class="eyebrow">BUILDING</span><h2>층별 송출 위치</h2><p>문제가 표시된 층을 누르면 해당 층의 공간 목록으로 이동합니다.</p></div><div class="svg-building-head-status"><b>${issueFloors}</b><span>확인 필요 층</span></div></div><div class="staff-building-visual"><svg class="svg-building" viewBox="0 0 620 660" role="img" aria-label="층별 영상 송출 상태"><text class="svg-building-brand" x="92" y="31">CLINIC SIGNAGE</text>${rows}<rect class="svg-building-base" x="78" y="592" width="470" height="7" rx="3"></rect></svg></div></section>`;
  }



  function render(){
    const waiting=state.patients.filter(p=>p.status==='waiting');
    const assigned=state.patients.filter(p=>p.status==='assigned');
    const inProgress=state.patients.filter(p=>p.status==='in_progress');
    const completed=state.patients.filter(p=>p.status==='completed');
    const statuses=state.rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length;
    const issues=statuses.filter(x=>['error','update','offline'].includes(x.key)).length,online=state.rooms.length-offline;
    const quick=state.rooms.filter(isQuickSession).length,custom=state.rooms.filter(r=>r.session_treatment).length;
    const groups=groupedRooms();
    qs('#staffRoot').innerHTML=`
      ${state.broadcast?.active?'<div class="broadcast-strip">전체 송출 중 · 맞춤 설정은 저장되며 전체 송출 종료 후 자동 적용됩니다.</div>':''}
      <div class="reception-head reception-head-board"><div><span class="eyebrow">LIVE MONITOR</span><h1>영상 송출 현황</h1><p>각 층과 공간에서 현재 어떤 영상이 송출되고 있는지 확인하고 필요한 공간만 관리합니다.</p></div><button id="staffStatusRefresh" class="btn">상태 새로고침</button></div>
      <div class="staff-ops-summary">
        <div class="is-live"><span>현재 송출</span><b data-staff-stat-live>${live}</b><small>전체 ${state.rooms.length}개 공간</small></div>
        <div><span>대기</span><b>${Math.max(0,state.rooms.length-live-issues)}</b><small>운영시간 외·재생 대기</small></div>
        <div class="${issues?'is-problem':''}"><span>확인 필요</span><b data-staff-stat-issues>${issues}</b><small>${offline?`연결 끊김 ${offline}곳`:'연결 정상'}</small></div>
      </div>

      ${staffBuildingOverview(groups)}
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
    const summary=groupStatusSummary(group.rooms),nowText=summary.key==='live'?`${summary.live}곳 송출 중`:summary.key==='issue'?`문제 공간 ${summary.issues}곳`:summary.key==='offline'?'모든 공간 연결 끊김':summary.key==='idle'?'현재 재생 대기':'현재 상태 확인';
    return `<details class="monitor-group staff-monitor-group group-state-${summary.key}" data-staff-group="${esc(group.id)}"><summary class="monitor-group-summary"><div class="monitor-group-overview"><div class="monitor-group-title-row"><h2>${esc(groupDisplayName(group.name))}</h2><span class="floor-type-label">${esc(careTypeLabel(group.care_type))}</span><span class="group-status-badge status-${summary.key}" data-staff-group-status>${esc(summary.label)}</span></div><p class="floor-purpose-summary">${esc(group.signage_purpose||'송출 목적 미설정')}</p><div class="group-metric-row"><span>공간 <b data-staff-group-total>${summary.total}</b></span><span>송출 <b data-staff-group-live>${summary.live}</b></span><span>온라인 <b data-staff-group-online>${summary.online}</b></span><span>문제 <b data-staff-group-issues>${summary.issues}</b></span></div><p data-staff-group-summary>${esc(nowText)}${group.target_audience?` · 대상 ${esc(group.target_audience)}`:''}</p></div><span class="group-detail-link">상세보기</span></summary><div class="monitor-group-body">${group.waiting_area_note?`<div class="floor-reason-note"><b>고객 대기공간</b><span>${esc(group.waiting_area_note)}</span></div>`:''}${group.signage_reason?`<div class="floor-reason-note"><b>왜 송출하나요?</b><span>${esc(group.signage_reason)}</span></div>`:''}<div class="monitor-room-grid staff-monitor-room-grid">${[...group.rooms].sort((a,b)=>roomProblemRank(a)-roomProblemRank(b)||(a.sort_order||0)-(b.sort_order||0)).map(roomCard).join('')}</div></div></details>`;
  }

  function roomCard(r){
    const p=patientForRoom(r.id),quick=isQuickSession(r),st=r.player_status||{},display=roomDisplayStatus(r),health=roomHealth(r),current=st.title||'대기 중',next=st.next_title||'',activeTreatment=p?.treatment||r.session_treatment||'';
    const audience=[p?.age_group||r.session_age_group,p?.gender||r.session_gender].filter(Boolean).map((v,i)=>i===0?ageLabel(v):genderLabel(v)).filter(x=>x!=='전체').join(' · '),manual=!!r.manual_active&&Array.isArray(r.manual_video_ids)&&r.manual_video_ids.length>0,defaultPlaylist=playlistById(r.default_playlist_id),currentVideo=currentVideoForRoom(r),on=staffIsOnline(r);
    const progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'';
    return `<details class="monitor-room staff-monitor-room health-${health}" data-room-card="${r.id}" data-health="${health}"><summary><div class="monitor-room-top"><div class="monitor-room-name"><span data-staff-live-dot class="dot ${on?'on':''}"></span><b>${esc(r.name)}</b></div><span class="room-status-badge status-${display.key}" data-staff-room-status>${esc(display.label)}</span></div><div class="monitor-current-thumb" data-staff-live-thumb>${staffThumb(currentVideo)}</div><div class="monitor-now"><span>우선순위 · ${esc(priorityLabel(st.priority||st.mode))}</span><b data-staff-live-title>${esc(current)}</b><small data-staff-live-detail>${on?`${esc(playbackLabel(st.playback_state))}${progress?` · ${progress}`:''}${roomIssueReason(r)?` · ${esc(roomIssueReason(r))}`:''}`:'오프라인 · 플레이어 연결 끊김'}</small></div><div class="monitor-next"><span>다음</span><b data-staff-live-next>${esc(next||'—')}</b></div><div class="monitor-card-foot"><span>${esc(roomTypeLabel(r.room_mode))}${manual?' · 개별 영상':activeTreatment?` · ${esc(treatmentLabel(activeTreatment))}`:defaultPlaylist?` · ${esc(defaultPlaylist.name)}`:''}</span><b>관리</b></div></summary><div class="monitor-room-controls staff-room-control-body">
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
    qs('#staffStatusRefresh')?.addEventListener('click',()=>load().catch(e=>toast(e.message||String(e),'error')));qsa('[data-scroll-group]').forEach(b=>{const open=()=>{const el=qs(`[data-staff-group="${b.dataset.scrollGroup}"]`);if(el){el.open=true;el.scrollIntoView({behavior:'smooth',block:'start'});}};b.addEventListener('click',open);b.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});});
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

  const OVERRIDE_MODES=['broadcast','broadcast_schedule','group','group_schedule','emergency'];
  const isOverridden=(room)=>OVERRIDE_MODES.includes(String(roomById(room)?.player_status?.mode||''));
  /* One staff action on one room: capture server time before the write, write, wake the
     player, reload reception state, then confirm the player is actually playing the new state. */
  async function staffControl(room,op,okMessage,{signal=true}={}){
    if(busy)return false;busy=true;
    const issuedAt=monitor.markIssue();
    let result;try{result=await op();}catch(e){result={error:e};}finally{busy=false;}
    if(result?.error){toast(result.error.message||String(result.error),'error');return false;}
    if(signal&&room)await signalRoom(room);
    if(okMessage)toast(okMessage);
    await load().catch(e=>toast(e.message||String(e),'error'));
    if(room)void confirmDelivery(room,issuedAt);
    return true;
  }
  async function confirmDelivery(room,issuedAt){
    const r=roomById(room);if(!r||roomHealth(r)==='offline')return;
    if(!monitor.rpcSupported){await monitor.awaitAck([room],issuedAt);return;}
    ackState.set(room,{status:'pending',at:issuedAt});updateStaffRoomDom(r);paintStaffSummary();
    const {result}=await monitor.awaitAck([room],issuedAt);
    const a=ackState.get(room);if(a&&a.at!==issuedAt)return;
    const v=result.get(room);
    if(v==='ok')ackState.delete(room);else if(a)a.status=v==='error'?'error':'unconfirmed';
    const cur=roomById(room);if(cur){updateStaffRoomDom(cur);paintStaffSummary();}
    if(v!=='ok')toast(`${cur?.name||'공간'} · 화면 적용을 확인하지 못했습니다.`,'error');
  }
  function applyLiveResult(res){
    if(!res)return;
    const seen=new Map((res.seen||[]).map(x=>[x.room_id,x.last_seen_at]));
    (res.rows||[]).forEach(row=>{seen.delete(row.room_id);const a=ackState.get(row.room_id);if(a&&monitor.verdict(row,a.at)==='ok')ackState.delete(row.room_id);mergePlayerLiveStatus(row);});
    seen.forEach((lastSeen,roomId)=>{const r=roomById(roomId);if(r&&lastSeen)r.last_seen_at=lastSeen;});
  }
  const roomForPatient=(id)=>state.patients.find(p=>p.id===id)?.room_id||null;

  async function setRoomPlaylist(room){
    const playlist=qs(`[data-staff-playlist="${room}"]`)?.value; if(!playlist)return toast('플레이리스트를 선택하세요.','error');
    await staffControl(room,()=>db.rpc('staff_set_room_playlist',{p_room:room,p_playlist:playlist}),'공간 플레이리스트를 변경했습니다.');
  }
  async function addRoomVideo(room){
    const video=qs(`[data-staff-video="${room}"]`)?.value; if(!video)return toast('추가할 영상을 선택하세요.','error');
    await staffControl(room,()=>db.rpc('staff_add_room_video',{p_room:room,p_video:video}),'이 공간에 영상 1개를 추가했습니다.');
  }
  async function clearRoomManual(room){
    await staffControl(room,()=>db.rpc('staff_clear_room_manual',{p_room:room}),'선택한 기본 플레이리스트로 돌아갑니다.');
  }
  async function staffToggleVideo(room,video,enabled){
    if(isOverridden(room))return toast('전체/그룹 송출 중에는 개별 영상을 변경할 수 없습니다.','error');
    await staffControl(room,()=>db.rpc('staff_set_room_video_rule',{p_room:room,p_video:video,p_enabled:enabled}));
  }
  async function staffMoveVideo(room,video,dir){
    if(isOverridden(room))return toast('전체/그룹 송출 중에는 순서를 바꿀 수 없습니다.','error');
    const items=staffRoomOutputItems(roomById(room)||{}),from=items.findIndex(x=>x.id===video),to=from+dir;if(from<0||to<0||to>=items.length)return;
    [items[from],items[to]]=[items[to],items[from]];
    await staffControl(room,()=>db.rpc('staff_set_room_video_order',{p_room:room,p_video_ids:items.map(x=>x.id)}));
  }
  async function quickSet(room,treatment){
    const age=qs(`[data-quick-age="${room}"]`)?.value||null;
    const gender=qs(`[data-quick-gender="${room}"]`)?.value||null;
    await staffControl(room,()=>db.rpc('staff_quick_set_room',{p_room:room,p_treatment:treatment,p_age_group:age,p_gender:gender}),`${treatmentLabel(treatment)} 맞춤 영상을 적용했습니다.`,{signal:false});
  }
  async function quickClear(room){
    await staffControl(room,()=>db.rpc('staff_quick_clear_room',{p_room:room}),'기본 영상으로 돌아갑니다.',{signal:false});
  }
  async function createPatient(){
    await staffControl(null,()=>db.rpc('staff_create_patient',{p_label:qs('#patientLabel').value.trim()||null,p_age_group:qs('#patientAge').value||null,p_gender:qs('#patientGender').value||null,p_treatment:qs('#patientTreatment').value}),'대기 환자를 등록했습니다.',{signal:false});
  }
  async function assignPatient(id){
    const room=qs(`[data-room-select="${id}"]`)?.value; if(!room)return toast('진료실을 선택하세요.','error');
    await staffControl(room,()=>db.rpc('staff_assign_patient',{p_patient:id,p_room:room}),'진료실에 배정했습니다.',{signal:false});
  }
  async function action(fn,id,msg){
    const room=roomForPatient(id);
    await staffControl(room,()=>db.rpc(fn,{p_patient:id}),msg,{signal:false});
  }

  function updateStaffRoomDom(r){
    const card=qs(`[data-room-card="${r.id}"]`);if(!card)return;
    const health=roomHealth(r),display=roomDisplayStatus(r),st=r.player_status||{},on=staffIsOnline(r),video=currentVideoForRoom(r),progress=st.duration?`${formatDuration(Signage.estimatedCurrentTime(r,monitor.serverNow()))} / ${formatDuration(st.duration)}`:'';
    card.dataset.health=health;card.className=`monitor-room staff-monitor-room health-${health}`;
    const dot=qs('[data-staff-live-dot]',card);if(dot)dot.classList.toggle('on',on);
    const status=qs('[data-staff-room-status]',card);if(status){status.className=`room-status-badge status-${display.key}`;status.textContent=display.label;}
    const thumb=qs('[data-staff-live-thumb]',card),thumbKey=String(video?.id||'');if(thumb&&thumb.dataset.videoId!==thumbKey){thumb.innerHTML=staffThumb(video);thumb.dataset.videoId=thumbKey;}
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
    card.className=`monitor-group staff-monitor-group group-state-${x.key}`;const badge=qs('[data-staff-group-status]',card);if(badge){badge.className=`group-status-badge status-${x.key}`;badge.textContent=x.label;}set('[data-staff-group-total]',x.total);set('[data-staff-group-live]',x.live);set('[data-staff-group-online]',x.online);set('[data-staff-group-issues]',x.issues);const p=qs('[data-staff-group-summary]',card);if(p)p.textContent=x.key==='live'?`${x.live}곳 송출 중`:x.key==='issue'?`문제 공간 ${x.issues}곳`:x.key==='offline'?'모든 공간 연결 끊김':'현재 재생 대기';
  }
  function mergePlayerLiveStatus(live){
    if(!live?.room_id)return;const idx=state.rooms.findIndex(r=>r.id===live.room_id);if(idx<0)return;state.rooms[idx]={...state.rooms[idx],last_seen_at:live.last_seen_at||state.rooms[idx].last_seen_at,player_status:live.player_status||state.rooms[idx].player_status};updateStaffRoomDom(state.rooms[idx]);paintStaffSummary();
  }
  let stateReloadTimer=null;
  function scheduleStaffStateReload(){clearTimeout(stateReloadTimer);stateReloadTimer=setTimeout(()=>{if(!document.hidden&&!busy)load({background:true}).catch(()=>{});},250);}

  async function refreshLiveRoom(roomId){
    if(!roomId||document.hidden)return;
    try{applyLiveResult(await monitor.fetchStatus({roomIds:[roomId]}));}catch(e){console.warn('Clinic Signage staff room status refresh failed:',e?.message||e);}
  }
  function queueLiveRoomRefresh(roomId){
    if(!roomId)return;clearTimeout(statusWakeTimers.get(roomId));
    statusWakeTimers.set(roomId,setTimeout(()=>{statusWakeTimers.delete(roomId);void refreshLiveRoom(roomId);},80));
  }
  function startRealtime(){
    // Control changes reload staff configuration. Status changes wake a one-room RPC refresh;
    // the 30s delta poll remains only as loss recovery.
    try{
      signalChannel=db.channel('clinic-staff-signal-v2223').on('postgres_changes',{event:'*',schema:'public',table:'player_control_signals'},scheduleStaffStateReload).subscribe();
      statusWakeChannel=db.channel('clinic-signage-status')
        .on('broadcast',{event:'changed'},({payload})=>queueLiveRoomRefresh(payload?.room_id))
        .subscribe();
    }catch(_){}
  }

  try{await load();startRealtime();monitor.start(Signage.cfg.livePollMs);}catch(e){qs('#staffRoot').innerHTML=`<p class="error">${esc(e.message||e)}</p>`;}
  const uiTimer=setInterval(()=>{if(document.hidden)return;state.rooms.forEach(updateStaffRoomDom);paintStaffSummary();},1000);
  window.addEventListener('beforeunload',()=>{clearInterval(uiTimer);clearTimeout(stateReloadTimer);statusWakeTimers.forEach(clearTimeout);monitor.stop();try{if(signalChannel)db.removeChannel(signalChannel);if(statusWakeChannel)db.removeChannel(statusWakeChannel);}catch(_){}});
})();
