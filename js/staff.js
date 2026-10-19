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
  const TREATMENTS=[['implant','임플란트'],['minish','미니쉬'],['whitening','미백'],['orthodontics','교정'],['checkup','검진'],['aftercare','수술 후 관리'],['general','일반 진료']];
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

  function render(){
    if(requestedRoomId&&!selectedRoom){qs('#staffRoot').innerHTML='<p class="error">지정된 공간을 찾을 수 없습니다.</p>';return;}
    const strip=broadcast?.active?'<div class="broadcast-strip">전체 병원 송출 중 · 설정한 맞춤 송출은 전체 송출 종료 후 자동 적용됩니다.</div>':'';
    if(selectedRoom){qs('#staffRoot').innerHTML=`${strip}${controlView(selectedRoom)}`;bindControl();return;}
    const groupNames=[...new Set(rooms.map(r=>r.group_name||'미분류'))];
    qs('#staffRoot').innerHTML=`${strip}<div class="page-head"><div><div class="eyebrow">STAFF</div><h1>공간 선택</h1></div><div class="stat">${rooms.length}곳</div></div><div class="staff-group-stack">${groupNames.map(name=>staffGroup(name,rooms.filter(r=>(r.group_name||'미분류')===name))).join('')}</div>`;
    qsa('[data-select-room]').forEach(b=>b.addEventListener('click',()=>{selectedRoom=rooms.find(r=>r.id===b.dataset.selectRoom)||null;selectedAudience=AUDIENCES[0];render();}));
    qsa('[data-end-session]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();endSession(b.dataset.endSession);}));
  }
  function staffGroup(name,list){const online=list.filter(isOnline).length;return `<section class="staff-group"><div class="staff-group-head"><b>${esc(name)}</b><span>${online}/${list.length} ONLINE</span></div><div class="staff-grid">${list.map(roomCard).join('')}</div></section>`;}
  function roomCard(r){const disabled=!canPersonalize(r);return `<section class="staff-room ${disabled?'staff-room-passive':''}"><button ${disabled?'disabled':''} data-select-room="${r.id}" class="staff-room-main"><span class="room-title"><span class="dot ${isOnline(r)?'on':''}"></span><b>${esc(r.name)}</b><em>${esc(ROOM_MODE_LABEL[r.room_mode]||'기타')}</em></span><span class="muted">${esc(profileText(r))}</span></button>${activeSession(r)?`<button class="btn flat" data-end-session="${r.id}">기본 영상으로 복귀</button>`:''}</section>`;}
  function controlView(r){
    if(!canPersonalize(r))return `<div class="staff-control"><div class="page-head"><div><div class="eyebrow">${esc(r.group_name||'미분류')} · ${esc(r.name)}</div><h1>${esc(ROOM_MODE_LABEL[r.room_mode]||'공간')}</h1></div>${requestedRoomId?'':`<button id="backRooms" class="text-btn dark">공간 변경</button>`}</div><section class="panel"><h2>환자 맞춤 송출을 사용하지 않는 공간입니다.</h2><p class="muted">대기실/기타 공간은 관리자 그룹 송출 또는 기본 영상으로 운영합니다.</p></section></div>`;
    return `<div class="staff-control"><div class="page-head"><div><div class="eyebrow">${esc(r.group_name||'미분류')} · ${esc(r.name)} · ${esc(ROOM_MODE_LABEL[r.room_mode])}</div><h1>환자 맞춤 송출</h1></div>${requestedRoomId?'':`<button id="backRooms" class="text-btn dark">공간 변경</button>`}</div><section class="panel staff-current"><div><div class="section-label">현재</div><b>${esc(profileText(r))}</b></div><button id="endSession" class="btn" ${activeSession(r)?'':'disabled'}>기본 영상</button></section><section class="panel"><div class="panel-head"><div><h2>대상</h2><p>선택하지 않으면 전체입니다. 필요할 때만 한 번 누르세요.</p></div></div><div class="quick-picks">${AUDIENCES.map(a=>`<button class="quick-pick ${selectedAudience.id===a.id?'on':''}" data-audience="${a.id}">${esc(a.label)}</button>`).join('')}</div></section><section class="panel"><div class="panel-head"><div><h2>진료유형</h2><p>누르는 즉시 가장 적합한 영상이 자동 송출됩니다.</p></div></div><div class="treatment-grid">${TREATMENTS.map(([id,label])=>`<button class="treatment-pick" data-treatment="${id}" ${busy?'disabled':''}>${esc(label)}</button>`).join('')}</div>${broadcast?.active?'<p class="error staff-note">전체 송출 종료 후 자동 적용됩니다.</p>':''}</section></div>`;
  }
  function bindControl(){qs('#backRooms')?.addEventListener('click',()=>{selectedRoom=null;selectedAudience=AUDIENCES[0];render();});if(!canPersonalize(selectedRoom))return;qs('#endSession')?.addEventListener('click',()=>endSession(selectedRoom.id));qsa('[data-audience]').forEach(b=>b.addEventListener('click',()=>{selectedAudience=AUDIENCES.find(a=>a.id===b.dataset.audience)||AUDIENCES[0];render();}));qsa('[data-treatment]').forEach(b=>b.addEventListener('click',()=>startSession(b.dataset.treatment)));}
  async function startSession(treatment){if(!selectedRoom||busy)return;busy=true;render();const {error}=await db.rpc('start_patient_session',{p_room:selectedRoom.id,p_age_group:selectedAudience.age,p_gender:selectedAudience.gender,p_treatment:treatment});busy=false;if(error){toast(error.message,'error');render();return;}toast(broadcast?.active?'맞춤 송출 예약됨':'맞춤 송출 시작');if(!requestedRoomId){selectedRoom=null;selectedAudience=AUDIENCES[0];}await load({preserveSelection:Boolean(requestedRoomId)});}
  async function endSession(id){const {error}=await db.rpc('end_session',{p_room:id});if(error)toast(error.message,'error');else{toast('기본 영상으로 복귀');await load({preserveSelection:true});}}

  try{await load();}catch(e){qs('#staffRoot').innerHTML=`<p class="error">${esc(e.message||e)}</p>`;}
  setInterval(()=>load({preserveSelection:true}).catch(()=>{}),20000);
})();
