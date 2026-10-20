(async function () {
  'use strict';
  const { db, qs, qsa, esc, toast, isOnline } = Signage;
  await Signage.requireAuth();
  qs('#signOut').addEventListener('click', Signage.signOut);

  const AGE_OPTIONS=[['','전체'],['teen','10대 이하'],['20-30','20~30대'],['40-50','40~50대'],['60+','60대 이상']];
  const GENDER_OPTIONS=[['','전체'],['female','여성'],['male','남성']];
  const TREATMENTS=[['minish','미니쉬'],['implant','임플란트'],['whitening','미백'],['orthodontics','교정'],['checkup','검진'],['aftercare','수술 후 관리'],['general','일반 진료']];
  let state={patients:[],rooms:[],playlists:[],videos:[],broadcast:{active:false}}, busy=false, timer=null;

  const treatmentLabel=(v)=>TREATMENTS.find(([id])=>id===v)?.[1]||v||'일반 진료';
  const ageLabel=(v)=>AGE_OPTIONS.find(([id])=>id===v)?.[1]||'전체';
  const genderLabel=(v)=>GENDER_OPTIONS.find(([id])=>id===v)?.[1]||'전체';
  const roomById=(id)=>state.rooms.find(r=>r.id===id)||null;
  const playlistById=(id)=>state.playlists.find(p=>p.id===id)||null;
  const roomTypeLabel=(v)=>({treatment:'진료실',consultation:'상담실',waiting:'대기실',lobby:'로비',vip:'VIP',other:'기타'})[v]||'공간';
  const isPatientRoom=(r)=>['treatment','consultation'].includes(r.room_mode);
  const playlistOptions=(selected='')=>`<option value="">플레이리스트 선택</option>${state.playlists.filter(p=>p.active!==false).map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}${p.kind==='patient'?' · 맞춤':''}</option>`).join('')}`;
  const videoOptions=()=>`<option value="">영상 선택</option>${state.videos.filter(v=>v.active!==false).map(v=>`<option value="${v.id}">${esc(v.title)}</option>`).join('')}`;
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

  async function load(){
    const {data,error}=await db.rpc('staff_reception_state');
    if(error)throw error;
    state={patients:data?.patients||[],rooms:data?.rooms||[],playlists:data?.playlists||[],videos:data?.videos||[],broadcast:data?.broadcast||{active:false}};
    render();
  }

  function render(){
    const waiting=state.patients.filter(p=>p.status==='waiting');
    const assigned=state.patients.filter(p=>p.status==='assigned');
    const inProgress=state.patients.filter(p=>p.status==='in_progress');
    const completed=state.patients.filter(p=>p.status==='completed');
    const online=state.rooms.filter(isOnline).length;
    const quick=state.rooms.filter(isQuickSession).length;
    const custom=state.rooms.filter(r=>r.session_treatment).length;
    qs('#staffRoot').innerHTML=`
      ${state.broadcast?.active?'<div class="broadcast-strip">전체 송출 중 · 맞춤 설정은 저장되며 전체 송출 종료 후 자동 적용됩니다.</div>':''}
      <div class="reception-head reception-head-board"><div><span class="eyebrow">RECEPTION</span><h1>공간 현황</h1><p>각 공간의 플레이리스트를 바꾸거나 영상 1개를 추가할 수 있습니다.</p></div></div>
      <div class="reception-summary reception-summary-board">
        <div class="is-primary"><span>온라인</span><b>${online}/${state.rooms.length}</b></div>
        <div><span>맞춤 송출</span><b>${custom}</b></div>
        <div><span>빠른 설정</span><b>${quick}</b></div>
        <div><span>등록 환자</span><b>${assigned.length+inProgress.length}</b></div>
        <div><span>대기</span><b>${waiting.length}</b></div>
      </div>

      <section class="reception-rooms reception-rooms-first">
        <div class="reception-section-head"><div><span class="eyebrow">SPACE STATUS</span><h2>공간</h2></div><b>${online}/${state.rooms.length} 온라인</b></div>
        <div class="reception-room-grid reception-room-grid-control">${state.rooms.map(roomCard).join('')}</div>
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

  function roomCard(r){
    const p=patientForRoom(r.id), quick=isQuickSession(r), current=r.player_status?.title||'대기 중', next=r.player_status?.next_title||'';
    const activeTreatment=p?.treatment||r.session_treatment||'';
    const audience=[p?.age_group||r.session_age_group,p?.gender||r.session_gender].filter(Boolean).map((v,i)=>i===0?ageLabel(v):genderLabel(v)).filter(x=>x!=='전체').join(' · ');
    const manual=!!r.manual_active&&Array.isArray(r.manual_video_ids)&&r.manual_video_ids.length>0;
    const defaultPlaylist=playlistById(r.default_playlist_id);
    return `<article class="reception-room-card reception-control-card ${p?'occupied':''} ${quick?'quick-custom':''} ${!isOnline(r)?'offline':''}" data-room-card="${r.id}">
      <div class="room-card-head"><span><i class="dot ${isOnline(r)?'on':''}"></i><b>${esc(r.group_name?`${r.group_name} · ${r.name}`:r.name)}</b></span><em>${esc(roomTypeLabel(r.room_mode))}</em></div>
      <div class="room-state-main"><span>송출 상태</span><b>${manual?'개별 영상':activeTreatment?esc(treatmentLabel(activeTreatment)):esc(defaultPlaylist?.name||'기본 플레이리스트')}</b>${audience?`<small>${esc(audience)}</small>`:''}</div>
      <div class="room-playing"><span>지금 재생</span><b>${esc(current)}</b>${next?`<small>다음 · ${esc(next)}</small>`:''}</div>
      <div class="staff-output-controls">
        <div class="staff-output-row"><span>플레이리스트</span><select data-staff-playlist="${r.id}">${playlistOptions(r.default_playlist_id||'')}</select><button class="btn primary" data-staff-playlist-apply="${r.id}">변경</button></div>
        <div class="staff-output-row"><span>영상 추가</span><select data-staff-video="${r.id}">${videoOptions()}</select><button class="btn" data-staff-video-add="${r.id}">추가</button>${manual?`<button class="btn" data-staff-manual-clear="${r.id}">기본으로</button>`:''}</div>
      </div>
      ${p?`<div class="room-patient compact"><b>${esc(p.label||`대기 ${p.queue_no}`)}</b><span>${esc(waitText(p))}</span></div>`:''}
      ${isPatientRoom(r)?`<div class="room-card-actions">${!p?`<button class="btn" data-open-quick="${r.id}">${quick?'맞춤 변경':'환자 맞춤'}</button>${quick?`<button class="btn" data-quick-clear="${r.id}">맞춤 해제</button>`:''}`:'<span class="room-managed-note">환자 관리에서 변경</span>'}</div>${!p?quickPanel(r):''}`:''}
    </article>`;
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
      <div class="patient-actions">${waiting?`<select data-room-select="${p.id}"><option value="">진료실 선택</option>${available.map(r=>`<option value="${r.id}">${esc(r.group_name?`${r.group_name} · `:'')}${esc(r.name)}${isOnline(r)?'':' · 오프라인'}</option>`).join('')}</select><button class="btn primary" data-assign="${p.id}">배정</button>`:`${p.status==='assigned'?`<button class="btn primary" data-start="${p.id}">진료 시작</button>`:''}<button class="btn" data-unassign="${p.id}">배정 변경</button><button class="btn" data-complete="${p.id}">종료</button>`}<button class="text-action danger-text" data-cancel="${p.id}">취소</button></div>
    </article>`;
  }

  function bind(){
    qsa('[data-staff-playlist-apply]').forEach(b=>b.addEventListener('click',()=>setRoomPlaylist(b.dataset.staffPlaylistApply)));
    qsa('[data-staff-video-add]').forEach(b=>b.addEventListener('click',()=>addRoomVideo(b.dataset.staffVideoAdd)));
    qsa('[data-staff-manual-clear]').forEach(b=>b.addEventListener('click',()=>clearRoomManual(b.dataset.staffManualClear)));
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
    if(error)return toast(error.message,'error'); toast('공간 플레이리스트를 변경했습니다.'); await load();
  }
  async function addRoomVideo(room){
    if(busy)return; const video=qs(`[data-staff-video="${room}"]`)?.value; if(!video)return toast('추가할 영상을 선택하세요.','error');
    busy=true; const {error}=await db.rpc('staff_add_room_video',{p_room:room,p_video:video}); busy=false;
    if(error)return toast(error.message,'error'); toast('이 공간에 영상 1개를 추가했습니다.'); await load();
  }
  async function clearRoomManual(room){
    if(busy)return; busy=true; const {error}=await db.rpc('staff_clear_room_manual',{p_room:room}); busy=false;
    if(error)return toast(error.message,'error'); toast('선택한 기본 플레이리스트로 돌아갑니다.'); await load();
  }

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

  try{await load();}catch(e){qs('#staffRoot').innerHTML=`<p class="error">${esc(e.message||e)}</p>`;}
  timer=setInterval(()=>{if(document.visibilityState==='visible')load().catch(()=>{});},10000);
  window.addEventListener('beforeunload',()=>clearInterval(timer));
})();
