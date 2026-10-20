(async function () {
  'use strict';
  const { db, qs, qsa, esc, toast, isOnline } = Signage;
  await Signage.requireAuth();
  qs('#signOut').addEventListener('click', Signage.signOut);

  const AUDIENCES=[
    {id:'all',label:'전체',age:null,gender:null},{id:'teen',label:'10대 이하',age:'teen',gender:null},
    {id:'20-30-f',label:'20~30 여성',age:'20-30',gender:'female'},{id:'20-30-m',label:'20~30 남성',age:'20-30',gender:'male'},
    {id:'40-50-f',label:'40~50 여성',age:'40-50',gender:'female'},{id:'40-50-m',label:'40~50 남성',age:'40-50',gender:'male'},
    {id:'60+-f',label:'60+ 여성',age:'60+',gender:'female'},{id:'60+-m',label:'60+ 남성',age:'60+',gender:'male'}
  ];
  const DEFAULT_TREATMENT='minish';
  const TREATMENTS=[['minish','미니쉬'],['implant','임플란트'],['whitening','미백'],['orthodontics','교정'],['checkup','검진'],['aftercare','수술 후 관리'],['general','일반 진료']];
  const TREATMENT_DESC={minish:'미니쉬 상담·치료 안내',implant:'임플란트 치료 안내',whitening:'미백 상담 안내',orthodontics:'교정 치료 안내',checkup:'검진 및 예방 안내',aftercare:'치료 후 관리 안내',general:'일반 진료 안내'};
  const ROOM_MODE_LABEL={treatment:'진료실',consultation:'상담실',waiting:'대기실',other:'기타'};
  const requestedRoomId=new URLSearchParams(location.search).get('room');
  let rooms=[],broadcast=null,selectedRoom=null,selectedAudience=AUDIENCES[0],busy=false,loadSeq=0;

  async function load({preserveSelection=true}={}){
    const seq=++loadSeq;const [rr,bb]=await Promise.all([db.rpc('staff_room_list'),db.from('broadcast').select('active,notice_text').eq('id',1).maybeSingle()]);
    if(rr.error)throw rr.error;if(bb.error)throw bb.error;if(seq!==loadSeq)return;
    rooms=rr.data||[];broadcast=bb.data||{active:false};
    if(requestedRoomId)selectedRoom=rooms.find(r=>r.id===requestedRoomId)||null;else if(preserveSelection&&selectedRoom)selectedRoom=rooms.find(r=>r.id===selectedRoom.id)||null;
    render();
  }
  const canPersonalize=(r)=>['treatment','consultation'].includes(r?.room_mode);
  function activeSession(r){return Boolean(r?.session_started_at&&(r.session_timeout_min===0||!r.session_expires_at||new Date(r.session_expires_at)>new Date()));}
  function profileText(r){if(!canPersonalize(r))return '그룹/기본 송출';if(!activeSession(r))return '기본 재생';const a=AUDIENCES.find(x=>x.age===r.session_age_group&&x.gender===r.session_gender)||AUDIENCES[0],t=TREATMENTS.find(([id])=>id===r.session_treatment)?.[1]||r.session_treatment||'맞춤';return `맞춤 송출 · ${a.label} · ${t}`;}
  function sessionAudience(r){return AUDIENCES.find(x=>x.age===r?.session_age_group&&x.gender===r?.session_gender)?.label||'전체';}
  function sessionTreatment(r){return TREATMENTS.find(([id])=>id===r?.session_treatment)?.[1]||'—';}
  function sessionRemaining(r){if(!activeSession(r))return '—';if(!r.session_expires_at)return '수동 종료';const ms=new Date(r.session_expires_at)-new Date();if(ms<=0)return '종료 예정';const min=Math.max(1,Math.ceil(ms/60000));return `${min}분 남음`;}
  function roomModeText(r){if(broadcast?.active)return '전체 송출';if(activeSession(r))return '맞춤 송출';return '기본 영상';}

  function render(){
    if(requestedRoomId&&!selectedRoom){qs('#staffRoot').innerHTML='<p class="error">지정된 공간을 찾을 수 없습니다.</p>';return;}
    const strip=broadcast?.active?'<div class="broadcast-strip">전체 송출 중 · 환자 맞춤 설정은 전체 송출 종료 후 자동 적용됩니다.</div>':'';
    if(selectedRoom){qs('#staffRoot').innerHTML=`${strip}${controlView(selectedRoom)}`;bindControl();return;}
    const groupNames=[...new Set(rooms.map(r=>r.group_name||'미분류'))];
    const online=rooms.filter(isOnline).length,active=rooms.filter(activeSession).length;
    qs('#staffRoot').innerHTML=`${strip}<div class="staff-dashboard-head"><div><span class="eyebrow">STAFF</span><h1>환자 영상</h1><p>공간을 선택하고 환자에 맞는 영상을 바로 설정합니다.</p></div></div><div class="staff-summary-grid"><div><span>전체 공간</span><b>${rooms.length}</b></div><div><span>온라인</span><b>${online}</b></div><div><span>맞춤 송출</span><b>${active}</b></div><div class="${broadcast?.active?'is-live':''}"><span>전체 송출</span><b>${broadcast?.active?'ON':'OFF'}</b></div></div><div class="staff-group-stack">${groupNames.map(name=>staffGroup(name,rooms.filter(r=>(r.group_name||'미분류')===name))).join('')}</div>`;
    qsa('[data-select-room]').forEach(b=>b.addEventListener('click',()=>{selectedRoom=rooms.find(r=>r.id===b.dataset.selectRoom)||null;selectedAudience=AUDIENCES[0];render();}));
    qsa('[data-end-session]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();endSession(b.dataset.endSession);}));
  }
  function staffGroup(name,list){const online=list.filter(isOnline).length;return `<section class="staff-group"><div class="staff-group-head"><div><b>${esc(name)}</b><small>${list.length}개 공간</small></div><span>${online}/${list.length} 온라인</span></div><div class="staff-grid">${list.map(roomCard).join('')}</div></section>`;}
  function roomCard(r){const disabled=!canPersonalize(r),active=activeSession(r);return `<section class="staff-room ${disabled?'staff-room-passive':''} ${active?'has-session':''}"><button ${disabled?'disabled':''} data-select-room="${r.id}" class="staff-room-main"><div class="staff-room-top"><span class="room-title"><span class="dot ${isOnline(r)?'on':''}"></span><b>${esc(r.name)}</b></span><em>${esc(ROOM_MODE_LABEL[r.room_mode]||'기타')}</em></div><div class="staff-room-status"><strong>${esc(roomModeText(r))}</strong><span>${esc(profileText(r))}</span></div><div class="staff-room-meta"><span>${isOnline(r)?'온라인':'오프라인'}</span>${active?`<span>${esc(sessionRemaining(r))}</span>`:''}</div></button>${active?`<button class="btn flat" data-end-session="${r.id}">기본으로</button>`:''}</section>`;}
  function controlView(r){
    const active=activeSession(r),online=isOnline(r);
    if(!canPersonalize(r))return `<div class="staff-control"><div class="page-head"><div><div class="eyebrow">${esc(r.group_name||'미분류')} · ${esc(r.name)}</div><h1>${esc(ROOM_MODE_LABEL[r.room_mode]||'공간')}</h1></div>${requestedRoomId?'':`<button id="backRooms" class="text-btn dark">공간 변경</button>`}</div><div class="staff-room-overview"><div><span>연결</span><b>${online?'온라인':'오프라인'}</b></div><div><span>송출</span><b>${broadcast?.active?'전체 송출':'기본 영상'}</b></div><div><span>공간 유형</span><b>${esc(ROOM_MODE_LABEL[r.room_mode]||'기타')}</b></div></div><section class="panel staff-info-panel"><span class="eyebrow">DISPLAY</span><h2>이 공간은 자동 송출로 운영됩니다.</h2><p>대기실 등 환자별 맞춤 설정을 사용하지 않는 공간입니다.</p></section></div>`;
    return `<div class="staff-control"><div class="page-head"><div><div class="eyebrow">${esc(r.group_name||'미분류')} · ${esc(r.name)}</div><h1>환자 영상 선택</h1><p class="page-intro">진료유형만 선택해도 바로 적용됩니다. 환자 조건은 필요한 경우에만 선택하세요.</p></div>${requestedRoomId?'':`<button id="backRooms" class="text-btn dark">공간 변경</button>`}</div><div class="staff-room-overview"><div><span>연결</span><b>${online?'온라인':'오프라인'}</b></div><div><span>현재 송출</span><b>${esc(roomModeText(r))}</b></div><div><span>환자</span><b>${active?esc(sessionAudience(r)):'전체'}</b></div><div><span>진료유형</span><b>${active?esc(sessionTreatment(r)):'—'}</b></div><div><span>자동 종료</span><b>${active?esc(sessionRemaining(r)):'—'}</b></div></div><section class="panel staff-current-card"><div><span class="eyebrow">NOW</span><h2>${active?esc(profileText(r)):'기본 영상을 재생 중입니다.'}</h2><p>${broadcast?.active?'현재 전체 송출이 우선 적용되고 있습니다. 설정한 맞춤 영상은 전체 송출 종료 후 적용됩니다.':active?'환자 맞춤 영상이 이 공간에 적용되어 있습니다.':'아래에서 진료유형을 선택하면 바로 맞춤 송출을 시작합니다.'}</p></div><button id="endSession" class="btn" ${active?'':'disabled'}>기본 영상으로</button></section><section class="panel staff-choice-panel"><div class="panel-head"><div><span class="eyebrow">OPTIONAL</span><h2>환자 조건</h2><p>선택하지 않으면 전체 환자용 영상이 적용됩니다.</p></div></div><div class="quick-picks">${AUDIENCES.map(a=>`<button class="quick-pick ${selectedAudience.id===a.id?'on':''}" data-audience="${a.id}"><b>${esc(a.label)}</b></button>`).join('')}</div></section><section class="panel staff-treatment-panel"><div class="panel-head"><div><span class="eyebrow">TREATMENT</span><h2>진료유형</h2><p>선택 즉시 이 공간의 환자 맞춤 영상이 시작됩니다.</p></div></div><div class="treatment-grid">${TREATMENTS.map(([id,label])=>`<button class="treatment-pick ${id===DEFAULT_TREATMENT?'is-default':''}" data-treatment="${id}" ${busy?'disabled':''}><span><b>${esc(label)}</b><small>${esc(TREATMENT_DESC[id]||'진료 안내')}</small></span>${id===DEFAULT_TREATMENT?'<em>기본</em>':''}</button>`).join('')}</div>${broadcast?.active?'<p class="staff-note">전체 송출 종료 후 자동 적용됩니다.</p>':''}</section></div>`;
  }
  function bindControl(){qs('#backRooms')?.addEventListener('click',()=>{selectedRoom=null;selectedAudience=AUDIENCES[0];render();});if(!canPersonalize(selectedRoom))return;qs('#endSession')?.addEventListener('click',()=>endSession(selectedRoom.id));qsa('[data-audience]').forEach(b=>b.addEventListener('click',()=>{selectedAudience=AUDIENCES.find(a=>a.id===b.dataset.audience)||AUDIENCES[0];render();}));qsa('[data-treatment]').forEach(b=>b.addEventListener('click',()=>startSession(b.dataset.treatment)));}
  async function startSession(treatment=DEFAULT_TREATMENT){if(!selectedRoom||busy)return;busy=true;render();const {error}=await db.rpc('start_patient_session',{p_room:selectedRoom.id,p_age_group:selectedAudience.age,p_gender:selectedAudience.gender,p_treatment:treatment});busy=false;if(error){toast(error.message,'error');render();return;}toast(broadcast?.active?'맞춤 송출 예약됨':'맞춤 송출 시작');if(!requestedRoomId){selectedRoom=null;selectedAudience=AUDIENCES[0];}await load({preserveSelection:Boolean(requestedRoomId)});}
  async function endSession(id){const {error}=await db.rpc('end_session',{p_room:id});if(error)toast(error.message,'error');else{toast('기본 영상으로 복귀');await load({preserveSelection:true});}}

  try{await load();}catch(e){qs('#staffRoot').innerHTML=`<p class="error">${esc(e.message||e)}</p>`;}
  setInterval(()=>load({preserveSelection:true}).catch(()=>{}),20000);
})();
