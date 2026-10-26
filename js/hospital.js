(async function () {
  'use strict';
  const { db, qs, qsa, esc, toast, formatDuration } = Signage;
  const auth=await Signage.requireAuth();
  if(!['admin','staff'].includes(auth.role)){location.replace('/');return;}
  qs('#signOut').addEventListener('click', Signage.signOut);
  const requestedSiteCode=new URLSearchParams(location.search).get('site')||'';
  let targetSiteId=auth.session?.site_id||null;
  if(auth.role==='admin'){
    if(!requestedSiteCode){location.replace('/admin.html');return;}
    const {data:target,error:targetError}=await db.from('sites').select('id,code,name').eq('code',requestedSiteCode).maybeSingle();
    if(targetError||!target?.id){location.replace('/admin.html');return;}
    targetSiteId=target.id;
    document.body.classList.add('hospital-superadmin-mode');
  } else {
    if(!targetSiteId){toast('병원 소속이 지정되지 않은 계정입니다.','error');await Signage.signOut();return;}
    const {data:ownSite}=await db.from('sites').select('id,code').eq('id',targetSiteId).maybeSingle();
    if(requestedSiteCode&&ownSite?.code&&requestedSiteCode!==ownSite.code){location.replace(`/hospital.html?site=${encodeURIComponent(ownSite.code)}`);return;}
    if(!requestedSiteCode&&ownSite?.code)history.replaceState(null,'',`/hospital.html?site=${encodeURIComponent(ownSite.code)}`);
  }

  const AGE_OPTIONS=[['','전체'],['teen','10대 이하'],['20-30','20~30대'],['40-50','40~50대'],['60+','60대 이상']];
  const GENDER_OPTIONS=[['','전체'],['female','여성'],['male','남성']];
  const TREATMENTS=[['minish','미니쉬'],['implant','임플란트'],['whitening','미백'],['orthodontics','교정'],['checkup','검진'],['aftercare','수술 후 관리'],['general','일반 진료']];
  const CONTROL_MODES=[['remote','원격 제어'],['manual','수동 운영'],['hybrid','하이브리드']];
  const FLOOR_SPACE_TYPES=[['treatment','진료실'],['consultation','상담실'],['waiting','대기'],['lounge','라운지'],['reception','접수/안내'],['lobby','로비'],['staff','스탭'],['support','지원'],['public','공용'],['other','기타']];
  let state={site:null,siteSettings:{},buildingAsset:{},floorplanAssets:{},floorSpaces:[],floorplanVersions:[],patients:[],rooms:[],groups:[],playlists:[],videos:[],playlistItems:[],roomRules:[],broadcast:{active:false}}, busy=false, signalChannel=null,statusWakeChannel=null,settingsOpen=false,spaceEditorGroupId=null,selectedFloorId=null,tab='output';
  qsa('.nav-btn').forEach(b=>b.addEventListener('click',()=>{tab=b.dataset.tab||'output';qsa('.nav-btn').forEach(x=>x.classList.toggle('active',x===b));selectedFloorId=tab==='output'?selectedFloorId:null;render();}));
  const floorplanUrlCache=new Map();
  const buildingImageUrlCache=new Map();
  const statusWakeTimers=new Map();
  // roomId -> {status:'pending'|'unconfirmed'|'error', at:issuedAtServerMs}
  const ackState=new Map();
  const monitor=Signage.createLiveMonitor({onUpdate:(res)=>applyLiveResult(res),roomIds:()=>state.rooms.map(r=>r.id)});
  async function signalRoom(room){try{await db.rpc('signal_signage_rooms',{p_room_ids:[room],p_group:null,p_all:false});}catch(_){}}

  const treatmentLabel=(v)=>TREATMENTS.find(([id])=>id===v)?.[1]||v||'일반 진료';
  const ageLabel=(v)=>AGE_OPTIONS.find(([id])=>id===v)?.[1]||'전체';
  const genderLabel=(v)=>GENDER_OPTIONS.find(([id])=>id===v)?.[1]||'전체';
  const roomById=(id)=>state.rooms.find(r=>r.id===id)||null;
  async function roomPlayerPath(roomId){
    const {data,error}=await db.rpc('hospital_room_player_path',{p_room:roomId});
    if(error)throw error;
    return String(data||'');
  }
  async function openRoomPlayer(roomId){
    try{const path=await roomPlayerPath(roomId);if(!path)throw new Error('환자 화면 주소를 찾을 수 없습니다.');window.open(path,'_blank','noopener,noreferrer');}
    catch(e){toast(e.message||String(e),'error');}
  }
  async function copyRoomPlayer(roomId){
    try{const path=await roomPlayerPath(roomId);if(!path)throw new Error('환자 화면 주소를 찾을 수 없습니다.');const url=new URL(path,location.origin).href;if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(url);else{const ta=document.createElement('textarea');ta.value=url;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();}toast('환자 화면 링크를 복사했습니다.');}
    catch(e){toast(e.message||String(e),'error');}
  }
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
    return `<div class="floor-room-focus"><div class="floor-room-focus-head"><div><span>${esc(roomTypeLabel(r.room_mode))}</span><b>${esc(r.name)}</b></div><em class="status-${status.key}">${esc(status.label)}</em></div><div class="floor-room-current"><div class="floor-room-current-thumb">${staffThumb(current)}</div><div class="floor-room-current-copy"><small>현재 영상</small><b>${esc(title)}</b></div></div><div class="floor-room-why"><small>왜 이 영상이 나오나요?</small><p>${esc(roomBroadcastReason(r))}</p></div>${isManual?'':`<div class="floor-room-patient-link"><small>환자 화면</small><div><button type="button" class="btn small" data-staff-player-open="${r.id}">화면 열기</button><button type="button" class="btn small" data-staff-player-copy="${r.id}">링크 복사</button></div></div>`}<div class="floor-room-actions">${isManual?'':`<select data-staff-playlist="${r.id}">${playlistOptions(r.default_playlist_id||'')}</select><button type="button" class="btn primary" data-staff-playlist-apply="${r.id}">영상 바꾸기</button>`}<button type="button" class="text-btn dark floor-room-preview-open" data-staff-open-room-detail="${r.id}">상세 설정</button></div></div>`;
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
  function normalizedPurposeName(name){
    let value=String(name||'').trim().replace(/\s+/g,' ');
    if(!value)return '';
    value=value.replace(/\s*(?:#?\d+|[A-Z])\s*$/i,'').trim();
    if(/^(?:엘리베이터|계단|복도|화장실|공용부|기타)$/i.test(value))return '';
    if(/^[0-9F_ -]+$/i.test(value))return '';
    return value;
  }
  function floorPurposeLabel(g){
    const n=floorNumber(g),raw=String(g?.name||'').trim();
    const stripped=raw.replace(new RegExp(`^${n}\\s*(?:층|F)?\\s*`,'i'),'').trim();
    if(stripped&&!/^\d+\s*(?:층|F)?$/i.test(stripped)&&stripped!==`${n}층`&&stripped!==`${n}F`)return stripped;
    const spaceNames=[...new Set(state.floorSpaces.filter(x=>x.group_id===g?.id).map(x=>normalizedPurposeName(x.name)).filter(Boolean))];
    const preferred=spaceNames.filter(x=>/(진료실|고객대기실|대기실|상담실|라운지|로비|접수|검사실|수술실|촬영실|식당|사무|의국|기공실)/.test(x));
    const picked=(preferred.length?preferred:spaceNames).slice(0,2);
    if(picked.length)return picked.join(' · ');
    const roomNames=[...new Set((g?.rooms||state.rooms.filter(r=>r.group_id===g?.id)).map(r=>normalizedPurposeName(r.name)).filter(Boolean))].filter(x=>/[가-힣]/.test(x));
    if(roomNames.length)return roomNames.slice(0,2).join(' · ');
    return '공간 미설정';
  }
  const currentVideoForRoom=(r)=>state.videos.find(v=>v.id===r.player_status?.video_id)||null;
  const playbackLabel=(v)=>({playing:'재생 중',paused:'일시정지',loading:'불러오는 중',error:'오류',connected:'연결됨'})[String(v||'').toLowerCase()]||'연결됨';
  const activePatients=()=>state.patients.filter(p=>['waiting','assigned','in_progress'].includes(p.status));
  const elapsedMinutes=(start,end=Date.now())=>start?Math.max(0,Math.floor((new Date(end).getTime()-new Date(start).getTime())/60000)):0;
  const waitText=(p)=>`${elapsedMinutes(p.waiting_started_at||p.created_at,p.assigned_at||Date.now())}분 대기`;
  const patientForRoom=(id)=>activePatients().find(x=>x.room_id===id)||null;
  const isQuickSession=(r)=>!!r.session_treatment&&!patientForRoom(r.id);

  async function load({background=false}={}){
    const [reception,building]=await Promise.all([db.rpc('hospital_reception_state',{p_site:targetSiteId}),db.rpc('hospital_building_asset',{p_site:targetSiteId})]);
    if(reception.error)throw reception.error;if(building.error)throw building.error;
    const data=reception.data||{},baseRooms=data.rooms||[];
    const liveStatuses=await monitor.fetchStatus({roomIds:baseRooms.map(r=>r.id)}).catch(()=>({rows:[]}));
    const liveByRoom=new Map((liveStatuses.rows||[]).map(x=>[x.room_id,x]));
    const rooms=baseRooms.map(r=>{const live=liveByRoom.get(r.id);return live?{...r,last_seen_at:live.last_seen_at||r.last_seen_at,player_status:live.player_status||r.player_status}:r;});
    state={site:data.site||null,siteSettings:{...(data.site_settings||{}),building_asset:building.data||{},floorplan_assets:data.floorplan_assets||{}},buildingAsset:building.data||{},floorplanAssets:data.floorplan_assets||{},floorSpaces:data.spaces||[],floorplanVersions:data.floorplan_versions||[],patients:data.patients||[],rooms,groups:data.groups||[],playlists:data.playlists||[],videos:data.videos||[],playlistItems:data.playlist_items||[],roomRules:data.room_video_rules||[],broadcast:data.broadcast||{active:false}};
    const actualSlug=String(state.site?.code||'').trim();
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
  function staffBuildingFloor(g){
    const n=floorNumber(g),rooms=g.rooms||state.rooms.filter(r=>r.group_id===g.id),st=groupStatusSummary(rooms),shortName=floorPurposeLabel(g);
    const status=st.issues?'확인 필요':st.offline?'연결 안 됨':rooms.length?'정상':'미사용';
    const cls=`hospital-floor-row floor-state-${st.key}${selectedFloorId===g.id?' is-selected':''}`;
    return `<button type="button" class="${cls}" data-staff-select-floor="${g.id}" aria-expanded="${selectedFloorId===g.id?'true':'false'}">
      <span class="hospital-floor-number">${n}F</span>
      <span class="hospital-floor-name">${esc(shortName)}</span>
      <span class="hospital-floor-state"><i></i>${esc(status)}${st.issues?` ${st.issues}`:''}</span>
    </button>`;
  }
  function staffFloorMarker(r){
    if(!roomMapPlaced(r))return '';
    const st=roomDisplayStatus(r),x=Number(r.map_x_pct),y=Number(r.map_y_pct);
    const current=currentVideoForRoom(r),thumb=current?.thumbnail_data_url?`<img src="${esc(current.thumbnail_data_url)}" alt="">`:'<span class="display-screen-icon"></span>';
    return `<button class="floor-display-pin control-${displayControlMode(r)} status-${st.key}" style="left:${x}%;top:${y}%" data-staff-floor-room="${r.id}" title="${esc(r.name)} · ${esc(st.label)}" aria-label="${esc(r.name)} · ${esc(st.label)}">
      <span class="floor-display-card"><b><i></i>${esc(r.name)}</b><span class="floor-display-preview">${thumb}</span></span>
    </button>`;
  }
  function staffFloorPanelMarkup(g){
    if(!g)return `<section class="hospital-floor-detail hospital-floor-detail-empty"><div><b>층을 선택하세요.</b><p>확인할 층을 누르면 도면과 디스플레이 위치가 열립니다.</p></div></section>`;
    const rooms=g.rooms||state.rooms.filter(r=>r.group_id===g.id),sum=groupStatusSummary(rooms),asset=floorAsset(g),unplaced=rooms.filter(r=>!roomMapPlaced(r));
    const n=floorNumber(g),online=rooms.filter(r=>displayControlMode(r)==='manual'||staffIsOnline(r)).length;
    return `<section class="hospital-floor-detail">
      <div class="hospital-floor-detail-head">
        <div><b>${n}층 · ${esc(floorPurposeLabel(g))}</b><span>도면에서 디스플레이를 누르면 현재 영상과 송출 이유를 확인할 수 있습니다.</span></div>
        <div class="hospital-floor-detail-stats"><span>디스플레이 <b>${rooms.length}</b></span><span>연결 <b>${online}</b></span>${sum.issues?`<span class="is-alert">확인 필요 <b>${sum.issues}</b></span>`:''}</div>
      </div>
      ${asset?`<div class="building-floorplan-wrap floor-activation-shell">
        <div class="floor-plan-stage building-floor-plan-stage is-floor-activating">
          <div class="floorplan-svg-host" data-floorplan-svg="${asset}"></div>
          ${state.floorSpaces.filter(x=>x.group_id===g.id).map(x=>floorSpaceOverlay(x)).join('')}
          ${rooms.map(staffFloorMarker).join('')}
        </div>
        <div class="floor-zone-inspector building-zone-inspector" data-staff-floor-zone-inspector>
          <div class="floor-zone-inspector-empty"><div><b>TV를 선택하세요.</b></div><p>현재 영상과 송출 이유를 확인할 수 있습니다.</p></div>
        </div>
      </div>`:`<div class="floor-plan-empty floor-plan-empty-action hospital-floor-empty"><b>등록된 도면이 없습니다.</b><p>설정에서 이 층의 도면을 등록하세요.</p><button type="button" class="btn small" data-staff-open-settings>도면 등록</button></div>`}
      ${unplaced.length?`<div class="building-plan-foot"><span>위치 미설정 ${unplaced.length}</span></div>`:''}
    </section>`;
  }
  function buildingFloorRail(floorGroups){
    const byNo=new Map(floorGroups.map(g=>[floorNumber(g),g]));
    const max=Math.max(14,...floorGroups.map(floorNumber));
    const min=Math.min(1,...floorGroups.map(floorNumber));
    const nums=[]; for(let n=max;n>=min;n--) nums.push(n);
    return `<div class="hospital-building-floor-rail">${nums.map(n=>{
      const g=byNo.get(n),selected=g&&selectedFloorId===g.id;
      return `<button type="button" class="${selected?'is-selected':''} ${g?'':'is-empty'}" ${g?`data-staff-select-floor="${g.id}"`:'disabled'}><span>${n}F</span></button>`;
    }).join('')}</div>`;
  }
  // v2.34.24 · 14층 건물 이미지 전용 층 zone
  // 옥상은 제외하고, 실제 TV가 보이는 중앙 실내 단면만 선택 영역으로 사용한다.
  const BUILDING_FLOOR_SHAPES={
    14:{top:9.6,left:30.4,width:41.7,height:5.7,points:'0,8 97,0 100,92 2,100'},
    13:{top:15.3,left:30.4,width:41.7,height:6.9,points:'0,6 98,0 100,94 2,100'},
    12:{top:22.2,left:30.4,width:41.7,height:5.6,points:'0,5 98,0 100,95 2,100'},
    11:{top:27.8,left:30.4,width:41.7,height:6.5,points:'0,5 98,0 100,95 2,100'},
    10:{top:34.3,left:30.4,width:41.7,height:6.0,points:'0,4 98,0 100,96 2,100'},
    9:{top:40.3,left:30.4,width:41.7,height:5.8,points:'0,4 98,0 100,96 2,100'},
    8:{top:46.1,left:30.4,width:41.7,height:5.9,points:'0,4 98,0 100,96 2,100'},
    7:{top:52.0,left:30.4,width:41.7,height:5.9,points:'0,3 99,0 100,97 2,100'},
    6:{top:57.9,left:30.4,width:41.7,height:5.8,points:'0,3 99,0 100,97 2,100'},
    5:{top:63.7,left:30.4,width:41.7,height:5.9,points:'0,3 99,0 100,97 2,100'},
    4:{top:69.6,left:30.4,width:41.7,height:5.8,points:'0,2 99,0 100,98 2,100'},
    3:{top:75.4,left:30.4,width:41.7,height:6.0,points:'0,2 99,0 100,98 2,100'},
    2:{top:81.4,left:30.4,width:41.7,height:4.7,points:'0,2 99,0 100,98 2,100'},
    1:{top:86.1,left:28.7,width:45.2,height:7.8,points:'0,1 100,0 100,98 0,100'}
  };
  function buildingFloorHitZones(floorGroups){
    const byNo=new Map(floorGroups.map(g=>[floorNumber(g),g]));
    return Object.entries(BUILDING_FLOOR_SHAPES).map(([floor,shape])=>{
      const g=byNo.get(Number(floor)); if(!g)return '';
      const selected=selectedFloorId===g.id;
      const polygon=shape.points.split(' ').map(pair=>pair.split(',').map(v=>`${v}%`).join(' ')).join(',');
      return `<button type="button" class="hospital-building-floor-hit${selected?' is-selected':''}" data-staff-select-floor="${g.id}" aria-label="${floor}층 선택" style="top:${shape.top}%;left:${shape.left}%;width:${shape.width}%;height:${shape.height}%;clip-path:polygon(${polygon})"></button>`;
    }).join('');
  }
  function staffBuildingOverview(groups){
    const floorGroups=groups.filter(g=>floorNumber(g)>0).sort((a,b)=>floorNumber(b)-floorNumber(a));
    if(selectedFloorId&&!floorGroups.some(g=>g.id===selectedFloorId))selectedFloorId=null;
    if(!floorGroups.length)return `<section class="hospital-building-empty"><b>등록된 층이 없습니다.</b><p>병원 설정에서 층을 먼저 추가하세요.</p><button type="button" class="btn small" data-staff-open-settings>병원 설정 열기</button></section>`;
    if(!selectedFloorId){
      const preferred=floorGroups.find(g=>floorNumber(g)===10&&floorAsset(g))||floorGroups.find(g=>floorAsset(g))||floorGroups.find(g=>groupStatusSummary(g.rooms||[]).issues)||floorGroups[0];
      selectedFloorId=preferred?.id||null;
    }
    const selected=floorGroups.find(g=>g.id===selectedFloorId)||null;
    const statuses=state.rooms.map(roomDisplayStatus),offline=statuses.filter(x=>x.key==='offline').length,issues=statuses.filter(x=>['error','update','offline','manual-warn'].includes(x.key)).length;
    const selectedNo=selected?floorNumber(selected):null;
    return `<section class="hospital-building-dashboard">
      <aside class="hospital-building-visual" aria-label="병원 건물 층별 보기">
        <div class="hospital-building-image-wrap">
          ${state.buildingAsset?.key?`<div class="hospital-building-image-host" data-building-image style="aspect-ratio:${Number(state.buildingAsset?.width||state.buildingAsset?.source_width||948)}/${Number(state.buildingAsset?.height||state.buildingAsset?.source_height||1659)}"><span data-building-loading>건물 이미지를 불러오는 중입니다.</span><div class="hospital-building-floor-layer">${buildingFloorHitZones(floorGroups)}</div></div>`:`<div class="hospital-building-image-empty"><b>건물 이미지가 없습니다.</b><span>병원 설정에서 건물 이미지를 등록하세요.</span><button type="button" class="btn small" data-staff-open-settings>건물 이미지 등록</button></div>`}
        </div>
      </aside>
      <div class="hospital-building-console">
        ${hospitalBroadcastCard()}
        ${issues?`<div class="hospital-issue-notice hospital-issue-notice-wide"><b>확인이 필요한 디스플레이 ${issues}대</b><span>${offline?`연결 안 됨 ${offline}대 포함`:''}</span></div>`:''}
        <div class="hospital-floor-console-card">
          <div class="hospital-floor-console-title"><div><h2>층을 선택하세요</h2><p>확인할 층을 누르면 도면이 열립니다.</p></div></div>
          <div class="hospital-floor-console-grid">
            <div class="hospital-floor-list" role="list">${floorGroups.map(staffBuildingFloor).join('')}</div>
            ${staffFloorPanelMarkup(selected)}
          </div>
        </div>
      </div>
    </section>`;
  }


  window.addEventListener('beforeunload',()=>revokeFloorplanCache(),{once:true});

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
  const floorplanMetaKey=(meta)=>typeof meta==='string'?meta.trim():String(meta?.key||meta?.object_key||meta?.path||'').trim();
  const floorplanVersionsFor=(floor)=>state.floorplanVersions.filter(v=>Number(v.floor_number)===Number(floor)).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const floorAsset=(g)=>{const n=floorNumber(g);return n&&floorplanMeta(n)?n:null;};
  const roomMapPlaced=(r)=>r?.map_x_pct!==null&&r?.map_x_pct!==undefined&&r?.map_y_pct!==null&&r?.map_y_pct!==undefined&&Number.isFinite(Number(r.map_x_pct))&&Number.isFinite(Number(r.map_y_pct));
  function floorSpaceOverlay(x,editable=false){return `<button type="button" class="floor-space-overlay ${editable?'is-editable':''}" data-floor-space="${x.id}" style="left:${Number(x.x_pct)}%;top:${Number(x.y_pct)}%;width:${Number(x.width_pct)}%;height:${Number(x.height_pct)}%"><span>${esc(x.name)}</span></button>`;}
  function displayMarker(r,editable=false){if(!roomMapPlaced(r))return '';const mode=displayControlMode(r);return `<button type="button" class="display-map-marker control-${mode} ${editable?'is-editable':''}" data-display-marker="${r.id}" style="left:${Number(r.map_x_pct)}%;top:${Number(r.map_y_pct)}%" title="${esc(r.name)} · ${esc(displayControlLabel(r))}" aria-label="${esc(r.name)} · ${esc(displayControlLabel(r))}"><i></i></button>`;}
  function revokeFloorplanCache(){
    floorplanUrlCache.clear();
  }
  function applyFloorplanGeometry(host,width,height){
    const w=Number(width)||0,h=Number(height)||0,stage=host.closest('.floor-plan-stage,.settings-map-stage');
    if(!stage||!w||!h)return;
    stage.style.aspectRatio=`${w} / ${h}`;
    stage.style.minHeight='0px';
    host.style.aspectRatio=`${w} / ${h}`;
  }
  async function getFloorplanImageUrl(floor,meta){
    const key=floorplanMetaKey(meta);
    if(!key)throw new Error('FLOORPLAN_KEY_MISSING');
    const cacheKey=`${state.site?.id||''}:${floor}:${key}`;
    const cached=floorplanUrlCache.get(cacheKey);
    if(cached&&cached.expiresAt>Date.now())return cached.url;
    const params=new URLSearchParams({floor:String(floor),key});
    if(state.site?.id)params.set('siteId',state.site.id);
    const data=await apiJson(`/api/floorplan?${params}`);
    if(!data?.url)throw new Error('FLOORPLAN_URL_MISSING');
    floorplanUrlCache.set(cacheKey,{url:data.url,expiresAt:Date.now()+240000});
    return data.url;
  }
  async function loadFloorplanSvgs(root=qs('#hospitalRoot')){
    const hosts=[...(root||document).querySelectorAll?.('[data-floorplan-svg]')||[]].filter(host=>!host.closest('details:not([open])'));
    await Promise.all(hosts.map(async host=>{
      const floor=Number(host.dataset.floorplanSvg);if(!floor||host.dataset.loaded==='1')return;
      try{
        const meta=floorplanMeta(floor);
        if(!floorplanMetaKey(meta))throw new Error('FLOORPLAN_KEY_MISSING');
        const url=await getFloorplanImageUrl(floor,meta);
        const img=document.createElement('img');
        img.src=url;
        img.alt=`${floor}층 평면도`;
        img.draggable=false;
        img.loading='eager';
        img.decoding='async';
        host.replaceChildren(img);
        await new Promise((resolve,reject)=>{
          const done=()=>{const w=Number(img.naturalWidth||meta?.width||meta?.source_width||0),h=Number(img.naturalHeight||meta?.height||meta?.source_height||0);if(w&&h)applyFloorplanGeometry(host,w,h);resolve();};
          if(img.complete){if(img.naturalWidth)done();else reject(new Error('도면 이미지를 표시할 수 없습니다.'));return;}
          img.onload=done;img.onerror=()=>reject(new Error('도면 이미지를 표시할 수 없습니다.'));
        });
        host.dataset.loaded='1';
      }catch(e){console.error('[floorplan] load failed',floor,e);host.innerHTML=`<span class="floor-plan-error">${floor}층 도면을 불러오지 못했습니다.<br>${esc(e?.message||'FLOORPLAN_LOAD_FAILED')}</span>`;}
    }));
  }
  async function saveFloorplanAssets(next){const {error}=await db.rpc('hospital_set_floorplan_assets',{p_site:targetSiteId,p_assets:next});if(error)throw error;state.floorplanAssets=next;state.siteSettings={...state.siteSettings,floorplan_assets:next};revokeFloorplanCache();}
  async function pruneFloorplanVersions(siteId,floor,keep=5){
    try{
      const {data,error}=await db.from('floorplan_versions').select('*').eq('site_id',siteId).eq('floor_number',floor).order('created_at',{ascending:false});
      if(error)throw error;const stale=(data||[]).slice(keep).filter(v=>!v.active);
      for(const v of stale){try{await apiJson('/api/floorplan-delete',{method:'POST',body:JSON.stringify({siteId,floor,key:v.object_key})});}catch(e){console.warn('[floorplan] old version R2 cleanup failed',e);}await db.from('floorplan_versions').delete().eq('id',v.id);}
    }catch(e){console.warn('[floorplan] version pruning skipped',e);}
  }
  async function imageSourceForFloorplan(file){
    if(typeof createImageBitmap==='function'){
      const bitmap=await createImageBitmap(file);
      return {source:bitmap,width:bitmap.width,height:bitmap.height,close:()=>bitmap.close?.()};
    }
    const url=URL.createObjectURL(file),img=new Image();
    try{
      await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('도면 이미지를 읽을 수 없습니다.'));img.src=url;});
      return {source:img,width:img.naturalWidth,height:img.naturalHeight,close:()=>URL.revokeObjectURL(url)};
    }catch(e){URL.revokeObjectURL(url);throw e;}
  }
  function canvasBlob(canvas,type,quality){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('도면 압축에 실패했습니다.')),type,quality));}
  async function optimizeFloorplanFile(file){
    const MAX_EDGE=2600,TARGET_BYTES=1800*1024,SKIP_BYTES=1200*1024,ABSOLUTE_BYTES=4*1024*1024;
    const image=await imageSourceForFloorplan(file);
    try{
      const originalWidth=Number(image.width)||0,originalHeight=Number(image.height)||0;
      const maxEdge=Math.max(originalWidth,originalHeight);
      if(file.size<=SKIP_BYTES&&maxEdge<=MAX_EDGE)return {file,optimized:false,originalSize:file.size,width:originalWidth,height:originalHeight};
      const baseScale=Math.min(1,MAX_EDGE/maxEdge);let best=null,bestWidth=originalWidth,bestHeight=originalHeight;
      for(let round=0;round<5;round++){
        const scale=baseScale*Math.pow(.86,round),width=Math.max(1,Math.round(originalWidth*scale)),height=Math.max(1,Math.round(originalHeight*scale));
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
        const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw new Error('도면 압축을 지원하지 않는 브라우저입니다.');
        ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(image.source,0,0,width,height);
        for(const quality of [.9,.84,.78,.72]){
          const blob=await canvasBlob(canvas,'image/webp',quality);if(!best||blob.size<best.size){best=blob;bestWidth=width;bestHeight=height;}if(blob.size<=TARGET_BYTES){best=blob;bestWidth=width;bestHeight=height;round=99;break;}
        }
      }
      if(!best)throw new Error('도면 압축에 실패했습니다.');
      if(best.size>=file.size&&file.size<=ABSOLUTE_BYTES)return {file,optimized:false,originalSize:file.size,width:originalWidth,height:originalHeight};
      if(best.size>ABSOLUTE_BYTES)throw new Error('도면을 최적화했지만 용량이 너무 큽니다. 더 작은 이미지를 사용하세요.');
      const base=String(file.name||'floorplan').replace(/\.[^.]+$/,'').slice(0,80)||'floorplan';
      return {file:new File([best],`${base}.webp`,{type:'image/webp',lastModified:Date.now()}),optimized:true,originalSize:file.size,width:bestWidth,height:bestHeight,source_width:originalWidth,source_height:originalHeight};
    }finally{image.close?.();}
  }
  async function getBuildingImageUrl(){
    const key=String(state.buildingAsset?.key||'');if(!key)return '';
    const cached=buildingImageUrlCache.get(key);if(cached&&cached.expiresAt>Date.now())return cached.url;
    const params=new URLSearchParams({siteId:state.site?.id||'',key,mode:'url'}),data=await apiJson(`/api/building-image?${params}`);
    if(!data?.url)throw new Error('BUILDING_IMAGE_URL_MISSING');
    buildingImageUrlCache.set(key,{url:data.url,expiresAt:Date.now()+240000});return data.url;
  }
  async function loadBuildingImages(root=qs('#hospitalRoot')){
    const hosts=[...(root||document).querySelectorAll?.('[data-building-image]')||[]];if(!hosts.length||!state.buildingAsset?.key)return;
    try{
      const url=await getBuildingImageUrl();
      hosts.forEach(host=>{if(host.dataset.loaded==='1')return;const img=new Image();img.alt='병원 건물 이미지';img.decoding='async';img.loading='eager';img.fetchPriority='high';img.className='hospital-building-image';img.onload=()=>host.querySelector('[data-building-loading]')?.remove();img.onerror=()=>{const loading=host.querySelector('[data-building-loading]');if(loading)loading.outerHTML='<span class="floor-plan-error">건물 이미지를 불러오지 못했습니다.</span>';};img.src=url;host.prepend(img);host.dataset.loaded='1';});
    }catch(_){hosts.forEach(host=>{const loading=host.querySelector('[data-building-loading]');if(loading)loading.outerHTML='<span class="floor-plan-error">건물 이미지를 불러오지 못했습니다.</span>';});}
  }
  async function saveBuildingAsset(asset){const {error}=await db.rpc('hospital_set_building_asset',{p_site:targetSiteId,p_asset:asset||{}});if(error)throw error;state.buildingAsset=asset||{};state.siteSettings={...state.siteSettings,building_asset:asset||{}};}
  async function uploadBuildingImage(file){
    if(!state.site?.id)return toast('병원 정보가 없습니다.','error');
    const type=String(file.type||'').toLowerCase();if(!['image/png','image/jpeg','image/webp'].includes(type))return toast('PNG, JPG, WebP 이미지만 업로드할 수 있습니다.','error');if(file.size>12*1024*1024)return toast('원본 이미지는 12MB 이하 파일을 사용하세요.','error');
    try{toast('건물 이미지를 최적화하고 있습니다.');const optimized=await optimizeFloorplanFile(file),uploadFile=optimized.file,mime=String(uploadFile.type||'').toLowerCase();const signed=await apiJson('/api/building-presign',{method:'POST',body:JSON.stringify({filename:uploadFile.name,contentType:mime,size:uploadFile.size,siteId:state.site.id})});await uploadByXhr(signed.uploadUrl,uploadFile,mime);const old=state.buildingAsset?.key||'';const next={key:signed.key,filename:uploadFile.name,mime,size:uploadFile.size,original_size:optimized.originalSize,optimized:optimized.optimized,width:optimized.width||null,height:optimized.height||null,source_width:optimized.source_width||optimized.width||null,source_height:optimized.source_height||optimized.height||null,updated_at:new Date().toISOString()};await saveBuildingAsset(next);buildingImageUrlCache.clear();if(old&&old!==signed.key){try{await apiJson('/api/building-delete',{method:'POST',body:JSON.stringify({siteId:state.site.id,key:old})});}catch(e){console.warn('[building] old image cleanup failed',e);}}toast('건물 이미지를 저장했습니다.');await load();}catch(e){toast(e.message||String(e),'error');}
  }
  async function removeBuildingImage(){const old=state.buildingAsset?.key||'';if(!old)return;if(!confirm('건물 이미지를 삭제할까요?'))return;try{await saveBuildingAsset({});buildingImageUrlCache.clear();try{await apiJson('/api/building-delete',{method:'POST',body:JSON.stringify({siteId:state.site.id,key:old})});}catch(e){console.warn('[building] R2 cleanup failed',e);}toast('건물 이미지를 삭제했습니다.');await load();}catch(e){toast(e.message||String(e),'error');}}
  function buildingImageSettingsMarkup(){const a=state.buildingAsset||{};return `<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>건물 이미지</b><small>송출 현황의 왼쪽 건물 시각화에 사용합니다. 병원별로 따로 저장됩니다.</small></div></div><div class="building-image-settings">${a.key?`<div class="building-image-settings-preview" data-building-image><span>이미지 불러오는 중</span></div>`:`<div class="building-image-settings-empty">등록된 건물 이미지가 없습니다.</div>`}<div class="building-image-settings-actions"><label class="btn small"><input type="file" accept="image/png,image/jpeg,image/webp" data-staff-building-upload><span>${a.key?'교체':'업로드'}</span></label>${a.key?'<button type="button" class="btn small" data-staff-building-remove>삭제</button>':''}</div></div></div>`;}
  async function uploadFloorplan(floor,file){
    if(!state.site?.id)return toast('병원 정보가 없습니다.','error');
    const originalMime=String(file.type||'').toLowerCase();if(!['image/png','image/jpeg','image/webp'].includes(originalMime))return toast('PNG, JPG, WebP 도면만 업로드할 수 있습니다.','error');if(file.size>12*1024*1024)return toast('원본 도면은 12MB 이하 파일을 사용하세요.','error');
    try{
      toast('도면을 최적화하고 있습니다.');
      const optimized=await optimizeFloorplanFile(file),uploadFile=optimized.file,mime=String(uploadFile.type||'').toLowerCase();
      const signed=await apiJson('/api/floorplan-presign',{method:'POST',body:JSON.stringify({floor,filename:uploadFile.name,contentType:mime,size:uploadFile.size,siteId:state.site.id})});
      await uploadByXhr(signed.uploadUrl,uploadFile,mime);
      const next={...state.floorplanAssets,[String(floor)]:{key:signed.key,filename:uploadFile.name,mime,size:uploadFile.size,original_size:optimized.originalSize,optimized:optimized.optimized,width:optimized.width||null,height:optimized.height||null,source_width:optimized.source_width||optimized.width||null,source_height:optimized.source_height||optimized.height||null,updated_at:new Date().toISOString()}};
      await db.from('floorplan_versions').update({active:false}).eq('site_id',state.site.id).eq('floor_number',floor);
      await db.from('floorplan_versions').insert({site_id:state.site.id,floor_number:floor,object_key:signed.key,filename:uploadFile.name,mime,size_bytes:uploadFile.size,active:true});
      await saveFloorplanAssets(next);await pruneFloorplanVersions(state.site.id,floor);
      const saved=Math.max(0,optimized.originalSize-uploadFile.size),rate=optimized.originalSize?Math.round(saved/optimized.originalSize*100):0;
      toast(optimized.optimized?`${floor}층 도면을 최적화해 저장했습니다. · ${rate}% 절감`:`${floor}층 도면을 저장했습니다.`);await load();
    }catch(e){toast(e.message||String(e),'error');}
  }
  async function resetFloorplan(floor){const old=floorplanMeta(floor);if(!old)return;if(!confirm(`${floor}층 업로드 도면을 기본/미등록 상태로 되돌릴까요?`))return;try{const next={...state.floorplanAssets};delete next[String(floor)];await saveFloorplanAssets(next);await db.from('floorplan_versions').update({active:false}).eq('site_id',state.site.id).eq('floor_number',floor);toast('현재 도면을 해제했습니다. 이전 버전은 보관됩니다.');await load();}catch(e){toast(e.message||String(e),'error');}}
  function floorplanAdminMarkup(){return `<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>층별 도면</b><small>등록된 도면만 표시됩니다. 업로드 시 화면용 크기로 자동 최적화합니다.</small></div></div><div class="floorplan-admin-list">${Array.from({length:14},(_,i)=>14-i).map(f=>{const m=floorplanMeta(f),versions=floorplanVersionsFor(f);return `<article class="floorplan-admin-row"><div class="floorplan-admin-copy"><b>${f}F</b><span>${m?'업로드 도면':'도면 없음'}</span><small>${m?esc(m.filename||'사용자 도면'):'PNG, JPG, WebP · 업로드 시 자동 압축'}${versions.length?` · 버전 ${versions.length}개`:''}</small></div><div class="floorplan-admin-actions"><label class="btn small floorplan-upload-btn"><input type="file" accept="image/png,image/jpeg,image/webp" data-staff-floorplan-upload="${f}"><span>${m?'교체':'업로드'}</span></label>${m?`<button class="btn small" type="button" data-staff-floorplan-reset="${f}">도면 제거</button>`:''}${versions.length>1?`<select class="compact-select" data-staff-floorplan-version="${f}">${versions.map(v=>`<option value="${v.id}" ${v.object_key===m?.key?'selected':''}>${esc(v.filename||'도면')} · ${new Date(v.created_at).toLocaleDateString('ko-KR')}</option>`).join('')}</select><button class="btn small" data-staff-floorplan-restore="${f}" type="button">복원</button>`:''}</div></article>`;}).join('')}</div></div>`;}
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
  function structureSetupMarkup(){const floors=[...state.groups].filter(g=>floorNumber(g)>0).sort((a,b)=>floorNumber(b)-floorNumber(a));return `<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>층 · 디스플레이 만들기</b><small>처음 설치할 때 필요한 기본 구조만 추가합니다.</small></div></div><div class="grid-2"><div class="settings-card"><h3>층 추가</h3><label class="field"><span>층 번호</span><input id="staffNewFloorNumber" type="number" min="1" max="99" placeholder="예: 8"></label><label class="field"><span>표시 이름</span><input id="staffNewFloorName" maxlength="30" placeholder="비우면 8F"></label><button id="staffCreateFloor" class="btn" type="button">층 추가</button></div><div class="settings-card"><h3>디스플레이 추가</h3><label class="field"><span>층</span><select id="staffNewDisplayGroup"><option value="">층 선택</option>${floors.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label><label class="field"><span>이름</span><input id="staffNewDisplayName" maxlength="40" placeholder="예: 진료실 1"></label><label class="field"><span>운영 방식</span><select id="staffNewDisplayMode">${CONTROL_MODES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><button id="staffCreateDisplay" class="btn" type="button">디스플레이 추가</button></div></div></div>`;}
  async function createHospitalFloor(){const n=Number(qs('#staffNewFloorNumber')?.value),name=(qs('#staffNewFloorName')?.value||'').trim();if(!Number.isInteger(n)||n<1||n>99)return toast('층 번호는 1~99 사이로 입력하세요.','error');const {error}=await db.rpc('hospital_create_floor',{p_site:targetSiteId,p_floor:n,p_name:name||null});if(error)return toast(error.message,'error');toast(`${n}층을 추가했습니다.`);await load();}
  async function createHospitalDisplay(){const group=qs('#staffNewDisplayGroup')?.value,name=(qs('#staffNewDisplayName')?.value||'').trim(),mode=qs('#staffNewDisplayMode')?.value||'remote';if(!group||!name)return toast('층과 디스플레이 이름을 입력하세요.','error');const {error}=await db.rpc('hospital_create_display',{p_site:targetSiteId,p_group:group,p_name:name,p_mode:mode});if(error)return toast(error.message,'error');toast('디스플레이를 추가했습니다.');await load();}
  function hospitalPlaylistManagerMarkup(){
    const own=state.playlists.filter(p=>p.site_id===state.site?.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
    const activeVideos=state.videos.filter(v=>v.active);
    const countFor=p=>state.playlistItems.filter(x=>x.playlist_id===p.id).length;
    return `<div class="hospital-video-overview"><div><small>플레이리스트</small><b>${own.length}</b><span>이 병원 전용</span></div><div><small>사용 가능한 영상</small><b>${activeVideos.length}</b><span>공용 영상 포함</span></div></div><div class="hospital-playlist-layout"><aside class="hospital-playlist-list"><div class="hospital-section-title"><div><b>플레이리스트</b><small>관리할 재생목록을 선택하세요.</small></div><button type="button" class="btn small" data-new-playlist>새로 만들기</button></div><div class="hospital-playlist-items">${own.map(p=>`<button type="button" class="hospital-playlist-item" data-playlist-pick="${p.id}"><span><b>${esc(p.name)}</b><small>영상 ${countFor(p)}개</small></span><i>›</i></button>`).join('')||'<div class="hospital-empty-card"><b>플레이리스트가 없습니다.</b><span>오른쪽에서 새 플레이리스트를 만들어보세요.</span></div>'}</div></aside><section class="hospital-playlist-editor"><div class="hospital-section-title"><div><b>플레이리스트 편집</b><small>이름과 재생할 영상만 정하면 됩니다.</small></div></div><label class="field hospital-playlist-select-field"><span>플레이리스트</span><select id="staffPlaylistSelect"><option value="">새 플레이리스트</option>${own.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label class="field"><span>이름</span><input id="staffPlaylistName" maxlength="60" placeholder="예: 대기실 기본 영상"></label><label class="field site-playlist-videos"><span>재생할 영상</span><small>여러 개 선택할 수 있습니다.</small><select id="staffPlaylistVideos" multiple size="9">${activeVideos.map(v=>`<option value="${v.id}">${esc(v.title)}</option>`).join('')}</select></label><div class="hospital-editor-actions"><button id="staffSavePlaylist" class="btn primary" type="button">플레이리스트 저장</button><button id="staffDeletePlaylist" class="btn danger-outline" type="button" disabled>삭제</button></div></section></div>`;
  }
  function fillHospitalPlaylistEditor(){const id=qs('#staffPlaylistSelect')?.value||'',p=state.playlists.find(x=>x.id===id);const name=qs('#staffPlaylistName'),videos=qs('#staffPlaylistVideos'),del=qs('#staffDeletePlaylist');if(name)name.value=p?.name||'';if(del)del.disabled=!p;if(videos){const ids=new Set((p?state.playlistItems.filter(x=>x.playlist_id===p.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(x=>x.video_id):[]));[...videos.options].forEach(o=>o.selected=ids.has(o.value));}}
  async function saveHospitalPlaylist(){const id=qs('#staffPlaylistSelect')?.value||null,name=(qs('#staffPlaylistName')?.value||'').trim(),videoIds=[...(qs('#staffPlaylistVideos')?.selectedOptions||[])].map(o=>o.value);if(!name)return toast('플레이리스트 이름을 입력하세요.','error');if(!videoIds.length)return toast('영상은 1개 이상 선택하세요.','error');const {error}=await db.rpc('hospital_save_site_playlist',{p_site:targetSiteId,p_id:id,p_name:name,p_video_ids:videoIds});if(error)return toast(error.message,'error');toast('병원 플레이리스트를 저장했습니다.');await load();}
  async function deleteHospitalPlaylist(){const id=qs('#staffPlaylistSelect')?.value;if(!id||!confirm('이 병원 플레이리스트를 삭제할까요?'))return;const {error}=await db.rpc('hospital_delete_site_playlist',{p_site:targetSiteId,p_id:id});if(error)return toast(error.message,'error');toast('병원 플레이리스트를 삭제했습니다.');await load();}
  const operatingConfig=()=>state.siteSettings||{};
  function operatingSettingsMarkup(){
    const c=operatingConfig(), row=(key,label,defStart,defEnd,defEnabled)=>`<div class="operating-row"><label class="switch"><input type="checkbox" data-op-enabled="${key}" ${String(c[`${key}_enabled`]??defEnabled)==='true'||c[`${key}_enabled`]===true?'checked':''}><i></i></label><b>${label}</b><input type="time" data-op-start="${key}" value="${esc(String(c[`${key}_start`]||defStart).slice(0,5))}"><span>–</span><input type="time" data-op-end="${key}" value="${esc(String(c[`${key}_end`]||defEnd).slice(0,5))}"></div>`;
    return `<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>운영시간</b><small>이 병원에만 적용됩니다.</small></div></div><div class="operating-list">${row('weekday','평일','09:00','20:00',true)}${row('saturday','토요일','09:00','17:00',true)}${row('sunday','일요일','09:00','17:00',false)}</div><label class="field"><span>비상 영상</span><select id="staffEmergencyVideo"><option value="">선택 안 함</option>${state.videos.map(v=>`<option value="${v.id}" ${String(c.emergency_video_id||'')===v.id?'selected':''}>${esc(v.title)}</option>`).join('')}</select></label><div class="inline"><button id="staffSaveOperating" class="btn primary" type="button">운영시간 저장</button><button id="staffCloseToday" class="btn" type="button">오늘 송출 종료</button><button id="staffReopenToday" class="btn" type="button">오늘 다시 열기</button></div></div>`;
  }
  async function saveOperatingConfig(){
    const read=(k,t)=>qs(`[data-op-${t}="${k}"]`),config={};
    for(const k of ['weekday','saturday','sunday']){config[`${k}_enabled`]=!!read(k,'enabled')?.checked;config[`${k}_start`]=read(k,'start')?.value||'09:00';config[`${k}_end`]=read(k,'end')?.value||'17:00';}
    config.emergency_video_id=qs('#staffEmergencyVideo')?.value||null;
    const {error}=await db.rpc('hospital_save_operating_config',{p_site:targetSiteId,p_config:config});if(error)return toast(error.message,'error');toast('운영시간을 저장했습니다.');await load();
  }
  function hospitalSettingsPageMarkup(){const site=state.site||{};const custom=Object.values(state.floorplanAssets||{}).filter(x=>x?.key).length,placed=state.rooms.filter(roomMapPlaced).length,total=state.rooms.length;return `<section class="hospital-admin-settings-page">${hospitalSetupProgress()}<div class="hospital-settings-primary"><div class="hospital-settings-intro"><span class="eyebrow">ESSENTIAL</span><h2>기본 운영</h2><p>병원 이름과 운영시간처럼 자주 확인하는 항목만 먼저 보여줍니다.</p></div><div class="hospital-admin-block hospital-settings-card"><div class="hospital-admin-block-head"><div><b>병원 정보</b><small>관리 화면에 표시되는 병원명과 건물명입니다.</small></div></div><div class="grid-2"><label class="field"><span>병원명</span><input id="staffSiteName" maxlength="60" value="${esc(site.name||'')}"></label><label class="field"><span>건물명</span><input id="staffBuildingLabel" maxlength="60" value="${esc(site.building_label||'')}"></label></div><button id="staffSaveSiteIdentity" class="btn primary" type="button">병원 정보 저장</button></div><div class="hospital-settings-card">${operatingSettingsMarkup()}</div></div><details class="hospital-settings-advanced"><summary><span><b>공간 · 도면 · 디스플레이 설정</b><small>처음 설치하거나 위치를 바꿀 때만 사용합니다.</small></span><em>도면 ${custom} · 디스플레이 ${placed}/${total}</em></summary><div class="hospital-settings-advanced-body">${buildingImageSettingsMarkup()}${structureSetupMarkup()}${floorplanAdminMarkup()}${floorSpaceManagerMarkup()}${displaySetupMarkup()}</div></details></section>`;}
  function hospitalVideosPageMarkup(){return `<section class="hospital-content-page"><div class="hospital-page-intro"><span class="eyebrow">PLAYLIST</span><h2>플레이리스트</h2><p>이미 등록된 영상 중 이 병원에서 사용할 재생 순서만 정합니다.</p></div>${hospitalPlaylistManagerMarkup()}</section>`;}
  async function saveHospitalIdentity(){const name=(qs('#staffSiteName')?.value||'').trim(),building=(qs('#staffBuildingLabel')?.value||'').trim();if(!name||!building)return toast('병원명과 건물명을 입력하세요.','error');const {error}=await db.rpc('hospital_update_site_identity',{p_site:targetSiteId,p_name:name,p_building_label:building});if(error)return toast(error.message,'error');toast('병원 정보를 저장했습니다.');await load();}
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
    qs('#staffSaveOperating')?.addEventListener('click',saveOperatingConfig);
    qs('#staffCreateFloor')?.addEventListener('click',createHospitalFloor);
    qs('#staffCreateDisplay')?.addEventListener('click',createHospitalDisplay);
    qs('#staffCloseToday')?.addEventListener('click',async()=>{if(!confirm('오늘 남은 송출을 이 병원에서 종료할까요?'))return;const {error}=await db.rpc('hospital_close_today',{p_site:targetSiteId});if(error)return toast(error.message,'error');toast('오늘 송출을 종료했습니다.');await load();});
    qs('#staffReopenToday')?.addEventListener('click',async()=>{const {error}=await db.rpc('hospital_reopen_today',{p_site:targetSiteId});if(error)return toast(error.message,'error');toast('오늘 송출을 다시 열었습니다.');await load();});
    qs('#staffPlaylistSelect')?.addEventListener('change',fillHospitalPlaylistEditor);
    qsa('[data-playlist-pick]').forEach(b=>b.addEventListener('click',()=>{const sel=qs('#staffPlaylistSelect');if(sel){sel.value=b.dataset.playlistPick;fillHospitalPlaylistEditor();qsa('[data-playlist-pick]').forEach(x=>x.classList.toggle('is-active',x.dataset.playlistPick===sel.value));qs('#staffPlaylistName')?.focus();}}));
    qs('[data-new-playlist]')?.addEventListener('click',()=>{const sel=qs('#staffPlaylistSelect');if(sel){sel.value='';fillHospitalPlaylistEditor();qsa('[data-playlist-pick]').forEach(x=>x.classList.remove('is-active'));qs('#staffPlaylistName')?.focus();}});
    qs('#staffSavePlaylist')?.addEventListener('click',saveHospitalPlaylist);
    qs('#staffDeletePlaylist')?.addEventListener('click',deleteHospitalPlaylist);
    fillHospitalPlaylistEditor();
    qsa('[data-staff-building-upload]').forEach(input=>input.addEventListener('change',()=>{const f=input.files?.[0];if(f)uploadBuildingImage(f);input.value='';}));qs('[data-staff-building-remove]')?.addEventListener('click',removeBuildingImage);qsa('[data-staff-floorplan-upload]').forEach(input=>input.addEventListener('change',()=>{const f=input.files?.[0];if(f)uploadFloorplan(Number(input.dataset.staffFloorplanUpload),f);input.value='';}));
    qsa('[data-staff-floorplan-reset]').forEach(b=>b.addEventListener('click',()=>resetFloorplan(Number(b.dataset.staffFloorplanReset))));
    qsa('[data-staff-floorplan-restore]').forEach(b=>b.addEventListener('click',()=>restoreHospitalFloorplan(Number(b.dataset.staffFloorplanRestore))));
    qsa('details').forEach(d=>d.addEventListener('toggle',()=>{if(d.open)loadFloorplanSvgs(d).catch(()=>{});}));
    bindFloorSpaceManager();bindDisplaySetup();loadBuildingImages(qs('#hospitalRoot')).catch(()=>{});if(tab==='settings')loadFloorplanSvgs(qs('#hospitalRoot')).catch(()=>{});
  }



  function broadcastPlaylistId(){const ids=(state.broadcast?.video_ids||[]).map(String);if(!ids.length)return '';return state.playlists.filter(p=>p.active!==false&&p.site_id===targetSiteId).find(p=>{const pids=state.playlistItems.filter(x=>x.playlist_id===p.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(x=>String(x.video_id));return pids.length===ids.length&&pids.every((id,i)=>id===ids[i]);})?.id||'';}
  function hospitalBroadcastCard(){const active=!!state.broadcast?.active,selected=broadcastPlaylistId(),own=state.playlists.filter(p=>p.active!==false&&p.site_id===targetSiteId);return `<section class="hospital-broadcast-card ${active?'is-active':''}"><div><small>병원 전체 송출</small><b>${active?'전체 디스플레이에 송출 중':'필요할 때만 전체 송출'}</b><p>선택한 병원 플레이리스트를 모든 원격 디스플레이에 우선 송출합니다.</p></div><div class="hospital-broadcast-actions"><select id="hospitalBroadcastPlaylist" ${active?'disabled':''}><option value="">${active&&selected?'송출 중인 플레이리스트':'플레이리스트 선택'}</option>${own.map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join('')}</select>${active?'<button class="btn danger" id="hospitalBroadcastStop">전체 송출 종료</button>':'<button class="btn primary" id="hospitalBroadcastStart">전체 송출 시작</button>'}</div></section>`;}
  async function setHospitalBroadcast(active){const playlist=qs('#hospitalBroadcastPlaylist')?.value||null;if(active&&!playlist)return toast('전체 송출할 플레이리스트를 선택하세요.','error');if(!confirm(active?'이 병원의 모든 원격 디스플레이에 전체 송출할까요?':'병원 전체 송출을 종료할까요?'))return;const {error}=await db.rpc('hospital_set_broadcast',{p_site:targetSiteId,p_active:active,p_playlist:playlist,p_notice:null});if(error)return toast(error.message||'전체 송출을 변경하지 못했습니다.','error');toast(active?'병원 전체 송출을 시작했습니다.':'병원 전체 송출을 종료했습니다.');await load();}

  function render(){
    const statuses=state.rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length;
    const issues=statuses.filter(x=>['error','update','offline','manual-warn'].includes(x.key)).length;
    const groups=groupedRooms();
    qsa('.nav-btn').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
    const siteLabel=qs('#hospitalSiteLabel');if(siteLabel)siteLabel.textContent=state.site?.name||'';
    const head=tab==='output'
      ? `<div class="hospital-output-hero"><div class="hospital-output-copy"><span class="eyebrow">${esc(state.site?.name||'병원')}</span><h1>원내 영상 송출</h1><p>진료실·대기실 디스플레이에서 지금 어떤 영상이 나가고 있는지 확인하고 필요한 곳만 바꿉니다.</p></div><div class="hospital-output-kpis"><div><span class="kpi-icon">▣</span><small>전체 디스플레이</small><b>${state.rooms.length}<em>대</em></b></div><div><span class="kpi-dot is-online"></span><small>현재 연결</small><b>${Math.max(0,state.rooms.length-offline)}<em>대</em></b></div><div class="${issues?'has-issue':''}"><span class="kpi-dot is-issue"></span><small>확인 필요</small><b>${issues}<em>대</em></b></div><button id="staffStatusRefresh" class="btn hospital-refresh-btn">새로고침</button></div></div>`
      : `<div class="reception-head reception-head-board hospital-simple-head"><div><span class="eyebrow">${esc(state.site?.name||'병원')}</span><h1>${tab==='videos'?'영상 · 플레이리스트':'병원 설정'}</h1><p>${tab==='videos'?'이 병원에서 송출할 플레이리스트와 재생 영상을 정리합니다.':'운영시간과 병원 정보는 위에서, 도면·공간·디스플레이 설정은 필요할 때만 아래에서 관리합니다.'}</p></div></div>`;
    let content='';
    if(tab==='output')content=`${staffBuildingOverview(groups)}<details class="hospital-output-tools"><summary><span><b>상세 관리</b><small>영상 순서나 세부 제어가 필요할 때만 엽니다.</small></span><em>${live}곳 송출 중</em></summary><div class="hospital-output-tools-body"><details class="staff-space-detail-drawer" open><summary><span><b>공간별 세부 관리</b><small>고급 제어가 필요한 경우에만 사용합니다.</small></span></summary><div class="staff-space-detail-body"><div class="staff-monitor-groups">${groups.map(groupCard).join('')}</div></div></details></div></details>`;
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
      ${displayControlMode(r)==='manual'?`<div class="manual-display-panel"><b>수동 디스플레이</b><p>${esc(r.display_note||'현장에서 직접 영상 재생 상태를 확인합니다.')}</p><button class="btn ${r.manual_check_status==='checked'?'':'primary'}" data-manual-check="${r.id}">${r.manual_check_status==='checked'?'미확인으로 변경':'오늘 확인 완료'}</button></div>`:`<details class="staff-output-details"><summary>송출 영상 목록</summary>${staffOutputList(r)}</details><div class="staff-output-controls"><div class="staff-output-row"><span>플레이리스트</span><select data-staff-playlist="${r.id}">${playlistOptions(r.default_playlist_id||'')}</select><button class="btn primary" data-staff-playlist-apply="${r.id}">변경</button></div><div class="staff-output-row"><span>영상 추가</span><select data-staff-video="${r.id}">${videoOptions()}</select><button class="btn" data-staff-video-add="${r.id}">추가</button>${manual?`<button class="btn" data-staff-manual-clear="${r.id}">기본으로</button>`:''}</div></div><div class="room-player-actions hospital-room-player-actions"><span>환자 화면</span><div><button class="btn small" data-staff-player-open="${r.id}">화면 열기</button><button class="btn small" data-staff-player-copy="${r.id}">링크 복사</button></div></div>`}
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
    qs('#staffStatusRefresh')?.addEventListener('click',()=>load().catch(e=>toast(e.message||String(e),'error')));qs('#hospitalBroadcastStart')?.addEventListener('click',()=>setHospitalBroadcast(true));qs('#hospitalBroadcastStop')?.addEventListener('click',()=>setHospitalBroadcast(false));qsa('[data-staff-open-settings]').forEach(b=>b.addEventListener('click',()=>{tab='settings';qsa('.nav-btn').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));renderPreservingUi(false);}));qsa('[data-staff-select-floor]').forEach(b=>{const open=()=>{selectedFloorId=selectedFloorId===b.dataset.staffSelectFloor?null:b.dataset.staffSelectFloor;renderPreservingUi(false);};b.addEventListener('click',open);b.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});});qsa('[data-staff-floor-room]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.staffFloorRoom,r=state.rooms.find(x=>x.id===id),inspector=qs('[data-staff-floor-zone-inspector]');if(r&&inspector){inspector.innerHTML=staffFloorRoomPreviewHtml(r);qsa('[data-staff-floor-room]').forEach(x=>x.classList.toggle('is-selected',x.dataset.staffFloorRoom===id));const open=qs('[data-staff-open-room-detail]',inspector);if(open)open.addEventListener('click',()=>{const drawer=qs('.staff-space-detail-drawer');if(drawer)drawer.open=true;requestAnimationFrame(()=>{const el=qs(`[data-room-card="${id}"]`);if(el){el.open=true;el.scrollIntoView({behavior:'smooth',block:'center'});}});});}}));
    qsa('#hospitalRoot select').forEach(el=>el.addEventListener('change',()=>{el.dataset.dirty='1';}));
    qsa('[data-staff-playlist-apply]').forEach(b=>b.addEventListener('click',()=>setRoomPlaylist(b.dataset.staffPlaylistApply)));
    qsa('[data-staff-player-open]').forEach(b=>b.addEventListener('click',()=>openRoomPlayer(b.dataset.staffPlayerOpen)));
    qsa('[data-staff-player-copy]').forEach(b=>b.addEventListener('click',()=>copyRoomPlayer(b.dataset.staffPlayerCopy)));
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
      const roomIds=state.rooms.map(r=>r.id).filter(Boolean);
      if(roomIds.length)signalChannel=db.channel(`clinic-hospital-signal:${state.site?.id||'unknown'}`).on('postgres_changes',{event:'*',schema:'public',table:'player_control_signals',filter:`room_id=in.(${roomIds.join(',')})`},scheduleStaffStateReload).subscribe();
      statusWakeChannel=db.channel(`clinic-signage-status:${state.site?.id||'unknown'}`)
        .on('broadcast',{event:'changed'},({payload})=>queueLiveRoomRefresh(payload?.room_id))
        .subscribe();
    }catch(_){}
  }

  try{await load();startRealtime();monitor.start(Signage.cfg.livePollMs);}catch(e){qs('#hospitalRoot').innerHTML=`<p class="error">${esc(e.message||e)}</p>`;}
  const uiTimer=setInterval(()=>{if(document.hidden)return;state.rooms.forEach(updateStaffRoomDom);paintStaffSummary();},1000);
  window.addEventListener('beforeunload',()=>{clearInterval(uiTimer);clearTimeout(stateReloadTimer);statusWakeTimers.forEach(clearTimeout);monitor.stop();try{if(signalChannel)db.removeChannel(signalChannel);if(statusWakeChannel)db.removeChannel(statusWakeChannel);}catch(_){}});
})();
