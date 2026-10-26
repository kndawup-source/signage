(async function () {
  'use strict';
  const { db, qs, qsa, esc, toast, formatDuration } = Signage;
  const auth=await Signage.requireAuth('staff');
  qs('#signOut').addEventListener('click', Signage.signOut);

  const AGE_OPTIONS=[['','전체'],['teen','10대 이하'],['20-30','20~30대'],['40-50','40~50대'],['60+','60대 이상']];
  const GENDER_OPTIONS=[['','전체'],['female','여성'],['male','남성']];
  const TREATMENTS=[['minish','미니쉬'],['implant','임플란트'],['whitening','미백'],['orthodontics','교정'],['checkup','검진'],['aftercare','수술 후 관리'],['general','일반 진료']];
  const CONTROL_MODES=[['remote','원격 제어'],['manual','수동 운영'],['hybrid','하이브리드']];
  const FLOOR_SPACE_TYPES=[['treatment','진료실'],['consultation','상담실'],['waiting','대기'],['lounge','라운지'],['reception','접수/안내'],['lobby','로비'],['staff','스탭'],['support','지원'],['public','공용'],['other','기타']];
  const FLOORPLAN_FLOORS=new Set([1,2,3,4,6,7,8,9,10,11,12,13,14]);
  let state={site:null,siteSettings:{},floorplanAssets:{},floorSpaces:[],floorplanVersions:[],patients:[],rooms:[],groups:[],playlists:[],videos:[],playlistItems:[],roomRules:[],broadcast:{active:false}}, busy=false, signalChannel=null,statusWakeChannel=null,settingsOpen=false,spaceEditorGroupId=null,selectedFloorId=null,tab='output';
  qsa('.nav-btn').forEach(b=>b.addEventListener('click',()=>{tab=b.dataset.tab||'output';qsa('.nav-btn').forEach(x=>x.classList.toggle('active',x===b));selectedFloorId=tab==='output'?selectedFloorId:null;render();}));
  const floorplanTextCache=new Map();
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
  function staffRoomVideoStripHtml(r){
    const ids=staffBaseIds(r).filter(Boolean);
    const videos=ids.map(id=>state.videos.find(v=>v.id===id)).filter(Boolean);
    if(!videos.length)return '<div class="floor-video-strip-empty">송출 예정 영상이 없습니다.</div>';
    return `<div class="floor-video-strip" aria-label="${esc(r.name)} 송출 영상">${videos.slice(0,12).map((v,i)=>`<div class="floor-video-thumb" title="${esc(v.title)}"><div>${staffThumb(v)}</div><small>${i+1}. ${esc(v.title)}</small></div>`).join('')}${videos.length>12?`<span class="floor-video-more">+${videos.length-12}</span>`:''}</div>`;
  }
  function roomBroadcastReason(r){
    const g=state.groups.find(x=>x.id===r.group_id)||null;
    const reason=String(g?.signage_reason||'').trim();
    if(reason)return reason;
    const purpose=String(g?.signage_purpose||'').trim();
    const target=String(g?.target_audience||'').trim();
    if(target&&purpose)return `${target}에게 ${purpose}을 위해 이 영상을 보여줍니다.`;
    if(purpose)return `${purpose}을 위해 이 영상을 보여줍니다.`;
    if(target)return `${target}에게 필요한 정보를 보여주기 위한 영상입니다.`;
    return `${r.name}에서 필요한 안내를 보여주기 위한 영상입니다.`;
  }
  function staffFloorRoomPreviewHtml(r){
    const status=roomDisplayStatus(r),current=currentVideoForRoom(r),isManual=displayControlMode(r)==='manual';
    const title=isManual?'현장 수동 운영':(current?.title||r.player_status?.title||'현재 재생 영상 없음');
    return `<div class="floor-room-focus"><div class="floor-room-focus-head"><div><span>${esc(roomTypeLabel(r.room_mode))}</span><b>${esc(r.name)}</b></div><em class="status-${status.key}">${esc(status.label)}</em></div><div class="floor-room-current"><div class="floor-room-current-thumb">${staffThumb(current)}</div><div class="floor-room-current-copy"><small>현재 영상</small><b>${esc(title)}</b></div></div><div class="floor-room-why"><small>왜 이 영상이 나오나요?</small><p>${esc(roomBroadcastReason(r))}</p></div><div class="floor-room-actions">${isManual?'':`<select data-staff-playlist="${r.id}">${playlistOptions(r.default_playlist_id||'')}</select><button type="button" class="btn primary" data-staff-playlist-apply="${r.id}">영상 바꾸기</button>`}<button type="button" class="text-btn dark floor-room-preview-open" data-staff-open-room-detail="${r.id}">상세 설정</button></div></div>`;
  }
  function staffOutputList(r){const items=staffRoomOutputItems(r);return `<div class="staff-output-list">${items.map((x,i)=>`<div class="staff-output-item ${x.rule?.enabled===false?'is-disabled':''}"><div class="staff-output-thumb">${staffThumb(x.video)}</div><b>${esc(x.video.title)}</b><label class="switch"><input type="checkbox" data-staff-video-toggle="${r.id}" data-video-id="${x.id}" ${x.rule?.enabled===false?'':'checked'} ${['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(String(r.player_status?.mode||''))?'disabled':''}><i></i></label><div><button data-staff-video-move="${r.id}" data-video-id="${x.id}" data-dir="-1" ${i===0?'disabled':''}>↑</button><button data-staff-video-move="${r.id}" data-video-id="${x.id}" data-dir="1" ${i===items.length-1?'disabled':''}>↓</button></div></div>`).join('')||'<span class="muted">재생 가능한 영상이 없습니다.</span>'}</div>`;}
  const displayControlMode=(r)=>String(r?.display_control_mode||'remote');
  const displayControlLabel=(r)=>CONTROL_MODES.find(([v])=>v===displayControlMode(r))?.[1]||'원격 제어';
  const roomHealth=(r)=>Signage.roomHealth(r,monitor.serverNow());
  const staffIsOnline=(r)=>displayControlMode(r)==='manual'?true:roomHealth(r)!=='offline';
  function roomDisplayStatus(r){
    const mode=displayControlMode(r);
    if(mode==='manual')return r.manual_check_status==='checked'?{key:'manual',label:'수동 운영'}:{key:'manual-warn',label:'수동 확인 필요'};
    const h=roomHealth(r),st=r.player_status||{},play=String(st.playback_state||'').toLowerCase(),ack=ackState.get(r.id);
    if(h==='offline')return {key:'offline',label:mode==='hybrid'?'원격 연결 끊김':'오프라인'};
    if(st.update_error||st.update_pending_version)return {key:'update',label:'업데이트 필요'};
    if(ack?.status==='error'||ack?.status==='unconfirmed'||h==='error'||h==='recovering'||st.error||st.offline_cache_error||Number(st.failed_video_count||0)>0)return {key:'error',label:'오류'};
    if(st.mode==='closed'||play==='closed'||r.paused||play==='paused'||ack?.status==='pending'||h==='delayed')return {key:'idle',label:'대기'};
    if(['playing','emergency'].includes(play))return {key:'live',label:'송출 중'};
    return {key:'idle',label:'대기'};
  }
  function roomIssueReason(r){const mode=displayControlMode(r);if(mode==='manual')return r.manual_check_status==='checked'?(r.manual_checked_at?`수동 확인 · ${new Date(r.manual_checked_at).toLocaleDateString('ko-KR')}`:'수동 확인 완료'):'현장 수동 확인 필요';const h=roomHealth(r),st=r.player_status||{},ack=ackState.get(r.id);if(h==='offline')return mode==='hybrid'?'원격 연결 끊김 · 수동 운영 가능':'플레이어 연결 끊김';if(st.update_error||st.update_pending_version)return '업데이트 필요';if(st.offline_cache_error)return '캐시 오류';if(Number(st.failed_video_count||0)>0)return `재생 실패 ${Number(st.failed_video_count||0)}개 건너뜀`;if(st.error)return String(st.error).slice(0,60);if(ack?.status==='error'||ack?.status==='unconfirmed')return '최근 변경 적용 확인 실패';if(st.mode==='closed')return '운영시간 외';return '';}
  const priorityLabel=(v)=>({broadcast:'전체',broadcast_schedule:'예약',manual:'개별',group:'층·구역',group_schedule:'예약',patient:'개별',session:'개별',default:'기본',emergency:'비상',closed:'운영시간 외'})[String(v||'').toLowerCase()]||'기본';
  function roomProblemRank(r){const k=roomDisplayStatus(r).key;return ({error:0,update:1,offline:2,'manual-warn':3,idle:4,manual:5,live:6})[k]??7;}
  function groupStatusSummary(rooms){
    const statuses=rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length,manual=statuses.filter(x=>x.key==='manual').length,manualNeedsCheck=statuses.filter(x=>x.key==='manual-warn').length;
    const issues=statuses.filter(x=>['error','update','offline','manual-warn'].includes(x.key)).length,online=rooms.filter(r=>displayControlMode(r)!=='manual'&&staffIsOnline(r)).length;
    let key='idle',label='대기';
    if(!rooms.length){label='공간 없음';}
    else if(offline===rooms.length-manual-manualNeedsCheck&&offline>0&&manual+manualNeedsCheck===0){key='offline';label='오프라인';}
    else if(issues>0){key='issue';label='확인 필요';}
    else if(live>0){key='live';label='송출 중';}
    else if(manual>0){key='manual';label='수동 운영';}
    return {live,offline,manual,manualNeedsCheck,issues,online,total:rooms.length,key,label};
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
    state={site:data.site||null,siteSettings:{floorplan_assets:data.floorplan_assets||{}},floorplanAssets:data.floorplan_assets||{},floorSpaces:data.spaces||[],floorplanVersions:data.floorplan_versions||[],patients:data.patients||[],rooms,groups:data.groups||[],playlists:data.playlists||[],videos:data.videos||[],playlistItems:data.playlist_items||[],roomRules:data.room_video_rules||[],broadcast:data.broadcast||{active:false}};
    const actualSlug=String(state.site?.slug||'').trim();
    if(actualSlug){const expected=`/hospital.html?site=${encodeURIComponent(actualSlug)}`;if(location.pathname!=='/hospital.html'||new URLSearchParams(location.search).get('site')!==actualSlug)history.replaceState(null,'',expected);}
    if(background&&isInteracting())return;
    renderPreservingUi(background);
  }
  function isInteracting(){
    const a=document.activeElement,root=qs('#hospitalRoot');
    return !!(a&&root&&root.contains(a)&&['INPUT','SELECT','TEXTAREA'].includes(a.tagName));
  }
  function uiKey(el){
    const card=el.closest('[data-room-card]')?.dataset.roomCard||el.closest('[data-staff-group]')?.dataset.staffGroup||'';
    return `${card}|${el.className}`;
  }
  function renderPreservingUi(keepInputs=true){
    const root=qs('#hospitalRoot');
    const openDetails=new Set(qsa('details[open]',root).map(uiKey));
    const openQuick=keepInputs?qsa('[data-quick-panel]:not(.hidden)',root).map(x=>x.dataset.quickPanel):[];
    const dirty=!keepInputs?[]:qsa('select[data-dirty="1"]',root).map(el=>{const attr=[...el.attributes].find(a=>a.name.startsWith('data-')&&a.name!=='data-dirty');return {sel:el.id?`#${el.id}`:attr?`[${attr.name}="${attr.value}"]`:null,value:el.value};}).filter(x=>x.sel);
    const scrollY=window.scrollY;
    render();
    qsa('details',root).forEach(d=>{if(openDetails.has(uiKey(d)))d.open=true;});
    openQuick.forEach(id=>qs(`[data-quick-panel="${id}"]`,root)?.classList.remove('hidden'));
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
  const FLOOR_DEFAULTS={1:{kind:'공용',name:'로비'},2:{kind:'공용',name:'종합안내·대기'},3:{kind:'일반진료',name:'일반진료'},4:{kind:'일반진료',name:'교정·임플란트'},5:{kind:'기타',name:'도면 미등록'},6:{kind:'지원',name:'기공실'},7:{kind:'MINISH',name:'예방·진료'},8:{kind:'MINISH',name:'진료센터 1'},9:{kind:'MINISH',name:'진료센터 2'},10:{kind:'MINISH',name:'진료센터 3'},11:{kind:'지원',name:'의국·사무'},12:{kind:'지원',name:'사무공간'},13:{kind:'공용',name:'식당'},14:{kind:'MINISH',name:'라운지'}};
  const FLOOR_GUIDES={
    1:{flow:'입구 → 접수·안내 → 엘리베이터',purpose:'첫 방문 안내와 병원 신뢰 형성',content:'병원 소개 · 진료 분야 · 이용 안내',exposure:'로비 · 접수 대기'},
    2:{flow:'접수·검사 → 대기 → 다음 진료 이동',purpose:'대기 중 정보 제공과 불안 완화',content:'치료 전 안내 · 자주 묻는 질문 · 케이스 소개',exposure:'대기공간 · 이동 동선'},
    3:{flow:'엘리베이터 → 대기 → 진료실',purpose:'진료 전 치료 이해도 높이기',content:'진료 과정 · 치료 전후 주의사항 · 케이스',exposure:'대기공간 · 진료실 앞'},
    4:{flow:'대기 → 상담 → 진료·검사',purpose:'교정·임플란트 치료 이해와 상담 보조',content:'치료 과정 · 장비/기술 설명 · 전후 관리',exposure:'상담 대기 · 진료실 앞'},
    5:{flow:'직원·내부 이동 중심',purpose:'공간 목적에 맞는 안내',content:'운영 안내 · 필요 콘텐츠',exposure:'주요 체류 지점'},
    6:{flow:'직원·기공 업무 동선',purpose:'내부 업무 지원과 공지',content:'업무 안내 · 교육 · 내부 공지',exposure:'업무 공간'},
    7:{flow:'엘리베이터 → 대기 → 진료실',purpose:'예방·진료 이해와 치료 준비',content:'예방 관리 · 치료 과정 · 주의사항',exposure:'대기공간 · 진료실 앞'},
    8:{flow:'대기 → 진료실 → 상담',purpose:'미니쉬 진료 이해와 신뢰 형성',content:'미니쉬 과정 · 케이스 · 치료 후 관리',exposure:'대기공간 · 진료실 앞'},
    9:{flow:'대기 → 진료실 → 상담',purpose:'미니쉬 진료 이해와 치료 선택 지원',content:'미니쉬 과정 · 전후 사례 · FAQ',exposure:'대기공간 · 진료실 앞'},
    10:{flow:'엘리베이터 → 대기 → 진료실',purpose:'치료 이해와 긴장 완화',content:'미니쉬 치료 과정 · 전후 관리 · 브랜드 신뢰',exposure:'대기공간 · 진료실 앞 · 상담실'},
    11:{flow:'의료진·직원 내부 이동',purpose:'내부 커뮤니케이션 지원',content:'교육 · 공지 · 운영 안내',exposure:'의국 · 공용 공간'},
    12:{flow:'직원 내부 이동',purpose:'업무 정보와 내부 공지 전달',content:'운영 공지 · 교육 · 캠페인',exposure:'사무 공용 공간'},
    13:{flow:'직원·방문객 식사 및 휴식',purpose:'휴식 공간 정보 제공',content:'병원 소식 · 캠페인 · 가벼운 브랜드 콘텐츠',exposure:'식당 · 휴게공간'},
    14:{flow:'상담·진료 후 → 라운지 → 퇴원/이동',purpose:'진료 후 신뢰 강화와 관리 안내',content:'치료 후 관리 · 브랜드 스토리 · 케이스',exposure:'라운지 · 상담 대기'}
  };
  const floorGuide=(g)=>FLOOR_GUIDES[floorNumber(g)]||{flow:'주요 이동 동선',purpose:'공간 목적에 맞는 영상 송출',content:'안내 · 치료 정보 · 운영 콘텐츠',exposure:'대기 및 주요 체류 지점'};

  function staffBuildingFloor(n,g){
    const rooms=g?g.rooms||state.rooms.filter(r=>r.group_id===g.id):[],st=g?groupStatusSummary(rooms):{key:'idle',issues:0,offline:0,live:0,total:0};
    const def=FLOOR_DEFAULTS[n]||{kind:'기타',name:'공간'},rawName=String(g?.name||'').trim(),shortName=(rawName&&!/^\d+$/.test(rawName))?rawName.replace(new RegExp(`^${n}\s*(층|F)?\s*`,'i'),'').trim():def.name;
    const status=!g?'미사용':st.issues?'확인 필요':st.offline?'연결 안 됨':'정상';
    const cls=`building-stack-floor floor-state-${st.key}${g?'':' is-unmanaged'}${selectedFloorId===g?.id?' is-selected':''}`;
    if(!g)return `<div class="${cls}" aria-hidden="true"><b>${n}F</b><span>${esc(shortName)}</span><em>${status}</em><i aria-hidden="true"></i></div>`;
    return `<button type="button" class="${cls}" data-staff-select-floor="${g.id}" aria-label="${n}층 ${esc(shortName)} ${esc(status)}"><b>${n}F</b><span>${esc(shortName)}</span><em>${esc(status)}</em><i aria-hidden="true"></i></button>`;
  }
  function staffFloorMarker(r){
    if(!roomMapPlaced(r))return '';
    const st=roomDisplayStatus(r),x=Number(r.map_x_pct),y=Number(r.map_y_pct);
    return `<button class="floor-display-pin control-${displayControlMode(r)} status-${st.key}" style="left:${x}%;top:${y}%" data-staff-floor-room="${r.id}" title="${esc(r.name)} · ${esc(st.label)}" aria-label="${esc(r.name)} · ${esc(st.label)}"><span class="display-screen-icon"></span><span class="floor-display-dot"></span></button>`;
  }
  function staffFloorPanelMarkup(g){
    if(!g)return `<section class="building-plan-pane is-empty"><div><h3>층을 선택하세요</h3><p>층을 누르면 도면과 디스플레이 위치가 바로 표시됩니다.</p></div></section>`;
    const rooms=g.rooms||state.rooms.filter(r=>r.group_id===g.id),sum=groupStatusSummary(rooms),asset=floorAsset(g),unplaced=rooms.filter(r=>!roomMapPlaced(r));
    const n=floorNumber(g),def=FLOOR_DEFAULTS[n]||{kind:'기타',name:'공간'};
    return `<section class="building-plan-pane"><div class="building-plan-head"><div><h3>${n?`${n}층`:esc(groupDisplayName(g.name))} · ${esc(g.name||def.name)}</h3><p>도면에서 디스플레이를 누르면 현재 영상과 송출 이유를 확인할 수 있습니다.</p></div><div class="building-plan-status"><span class="room-status-badge status-${sum.key}">${esc(sum.issues?'확인 필요':sum.offline?'연결 안 됨':'정상')}</span></div></div>${asset?`<div class="building-floorplan-wrap floor-activation-shell"><div class="floor-plan-stage building-floor-plan-stage is-floor-activating"><div class="floorplan-svg-host" data-floorplan-svg="${asset}"></div>${state.floorSpaces.filter(x=>x.group_id===g.id).map(x=>floorSpaceOverlay(x)).join('')}${rooms.map(staffFloorMarker).join('')}</div><div class="floor-zone-inspector building-zone-inspector" data-staff-floor-zone-inspector><div class="floor-zone-inspector-empty"><div><b>디스플레이를 선택하세요.</b></div><p>현재 영상과 왜 이 영상이 나오는지 바로 확인할 수 있습니다.</p></div></div></div>`:`<div class="floor-plan-empty floor-plan-empty-action"><b>도면이 없습니다.</b><span>병원 설정에서 이 층의 도면을 등록하세요.</span><button type="button" class="btn small" data-staff-open-settings>도면 등록</button></div>`}${unplaced.length?`<div class="building-plan-foot"><span>위치 미설정 ${unplaced.length}</span></div>`:''}</section>`;
  }
  function staffBuildingOverview(groups){
    const floorGroups=groups.filter(g=>floorNumber(g)>=1&&floorNumber(g)<=14),byFloor=new Map(floorGroups.map(g=>[floorNumber(g),g]));
    if(!selectedFloorId||!floorGroups.some(g=>g.id===selectedFloorId))selectedFloorId=(floorGroups.find(g=>groupStatusSummary(g.rooms).issues>0&&floorAsset(g))||floorGroups.find(g=>floorAsset(g))||floorGroups[0]||{}).id||null;
    const selected=floorGroups.find(g=>g.id===selectedFloorId)||null,issueFloors=floorGroups.filter(g=>groupStatusSummary(g.rooms).issues>0).length;
    const rows=Array.from({length:14},(_,i)=>14-i).map(n=>staffBuildingFloor(n,byFloor.get(n)||null)).join('');
    return `<section class="building-command-board hospital-building-command"><div class="building-command-head"><div><h2>층을 선택하세요</h2><p>확인할 층을 누르면 도면이 열립니다.</p></div></div><div class="building-command-grid"><aside class="building-nav-pane"><div class="building-floor-stack" role="list" aria-label="1층부터 14층까지 병원 송출 현황">${rows}</div></aside>${staffFloorPanelMarkup(selected)}</div></section>`;
  }


  function apiHeaders(){
    const session=Signage.getPinSession?.();
    return {'content-type':'application/json',...(session?.token?{'x-signage-session':session.token}:{})};
  }
  async function apiJson(path,options={}){
    const response=await fetch(path,{...options,headers:{...apiHeaders(),...(options.headers||{})}}),text=await response.text();
    let data={};try{data=text?JSON.parse(text):{};}catch{data={error:text||`HTTP ${response.status}`};}
    if(!response.ok)throw new Error(data.error||data.message||`HTTP ${response.status}`);return data;
  }
  function uploadByXhr(url,file,contentType,onProgress){return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('PUT',url,true);xhr.setRequestHeader('Content-Type',contentType);xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress?.(Math.round(e.loaded/e.total*100));};xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error(`도면 업로드 실패 · HTTP ${xhr.status}`));xhr.onerror=()=>reject(new Error('도면 업로드 네트워크 오류'));xhr.send(file);});}
  const floorplanMeta=(floor)=>state.floorplanAssets?.[String(Math.trunc(Number(floor)))]||null;
  const floorplanVersionsFor=(floor)=>state.floorplanVersions.filter(v=>Number(v.floor_number)===Number(floor)).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const floorAsset=(g)=>{const n=floorNumber(g);return n&&(FLOORPLAN_FLOORS.has(n)||floorplanMeta(n))?n:null;};
  const roomMapPlaced=(r)=>r?.map_x_pct!==null&&r?.map_x_pct!==undefined&&r?.map_y_pct!==null&&r?.map_y_pct!==undefined&&Number.isFinite(Number(r.map_x_pct))&&Number.isFinite(Number(r.map_y_pct));
  function floorSpaceOverlay(x,editable=false){return `<button type="button" class="floor-space-overlay ${editable?'is-editable':''}" data-floor-space="${x.id}" style="left:${Number(x.x_pct)}%;top:${Number(x.y_pct)}%;width:${Number(x.width_pct)}%;height:${Number(x.height_pct)}%"><span>${esc(x.name)}</span></button>`;}
  function displayMarker(r,editable=false){if(!roomMapPlaced(r))return '';const mode=displayControlMode(r);return `<button type="button" class="display-map-marker control-${mode} ${editable?'is-editable':''}" data-display-marker="${r.id}" style="left:${Number(r.map_x_pct)}%;top:${Number(r.map_y_pct)}%" title="${esc(r.name)} · ${esc(displayControlLabel(r))}" aria-label="${esc(r.name)} · ${esc(displayControlLabel(r))}"><i></i></button>`;}
  async function loadFloorplanSvgs(root=qs('#hospitalRoot')){
    const hosts=[...(root||document).querySelectorAll?.('[data-floorplan-svg]')||[]];
    await Promise.all(hosts.map(async host=>{const floor=Number(host.dataset.floorplanSvg);if(!floor||host.dataset.loaded==='1')return;try{const meta=floorplanMeta(floor),params=new URLSearchParams({floor:String(floor),v:'2.33.2'});if(meta?.key)params.set('key',meta.key);if(state.site?.id)params.set('siteId',state.site.id);const response=await fetch(`/api/floorplan?${params}`,{headers:apiHeaders(),cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);host.innerHTML=await response.text();host.dataset.loaded='1';}catch(_){host.innerHTML=`<span class="floor-plan-error">${floor}층 도면을 불러오지 못했습니다.</span>`;}}));
  }
  async function saveFloorplanAssets(next){const {error}=await db.rpc('staff_set_floorplan_assets',{p_assets:next});if(error)throw error;state.floorplanAssets=next;state.siteSettings={...state.siteSettings,floorplan_assets:next};floorplanTextCache.clear();}
  async function pruneFloorplanVersions(siteId,floor,keep=5){
    try{
      const {data,error}=await db.from('floorplan_versions').select('*').eq('site_id',siteId).eq('floor_number',floor).order('created_at',{ascending:false});
      if(error)throw error;const stale=(data||[]).slice(keep).filter(v=>!v.active);
      for(const v of stale){try{await apiJson('/api/floorplan-delete',{method:'POST',body:JSON.stringify({siteId,key:v.object_key})});}catch(e){console.warn('[floorplan] old version R2 cleanup failed',e);}await db.from('floorplan_versions').delete().eq('id',v.id);}
    }catch(e){console.warn('[floorplan] version pruning skipped',e);}
  }
  async function uploadFloorplan(floor,file){
    if(!state.site?.id)return toast('병원 정보가 없습니다.','error');
    const mime=String(file.type||'').toLowerCase();if(!['image/png','image/jpeg','image/webp'].includes(mime))return toast('PNG, JPG, WebP 도면만 업로드할 수 있습니다.','error');if(file.size>12*1024*1024)return toast('도면은 12MB 이하로 업로드하세요.','error');
    try{const signed=await apiJson('/api/floorplan-presign',{method:'POST',body:JSON.stringify({floor,filename:file.name,contentType:mime,size:file.size,siteId:state.site.id})});await uploadByXhr(signed.uploadUrl,file,mime);const next={...state.floorplanAssets,[String(floor)]:{key:signed.key,filename:file.name,mime,size:file.size,updated_at:new Date().toISOString()}};await db.from('floorplan_versions').update({active:false}).eq('site_id',state.site.id).eq('floor_number',floor);await db.from('floorplan_versions').insert({site_id:state.site.id,floor_number:floor,object_key:signed.key,filename:file.name,mime,size_bytes:file.size,active:true});await saveFloorplanAssets(next);await pruneFloorplanVersions(state.site.id,floor);toast(`${floor}층 도면을 저장했습니다.`);await load();}catch(e){toast(e.message||String(e),'error');}
  }
  async function resetFloorplan(floor){const old=floorplanMeta(floor);if(!old)return;if(!confirm(`${floor}층 업로드 도면을 기본/미등록 상태로 되돌릴까요?`))return;try{const next={...state.floorplanAssets};delete next[String(floor)];await saveFloorplanAssets(next);await db.from('floorplan_versions').update({active:false}).eq('site_id',state.site.id).eq('floor_number',floor);toast('현재 도면을 해제했습니다. 이전 버전은 보관됩니다.');await load();}catch(e){toast(e.message||String(e),'error');}}
  function floorplanAdminMarkup(){return `<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>층별 도면</b><small>각 층의 실제 도면을 업로드합니다. 이전 버전은 유지되어 되돌릴 수 있습니다.</small></div></div><div class="floorplan-admin-list">${Array.from({length:14},(_,i)=>14-i).map(f=>{const m=floorplanMeta(f),fallback=FLOORPLAN_FLOORS.has(f),versions=floorplanVersionsFor(f);return `<article class="floorplan-admin-row"><div class="floorplan-admin-copy"><b>${f}F</b><span>${m?'업로드 도면':fallback?'기본 도면':'도면 없음'}</span><small>${m?esc(m.filename||'사용자 도면'):'필요하면 직접 업로드하세요.'}${versions.length?` · 버전 ${versions.length}개`:''}</small></div><div class="floorplan-admin-actions"><label class="btn small floorplan-upload-btn"><input type="file" accept="image/png,image/jpeg,image/webp" data-staff-floorplan-upload="${f}"><span>${m?'교체':'업로드'}</span></label>${m?`<button class="btn small" type="button" data-staff-floorplan-reset="${f}">기본/없음</button>`:''}${versions.length>1?`<select class="compact-select" data-staff-floorplan-version="${f}">${versions.map(v=>`<option value="${v.id}" ${v.object_key===m?.key?'selected':''}>${esc(v.filename||'도면')} · ${new Date(v.created_at).toLocaleDateString('ko-KR')}</option>`).join('')}</select><button class="btn small" data-staff-floorplan-restore="${f}" type="button">복원</button>`:''}</div></article>`;}).join('')}</div></div>`;}
  function displaySetupMarkup(){
    const floors=[...state.groups].filter(g=>floorNumber(g)>0).sort((a,b)=>floorNumber(b)-floorNumber(a));
    return `<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>디스플레이 위치</b><small>운영 방식을 고르고 도면을 클릭하면 점으로 저장됩니다. 점을 드래그해 다시 옮길 수 있습니다.</small></div></div><div class="display-setup-list">${floors.map(g=>{const rooms=state.rooms.filter(r=>r.group_id===g.id),asset=floorAsset(g);if(!rooms.length)return '';return `<details class="display-setup-floor"><summary><span><b>${esc(g.name)}</b><small>디스플레이 ${rooms.length}대 · 위치 미설정 ${rooms.filter(r=>!roomMapPlaced(r)).length}대</small></span></summary><div class="display-setup-body"><div class="display-setup-toolbar"><label><span>디스플레이</span><select data-staff-map-room="${g.id}">${rooms.map(r=>`<option value="${r.id}">${esc(r.name)} · ${esc(displayControlLabel(r))}${roomMapPlaced(r)?' · 배치됨':' · 위치 미설정'}</option>`).join('')}</select></label><label><span>운영 방식</span><select data-staff-map-mode="${g.id}">${CONTROL_MODES.map(([v,l])=>`<option value="${v}" ${displayControlMode(rooms[0])===v?'selected':''}>${l}</option>`).join('')}</select></label><button class="btn small" type="button" data-staff-map-clear="${g.id}">선택 위치 지우기</button></div>${asset?`<div class="settings-map-stage display-setup-stage" data-staff-map-stage="${g.id}"><div class="floorplan-svg-host" data-floorplan-svg="${asset}"></div>${state.floorSpaces.filter(x=>x.group_id===g.id).map(x=>floorSpaceOverlay(x)).join('')}${rooms.map(r=>displayMarker(r,true)).join('')}</div>`:'<div class="floor-plan-empty">도면을 먼저 업로드하세요.</div>'}</div></details>`;}).join('')}</div></div>`;
  }
  function floorSpaceManagerMarkup(){
    const floors=[...state.groups].filter(g=>floorNumber(g)>0).sort((a,b)=>floorNumber(b)-floorNumber(a));if(!floors.length)return '';
    const current=floors.find(g=>g.id===spaceEditorGroupId)||floors[0];spaceEditorGroupId=current.id;const spaces=state.floorSpaces.filter(x=>x.group_id===current.id),asset=floorAsset(current);
    return `<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>공간 구분</b><small>도면 위에서 드래그해 진료실·대기실·라운지 등 운영 공간을 사각형으로 지정합니다.</small></div></div><div class="floor-space-toolbar"><label><span>층</span><select id="staffSpaceFloor">${floors.map(g=>`<option value="${g.id}" ${g.id===current.id?'selected':''}>${esc(g.name)}</option>`).join('')}</select></label><label><span>공간명</span><input id="staffSpaceName" maxlength="40" placeholder="예: 진료실 1"></label><label><span>유형</span><select id="staffSpaceType">${FLOOR_SPACE_TYPES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label></div>${asset?`<div class="settings-map-stage floor-space-stage" data-staff-space-stage="${current.id}"><div class="floorplan-svg-host" data-floorplan-svg="${asset}"></div>${spaces.map(x=>floorSpaceOverlay(x,true)).join('')}</div>`:'<div class="floor-plan-empty">도면을 먼저 업로드하세요.</div>'}<div class="floor-space-list">${spaces.map(x=>`<div><span><b>${esc(x.name)}</b><small>${esc(FLOOR_SPACE_TYPES.find(([v])=>v===x.space_type)?.[1]||'기타')}</small></span><button class="text-action danger-text" data-staff-delete-space="${x.id}">삭제</button></div>`).join('')||'<span class="muted">지정한 공간이 없습니다.</span>'}</div></div>`;
  }
  function hospitalSetupProgress(){const custom=Object.values(state.floorplanAssets||{}).filter(x=>x?.key).length,spaces=state.floorSpaces.length,total=state.rooms.length,placed=state.rooms.filter(roomMapPlaced).length;const steps=[['병원 정보',!!state.site?.name&&!!state.site?.building_label],['도면',custom>0],['공간',spaces>0],['디스플레이',total>0&&placed===total]];const done=steps.filter(x=>x[1]).length;return `<div class="hospital-setup-progress"><div><b>초기 설치</b><span>${done}/${steps.length} 완료</span></div><div>${steps.map(([l,ok],i)=>`<span class="${ok?'is-done':''}"><i>${ok?'✓':i+1}</i>${l}</span>`).join('')}</div></div>`;}
  function hospitalPlaylistManagerMarkup(){
    const own=state.playlists.filter(p=>p.site_id===state.site?.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
    return `<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>병원 플레이리스트</b><small>본사/공용 영상을 조합해 이 병원에서만 사용하는 재생목록을 만듭니다.</small></div></div><div class="site-playlist-manager"><label class="field"><span>플레이리스트</span><select id="staffPlaylistSelect"><option value="">새 플레이리스트</option>${own.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label class="field"><span>이름</span><input id="staffPlaylistName" maxlength="60" placeholder="예: 대기실 기본 영상"></label><label class="field site-playlist-videos"><span>영상 선택 · Ctrl/⌘ 또는 터치로 여러 개 선택</span><select id="staffPlaylistVideos" multiple size="7">${state.videos.filter(v=>v.active).map(v=>`<option value="${v.id}">${esc(v.title)}</option>`).join('')}</select></label><div class="inline"><button id="staffSavePlaylist" class="btn primary" type="button">저장</button><button id="staffDeletePlaylist" class="btn danger-outline" type="button" disabled>삭제</button></div></div></div>`;
  }
  function fillHospitalPlaylistEditor(){const id=qs('#staffPlaylistSelect')?.value||'',p=state.playlists.find(x=>x.id===id);const name=qs('#staffPlaylistName'),videos=qs('#staffPlaylistVideos'),del=qs('#staffDeletePlaylist');if(name)name.value=p?.name||'';if(del)del.disabled=!p;if(videos){const ids=new Set((p?state.playlistItems.filter(x=>x.playlist_id===p.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(x=>x.video_id):[]));[...videos.options].forEach(o=>o.selected=ids.has(o.value));}}
  async function saveHospitalPlaylist(){const id=qs('#staffPlaylistSelect')?.value||null,name=(qs('#staffPlaylistName')?.value||'').trim(),videoIds=[...(qs('#staffPlaylistVideos')?.selectedOptions||[])].map(o=>o.value);if(!name)return toast('플레이리스트 이름을 입력하세요.','error');if(!videoIds.length)return toast('영상은 1개 이상 선택하세요.','error');const {error}=await db.rpc('staff_save_site_playlist',{p_id:id,p_name:name,p_video_ids:videoIds});if(error)return toast(error.message,'error');toast('병원 플레이리스트를 저장했습니다.');await load();}
  async function deleteHospitalPlaylist(){const id=qs('#staffPlaylistSelect')?.value;if(!id||!confirm('이 병원 플레이리스트를 삭제할까요?'))return;const {error}=await db.rpc('staff_delete_site_playlist',{p_id:id});if(error)return toast(error.message,'error');toast('병원 플레이리스트를 삭제했습니다.');await load();}
  function hospitalSettingsPageMarkup(){const site=state.site||{};return `<section class="hospital-admin-settings-page">${hospitalSetupProgress()}<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>병원 정보</b><small>이 병원의 관리자 화면 이름입니다.</small></div></div><div class="grid-2"><label class="field"><span>병원명</span><input id="staffSiteName" maxlength="60" value="${esc(site.name||'')}"></label><label class="field"><span>건물명</span><input id="staffBuildingLabel" maxlength="60" value="${esc(site.building_label||'')}"></label></div><button id="staffSaveSiteIdentity" class="btn primary" type="button">저장</button></div>${floorplanAdminMarkup()}${floorSpaceManagerMarkup()}${displaySetupMarkup()}</section>`;}
  function hospitalVideosPageMarkup(){return `<section class="hospital-content-page"><div class="page-head compact"><div><span class="eyebrow">VIDEOS</span><h2>영상</h2><p>이 병원에서 사용하는 플레이리스트만 관리합니다.</p></div></div>${hospitalPlaylistManagerMarkup()}</section>`;}
  async function saveHospitalIdentity(){const name=(qs('#staffSiteName')?.value||'').trim(),building=(qs('#staffBuildingLabel')?.value||'').trim();if(!name||!building)return toast('병원명과 건물명을 입력하세요.','error');const {error}=await db.rpc('staff_update_site_identity',{p_name:name,p_building_label:building});if(error)return toast(error.message,'error');toast('병원 정보를 저장했습니다.');await load();}
  async function saveDisplaySetup(roomId,x,y,mode){const r=state.rooms.find(x=>x.id===roomId);if(!r)return;const useMode=mode||displayControlMode(r);const {error}=await db.rpc('staff_set_display_setup',{p_room:roomId,p_mode:useMode,p_x:x,p_y:y,p_note:r.display_note||null});if(error)return toast(error.message,'error');r.map_x_pct=x;r.map_y_pct=y;r.display_control_mode=useMode;if(useMode==='manual'&&r.manual_check_status==='not_required')r.manual_check_status='needs_check';render();}
  function bindDisplaySetup(){
    qsa('[data-staff-map-stage]').forEach(stage=>stage.addEventListener('click',e=>{if(e.target.closest('[data-display-marker]'))return;const gid=stage.dataset.staffMapStage,select=qs(`[data-staff-map-room="${gid}"]`),mode=qs(`[data-staff-map-mode="${gid}"]`)?.value,roomId=select?.value;if(!roomId)return;const rect=stage.getBoundingClientRect(),x=Math.max(0,Math.min(100,(e.clientX-rect.left)/rect.width*100)),y=Math.max(0,Math.min(100,(e.clientY-rect.top)/rect.height*100));saveDisplaySetup(roomId,x,y,mode);}));
    qsa('[data-staff-map-room]').forEach(sel=>sel.addEventListener('change',()=>{const r=roomById(sel.value),gid=sel.dataset.staffMapRoom,m=qs(`[data-staff-map-mode="${gid}"]`);if(r&&m)m.value=displayControlMode(r);}));
    qsa('[data-staff-map-mode]').forEach(sel=>sel.addEventListener('change',()=>{const roomId=qs(`[data-staff-map-room="${sel.dataset.staffMapMode}"]`)?.value,r=roomById(roomId);if(r)saveDisplaySetup(roomId,r.map_x_pct,r.map_y_pct,sel.value);}));
    qsa('[data-staff-map-clear]').forEach(b=>b.addEventListener('click',()=>{const id=qs(`[data-staff-map-room="${b.dataset.staffMapClear}"]`)?.value;if(id)saveDisplaySetup(id,null,null,displayControlMode(roomById(id)));}));
    qsa('[data-display-marker]').forEach(marker=>marker.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();const stage=marker.closest('[data-staff-map-stage]');if(!stage)return;marker.setPointerCapture?.(e.pointerId);const move=ev=>{const rect=stage.getBoundingClientRect(),x=Math.max(0,Math.min(100,(ev.clientX-rect.left)/rect.width*100)),y=Math.max(0,Math.min(100,(ev.clientY-rect.top)/rect.height*100));marker.style.left=`${x}%`;marker.style.top=`${y}%`;};const up=ev=>{marker.removeEventListener('pointermove',move);marker.removeEventListener('pointerup',up);const rect=stage.getBoundingClientRect(),x=Math.max(0,Math.min(100,(ev.clientX-rect.left)/rect.width*100)),y=Math.max(0,Math.min(100,(ev.clientY-rect.top)/rect.height*100));saveDisplaySetup(marker.dataset.displayMarker,x,y,displayControlMode(roomById(marker.dataset.displayMarker)));};marker.addEventListener('pointermove',move);marker.addEventListener('pointerup',up);}));
  }
  function bindFloorSpaceManager(){
    qs('#staffSpaceFloor')?.addEventListener('change',e=>{spaceEditorGroupId=e.target.value;settingsOpen=true;render();});
    qsa('[data-staff-delete-space]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('공간 구분을 삭제할까요?'))return;const {error}=await db.from('floor_spaces').delete().eq('id',b.dataset.staffDeleteSpace);if(error)return toast(error.message,'error');await load();}));
    const stage=qs('[data-staff-space-stage]');if(!stage)return;let start=null,preview=null;
    stage.addEventListener('pointerdown',e=>{if(e.target.closest('[data-floor-space]'))return;const name=(qs('#staffSpaceName')?.value||'').trim();if(!name)return toast('공간명을 먼저 입력하세요.','error');const rect=stage.getBoundingClientRect();start={x:Math.max(0,Math.min(100,(e.clientX-rect.left)/rect.width*100)),y:Math.max(0,Math.min(100,(e.clientY-rect.top)/rect.height*100))};preview=document.createElement('div');preview.className='floor-space-draft';stage.appendChild(preview);stage.setPointerCapture?.(e.pointerId);});
    stage.addEventListener('pointermove',e=>{if(!start||!preview)return;const rect=stage.getBoundingClientRect(),x=Math.max(0,Math.min(100,(e.clientX-rect.left)/rect.width*100)),y=Math.max(0,Math.min(100,(e.clientY-rect.top)/rect.height*100)),l=Math.min(start.x,x),t=Math.min(start.y,y),w=Math.abs(x-start.x),h=Math.abs(y-start.y);Object.assign(preview.style,{left:`${l}%`,top:`${t}%`,width:`${w}%`,height:`${h}%`});});
    stage.addEventListener('pointerup',async e=>{if(!start)return;const rect=stage.getBoundingClientRect(),x=Math.max(0,Math.min(100,(e.clientX-rect.left)/rect.width*100)),y=Math.max(0,Math.min(100,(e.clientY-rect.top)/rect.height*100)),l=Math.min(start.x,x),t=Math.min(start.y,y),w=Math.abs(x-start.x),h=Math.abs(y-start.y);preview?.remove();preview=null;start=null;if(w<2||h<2)return toast('공간 영역을 조금 더 크게 드래그하세요.','error');const name=(qs('#staffSpaceName')?.value||'').trim(),type=qs('#staffSpaceType')?.value||'other',groupId=stage.dataset.staffSpaceStage;const {error}=await db.from('floor_spaces').insert({site_id:state.site.id,group_id:groupId,name,space_type:type,x_pct:l,y_pct:t,width_pct:w,height_pct:h});if(error)return toast(error.message,'error');toast('공간을 저장했습니다.');await load();});
  }
  async function restoreHospitalFloorplan(floor){const id=qs(`[data-staff-floorplan-version="${floor}"]`)?.value,v=state.floorplanVersions.find(x=>x.id===id);if(!v)return;try{const next={...state.floorplanAssets,[String(floor)]:{key:v.object_key,filename:v.filename,mime:v.mime,size:Number(v.size_bytes||0),updated_at:new Date().toISOString()}};await db.from('floorplan_versions').update({active:false}).eq('site_id',state.site.id).eq('floor_number',floor);await db.from('floorplan_versions').update({active:true}).eq('id',v.id);await saveFloorplanAssets(next);toast(`${floor}층 도면을 복원했습니다.`);await load();}catch(e){toast(e.message||String(e),'error');}}
  function bindHospitalAdminSettings(){
    const details=qs('.hospital-admin-settings');
    qs('#staffSaveSiteIdentity')?.addEventListener('click',saveHospitalIdentity);
    qs('#staffPlaylistSelect')?.addEventListener('change',fillHospitalPlaylistEditor);
    qs('#staffSavePlaylist')?.addEventListener('click',saveHospitalPlaylist);
    qs('#staffDeletePlaylist')?.addEventListener('click',deleteHospitalPlaylist);
    fillHospitalPlaylistEditor();
    qsa('[data-staff-floorplan-upload]').forEach(input=>input.addEventListener('change',()=>{const f=input.files?.[0];if(f)uploadFloorplan(Number(input.dataset.staffFloorplanUpload),f);input.value='';}));
    qsa('[data-staff-floorplan-reset]').forEach(b=>b.addEventListener('click',()=>resetFloorplan(Number(b.dataset.staffFloorplanReset))));
    qsa('[data-staff-floorplan-restore]').forEach(b=>b.addEventListener('click',()=>restoreHospitalFloorplan(Number(b.dataset.staffFloorplanRestore))));
    bindFloorSpaceManager();bindDisplaySetup();if(tab==='settings')loadFloorplanSvgs(qs('#hospitalRoot')).catch(()=>{});
  }


  function render(){
    const statuses=state.rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length;
    const issues=statuses.filter(x=>['error','update','offline','manual-warn'].includes(x.key)).length;
    const groups=groupedRooms();
    qsa('.nav-btn').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
    const head=`<div class="reception-head reception-head-board hospital-simple-head"><div><span class="eyebrow">HOSPITAL ADMIN</span><h1>${esc(state.site?.name||'병원')}</h1><p>${tab==='output'?'층을 선택하고 도면에서 디스플레이를 눌러 현재 영상과 송출 이유를 확인합니다.':tab==='videos'?'이 병원에서 사용할 영상을 묶어 플레이리스트를 관리합니다.':'병원 정보와 도면, 디스플레이 위치를 설정합니다.'}</p></div>${tab==='output'?'<button id="staffStatusRefresh" class="btn">새로고침</button>':''}</div>`;
    let content='';
    if(tab==='output')content=`${issues?`<div class="hospital-issue-notice"><b>확인이 필요한 디스플레이 ${issues}대</b><span>${offline?`연결 안 됨 ${offline}대 포함`:''}</span></div>`:''}${staffBuildingOverview(groups)}<details class="staff-space-detail-drawer"><summary><span><b>상세 관리</b><small>영상 순서나 세부 제어가 필요할 때만 엽니다.</small></span><em>${live}곳 송출 중</em></summary><div class="staff-space-detail-body"><div class="staff-monitor-groups">${groups.map(groupCard).join('')}</div></div></details>`;
    else if(tab==='videos')content=hospitalVideosPageMarkup();
    else content=hospitalSettingsPageMarkup();
    qs('#hospitalRoot').innerHTML=`${state.broadcast?.active&&tab==='output'?'<div class="broadcast-strip">전체 송출 중입니다.</div>':''}${head}${content}`;
    bind();
    loadFloorplanSvgs(qs('#hospitalRoot')).catch(()=>{});
  }

  function groupCard(group){
    const summary=groupStatusSummary(group.rooms),nowText=summary.key==='live'?`${summary.live}곳 송출 중`:summary.key==='issue'?`문제 공간 ${summary.issues}곳`:summary.key==='offline'?'모든 공간 연결 끊김':summary.key==='idle'?'현재 재생 대기':'현재 상태 확인';
    return `<details class="monitor-group staff-monitor-group group-state-${summary.key}" data-staff-group="${esc(group.id)}"><summary class="monitor-group-summary"><div class="monitor-group-overview"><div class="monitor-group-title-row"><h2>${esc(groupDisplayName(group.name))}</h2><span class="floor-type-label">${esc(careTypeLabel(group.care_type))}</span><span class="group-status-badge status-${summary.key}" data-staff-group-status>${esc(summary.label)}</span></div><p class="floor-purpose-summary">${esc(group.signage_purpose||'송출 목적 미설정')}</p><div class="group-metric-row"><span>공간 <b data-staff-group-total>${summary.total}</b></span><span>송출 <b data-staff-group-live>${summary.live}</b></span><span>원격 정상 <b data-staff-group-online>${summary.online}</b></span><span>수동 <b>${summary.manual+summary.manualNeedsCheck}</b></span><span>문제 <b data-staff-group-issues>${summary.issues}</b></span></div><p data-staff-group-summary>${esc(nowText)}${group.target_audience?` · 대상 ${esc(group.target_audience)}`:''}</p></div><span class="group-detail-link">상세보기</span></summary><div class="monitor-group-body">${group.waiting_area_note?`<div class="floor-reason-note"><b>고객 대기공간</b><span>${esc(group.waiting_area_note)}</span></div>`:''}${group.signage_reason?`<div class="floor-reason-note"><b>왜 송출하나요?</b><span>${esc(group.signage_reason)}</span></div>`:''}<div class="monitor-room-grid staff-monitor-room-grid">${[...group.rooms].sort((a,b)=>roomProblemRank(a)-roomProblemRank(b)||(a.sort_order||0)-(b.sort_order||0)).map(roomCard).join('')}</div></div></details>`;
  }

  function roomCard(r){
    const p=patientForRoom(r.id),quick=isQuickSession(r),st=r.player_status||{},display=roomDisplayStatus(r),health=roomHealth(r),current=st.title||'대기 중',next=st.next_title||'',activeTreatment=p?.treatment||r.session_treatment||'';
    const audience=[p?.age_group||r.session_age_group,p?.gender||r.session_gender].filter(Boolean).map((v,i)=>i===0?ageLabel(v):genderLabel(v)).filter(x=>x!=='전체').join(' · '),manual=!!r.manual_active&&Array.isArray(r.manual_video_ids)&&r.manual_video_ids.length>0,defaultPlaylist=playlistById(r.default_playlist_id),currentVideo=currentVideoForRoom(r),on=staffIsOnline(r);
    const progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'';
    return `<details class="monitor-room staff-monitor-room health-${health}" data-room-card="${r.id}" data-health="${health}"><summary><div class="monitor-room-top"><div class="monitor-room-name"><span data-staff-live-dot class="dot ${on?'on':''}"></span><b>${esc(r.name)}</b></div><span class="room-status-badge status-${display.key}" data-staff-room-status>${esc(display.label)}</span></div><div class="monitor-current-thumb" data-staff-live-thumb>${staffThumb(currentVideo)}</div><div class="monitor-now"><span>우선순위 · ${esc(priorityLabel(st.priority||st.mode))}</span><b data-staff-live-title>${esc(current)}</b><small data-staff-live-detail>${displayControlMode(r)==='manual'?esc(roomIssueReason(r)):(on?`${esc(playbackLabel(st.playback_state))}${progress?` · ${progress}`:''}${roomIssueReason(r)?` · ${esc(roomIssueReason(r))}`:''}`:'오프라인 · 플레이어 연결 끊김')}</small></div><div class="monitor-next"><span>다음</span><b data-staff-live-next>${esc(next||'—')}</b></div><div class="monitor-card-foot"><span>${esc(roomTypeLabel(r.room_mode))}${manual?' · 개별 영상':activeTreatment?` · ${esc(treatmentLabel(activeTreatment))}`:defaultPlaylist?` · ${esc(defaultPlaylist.name)}`:''}</span><b>관리</b></div></summary><div class="monitor-room-controls staff-room-control-body">
      ${audience?`<div class="room-output-note">맞춤 대상 · ${esc(audience)}</div>`:''}
      ${displayControlMode(r)==='manual'?`<div class="manual-display-panel"><b>수동 디스플레이</b><p>${esc(r.display_note||'현장에서 직접 영상 재생 상태를 확인합니다.')}</p><button class="btn ${r.manual_check_status==='checked'?'':'primary'}" data-manual-check="${r.id}">${r.manual_check_status==='checked'?'미확인으로 변경':'오늘 확인 완료'}</button></div>`:`<details class="staff-output-details"><summary>송출 영상 목록</summary>${staffOutputList(r)}</details><div class="staff-output-controls"><div class="staff-output-row"><span>플레이리스트</span><select data-staff-playlist="${r.id}">${playlistOptions(r.default_playlist_id||'')}</select><button class="btn primary" data-staff-playlist-apply="${r.id}">변경</button></div><div class="staff-output-row"><span>영상 추가</span><select data-staff-video="${r.id}">${videoOptions()}</select><button class="btn" data-staff-video-add="${r.id}">추가</button>${manual?`<button class="btn" data-staff-manual-clear="${r.id}">기본으로</button>`:''}</div></div>`}
      ${p?`<div class="room-patient compact"><b>${esc(p.label||`대기 ${p.queue_no}`)}</b><span>${esc(waitText(p))}</span></div>`:''}
      ${displayControlMode(r)!=='manual'&&isPatientRoom(r)?`<div class="room-card-actions">${!p?`<button class="btn" data-open-quick="${r.id}">${quick?'맞춤 변경':'환자 맞춤'}</button>${quick?`<button class="btn" data-quick-clear="${r.id}">맞춤 해제</button>`:''}`:'<span class="room-managed-note">환자 관리에서 변경</span>'}</div>${!p?quickPanel(r):''}`:''}
    </div></details>`;
  }

  function quickPanel(r){
    return `<div class="quick-room-panel hidden" data-quick-panel="${r.id}">
      <div class="quick-room-head"><b>맞춤 영상</b><button class="text-btn dark" data-close-quick="${r.id}">닫기</button></div>
      <div class="quick-treatment-grid">${TREATMENTS.map(([v,l])=>`<button class="quick-treatment ${r.session_treatment===v?'on':''}" data-quick-treatment="${v}" data-room="${r.id}">${l}</button>`).join('')}</div>
      <details class="quick-detail"><summary>연령·성별도 설정</summary><div class="quick-detail-grid"><label class="field"><span>연령</span><select data-quick-age="${r.id}">${AGE_OPTIONS.map(([v,l])=>`<option value="${v}" ${r.session_age_group===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="field"><span>성별</span><select data-quick-gender="${r.id}">${GENDER_OPTIONS.map(([v,l])=>`<option value="${v}" ${r.session_gender===v?'selected':''}>${l}</option>`).join('')}</select></label></div><p>연령·성별을 선택한 뒤 진료유형을 누르면 함께 적용됩니다.</p></details>
    </div>`;
  }


  async function markManualChecked(roomId){const r=roomById(roomId);if(!r)return;const checked=r.manual_check_status!=='checked';const {error}=await db.rpc('staff_mark_manual_display_checked',{p_room:roomId,p_checked:checked});if(error)return toast(error.message,'error');toast(checked?'수동 디스플레이 확인 완료':'미확인 상태로 변경했습니다.');await load();}

  function bind(){
    bindHospitalAdminSettings();
    qs('#staffStatusRefresh')?.addEventListener('click',()=>load().catch(e=>toast(e.message||String(e),'error')));qsa('[data-staff-open-settings]').forEach(b=>b.addEventListener('click',()=>{tab='settings';qsa('.nav-btn').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));renderPreservingUi(false);}));qsa('[data-staff-select-floor]').forEach(b=>{const open=()=>{selectedFloorId=b.dataset.staffSelectFloor;renderPreservingUi(false);};b.addEventListener('click',open);b.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});});qsa('[data-staff-floor-room]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.staffFloorRoom,r=state.rooms.find(x=>x.id===id),inspector=qs('[data-staff-floor-zone-inspector]');if(r&&inspector){inspector.innerHTML=staffFloorRoomPreviewHtml(r);qsa('[data-staff-floor-room]').forEach(x=>x.classList.toggle('is-selected',x.dataset.staffFloorRoom===id));const open=qs('[data-staff-open-room-detail]',inspector);if(open)open.addEventListener('click',()=>{const drawer=qs('.staff-space-detail-drawer');if(drawer)drawer.open=true;requestAnimationFrame(()=>{const el=qs(`[data-room-card="${id}"]`);if(el){el.open=true;el.scrollIntoView({behavior:'smooth',block:'center'});}});});}}));
    qsa('#hospitalRoot select').forEach(el=>el.addEventListener('change',()=>{el.dataset.dirty='1';}));
    qsa('[data-staff-playlist-apply]').forEach(b=>b.addEventListener('click',()=>setRoomPlaylist(b.dataset.staffPlaylistApply)));
    qsa('[data-staff-video-add]').forEach(b=>b.addEventListener('click',()=>addRoomVideo(b.dataset.staffVideoAdd)));
    qsa('[data-staff-manual-clear]').forEach(b=>b.addEventListener('click',()=>clearRoomManual(b.dataset.staffManualClear)));
    qsa('[data-manual-check]').forEach(b=>b.addEventListener('click',()=>markManualChecked(b.dataset.manualCheck)));
    qsa('[data-staff-video-toggle]').forEach(i=>i.addEventListener('change',()=>staffToggleVideo(i.dataset.staffVideoToggle,i.dataset.videoId,i.checked)));
    qsa('[data-staff-video-move]').forEach(b=>b.addEventListener('click',()=>staffMoveVideo(b.dataset.staffVideoMove,b.dataset.videoId,Number(b.dataset.dir))));
    qsa('[data-open-quick]').forEach(b=>b.addEventListener('click',()=>qs(`[data-quick-panel="${b.dataset.openQuick}"]`)?.classList.remove('hidden')));
    qsa('[data-close-quick]').forEach(b=>b.addEventListener('click',()=>qs(`[data-quick-panel="${b.dataset.closeQuick}"]`)?.classList.add('hidden')));
    qsa('[data-quick-treatment]').forEach(b=>b.addEventListener('click',()=>quickSet(b.dataset.room,b.dataset.quickTreatment)));
    qsa('[data-quick-clear]').forEach(b=>b.addEventListener('click',()=>quickClear(b.dataset.quickClear)));
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
    const title=qs('[data-staff-live-title]',card);if(title)title.textContent=displayControlMode(r)==='manual'?'현장 수동 운영':(st.title||'대기 중');
    const next=qs('[data-staff-live-next]',card);if(next)next.textContent=st.next_title||'—';
    const detail=qs('[data-staff-live-detail]',card);if(detail)detail.textContent=displayControlMode(r)==='manual'?roomIssueReason(r):(on?`${playbackLabel(st.playback_state)}${progress?` · ${progress}`:''}${roomIssueReason(r)?` · ${roomIssueReason(r)}`:''}`:'오프라인 · 플레이어 연결 끊김');
  }
  function paintStaffSummary(){
    const statuses=state.rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length,issues=statuses.filter(x=>['error','update','offline','manual-warn'].includes(x.key)).length;
    const set=(sel,val)=>{const el=qs(sel);if(el)el.textContent=String(val);};set('[data-staff-stat-total]',state.rooms.length);set('[data-staff-stat-live]',live);set('[data-staff-stat-issues]',issues);set('[data-staff-stat-offline]',offline);set('[data-staff-stat-online]',state.rooms.filter(r=>displayControlMode(r)!=='manual'&&staffIsOnline(r)).length);
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
    try{applyLiveResult(await monitor.fetchStatus({roomIds:[roomId]}));}catch(e){console.warn('Clinic Signage hospital room status refresh failed:',e?.message||e);}
  }
  function queueLiveRoomRefresh(roomId){
    if(!roomId||!roomById(roomId))return;clearTimeout(statusWakeTimers.get(roomId));
    statusWakeTimers.set(roomId,setTimeout(()=>{statusWakeTimers.delete(roomId);void refreshLiveRoom(roomId);},80));
  }
  function startRealtime(){
    // Control changes reload staff configuration. Status changes wake a one-room RPC refresh;
    // the 30s delta poll remains only as loss recovery.
    try{
      signalChannel=db.channel('clinic-hospital-signal-v23319').on('postgres_changes',{event:'*',schema:'public',table:'player_control_signals'},scheduleStaffStateReload).subscribe();
      statusWakeChannel=db.channel('clinic-signage-status')
        .on('broadcast',{event:'changed'},({payload})=>queueLiveRoomRefresh(payload?.room_id))
        .subscribe();
    }catch(_){}
  }

  try{await load();startRealtime();monitor.start(Signage.cfg.livePollMs);}catch(e){qs('#hospitalRoot').innerHTML=`<p class="error">${esc(e.message||e)}</p>`;}
  const uiTimer=setInterval(()=>{if(document.hidden)return;state.rooms.forEach(updateStaffRoomDom);paintStaffSummary();},1000);
  window.addEventListener('beforeunload',()=>{clearInterval(uiTimer);clearTimeout(stateReloadTimer);statusWakeTimers.forEach(clearTimeout);monitor.stop();try{if(signalChannel)db.removeChannel(signalChannel);if(statusWakeChannel)db.removeChannel(statusWakeChannel);}catch(_){}});
})();
