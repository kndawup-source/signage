(async function () {
  'use strict';
  const { db, qs, qsa, esc, toast, isOnline } = Signage;
  await Signage.requireAuth();
  qs('#signOut').addEventListener('click', Signage.signOut);

  const AGE_OPTIONS=[['','전체'],['teen','10대 이하'],['20-30','20~30대'],['40-50','40~50대'],['60+','60대 이상']];
  const GENDER_OPTIONS=[['','전체'],['female','여성'],['male','남성']];
  const TREATMENTS=[['minish','미니쉬'],['implant','임플란트'],['whitening','미백'],['orthodontics','교정'],['checkup','검진'],['aftercare','수술 후 관리'],['general','일반 진료']];
  let state={patients:[],rooms:[],broadcast:{active:false}}, busy=false, timer=null;

  const treatmentLabel=(v)=>TREATMENTS.find(([id])=>id===v)?.[1]||v||'일반 진료';
  const ageLabel=(v)=>AGE_OPTIONS.find(([id])=>id===v)?.[1]||'전체';
  const genderLabel=(v)=>GENDER_OPTIONS.find(([id])=>id===v)?.[1]||'전체';
  const roomById=(id)=>state.rooms.find(r=>r.id===id)||null;
  const activePatients=()=>state.patients.filter(p=>['waiting','assigned','in_progress'].includes(p.status));
  const elapsedMinutes=(start,end=Date.now())=>start?Math.max(0,Math.floor((new Date(end).getTime()-new Date(start).getTime())/60000)):0;
  const waitText=(p)=>`${elapsedMinutes(p.waiting_started_at||p.created_at,p.assigned_at||Date.now())}분 대기`;
  const roomStatus=(r)=>{const p=activePatients().find(x=>x.room_id===r.id);return p?{text:p.status==='in_progress'?'진료 중':'배정됨',patient:p}:{text:'비어 있음',patient:null};};

  async function load(){
    const {data,error}=await db.rpc('staff_reception_state');
    if(error)throw error;
    state={patients:data?.patients||[],rooms:data?.rooms||[],broadcast:data?.broadcast||{active:false}};
    render();
  }

  function render(){
    const waiting=state.patients.filter(p=>p.status==='waiting');
    const assigned=state.patients.filter(p=>p.status==='assigned');
    const inProgress=state.patients.filter(p=>p.status==='in_progress');
    const completed=state.patients.filter(p=>p.status==='completed');
    const online=state.rooms.filter(isOnline).length;
    qs('#staffRoot').innerHTML=`
      ${state.broadcast?.active?'<div class="broadcast-strip">전체 송출 중 · 환자 배정은 가능하며 전체 송출 종료 후 맞춤 영상이 자동 적용됩니다.</div>':''}
      <div class="reception-head"><div><span class="eyebrow">RECEPTION</span><h1>환자 영상 배정</h1><p>리셉션에서 환자를 등록하고 진료실만 배정하면 영상은 자동으로 전환됩니다.</p></div><button id="openPatientForm" class="btn primary">환자 추가</button></div>
      <div class="reception-summary"><div><span>대기</span><b>${waiting.length}</b></div><div><span>배정</span><b>${assigned.length}</b></div><div><span>진료 중</span><b>${inProgress.length}</b></div><div><span>오늘 완료</span><b>${completed.length}</b></div><div><span>진료실 온라인</span><b>${online}/${state.rooms.length}</b></div></div>
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
      <section class="reception-rooms"><div class="reception-section-head"><div><span class="eyebrow">ROOMS</span><h2>진료실 현황</h2></div><b>${online}/${state.rooms.length} 온라인</b></div><div class="reception-room-grid">${state.rooms.map(roomCard).join('')}</div></section>`;
    bind();
  }

  function patientCard(p){
    const room=roomById(p.room_id), waiting=p.status==='waiting';
    const status=p.status==='waiting'?'대기':p.status==='assigned'?'배정됨':'진료 중';
    const audience=[ageLabel(p.age_group),genderLabel(p.gender)].filter(x=>x!=='전체').join(' · ')||'전체 환자';
    const available=state.rooms.filter(r=>['treatment','consultation'].includes(r.room_mode)&&!activePatients().some(x=>x.room_id===r.id&&x.id!==p.id));
    return `<article class="patient-card status-${p.status}" data-patient="${p.id}">
      <div class="patient-card-top"><div><span class="patient-status">${status}</span><h3>${esc(p.label||`대기 ${p.queue_no}`)}</h3></div><strong>${esc(waitText(p))}</strong></div>
      <div class="patient-profile"><b>${esc(treatmentLabel(p.treatment))}</b><span>${esc(audience)}</span></div>
      ${room?`<div class="patient-room"><span>진료실</span><b>${esc(room.name)}</b><small>${esc(room.player_status?.title||'영상 준비 중')}</small></div>`:''}
      <div class="patient-actions">${waiting?`<select data-room-select="${p.id}"><option value="">진료실 선택</option>${available.map(r=>`<option value="${r.id}">${esc(r.group_name?`${r.group_name} · `:'')}${esc(r.name)}${isOnline(r)?'':' · 오프라인'}</option>`).join('')}</select><button class="btn primary" data-assign="${p.id}">배정</button>`:`${p.status==='assigned'?`<button class="btn primary" data-start="${p.id}">진료 시작</button>`:''}<button class="btn" data-unassign="${p.id}">배정 변경</button><button class="btn" data-complete="${p.id}">종료</button>`}<button class="text-action danger-text" data-cancel="${p.id}">취소</button></div>
    </article>`;
  }

  function roomCard(r){
    const rs=roomStatus(r), p=rs.patient, current=r.player_status?.title||'대기 중', next=r.player_status?.next_title||'';
    return `<article class="reception-room-card ${p?'occupied':''} ${!isOnline(r)?'offline':''}"><div class="room-card-head"><span><i class="dot ${isOnline(r)?'on':''}"></i><b>${esc(r.name)}</b></span><em>${esc(rs.text)}</em></div>${p?`<div class="room-patient"><b>${esc(p.label||`대기 ${p.queue_no}`)}</b><span>${esc(treatmentLabel(p.treatment))} · ${esc(waitText(p))}</span></div>`:'<div class="room-patient empty"><b>사용 가능</b><span>환자 배정 대기</span></div>'}<div class="room-playing"><span>지금 재생</span><b>${esc(current)}</b>${next?`<small>다음 · ${esc(next)}</small>`:''}</div></article>`;
  }

  function bind(){
    qs('#openPatientForm')?.addEventListener('click',()=>qs('#patientForm').classList.remove('hidden'));
    qs('#closePatientForm')?.addEventListener('click',()=>qs('#patientForm').classList.add('hidden'));
    qs('#createPatient')?.addEventListener('click',createPatient);
    qsa('[data-assign]').forEach(b=>b.addEventListener('click',()=>assignPatient(b.dataset.assign)));
    qsa('[data-start]').forEach(b=>b.addEventListener('click',()=>action('staff_start_patient',b.dataset.start,'진료를 시작했습니다.')));
    qsa('[data-complete]').forEach(b=>b.addEventListener('click',()=>action('staff_complete_patient',b.dataset.complete,'환자 영상을 종료했습니다.')));
    qsa('[data-unassign]').forEach(b=>b.addEventListener('click',()=>action('staff_unassign_patient',b.dataset.unassign,'배정을 해제했습니다.')));
    qsa('[data-cancel]').forEach(b=>b.addEventListener('click',()=>{if(confirm('이 환자 대기를 취소할까요?'))action('staff_cancel_patient',b.dataset.cancel,'취소했습니다.');}));
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
