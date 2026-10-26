(async function () {
  'use strict';
  const { db, qs, qsa, esc, toast, formatBytes, formatDuration, titleFromPath } = Signage;
  await Signage.requireAuth('admin');
  qs('#signOut').addEventListener('click', Signage.signOut);

  const AGE_OPTIONS=[['teen','10대 이하'],['20-30','20~30대'],['40-50','40~50대'],['60+','60대 이상']];
  const GENDER_OPTIONS=[['female','여성'],['male','남성']];
  const TREATMENT_OPTIONS=[['minish','미니쉬'],['implant','임플란트'],['whitening','미백'],['orthodontics','교정'],['checkup','검진'],['aftercare','수술 후 관리'],['general','일반 진료']];
  const GROUP_KINDS=[['floor','층'],['zone','구역'],['consultation','구역'],['waiting','구역'],['vip','VIP'],['other','기타']];
  const ROOM_MODES=[['treatment','진료실'],['consultation','상담실'],['waiting','대기실'],['lounge','라운지'],['reception','접수/안내'],['lobby','로비'],['public','공용 모니터'],['staff','스탭 공간'],['vip','VIP'],['other','기타']];
  const CONTROL_MODES=[['remote','원격 제어'],['manual','수동 운영'],['hybrid','하이브리드']];
  const FLOOR_SPACE_TYPES=[['treatment','진료실'],['consultation','상담실'],['waiting','대기'],['lounge','라운지'],['reception','접수/안내'],['lobby','로비'],['staff','스탭'],['support','지원'],['public','공용'],['other','기타']];
  const MAX_EMERGENCY_BYTES=250*1024*1024;
  // Single source of truth: /player-release.json (the same file players poll for updates).
  const PLAYER_VERSION=(await Signage.fetchPlayerRelease())||String(window.CLINIC_SIGNAGE_VERSION||'2.30.0');
  // datetime-local is local wall-clock time; avoid UTC conversion shifting KST by 9 hours.
  const toLocalInput=(value)=>{if(!value)return '';const d=new Date(value);if(Number.isNaN(d.getTime()))return '';const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;};

  const scopedHospitalMode=location.pathname==='/hospital.html';
  let tab='dashboard', storageHealth=null, loadSeq=0, uploadBusy=false, groupSaveBusy=false, issuesOnly=false, dashboardView='building', selectedFloorId=null, buildingPeriod='live', spaceEditorGroupId=null, hospitalSearch='', hospitalFilter='all', hospitalFocusOpen=scopedHospitalMode;
  const localDateKey=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  let state={rooms:[],allRooms:[],videos:[],playlists:[],playlistItems:[],roomRules:[],groups:[],groupBroadcasts:[],schedules:[],history:[],broadcast:null,settings:{emergency_video_id:null},playbackToday:null,building7d:null,sites:[],currentSite:null,siteSettings:null,floorSpaces:[],floorplanVersions:[],audit:[]};
  let controlSignalChannel=null,statusWakeChannel=null,spatialRefreshTimer=null;
  const statusWakeTimers=new Map();
  // roomId -> {status:'pending'|'unconfirmed'|'error', at:issuedAtServerMs}
  const ackState=new Map();
  const monitor=Signage.createLiveMonitor({onUpdate:(res)=>applyLiveResult(res)});
  let liveRefreshBusy=false,liveControlBusy=false,liveControlSig='';

  qsa('.nav-btn').forEach((b)=>b.addEventListener('click',()=>{tab=b.dataset.tab;qsa('.nav-btn').forEach((x)=>x.classList.toggle('active',x===b));render();}));

  async function load(){
    const seq=++loadSeq;
    const [rooms,liveStatuses,videos,playlists,playlistItems,roomRules,groups,groupBroadcasts,schedules,historyRes,broadcast,settings,sites,siteSettings,floorSpaces,floorplanVersions,audit]=await Promise.all([
      db.from('rooms').select('*').order('sort_order').order('created_at'),
      monitor.loadAll().then(data=>({data,error:null}),error=>({data:null,error})),
      db.from('videos').select('*').order('created_at',{ascending:false}),
      db.from('playlists').select('*').order('sort_order').order('created_at'),
      db.from('playlist_items').select('*').order('sort_order').order('created_at'),
      db.from('room_video_rules').select('*'),
      db.from('signage_groups').select('*').order('sort_order').order('created_at'),
      db.from('group_broadcasts').select('*'),
      db.from('broadcast_schedules').select('*').order('starts_at',{ascending:true}),
      db.from('control_history').select('*').order('created_at',{ascending:false}).limit(20),
      db.from('broadcast').select('*').eq('id',1).maybeSingle(),
      db.from('app_settings').select('*').eq('id',1).maybeSingle(),
      db.from('sites').select('*').order('created_at'),
      db.from('site_settings').select('*'),
      db.from('floor_spaces').select('*').order('sort_order').order('created_at'),
      db.from('floorplan_versions').select('*').order('created_at',{ascending:false}),
      db.from('audit_log').select('*').order('created_at',{ascending:false}).limit(50)
    ]);
    const errors=[rooms.error,liveStatuses.error,videos.error,playlists.error,playlistItems.error,roomRules.error,groups.error,groupBroadcasts.error,schedules.error,historyRes.error,broadcast.error,settings.error,sites.error,siteSettings.error,floorSpaces.error,floorplanVersions.error,audit.error].filter(Boolean);
    if(errors.length)throw errors[0]; if(seq!==loadSeq)return;
    const liveByRoom=new Map((liveStatuses.data?.rows||[]).map(x=>[x.room_id,x]));
    const mergedRooms=(rooms.data||[]).map(r=>{const live=liveByRoom.get(r.id);return live?{...r,last_seen_at:live.last_seen_at||r.last_seen_at,player_status:live.player_status||r.player_status}:r;});
    const siteList=sites.data||[],defaultSite=siteList.find(x=>x.code==='default')||siteList[0]||null;
    const urlSlug=new URLSearchParams(location.search).get('site')||'';
    const savedSite=localStorage.getItem('clinic_signage_superadmin_site')||'';
    const currentSite=siteList.find(x=>String(x.code||'')===urlSlug)||siteList.find(x=>x.id===savedSite)||defaultSite;
    if(currentSite?.id)localStorage.setItem('clinic_signage_superadmin_site',currentSite.id);
    if(location.search){const canonical=new URL('/admin.html',location.origin);window.history.replaceState(null,'',canonical.pathname);}
    const analyticsArgs=currentSite?.id?{p_site:currentSite.id}:{};
    const [playbackToday,building7d]=await Promise.all([
      db.rpc('admin_playback_today',analyticsArgs).then(r=>r.error?null:r.data).catch(()=>null),
      db.rpc('admin_building_period_stats',{p_days:7,...analyticsArgs}).then(r=>r.error?null:r.data).catch(()=>null)
    ]);
    const sid=currentSite?.id||null,siteSetting=(siteSettings.data||[]).find(x=>x.site_id===sid)||null;
    const filteredRooms=sid?mergedRooms.filter(r=>!r.site_id||r.site_id===sid):mergedRooms,filteredGroups=sid?(groups.data||[]).filter(g=>!g.site_id||g.site_id===sid):(groups.data||[]);
    const filteredVideos=(videos.data||[]).filter(v=>!v.site_id||!sid||v.site_id===sid),filteredPlaylists=(playlists.data||[]).filter(p=>!p.site_id||!sid||p.site_id===sid),playlistIds=new Set(filteredPlaylists.map(p=>p.id)),roomIds=new Set(filteredRooms.map(r=>r.id));
    const filteredItems=(playlistItems.data||[]).filter(x=>playlistIds.has(x.playlist_id)),filteredRules=(roomRules.data||[]).filter(x=>roomIds.has(x.room_id));
    const mergedSettings={...(settings.data||{emergency_video_id:null}),site_name:currentSite?.name||settings.data?.site_name,building_label:currentSite?.building_label||settings.data?.building_label,floorplan_assets:siteSetting?.floorplan_assets||settings.data?.floorplan_assets||{}};
    state={rooms:filteredRooms,allRooms:mergedRooms,videos:filteredVideos,playlists:filteredPlaylists,playlistItems:filteredItems,roomRules:filteredRules,groups:filteredGroups,groupBroadcasts:groupBroadcasts.data||[],schedules:schedules.data||[],history:historyRes.data||[],broadcast:broadcast.data||{id:1,active:false,video_ids:[]},settings:mergedSettings,playbackToday:playbackToday||null,building7d:building7d||null,sites:siteList,currentSite,siteSettings:siteSetting,floorSpaces:(floorSpaces.data||[]).filter(x=>!sid||x.site_id===sid),floorplanVersions:(floorplanVersions.data||[]).filter(x=>!sid||x.site_id===sid),audit:(audit.data||[]).filter(x=>!sid||!x.site_id||x.site_id===sid)};
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
  function uploadByXhr(url,file,contentType,onProgress){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open('PUT',url,true);
      xhr.setRequestHeader('Content-Type',contentType||'video/mp4');
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
  const modeLabel=(m)=>({broadcast:'전체',broadcast_schedule:'전체 예약',manual:'개별',group:'층·구역',group_schedule:'층·구역 예약',patient:'맞춤',session:'맞춤',default:'기본',emergency:'비상',closed:'운영시간 외'})[m]||m||'기본';
  const priorityLabel=(m)=>({broadcast:'전체',broadcast_schedule:'예약',manual:'개별',group:'층·구역',group_schedule:'예약',patient:'개별 맞춤',session:'개별 맞춤',default:'기본',emergency:'비상',closed:'운영시간 외'})[m]||'기본';
  const windowPhase=(active,start,end)=>{if(!active)return 'off';const now=Date.now(),st=start?new Date(start).getTime():null,en=end?new Date(end).getTime():null;if(st&&st>now)return 'scheduled';if(en&&en<=now)return 'ended';return 'live';};
  const broadcastPhase=()=>windowPhase(!!state.broadcast?.active,state.broadcast?.starts_at,state.broadcast?.ends_at);
  const manualPhase=(r)=>windowPhase(!!r?.manual_active,r?.manual_starts_at,r?.manual_ends_at);
  const manualIsEffective=(r)=>manualPhase(r)==='live';
  const timeWindowText=(start,end)=>{const fmt=v=>v?new Date(v).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';if(start&&end)return `${fmt(start)} → ${fmt(end)}`;if(start)return `${fmt(start)}부터`;if(end)return `${fmt(end)}까지`;return '직접 종료';};
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
  function roomPlaylistOptions(selected=''){
    const list=state.playlists.filter(p=>p.active).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)||String(a.name).localeCompare(String(b.name),'ko'));
    return `<option value="">플레이리스트 선택</option>${list.map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}${p.kind==='patient'?' · 맞춤':''}</option>`).join('')}`;
  }
  function optionChips(kind,selected=[],options=[]){const allLabel=kind==='target_treatment'?'공통':'전체';return `<button type="button" class="chip ${!selected.length?'on':''}" data-target-kind="${kind}" data-target-value="">${allLabel}</button>${options.map(([v,l])=>`<button type="button" class="chip ${selected.includes(v)?'on':''}" data-target-kind="${kind}" data-target-value="${v}">${esc(l)}</button>`).join('')}`;}
  const videoOptions=(selected='')=>`<option value="">영상 선택</option>${activeVideos().map(v=>`<option value="${v.id}" ${selected===v.id?'selected':''}>${esc(v.title)}</option>`).join('')}`;
  const roomRules=(roomId)=>state.roomRules.filter(x=>x.room_id===roomId);
  const roomHealth=(r)=>Signage.roomHealth(r,monitor.serverNow());
  const adminIsOnline=(r)=>displayControlMode(r)==='manual'?true:roomHealth(r)!=='offline';
  const playerVersion=(r)=>String(r?.player_status?.app_version||'').trim();
  const playerNeedsUpdate=(r)=>{const v=playerVersion(r);return !!v&&v!==PLAYER_VERSION;};
  const outdatedRooms=()=>state.rooms.filter(playerNeedsUpdate);
  function randomReloadNonce(){
    try{return crypto.getRandomValues(new Uint32Array(1))[0]&0x7fffffff;}
    catch(_){return Math.floor(Math.random()*0x7fffffff);}
  }
  const displayControlMode=(r)=>String(r?.display_control_mode||'remote');
  const displayControlLabel=(r)=>CONTROL_MODES.find(([v])=>v===displayControlMode(r))?.[1]||'원격 제어';
  function roomDisplayStatus(r){
    const mode=displayControlMode(r);
    if(mode==='manual')return r.manual_check_status==='checked'?{key:'manual',label:'수동 운영'}:{key:'manual-warn',label:'수동 확인 필요'};
    const h=roomHealth(r),st=r.player_status||{},play=String(st.playback_state||'').toLowerCase(),ack=ackState.get(r.id);
    if(h==='offline')return {key:'offline',label:mode==='hybrid'?'원격 연결 끊김':'오프라인'};
    if(playerNeedsUpdate(r)||st.update_pending_version||st.update_error)return {key:'update',label:'업데이트 필요'};
    if(ack?.status==='error'||ack?.status==='unconfirmed'||h==='error'||h==='recovering'||st.error||st.offline_cache_error||Number(st.failed_video_count||0)>0)return {key:'error',label:'오류'};
    if(st.mode==='closed'||play==='closed'||r.paused||play==='paused'||ack?.status==='pending'||h==='delayed')return {key:'idle',label:'대기'};
    if(['playing','emergency'].includes(play))return {key:'live',label:'송출 중'};
    return {key:'idle',label:'대기'};
  }

  function roomIssueReason(r){
    const h=roomHealth(r),st=r.player_status||{},ack=ackState.get(r.id),play=String(st.playback_state||'').toLowerCase();
    if(displayControlMode(r)==='manual')return r.manual_check_status==='checked'?'수동 점검 완료':'수동 점검 필요';
    if(h==='offline')return displayControlMode(r)==='hybrid'?'원격 연결 끊김 · 수동 운영 가능':'플레이어 연결 끊김';
    if(st.update_error)return '자동 업데이트 확인 실패';
    if(playerNeedsUpdate(r)||st.update_pending_version)return `플레이어 업데이트 필요 · ${PLAYER_VERSION}`;
    if(st.offline_cache_error)return `오프라인 캐시 오류 · ${String(st.offline_cache_error).slice(0,60)}`;
    if(Number(st.failed_video_count||0)>0)return `재생 실패 영상 ${Number(st.failed_video_count||0)}개 자동 건너뜀`;
    if(st.error)return String(st.error).slice(0,80);
    if(ack?.status==='error'||ack?.status==='unconfirmed')return '최근 송출 변경 적용 확인 실패';
    if(h==='recovering')return '플레이어 자동 복구 중';
    if(st.mode==='closed'||play==='closed')return '운영시간 외 검정 대기';
    if(r.paused||play==='paused')return '일시정지';
    return '';
  }
  function buildingPeriodRoomStat(roomId){
    if(buildingPeriod==='today')return (state.playbackToday?.rooms||[]).find(x=>x.room_id===roomId)||null;
    if(buildingPeriod==='7d')return (state.building7d?.rooms||[]).find(x=>x.room_id===roomId)||null;
    return null;
  }
  function floorPeriodSummary(g,rooms){
    if(buildingPeriod==='live')return groupStatusSummary(rooms);
    if(buildingPeriod==='today'&&!state.playbackToday)return {key:'idle',label:'통계 준비 중',rate:0,errors:0,reconnects:0,total:rooms.length,live:0,issues:0,offline:0,unavailable:true};
    if(buildingPeriod==='7d'&&!state.building7d)return {key:'idle',label:'통계 준비 중',rate:0,errors:0,reconnects:0,total:rooms.length,live:0,issues:0,offline:0,unavailable:true};
    const stats=rooms.map(r=>buildingPeriodRoomStat(r.id)).filter(Boolean),total=rooms.length;
    const playing=stats.reduce((a,x)=>a+Number(x.playing_seconds||0),0),planned=stats.reduce((a,x)=>a+Number(x.planned_seconds||0),0),errors=stats.reduce((a,x)=>a+Number(x.error_count||0),0),reconnects=stats.reduce((a,x)=>a+Number(x.reconnect_count||0),0);
    const rate=planned>0?Math.min(100,playing*100/planned):0;
    const key=errors>0?'issue':rate>=95?'live':rate>0?'idle':'offline';
    return {key,label:errors?`오류 ${errors}`:`${rate.toFixed(0)}%`,rate,errors,reconnects,total,live:0,issues:errors,offline:0};
  }
  function groupDisplayName(group){
    const name=String(group?.name||'미분류').trim();
    return group?.kind==='floor'&&/^\d+$/.test(name)?`${name}층`:name;
  }
  function groupStatusSummary(rooms){
    const statuses=rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length;
    const manual=statuses.filter(x=>x.key==='manual').length,manualNeedsCheck=statuses.filter(x=>x.key==='manual-warn').length;
    const issues=statuses.filter(x=>['error','update','offline','manual-warn'].includes(x.key)).length;
    const online=rooms.filter(r=>displayControlMode(r)!=='manual').length-offline;
    let key='idle',label='대기';
    if(!rooms.length){key='idle';label='공간 없음';}
    else if(offline===rooms.length){key='offline';label='오프라인';}
    else if(issues>0){key='issue';label='확인 필요';}
    else if(live>0){key='live';label='송출 중';}
    else if(manual>0){key='manual';label='수동 운영';}
    return {live,offline,manual,manualNeedsCheck,issues,online,total:rooms.length,key,label};
  }
  function patientPlaylistForRoom(r){const matches=state.playlists.filter(p=>p.active&&p.kind==='patient'&&(!(p.target_treatment||[]).length||(r.session_treatment&&(p.target_treatment||[]).includes(r.session_treatment)))&&(!(p.target_age||[]).length||(r.session_age_group&&(p.target_age||[]).includes(r.session_age_group)))&&(!(p.target_gender||[]).length||(r.session_gender&&(p.target_gender||[]).includes(r.session_gender))));return matches.sort((a,b)=>(((b.target_treatment||[]).length?100:0)+((b.target_age||[]).length?10:0)+((b.target_gender||[]).length?5:0))-(((a.target_treatment||[]).length?100:0)+((a.target_age||[]).length?10:0)+((a.target_gender||[]).length?5:0))||(a.sort_order||0)-(b.sort_order||0))[0]||null;}
  function roomBaseVideoIds(r){const mode=String(r.player_status?.mode||'');if(['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(mode)){const live=Array.isArray(r.player_status?.playlist_video_ids)?r.player_status.playlist_video_ids.filter(Boolean):[];if(live.length)return live;}if(manualIsEffective(r)&&Array.isArray(r.manual_video_ids)&&r.manual_video_ids.length)return r.manual_video_ids;if(mode==='patient'){const pp=patientPlaylistForRoom(r);if(pp)return playlistItems(pp.id).map(x=>x.video_id);}const fallback=r.default_playlist_id||groupById(r.group_id)?.default_playlist_id||state.playlists.filter(p=>p.active&&p.kind==='default').sort((a,b)=>(a.sort_order||0)-(b.sort_order||0))[0]?.id;return playlistItems(fallback).map(x=>x.video_id);}
  function roomOutputItems(r){
    const ids=roomBaseVideoIds(r);
    const rules=new Map(roomRules(r.id).map(x=>[x.video_id,x]));
    const now=Date.now();
    return ids.map((id,idx)=>{const video=state.videos.find(v=>v.id===id),rule=rules.get(id),ruleEnabled=rule?.enabled!==false;const scheduledOn=(!rule?.starts_at||new Date(rule.starts_at).getTime()<=now)&&(!rule?.ends_at||new Date(rule.ends_at).getTime()>now);return {id,video,rule,baseIndex:idx,ruleEnabled,scheduledOn,enabled:ruleEnabled&&scheduledOn};}).filter(x=>x.video).sort((a,b)=>(a.rule?.sort_order??((a.baseIndex+1)*10))-(b.rule?.sort_order??((b.baseIndex+1)*10))||a.baseIndex-b.baseIndex);
  }
  function thumb(v){return v?.thumbnail_data_url?`<img loading="lazy" decoding="async" src="${esc(v.thumbnail_data_url)}" alt="">`:`<span>${esc((v?.title||'VIDEO').slice(0,2))}</span>`;}
  function roomVideoStripHtml(r){
    const ids=roomBaseVideoIds(r).filter(Boolean);
    const videos=ids.map(id=>state.videos.find(v=>v.id===id)).filter(Boolean);
    if(!videos.length)return '<div class="floor-video-strip-empty">송출 예정 영상이 없습니다.</div>';
    return `<div class="floor-video-strip" aria-label="${esc(r.name)} 송출 영상">${videos.slice(0,12).map((v,i)=>`<div class="floor-video-thumb" title="${esc(v.title)}"><div>${thumb(v)}</div><small>${i+1}. ${esc(v.title)}</small></div>`).join('')}${videos.length>12?`<span class="floor-video-more">+${videos.length-12}</span>`:''}</div>`;
  }
  function roomPreviewVideo(r){
    const liveId=String(r?.player_status?.video_id||'').trim();
    if(liveId){const live=state.videos.find(v=>v.id===liveId);if(live)return live;}
    return roomOutputItems(r).find(x=>x.enabled)?.video||roomOutputItems(r)[0]?.video||null;
  }
  function roomPlaybackReason(r){
    const g=groupById(r?.group_id),reason=String(g?.signage_reason||'').trim(),purpose=String(g?.signage_purpose||'').trim(),audience=String(g?.target_audience||'').trim();
    if(reason)return reason;
    if(audience&&purpose)return `${audience}에게 ${purpose}를 위해 재생합니다.`;
    if(purpose)return `${purpose}를 위해 재생합니다.`;
    return '이 공간에 맞게 설정된 영상을 재생합니다.';
  }
  function floorRoomPreviewHtml(r){
    const st=roomDisplayStatus(r),video=roomPreviewVideo(r),online=displayControlMode(r)==='manual'||adminIsOnline(r),label=displayControlMode(r)==='manual'?'현장 운영':online?'현재 재생 중':'설정된 영상';
    return `<div class="floor-room-focus"><div class="floor-room-focus-head"><div><span>${esc(roomModeLabel(r.room_mode))}</span><b>${esc(r.name)}</b></div><em class="status-${st.key}">${esc(st.label)}</em></div><div class="floor-room-current"><div class="floor-room-current-thumb">${video?thumb(video):'<span>영상 없음</span>'}</div><div class="floor-room-current-copy"><small>${esc(label)}</small><b>${esc(video?.title||'등록된 영상이 없습니다.')}</b></div></div><div class="floor-room-why"><small>왜 이 영상이 나오나요?</small><p>${esc(roomPlaybackReason(r))}</p></div><button type="button" class="btn primary floor-room-preview-open" data-open-room-detail="${r.id}">영상 바꾸기</button></div>`;
  }
  function roomOutputListHtml(r,staff=false){
    const items=roomOutputItems(r);if(!items.length)return '<div class="room-output-empty">재생 가능한 영상이 없습니다.</div>';
    return `<div class="room-output-list">${items.map((x,i)=>`<div class="room-output-item ${x.enabled?'':'is-disabled'}"><div class="room-output-thumb">${thumb(x.video)}</div><div class="room-output-copy"><b>${esc(x.video.title)}</b><small>${formatDuration(x.video.duration_sec||0)}${x.rule?.starts_at||x.rule?.ends_at?(x.scheduledOn?' · 예약 적용':' · 예약 대기'):''}</small></div><label class="switch"><input type="checkbox" data-room-video-toggle="${r.id}" data-video-id="${x.id}" ${x.ruleEnabled?'checked':''} ${['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(String(r.player_status?.mode||''))?'disabled':''}><i></i></label><div class="room-output-order"><button data-room-video-move="${r.id}" data-video-id="${x.id}" data-dir="-1" ${i===0?'disabled':''}>↑</button><button data-room-video-move="${r.id}" data-video-id="${x.id}" data-dir="1" ${i===items.length-1?'disabled':''}>↓</button></div>${staff?'':`<details class="room-video-schedule"><summary>기간</summary><div><input type="datetime-local" data-rule-start="${r.id}:${x.id}" value="${toLocalInput(x.rule?.starts_at)}"><span>–</span><input type="datetime-local" data-rule-end="${r.id}:${x.id}" value="${toLocalInput(x.rule?.ends_at)}"><button class="btn small" data-rule-save="${r.id}" data-video-id="${x.id}">저장</button></div></details>`}</div>`).join('')}</div>`;
  }
  function contentWarnings(){return state.rooms.map(r=>{const items=roomOutputItems(r).filter(x=>x.enabled),known=items.filter(x=>Number(x.video.duration_sec)>0),sec=known.reduce((s,x)=>s+Number(x.video.duration_sec||0),0);if(items.length===0)return `${r.name}: 재생 영상 없음`;if(items.length===1)return `${r.name}: 재생 영상 1개`;if(known.length===items.length&&sec<180)return `${r.name}: 전체 길이 ${Math.ceil(sec/60)}분 미만`;return null;}).filter(Boolean);}
  const CARE_TYPES=[['general','일반진료'],['minish','MINISH'],['common','공용'],['support','지원'],['other','기타']];
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

  const careTypeLabel=(v)=>CARE_TYPES.find(([id])=>id===v)?.[1]||'미설정';
  const floorNumber=(g)=>Number(g?.floor_number||(/^\d+$/.test(String(g?.name||'').trim())?String(g.name).trim():String(g?.name||'').match(/(\d+)/)?.[1]||0));
  const floorTitle=(g)=>{const n=floorNumber(g);return n?`${n}F`:groupDisplayName(g);};
  function roomMapPlaced(r){if(r?.map_x_pct==null||r?.map_y_pct==null||r.map_x_pct===''||r.map_y_pct==='')return false;const x=Number(r.map_x_pct),y=Number(r.map_y_pct);return Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&x<=100&&y>=0&&y<=100;}
  const floorplanAssets=()=>state.settings?.floorplan_assets&&typeof state.settings.floorplan_assets==='object'?state.settings.floorplan_assets:{};
  const floorplanMeta=(floor)=>floorplanAssets()?.[String(Math.trunc(Number(floor)))]||null;
  const floorplanVersionsFor=(floor)=>state.floorplanVersions.filter(v=>Number(v.floor_number)===Number(floor)).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const floorplanKey=(floor)=>String(floorplanMeta(floor)?.key||'').trim();
  const floorAsset=(g)=>{const n=floorNumber(g);return n&&!!floorplanKey(n)?n:null;};
  const floorplanTextCache=new Map();
  const zoneTypeLabel=(v)=>({treatment:'진료',consult:'상담',waiting:'대기',reception:'안내',support:'지원',office:'사무',common:'공용'})[v]||'공간';
  function zoneRoomsForBounds(bounds){
    const nums=String(bounds||'').split(',').map(Number);if(nums.length!==4||nums.some(Number.isNaN))return [];
    const [x,y,w,h]=nums;return state.rooms.filter(r=>roomMapPlaced(r)&&Number(r.map_x_pct)>=x&&Number(r.map_x_pct)<=x+w&&Number(r.map_y_pct)>=y&&Number(r.map_y_pct)<=y+h);
  }
  function bindFloorZoneInteractions(stage){
    if(!stage||stage.dataset.zoneBound==='1')return;stage.dataset.zoneBound='1';
    const zones=qsa('.floor-zone',stage),inspector=stage.closest('.floor-map-card')?.querySelector('[data-floor-zone-inspector]');
    const selectZone=(zone)=>{zones.forEach(z=>z.classList.toggle('is-selected',z===zone));if(!inspector)return;const label=zone.dataset.zoneLabel||'공간',type=zoneTypeLabel(zone.dataset.zoneType),rooms=zoneRoomsForBounds(zone.dataset.zoneBounds);const roomText=rooms.length?rooms.map(r=>{const st=roomDisplayStatus(r);return `${r.name} · ${st.label}`;}).join(' / '):'이 공간에 배치된 디스플레이가 없습니다.';inspector.innerHTML=`<div><span>${esc(type)}</span><b>${esc(label)}</b></div><p>${esc(roomText)}</p>`;};
    zones.forEach(zone=>{zone.addEventListener('click',e=>{e.stopPropagation();selectZone(zone);});zone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectZone(zone);}});});
  }
  async function hydrateFloorplanImages(){
    const hosts=qsa('[data-floorplan-svg]');
    await Promise.all(hosts.map(async host=>{const floor=Number(host.dataset.floorplanSvg);if(!floor||host.dataset.loaded==='1')return;try{let text=floorplanTextCache.get(floor);if(!text){const key=floorplanKey(floor);const params=new URLSearchParams({floor:String(floor),v:'2.34.4'});if(key)params.set('key',key);if(state.currentSite?.id)params.set('siteId',state.currentSite.id);const response=await fetch(`/api/floorplan?${params}`,{headers:apiHeaders(),cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);text=await response.text();floorplanTextCache.set(floor,text);}if(document.contains(host)){host.innerHTML=text;host.dataset.loaded='1';bindFloorZoneInteractions(host.closest('.floor-plan-stage'));}}catch(_){host.innerHTML=`<span class="floor-plan-error">${floor}층 평면도를 불러오지 못했습니다.</span>`;host.closest('.floor-plan-stage,.settings-map-stage')?.classList.add('floorplan-load-error');}}));
  }
  function floorMapMarker(r,editor=false){
    if(!roomMapPlaced(r))return '';
    const x=Number(r.map_x_pct),y=Number(r.map_y_pct),st=roomDisplayStatus(r),mode=String(r.room_mode||'other');
    if(editor)return `<button type="button" class="display-position-marker control-${displayControlMode(r)} status-${st.key}" style="left:${x}%;top:${y}%" data-display-marker="${r.id}" title="${esc(r.name)} · ${esc(roomModeLabel(r.room_mode))} · ${esc(displayControlLabel(r))}" aria-label="${esc(r.name)} 디스플레이 위치"><span class="display-position-dot"></span></button>`;
    return `<button class="floor-display-pin control-${displayControlMode(r)} status-${st.key}" style="left:${x}%;top:${y}%" data-floor-room="${r.id}" title="${esc(r.name)} · ${esc(st.label)}" aria-label="${esc(r.name)} · ${esc(st.label)}"><span class="display-screen-icon"></span><span class="floor-display-dot"></span></button>`;
  }
  const floorPurposeLine=(g)=>[careTypeLabel(g?.care_type),g?.signage_purpose].filter(Boolean).join(' · ');
  const floorPlaylistName=(g)=>playlistById(g?.default_playlist_id)?.name||'';
  function floorSummaryCard(g,rooms){
    const sum=floorPeriodSummary(g,rooms),n=floorNumber(g),purpose=floorPurposeLine(g)||'송출 목적 미설정',audience=g?.target_audience||'대상 미설정',reason=g?.signage_reason||'송출 이유 미설정';
    const statusLine=buildingPeriod==='live'?`${sum.live} 송출 · ${sum.issues} 문제 · ${sum.offline} 오프라인`:sum.unavailable?'통계 준비 중':`재생률 ${Number(sum.rate||0).toFixed(0)}% · 오류 ${sum.errors||0} · 재연결 ${sum.reconnects||0}`;
    return `<button class="building-floor-row floor-state-${sum.key}" data-open-floor="${g.id}"><span class="building-floor-no">${n?`${n}F`:esc(groupDisplayName(g))}</span><span class="building-floor-copy"><b>${esc(purpose)}</b><small>${esc(audience)} · ${esc(reason)}</small><em>${esc(statusLine)}</em></span><span class="room-status-badge status-${sum.key}">${esc(sum.label)}</span></button>`;
  }
  function buildingStackFloor(n,g){
    const rooms=g?state.rooms.filter(r=>r.group_id===g.id):[],sum=g?floorPeriodSummary(g,rooms):{key:'idle',issues:0,offline:0,live:0,total:0,label:'비운영'};
    const def=FLOOR_DEFAULTS[n]||{kind:'기타',name:'공간'},active=g&&(issuesOnly?sum.issues>0||sum.offline>0:true);
    const rawName=String(g?.name||'').trim(),shortName=(rawName&&!/^\d+$/.test(rawName))?rawName.replace(new RegExp(`^${n}\\s*(층|F)?\\s*`,'i'),'').trim():def.name;
    const status=!g?'비운영':buildingPeriod==='live'?(sum.issues||sum.offline?'확인 필요':sum.live?'정상':'대기'):(sum.unavailable?'준비 중':`재생률 ${Number(sum.rate||0).toFixed(0)}%`);
    const cls=`building-stack-floor floor-state-${sum.key}${g?'':' is-unmanaged'}${g&&!active?' is-muted':''}${selectedFloorId===g?.id?' is-selected':''}`;
    if(!g)return `<div class="${cls}" aria-hidden="true"><b>${n}층</b><span>${esc(shortName)}</span><em>비운영</em><i aria-hidden="true"></i></div>`;
    return `<button type="button" class="${cls}" data-building-select-floor="${g.id}" aria-label="${n}층 ${esc(shortName)} ${esc(status)}"><b>${n}층</b><span>${esc(shortName)}</span><em>${esc(status)}</em><i aria-hidden="true"></i></button>`;
  }
    function buildingFloorPanelMarkup(g){
    if(!g)return `<section class="building-plan-pane is-empty"><div><h3>층을 선택하세요</h3><p>확인할 층을 누르면 도면과 디스플레이 위치가 바로 표시됩니다.</p></div></section>`;
    const rooms=state.rooms.filter(r=>r.group_id===g.id),sum=groupStatusSummary(rooms),asset=floorAsset(g),unplaced=rooms.filter(r=>!roomMapPlaced(r));
    const def=FLOOR_DEFAULTS[floorNumber(g)]||{name:'공간'};
    const floorState=sum.issues||sum.offline?'확인 필요':sum.live?'정상':'대기';
    return `<section class="building-plan-pane">
      <div class="building-plan-head">
        <div><h3>${esc(floorTitle(g))} · ${esc(g.name||def.name)}</h3><p>도면에서 디스플레이를 누르면 현재 영상과 송출 이유를 확인할 수 있습니다.</p></div>
        <div class="building-plan-status status-${sum.key}"><i></i><b>${esc(floorState)}</b><small>${sum.total}대</small></div>
      </div>
      ${asset?`<div class="building-floorplan-wrap floor-activation-shell"><div class="floor-plan-stage building-floor-plan-stage is-floor-activating"><div class="floorplan-svg-host" data-floorplan-svg="${asset}"></div>${state.floorSpaces.filter(x=>x.group_id===g.id).map(x=>floorSpaceOverlay(x)).join('')}${rooms.map(floorMarker).join('')}</div><div class="floor-zone-inspector building-zone-inspector" data-floor-zone-inspector><div class="floor-zone-inspector-empty"><div><span>디스플레이 선택</span><b>도면에서 TV를 눌러보세요.</b></div><p>현재 나오는 영상과 이 영상이 나오는 이유를 바로 확인할 수 있습니다.</p></div></div></div>`:`<div class="floor-plan-empty floor-plan-empty-action"><b>도면이 없습니다.</b><span>설정에서 이 층의 도면을 등록하세요.</span><button type="button" class="btn small" data-go-floorplan-settings>도면 등록</button></div>`}
      ${unplaced.length?`<div class="building-plan-foot"><span>도면에 위치가 없는 디스플레이 ${unplaced.length}대</span></div>`:''}
    </section>`;
  }
  function buildingDashboardMarkup(){
    const groupsByFloor=new Map(state.groups.filter(g=>floorNumber(g)>=1&&floorNumber(g)<=14).map(g=>[floorNumber(g),g]));
    const managed=[...groupsByFloor.values()];
    const issueFloors=managed.filter(g=>{const s=groupStatusSummary(state.rooms.filter(r=>r.group_id===g.id));return s.issues>0||s.offline>0;}).length;
    const current=groupById(selectedFloorId);
    if(!current||!groupsByFloor.has(floorNumber(current))){
      const firstIssue=managed.find(g=>{const s=groupStatusSummary(state.rooms.filter(r=>r.group_id===g.id));return (s.issues>0||s.offline>0)&&floorAsset(g);});
      const firstWithPlan=managed.find(g=>floorAsset(g));
      selectedFloorId=(firstIssue||firstWithPlan||managed[0]||{}).id||null;
    }
    const selected=groupById(selectedFloorId);
    const floorStack=Array.from({length:14},(_,i)=>14-i).map(n=>buildingStackFloor(n,groupsByFloor.get(n)||null)).join('');
    return `<section class="building-command-board">
      <div class="building-command-head"><div><h2>층별 디스플레이</h2><p>층을 선택해 진료실 영상과 디스플레이 상태를 확인하세요.</p></div></div>
      <div class="building-command-grid">
        <aside class="building-nav-pane">
          <div class="building-floor-stack" role="list" aria-label="1층부터 14층까지 건물 송출 현황">${floorStack}</div>
          
        </aside>
        ${buildingFloorPanelMarkup(selected)}
      </div>
    </section>`;
  }
  function floorMarker(r){return floorMapMarker(r,false);}
  function floorDashboardMarkup(g){
    if(!g)return buildingDashboardMarkup();
    const rooms=state.rooms.filter(r=>r.group_id===g.id),sum=groupStatusSummary(rooms),unplaced=rooms.filter(r=>!roomMapPlaced(r));
    const purpose=g.signage_purpose||'송출 목적이 아직 입력되지 않았습니다.';
    const audience=g.target_audience||'대상 미설정';
    const waiting=g.waiting_area_note||'대기공간 정보 미설정';
    const reason=g.signage_reason||'송출 이유가 아직 입력되지 않았습니다.';
    const playlist=floorPlaylistName(g)||'공간별/기본 플레이리스트';
    const asset=floorAsset(g);
    const roomRows=[...rooms].sort((a,b)=>roomProblemRank(a)-roomProblemRank(b)||(a.sort_order||0)-(b.sort_order||0)).map(r=>{const st=roomDisplayStatus(r),ps=r.player_status||{};return `<button class="floor-room-row" data-floor-room="${r.id}"><span class="room-status-badge status-${st.key}">${esc(st.label)}</span><b>${esc(r.name)}</b><small>${esc(roomModeLabel(r.room_mode))} · ${esc(priorityLabel(ps.priority||ps.mode))}${roomIssueReason(r)?` · ${esc(roomIssueReason(r))}`:''}</small></button>`;}).join('');
    return `<section class="floor-dashboard"><div class="floor-context"><div><button class="text-btn floor-back" data-building-view>건물</button><span class="eyebrow">${esc(careTypeLabel(g.care_type))}</span><h2>${esc(floorTitle(g))} · ${esc(g.name)}</h2><p>${esc(purpose)}</p></div><div class="floor-context-facts"><span><small>주요 대상</small><b>${esc(audience)}</b></span><span><small>고객 대기공간</small><b>${esc(waiting)}</b></span><span><small>송출 이유</small><b>${esc(reason)}</b></span><span><small>기본 플레이리스트</small><b>${esc(playlist)}</b></span></div></div><div class="floor-live-summary"><span class="room-status-badge status-${sum.key}">${esc(sum.label)}</span><b>${sum.live}/${sum.total} 송출 중</b><span>문제 ${sum.issues} · 오프라인 ${sum.offline}</span></div><div class="floor-map-card floor-map-card-focus"><div class="floor-map-head"><div><b>${esc(floorTitle(g))} 평면도</b><small>공간을 누르면 해당 구역이 강조됩니다. 디스플레이 아이콘은 실제 설치 위치와 상태를 보여줍니다.</small></div><span>${rooms.length}대</span></div>${asset?`<div class="floor-plan-stage"><div class="floorplan-svg-host" data-floorplan-svg="${asset}"></div>${rooms.map(floorMarker).join('')}</div><div class="floor-zone-inspector" data-floor-zone-inspector><div class="floor-zone-inspector-empty"><div><span>공간 선택</span><b>평면도에서 디스플레이를 선택하세요.</b></div><p>선택하면 이 위치에서 송출될 영상이 작은 썸네일로 표시됩니다.</p></div></div>`:'<div class="floor-plan-empty">등록된 평면도가 없습니다.</div>'}${unplaced.length?`<div class="floor-map-unplaced">위치 미설정 디스플레이 ${unplaced.length}대 · 설정 &gt; 디스플레이 위치 설정에서 배치하세요.</div>`:''}</div><details class="floor-room-drawer"><summary><span><b>공간 목록</b><small>문제 공간을 먼저 표시합니다.</small></span><em>${rooms.length}곳</em></summary><div class="floor-room-drawer-body">${roomRows||'<span class="muted">등록된 공간이 없습니다.</span>'}</div></details></section>`;
  }

  function dashboardViewNav(){return `<div class="dashboard-view-nav" role="tablist" aria-label="송출 현황 보기"><button class="${dashboardView==='building'?'active':''}" data-dashboard-view="building">건물 · 평면도</button><button class="${dashboardView==='rooms'?'active':''}" data-dashboard-view="rooms">공간 목록</button></div>`;}
  function render(){if(tab==='dashboard')renderDashboard();else if(tab==='videos')renderVideos();else renderSettings();}

  function operationalAlerts(){
    const alerts=[];
    const errors=state.rooms.filter(r=>roomDisplayStatus(r).key==='error');
    const offline=state.rooms.filter(r=>roomDisplayStatus(r).key==='offline');
    const updates=state.rooms.filter(r=>roomDisplayStatus(r).key==='update');
    if(errors.length)alerts.push({type:'danger',text:`재생 오류 ${errors.length}곳 · ${errors.slice(0,4).map(r=>r.name).join(', ')}${errors.length>4?' 외':''}`});
    if(offline.length)alerts.push({type:'warn',text:`연결 끊김 ${offline.length}곳 · ${offline.slice(0,5).map(r=>r.name).join(', ')}${offline.length>5?' 외':''}`});
    if(updates.length)alerts.push({type:'warn',text:`플레이어 업데이트 필요 ${updates.length}곳 · ${updates.slice(0,4).map(r=>r.name).join(', ')}${updates.length>4?' 외':''}`});
    return alerts;
  }
  function alertsHtml(){return `<div id="opsAlerts" class="ops-alerts">${operationalAlerts().map(x=>`<div class="ops-alert ${x.type}">${esc(x.text)}</div>`).join('')}</div>`;}
  function paintAlerts(){const el=qs('#opsAlerts');if(el)el.innerHTML=operationalAlerts().map(x=>`<div class="ops-alert ${x.type}">${esc(x.text)}</div>`).join('');}

  function hms(sec){sec=Math.max(0,Number(sec)||0);const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60);return h?`${h}시간 ${m}분`:`${m}분`;}
  function playbackAnalyticsMarkup(){
    const d=state.playbackToday;if(!d)return '';
    const overall=d.overall||{},rooms=d.rooms||[],rate=Number(overall.rate||0),remaining=Math.max(0,Number(overall.planned_seconds||0)-Number(overall.playing_seconds||0));
    const periods=d.periods||{};
    const periodCard=(key,label)=>{const x=periods[key]||{},r=Number(x.rate||0),miss=Math.max(0,Number(x.planned_seconds||0)-Number(x.playing_seconds||0));return `<article class="stats-period-card"><span>${label}</span><b>${r.toFixed(1)}%</b><small>재생 ${hms(x.playing_seconds)} · 중단 ${hms(miss)}</small></article>`;};
    const roomRows=rooms.map(r=>{const rr=Math.max(0,Math.min(100,Number(r.rate||0)));const miss=Math.max(0,Number(r.planned_seconds||0)-Number(r.playing_seconds||0));return `<div class="playback-room-row"><div class="playback-room-name"><b>${esc(r.name)}</b><span>${esc(r.group_name||'')}</span></div><div class="playback-room-bar"><i style="width:${rr}%"></i></div><b class="playback-rate">${rr.toFixed(1)}%</b><span class="playback-room-meta">재생 ${hms(r.playing_seconds)} · 중단 ${hms(miss)}${Number(r.error_count||0)?` · 오류 ${r.error_count}`:''}</span></div>`;}).join('');
    const hours=d.is_open===false?'오늘 휴무':`${String(d.operating_start||'09:00').slice(0,5)}–${String(d.operating_end||'20:00').slice(0,5)} 기준`;
    return `<details class="playback-analytics"><summary class="playback-summary-card"><div><span class="eyebrow">PLAYBACK</span><h2>전체 재생률</h2><p>${hours}</p></div><div class="playback-summary-rate"><b>${rate.toFixed(1)}%</b><span>상세보기</span></div><div class="playback-overall-bar"><i style="width:${Math.max(0,Math.min(100,rate))}%"></i></div></summary><div class="playback-detail-body"><div class="stats-period-grid">${periodCard('today','오늘')}${periodCard('week','이번 주')}${periodCard('month','이번 달')}</div><div class="playback-summary"><span>오늘 재생 <b>${hms(overall.playing_seconds)}</b></span><span>오늘 중단 <b>${hms(remaining)}</b></span><span>오류 <b>${overall.error_count||0}</b></span><span>재연결 <b>${overall.reconnect_count||0}</b></span></div><div class="playback-room-section"><div class="playback-room-section-head"><b>공간별 오늘 재생률</b><span>${rooms.length}곳</span></div><div class="playback-room-list">${roomRows}</div></div></div></details>`;
  }

  function operatingNowLabel(){
    if(state.settings.early_closed_date===localDateKey())return '오늘 운영 종료';
    const d=new Date().getDay(),key=d===0?'sunday':d===6?'saturday':'weekday';
    const enabled=state.settings[`operating_${key}_enabled`]!==false;
    if(!enabled)return '오늘 휴무';
    const start=state.settings[`operating_${key}_start`]||'09:00',end=state.settings[`operating_${key}_end`]||'20:00';
    return `${String(start).slice(0,5)}–${String(end).slice(0,5)} 운영`;
  }
  function problemBreakdownMarkup(){
    const offline=state.rooms.filter(r=>roomDisplayStatus(r).key==='offline').length;
    const updates=state.rooms.filter(r=>roomDisplayStatus(r).key==='update').length;
    const errors=state.rooms.filter(r=>roomDisplayStatus(r).key==='error').length;
    const manual=state.rooms.filter(r=>roomDisplayStatus(r).key==='manual-warn').length;
    if(!offline&&!updates&&!errors&&!manual)return '<span class="ops-ok-copy">현재 확인이 필요한 공간이 없습니다.</span>';
    return `<span>연결 끊김 <b>${offline}</b></span><span>업데이트 <b>${updates}</b></span><span>재생 오류 <b>${errors}</b></span>${manual?`<span>수동 확인 <b>${manual}</b></span>`:''}`;
  }

  function siteSlug(site){return String(site?.code||'').trim()||'site';}
  function siteRooms(site){const all=state.allRooms||state.rooms||[];return all.filter(r=>r.site_id===site.id||(!r.site_id&&state.sites.length===1));}
  function sitePortfolioStats(site){
    const rooms=siteRooms(site),statuses=rooms.map(roomDisplayStatus);
    return {total:rooms.length,live:statuses.filter(x=>x.key==='live').length,issues:statuses.filter(x=>['error','update','offline','manual-warn'].includes(x.key)).length};
  }
  function siteAdminPath(site){return `/hospital.html?site=${encodeURIComponent(siteSlug(site))}`;}
  function absoluteAddress(path){try{return new URL(path,location.origin).toString();}catch{return `${location.origin}${path}`;}}
  function sitePlayerRooms(site){return siteRooms(site).filter(r=>displayControlMode(r)!=='manual'&&r.player_key);}
  function siteAddressLinksMarkup(site){
    const adminPath=siteAdminPath(site),players=sitePlayerRooms(site);
    return `<div class="super-site-addresses"><div class="super-site-address-row"><span><b>병원 관리자</b><code>${esc(absoluteAddress(adminPath))}</code></span><span class="super-site-address-actions"><button type="button" data-copy-address="${esc(adminPath)}" data-copy-label="${esc(site.name)} 관리자 주소">주소 복사</button></span></div><details class="super-site-player-links"><summary><span><b>환자 화면</b><small>${players.length}개 웹 송출 화면</small></span><em>링크 보기</em></summary><div class="super-site-player-list">${players.length?players.map(r=>{const path=`/player.html?key=${encodeURIComponent(r.player_key)}`;return `<div class="super-site-player-row"><span><b>${esc(r.name)}</b><code>${esc(absoluteAddress(path))}</code></span><span class="super-site-address-actions"><button type="button" data-open-address="${esc(path)}">열기</button><button type="button" data-copy-address="${esc(path)}" data-copy-label="${esc(site.name)} ${esc(r.name)} 환자 화면 주소">복사</button></span></div>`;}).join(''):`<p class="super-site-player-empty">원격 또는 하이브리드 디스플레이가 없습니다.</p>`}</div></details></div>`;
  }
  function hospitalPortfolioMarkup(){
    if(!state.sites.length)return '';
    const rows=state.sites.map(site=>({site,stats:sitePortfolioStats(site)})).sort((a,b)=>(b.stats.issues-a.stats.issues)||String(a.site.name||'').localeCompare(String(b.site.name||''),'ko'));
    const totals=rows.reduce((acc,row)=>{acc.displays+=row.stats.total;acc.live+=row.stats.live;acc.issues+=row.stats.issues;if(row.stats.issues)acc.issueSites+=1;return acc;},{displays:0,live:0,issues:0,issueSites:0});
    if(!hospitalFocusOpen){
      const hospitalRows=rows.map(({site,stats})=>`<button type="button" class="hospital-overview-row ${stats.issues?'has-issue':''}" data-select-site="${site.id}"><span class="hospital-overview-identity"><b>${esc(site.name)}</b><small>${stats.issues?`확인 필요 ${stats.issues}`:'정상'}</small></span><span class="hospital-overview-stat"><b>${stats.total}</b><small>디스플레이</small></span><span class="hospital-overview-stat"><b>${stats.live}</b><small>송출 중</small></span><span class="hospital-overview-arrow" aria-hidden="true">›</span></button>`).join('');
      return `<section class="hospital-overview-shell"><div class="hospital-overview-head"><div><span class="eyebrow">HOSPITALS</span><h1>병원 현황</h1><p>확인이 필요한 병원을 먼저 보고, 필요한 병원만 선택합니다.</p></div></div><div class="hospital-overview-summary"><span><b>${state.sites.length}</b><small>병원</small></span><span><b>${totals.displays}</b><small>전체 디스플레이</small></span><span class="${totals.issues?'has-issue':''}"><b>${totals.issues}</b><small>확인 필요</small></span></div><div class="hospital-overview-list">${hospitalRows}</div></section>`;
    }
    const current=state.currentSite||state.sites[0],currentStats=sitePortfolioStats(current);
    return `<section class="hospital-focus-bar ${currentStats.issues?'has-issue':''}"><button type="button" class="hospital-focus-back" data-close-hospital aria-label="병원 목록으로 돌아가기">←</button><span class="hospital-focus-name"><b>${esc(current.name)}</b><small>${currentStats.issues?`확인 필요 ${currentStats.issues}`:'정상'}</small></span><span class="hospital-focus-metric"><b>${currentStats.total}</b><small>디스플레이</small></span><span class="hospital-focus-metric"><b>${currentStats.live}</b><small>송출 중</small></span></section>`;
  }

  function renderDashboard(){
    const videos=activeVideos(),selected=state.broadcast?.video_ids||[],online=state.rooms.filter(adminIsOnline).length;
    const grouped=[...state.groups.map(g=>({group:g,rooms:state.rooms.filter(r=>r.group_id===g.id)})),{group:null,rooms:state.rooms.filter(r=>!r.group_id)}].filter(x=>x.rooms.length||x.group);
    const roomStatuses=state.rooms.map(roomDisplayStatus),liveCount=roomStatuses.filter(x=>x.key==='live').length;
    const offlineCount=roomStatuses.filter(x=>x.key==='offline').length;
    const issueCount=roomStatuses.filter(x=>['error','update','offline','manual-warn'].includes(x.key)).length;
    const paused=state.rooms.filter(r=>r.paused||String(r.player_status?.playback_state||'').toLowerCase()==='paused').length;
    const activeGroups=state.groupBroadcasts.filter(g=>g.active).length;
    const storageState=storageHealth===false?'설정 필요':(storageHealth?.ok?'정상':'확인 중');
    const selectedTitles=selected.map(id=>state.videos.find(v=>v.id===id)?.title).filter(Boolean);
    const broadcastText=selectedTitles.length?selectedTitles.slice(0,2).join(' · ')+(selectedTitles.length>2?` 외 ${selectedTitles.length-2}개`:''):'기본 영상';
    const bPhase=broadcastPhase(),bLive=bPhase==='live',bScheduled=bPhase==='scheduled';
    const bStatus=bLive?'송출 중':bScheduled?'예약 대기':bPhase==='ended'?'종료됨':'기본 상태';
    const bTime=(state.broadcast?.active&&bPhase!=='off')?timeWindowText(state.broadcast?.starts_at,state.broadcast?.ends_at):'';
    const idleCount=roomStatuses.filter(x=>x.key==='idle').length;
    if(!hospitalFocusOpen){qs('#adminRoot').innerHTML=hospitalPortfolioMarkup();bindDashboard();return;}
    qs('#adminRoot').innerHTML=`
      ${hospitalPortfolioMarkup()}
      <div class="ops-section-head"><div><span class="eyebrow">FLOOR CONTROL</span><h1>층별 관제</h1><p>층을 선택해 도면, 디스플레이 위치, 송출 영상을 확인합니다.</p></div><div class="ops-section-actions"><em>${esc(operatingNowLabel())}</em><button id="refreshLiveStatus" class="btn small">새로고침</button>${state.settings.early_closed_date===localDateKey()?'<button id="reopenToday" class="btn small primary">오늘 송출 재개</button>':'<button id="closeToday" class="btn small">오늘 운영 종료</button>'}</div></div>
      ${issueCount?`<section class="ops-problem-line has-problem"><b>문제 공간 ${issueCount}</b><div>${problemBreakdownMarkup()}</div><button id="issuesOnly" class="text-btn dark">${issuesOnly?'전체 층 보기':'문제 층만 보기'}</button></section>`:''}
      ${dashboardViewNav()}
      <div id="dashboardSpatialView">${dashboardView==='building'?buildingDashboardMarkup():dashboardView==='floor'?floorDashboardMarkup(groupById(selectedFloorId)):`<div class="monitor-groups">${grouped.map(({group,rooms})=>groupSection(group,rooms,videos)).join('')}</div>`}</div>
      <details class="ops-control-panel">
        <summary><span><b>전체 송출 · 고급 제어</b><small>${state.sites.length>1?'전체 병원 공통 송출':'병원 전체 일괄 송출'}, 플레이어 새로고침, 여러 공간 일괄 변경</small></span><em>${bLive?'전체 송출 중':bScheduled?'예약 대기':'필요할 때만 사용'}</em></summary>
        <div class="ops-control-body">
          <section class="monitor-broadcast-strip ${bLive?'is-live':''} ${bScheduled?'is-scheduled':''}">
            <div class="monitor-broadcast-copy"><span>${state.sites.length>1?'전체 병원 공통 송출':'병원 전체 일괄 송출'}</span><b>${bStatus}</b><em>${esc(broadcastText)}${bTime?` · ${esc(bTime)}`:''}</em></div>
            <div class="monitor-broadcast-actions"><details><summary>영상 선택</summary><div class="monitor-broadcast-panel"><div id="broadcastPicks" class="pick-list">${videos.map(v=>`<button class="pick ${selected.includes(v.id)?'on':''}" data-video-id="${v.id}">${selected.includes(v.id)?`<span>${selected.indexOf(v.id)+1}</span>`:''}${esc(v.title)}</button>`).join('')||'<span class="muted">사용 가능한 영상이 없습니다.</span>'}</div><div class="output-time-grid"><label><span>시작</span><input id="broadcastStart" type="datetime-local" value="${toLocalInput(bPhase==='ended'?null:state.broadcast?.starts_at)}"><small>비우면 즉시</small></label><label><span>종료</span><input id="broadcastEnd" type="datetime-local" value="${toLocalInput(bPhase==='ended'?null:state.broadcast?.ends_at)}"><small>비우면 직접 중지</small></label></div><div class="inline top-gap"><input id="notice" class="grow" placeholder="공지 문구" value="${esc(state.broadcast?.notice_text||'')}"><button id="noticeSave" class="btn">공지 저장</button></div></div></details><button class="btn" data-undo-scope="hospital">되돌리기</button>${state.broadcast?.active&&bPhase!=='ended'?'<select id="broadcastResume"><option value="previous">종료 후 이전 상태</option><option value="default">종료 후 기본 영상</option></select>':''}<button id="broadcastToggle" class="btn ${state.broadcast?.active&&bPhase!=='ended'?'danger':'primary'}" ${(!state.broadcast?.active||bPhase==='ended')&&!selected.length?'disabled':''}>${state.broadcast?.active&&bPhase!=='ended'?(bScheduled?'예약 취소':'전체 중지'):'전체 시작'}</button></div>
          </section>
          <div class="ops-player-actions">${outdatedRooms().length?`<button id="reloadOutdatedPlayers" class="btn">업데이트 필요 ${outdatedRooms().length}곳 새로고침</button>`:''}<button id="reloadAllPlayers" class="btn">전체 플레이어 새로고침</button><span>플레이어 ${esc(PLAYER_VERSION)} · Realtime + ACK</span></div>
          <details class="monitor-batch"><summary>여러 공간 한 번에 바꾸기</summary><div class="monitor-batch-body"><select id="batchVideo" class="grow">${videoOptions()}</select><button id="batchSend" class="btn primary">보내기</button><button id="batchAuto" class="btn">기본으로</button><button id="reloadSelectedPlayers" class="btn">선택 플레이어 새로고침</button><button id="clearRoomChecks" class="btn">선택 해제</button></div></details>
        </div>
      </details>
      <details class="ops-analytics-panel"><summary><span><b>운영 통계</b><small>재생률과 기간별 기록은 실시간 관제와 분리해서 확인합니다.</small></span><em>오늘 · 주 · 월</em></summary><div class="ops-analytics-body">${playbackAnalyticsMarkup()}</div></details>
      <div class="dashboard-secondary-grid">
        <details class="dashboard-secondary"><summary><span><b>예약 송출</b><small>정해진 시간에 전체 또는 그룹 영상 송출</small></span><em>${state.schedules.filter(s=>new Date(s.ends_at)>new Date()).length}건</em></summary><div class="dashboard-secondary-body">${schedulePanel(videos)}</div></details>
        <details class="dashboard-secondary"><summary><span><b>송출 기록</b><small>최근 변경 확인 및 되돌리기</small></span><em>${state.history.length}건</em></summary><div class="dashboard-secondary-body">${historyPanel()}</div></details>
      </div>`
    bindDashboard();
    hydrateFloorplanImages();
  }

  function groupSection(group,rooms,videos){
    const gid=group?.id||'',gb=group?groupBroadcast(gid):null,selectedId=gb?.video_ids?.[0]||'',summary=groupStatusSummary(rooms);
    const currentVideo=state.videos.find(v=>v.id===selectedId)?.title||'',baseRooms=issuesOnly?rooms.filter(r=>roomDisplayStatus(r).key!=='live'&&roomDisplayStatus(r).key!=='idle'):rooms,visibleRooms=[...baseRooms].sort((a,b)=>roomProblemRank(a)-roomProblemRank(b)||(a.sort_order||0)-(b.sort_order||0));
    const nowText=summary.key==='live'?`${summary.live}곳 송출 중`:summary.key==='issue'?`문제 공간 ${summary.issues}곳`:summary.key==='offline'?'모든 공간 연결 끊김':summary.key==='idle'?'현재 재생 대기':'현재 상태 확인';
    return `<details class="monitor-group group-state-${summary.key}" data-group-card="${gid||'ungrouped'}" ${issuesOnly?'open':''}><summary class="monitor-group-summary"><div class="monitor-group-overview"><div class="monitor-group-title-row"><h2>${esc(groupDisplayName(group))}</h2><span class="group-status-badge status-${summary.key}" data-group-status>${esc(summary.label)}</span></div><div class="group-metric-row"><span>공간 <b data-group-total>${summary.total}</b></span><span>송출 <b data-group-live>${summary.live}</b></span><span>온라인 <b data-group-online>${summary.online}</b></span><span>문제 <b data-group-issues>${summary.issues}</b></span></div><p data-group-live-summary>${esc(nowText)}${gb?.active&&currentVideo?` · 그룹 송출 ${esc(currentVideo)}`:''}</p></div><span class="group-detail-link">상세보기</span></summary><div class="monitor-group-body">${group?`<div class="monitor-group-control-row"><details class="monitor-group-control"><summary>그룹 송출</summary><div><select data-group-video="${gid}">${videoOptions(selectedId)}</select><button class="btn primary" data-group-apply="${gid}">${gb.active?'변경':'보내기'}</button>${gb.active?`<button class="btn danger-outline" data-group-stop="${gid}">중지</button>`:''}<button class="btn" data-undo-group="${gid}">되돌리기</button></div></details></div>`:''}<div class="monitor-room-grid">${visibleRooms.map(r=>roomCard(r,videos)).join('')||'<p class="muted">표시할 공간이 없습니다.</p>'}</div></div></details>`;
  }

  function roomCard(r,videos){
    const h=roomHealth(r),displayStatus=roomDisplayStatus(r),isManual=displayControlMode(r)==='manual',on=!isManual&&adminIsOnline(r),st=r.player_status||{},progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'',manualConfigured=r.manual_active&&r.manual_video_ids?.length,manual=manualIsEffective(r)&&r.manual_video_ids?.length,mPhase=manualPhase(r);
    const p=playlistInfo(st),currentTitle=isManual?'현장 수동 운영':st.mode==='closed'?'운영시간 외':(r.paused?'일시정지':(st.title||'대기 중')),nextTitle=isManual?'—':(p.next||((p.titles.length>1)?p.titles[(p.current+1)%p.titles.length]:'—'));
    const currentVideo=isManual?null:(state.videos.find(v=>v.id===st.video_id)||null),manualCount=manualConfigured?(r.manual_video_ids||[]).length:0,output=isManual?[]:roomOutputItems(r),enabledCount=output.filter(x=>x.enabled).length;
    const modeText=isManual?'운영 방식 · 수동':`우선순위 · ${esc(priorityLabel(st.priority||st.mode))}`;
    const detailText=isManual?roomIssueReason(r):(on?`${esc(playbackLabel(st.playback_state))}${progress?` · ${progress}`:''}${st.muted?' · 음소거':''}${roomIssueReason(r)?` · ${esc(roomIssueReason(r))}`:''}`:'오프라인 · 플레이어 연결 끊김');
    const body=isManual?`<div class="monitor-room-controls"><div class="manual-display-panel"><b>수동 운영 디스플레이</b><p>${esc(r.display_note||'현장에서 직접 영상 상태를 확인합니다. 원격 heartbeat/ACK/오프라인 판정 대상이 아닙니다.')}</p><div class="inline"><button class="btn ${r.manual_check_status==='checked'?'':'primary'}" data-admin-manual-check="${r.id}">${r.manual_check_status==='checked'?'미확인으로 변경':'오늘 확인 완료'}</button><span class="section-label">${esc(roomIssueReason(r))}</span></div></div></div>`:`<div class="monitor-room-controls room-output-editor"><div class="room-output-head"><div><b>실제 송출 목록</b><span>${['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(String(st.mode||''))?'상위 송출이 적용 중이라 목록은 보기 전용입니다.':'개별 영상을 끄거나 순서를 바꿀 수 있습니다.'}</span></div><button class="btn small" data-room-rules-clear="${r.id}">목록 설정 초기화</button></div>${roomOutputListHtml(r)}<div class="room-output-row"><span class="room-output-label">플레이리스트</span><select data-output-playlist="${r.id}" class="grow">${roomPlaylistOptions(r.default_playlist_id||'')}</select><button class="btn small primary" data-room-playlist-apply="${r.id}">변경</button></div><div class="room-output-row"><span class="room-output-label">영상 추가</span><select data-output-video="${r.id}" class="grow">${videoOptions()}</select><button class="btn small" data-room-video-add="${r.id}">추가</button>${manualConfigured?`<button class="btn small" data-room-auto="${r.id}">기본으로</button>`:''}</div><details class="room-timed-output"><summary>개별 송출 시간</summary><div class="room-timed-output-body"><select data-timed-source="${r.id}" class="grow"><optgroup label="영상">${state.videos.filter(v=>v.active).map(v=>`<option value="video:${v.id}">${esc(v.title)}</option>`).join('')}</optgroup><optgroup label="플레이리스트">${state.playlists.filter(p=>p.active).map(p=>`<option value="playlist:${p.id}">${esc(p.name)}</option>`).join('')}</optgroup></select><div class="output-time-grid compact"><label><span>시작</span><input type="datetime-local" data-timed-start="${r.id}" value="${toLocalInput(mPhase==='ended'?null:r.manual_starts_at)}"><small>비우면 즉시</small></label><label><span>종료</span><input type="datetime-local" data-timed-end="${r.id}" value="${toLocalInput(mPhase==='ended'?null:r.manual_ends_at)}"><small>비우면 직접 종료</small></label></div><button class="btn small primary" data-room-timed-apply="${r.id}">시간 송출</button>${manualConfigured?`<button class="btn small" data-room-auto="${r.id}">시간/개별 해제</button>`:''}</div></details>${manualConfigured?`<div class="room-output-note">개별 송출 ${manualCount}개 · ${mPhase==='scheduled'?'예약 대기':mPhase==='ended'?'종료됨':mPhase==='live'?'송출 중':'설정됨'}${(r.manual_starts_at||r.manual_ends_at)?` · ${esc(timeWindowText(r.manual_starts_at,r.manual_ends_at))}`:''}</div>`:''}<div class="room-output-note">${esc(cacheStatusText(r))}</div><div class="room-output-note">플레이어 ${esc(playerVersion(r)||'미확인')}${st.update_error?' · 업데이트 확인 실패':playerNeedsUpdate(r)||st.update_pending_version?` · 업데이트 필요 (${esc(PLAYER_VERSION)})`:(playerVersion(r)?' · 최신':'')}</div><div class="room-player-actions"><span>공간 플레이어</span><div><button class="btn small" data-room-player-open="${r.id}">열기</button><button class="btn small" data-room-player-copy="${r.id}">링크 복사</button></div></div><div class="inline monitor-secondary-controls"><button class="btn small" data-room-action="pause" data-room-id="${r.id}">${r.paused?'재생':'일시정지'}</button><button class="btn small" data-room-action="reload" data-room-id="${r.id}">새로고침</button><span class="section-label">음량 ${r.volume}${r.force_mute?' · 항상 음소거':''}</span><input data-volume="${r.id}" type="range" min="0" max="100" value="${r.volume}"></div><div class="inline"><input class="grow" data-overlay="${r.id}" placeholder="화면 문구" value="${esc(r.overlay_text||'')}"><button class="btn small" data-overlay-save="${r.id}">문구 적용</button></div></div>`;
    return `<details class="monitor-room health-${h}" data-room-card="${r.id}" data-health="${h}"><summary><div class="monitor-room-top"><div class="monitor-room-name"><label class="room-check" onclick="event.stopPropagation()"><input type="checkbox" data-room-check="${r.id}" ${isManual?'disabled title="수동 디스플레이는 원격 일괄 제어 대상이 아닙니다."':''}></label><span data-live-dot class="dot ${on?'on':isManual?'manual':''}"></span><b>${esc(r.name)}</b></div><span class="monitor-health room-status-badge status-${displayStatus.key}">${esc(displayStatus.label)}</span></div><div class="monitor-current-thumb">${isManual?'<span>수동</span>':thumb(currentVideo)}</div><div class="monitor-now"><span data-live-mode>${modeText}</span><b data-live-title>${esc(currentTitle)}</b><small data-live-detail>${detailText}</small></div><div class="monitor-next"><span>다음</span><b data-live-next>${esc(nextTitle||'—')}</b></div><div class="monitor-card-foot"><span>${isManual?'수동 디스플레이':`송출 목록 ${enabledCount}/${output.length}`}</span><b>관리</b></div></summary>${body}</details>`;
  }

  function schedulePanel(videos){
    const now=new Date(), future=state.schedules.filter(s=>new Date(s.ends_at)>now);
    return `<section class="panel"><div class="panel-head"><div><h2>예약</h2></div></div><div class="schedule-form"><select id="scheduleScope"><option value="hospital">${state.sites.length>1?'전체 병원 공통':'전체 병원'}</option>${state.groups.map(g=>`<option value="group:${g.id}">${esc(g.name)}</option>`).join('')}</select><select id="scheduleVideo">${videoOptions()}</select><input id="scheduleStart" type="datetime-local"><input id="scheduleEnd" type="datetime-local"><input id="scheduleNotice" placeholder="공지 자막(선택)"><button id="addSchedule" class="btn primary">예약 추가</button></div><div class="schedule-list">${future.map(s=>{const g=groupById(s.group_id);const v=state.videos.find(x=>x.id===s.video_ids?.[0]);return `<div class="schedule-row"><b>${s.scope_type==='hospital'?(state.sites.length>1?'전체 병원 공통':'전체 병원'):esc(g?.name||'그룹')}</b><span>${esc(v?.title||'영상')} · ${new Date(s.starts_at).toLocaleString('ko-KR')} → ${new Date(s.ends_at).toLocaleString('ko-KR')}</span><button class="btn small danger-outline" data-delete-schedule="${s.id}">삭제</button></div>`;}).join('')||'<p class="muted">예정된 예약이 없습니다.</p>'}</div></section>`;
  }
  function historyPanel(){return `<section class="panel"><div class="panel-head"><div><h2>기록</h2></div></div><div class="history-list">${state.history.slice(0,15).map(h=>`<div class="history-row"><span><b>${esc(h.label||h.scope_type)}</b><small>${esc(h.action)} · ${new Date(h.created_at).toLocaleString('ko-KR')}</small></span>${h.before_state&&['hospital','group','rooms'].includes(h.scope_type)?`<button class="btn small" data-undo-history="${h.id}">되돌리기</button>`:''}</div>`).join('')||'<p class="muted">이력이 없습니다.</p>'}</div></section>`;}

  function bindDashboard(){
    qsa('[data-go-floorplan-settings]').forEach(b=>b.addEventListener('click',()=>{tab='settings';render();requestAnimationFrame(()=>qs('.floorplan-manager')?.scrollIntoView({behavior:'smooth',block:'start'}));}));
    qsa('[data-select-site]').forEach(b=>b.addEventListener('click',()=>switchSite(b.dataset.selectSite)));qsa('[data-close-hospital]').forEach(b=>b.addEventListener('click',()=>{if(scopedHospitalMode){location.href='/admin.html';return;}hospitalFocusOpen=false;selectedFloorId=null;dashboardView='building';render();}));qsa('[data-open-address]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openAddress(b.dataset.openAddress)}));qsa('[data-copy-address]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();copyAddress(b.dataset.copyAddress,b.dataset.copyLabel||'주소')}));
    qsa('[data-admin-manual-check]').forEach(b=>b.addEventListener('click',()=>markAdminManualChecked(b.dataset.adminManualCheck)));
    qsa('[data-dashboard-view]').forEach(b=>b.addEventListener('click',()=>{dashboardView=b.dataset.dashboardView;if(dashboardView==='floor'&&!selectedFloorId){const first=state.groups.find(g=>floorNumber(g));selectedFloorId=first?.id||null;}renderDashboard();}));qsa('[data-building-period]').forEach(b=>b.addEventListener('click',()=>{buildingPeriod=b.dataset.buildingPeriod||'live';renderDashboard();}));
    qsa('[data-building-select-floor]').forEach(b=>{const select=()=>{if(!b.dataset.buildingSelectFloor)return;selectedFloorId=b.dataset.buildingSelectFloor;dashboardView='building';renderDashboard();};b.addEventListener('click',select);b.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}});});qsa('[data-open-floor]').forEach(b=>{const open=()=>{if(!b.dataset.openFloor)return;selectedFloorId=b.dataset.openFloor;dashboardView='floor';renderDashboard();};b.addEventListener('click',open);b.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});});
    qs('[data-building-view]')?.addEventListener('click',()=>{dashboardView='building';renderDashboard();});
    qsa('[data-floor-room]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.floorRoom,r=state.rooms.find(x=>x.id===id),inspector=qs('[data-floor-zone-inspector]');if(r&&inspector){inspector.innerHTML=floorRoomPreviewHtml(r);qsa('[data-floor-room]').forEach(x=>x.classList.toggle('is-selected',x.dataset.floorRoom===id));const open=qs('[data-open-room-detail]',inspector);if(open)open.addEventListener('click',()=>{dashboardView='rooms';renderDashboard();requestAnimationFrame(()=>{const card=qs(`[data-room-card="${id}"]`);if(card){card.open=true;card.scrollIntoView({behavior:'smooth',block:'center'});}});});}}));
    qs('#issuesOnly')?.addEventListener('click',()=>{issuesOnly=!issuesOnly;renderDashboard();});qs('#refreshLiveStatus')?.addEventListener('click',refreshAllLiveStatus);
    qs('#closeToday')?.addEventListener('click',async()=>{if(!confirm('오늘 남은 송출을 모두 종료할까요? 다음 운영일 시작시간에 자동 재개됩니다.'))return;const {error}=await db.rpc('admin_close_today');if(error)return toast(error.message,'error');toast('오늘 운영을 종료했습니다.');await load();});
    qs('#reopenToday')?.addEventListener('click',async()=>{const {error}=await db.rpc('admin_reopen_today');if(error)return toast(error.message,'error');toast('오늘 송출을 재개했습니다.');await load();});
    qs('#reloadOutdatedPlayers')?.addEventListener('click',()=>reloadPlayers(outdatedRooms().map(r=>r.id),'업데이트가 필요한 플레이어'));
    qs('#reloadAllPlayers')?.addEventListener('click',()=>reloadPlayers(state.rooms.map(r=>r.id),'전체 플레이어',true));
    qs('#reloadSelectedPlayers')?.addEventListener('click',()=>{const ids=qsa('[data-room-check]:checked').map(i=>i.dataset.roomCheck);if(!ids.length)return toast('새로고침할 공간을 선택하세요.','error');reloadPlayers(ids,'선택한 플레이어');});
    qs('#broadcastPicks')?.addEventListener('click',async(e)=>{const b=e.target.closest('[data-video-id]');if(!b)return;let ids=[...(state.broadcast.video_ids||[])],id=b.dataset.videoId;ids=ids.includes(id)?ids.filter(x=>x!==id):[...ids,id];const configured=state.broadcast.active&&broadcastPhase()!=='ended';await runControl({all:true},()=>configured?db.rpc('admin_set_broadcast_timed',{p_active:ids.length>0,p_video_ids:ids,p_notice:state.broadcast.notice_text||null,p_starts_at:state.broadcast.starts_at||null,p_ends_at:state.broadcast.ends_at||null}):db.from('broadcast').update({video_ids:ids,updated_at:new Date().toISOString()}).eq('id',1),null,{ack:configured});});
    qs('#broadcastToggle')?.addEventListener('click',async()=>{const configured=state.broadcast.active&&broadcastPhase()!=='ended',next=!configured;if(next&&!state.broadcast.video_ids?.length)return;const resume=qs('#broadcastResume')?.value||'previous';if(!next)return runControl({all:true},()=>db.rpc('admin_stop_broadcast',{p_resume:resume}),'전체 송출 종료');const start=qs('#broadcastStart')?.value||'',end=qs('#broadcastEnd')?.value||'';if(start&&end&&new Date(end)<=new Date(start))return toast('종료 시각은 시작 시각보다 뒤여야 합니다.','error');if(end&&!start&&new Date(end)<=new Date())return toast('종료 시각은 현재보다 뒤여야 합니다.','error');const future=!!start&&new Date(start)>new Date();await runControl({all:true},()=>db.rpc('admin_set_broadcast_timed',{p_active:true,p_video_ids:state.broadcast.video_ids||[],p_notice:state.broadcast.notice_text||null,p_starts_at:start?new Date(start).toISOString():null,p_ends_at:end?new Date(end).toISOString():null}),future?'전체 송출 예약':'전체 송출 시작',{ack:!future});});
    qs('#noticeSave')?.addEventListener('click',()=>{const notice=qs('#notice').value.trim()||null;return runControl({all:true},()=>db.from('broadcast').update({notice_text:notice,updated_at:new Date().toISOString()}).eq('id',1),'공지 적용 완료');});
    qsa('[data-group-apply]').forEach(b=>b.addEventListener('click',()=>applyGroup(b.dataset.groupApply)));qsa('[data-group-stop]').forEach(b=>b.addEventListener('click',()=>stopGroup(b.dataset.groupStop)));
    qsa('[data-room-playlist-apply]').forEach(b=>b.addEventListener('click',()=>setRoomPlaylist(b.dataset.roomPlaylistApply)));
    qsa('[data-room-video-add]').forEach(b=>b.addEventListener('click',()=>addRoomVideo(b.dataset.roomVideoAdd)));
    qsa('[data-room-timed-apply]').forEach(b=>b.addEventListener('click',()=>applyTimedRoomOutput(b.dataset.roomTimedApply)));
    qsa('[data-room-auto]').forEach(b=>b.addEventListener('click',()=>clearRoomVideo(b.dataset.roomAuto)));
    qsa('[data-room-video-toggle]').forEach(i=>i.addEventListener('change',()=>setRoomVideoRule(i.dataset.roomVideoToggle,i.dataset.videoId,i.checked)));
    qsa('[data-room-video-move]').forEach(b=>b.addEventListener('click',()=>moveRoomVideo(b.dataset.roomVideoMove,b.dataset.videoId,Number(b.dataset.dir))));
    qsa('[data-rule-save]').forEach(b=>b.addEventListener('click',()=>saveRoomVideoRuleSchedule(b.dataset.ruleSave,b.dataset.videoId)));
    qsa('[data-room-rules-clear]').forEach(b=>b.addEventListener('click',()=>clearRoomRules(b.dataset.roomRulesClear)));qsa('[data-room-player-open]').forEach(b=>b.addEventListener('click',()=>openRoomPlayer(b.dataset.roomPlayerOpen)));qsa('[data-room-player-copy]').forEach(b=>b.addEventListener('click',()=>copyRoomPlayer(b.dataset.roomPlayerCopy)));
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

  const OVERRIDE_MODES=['broadcast','broadcast_schedule','group','group_schedule','emergency'];
  const isOverridden=(roomId)=>OVERRIDE_MODES.includes(String(state.rooms.find(r=>r.id===roomId)?.player_status?.mode||''));
  async function applyGroup(groupId){const id=qs(`[data-group-video="${groupId}"]`)?.value,notice=qs(`[data-group-notice="${groupId}"]`)?.value.trim()||null;if(!id)return toast('그룹에 송출할 영상을 선택하세요.','error');const wasActive=groupBroadcast(groupId).active;await runControl({groupId},()=>db.rpc('admin_set_group_broadcast',{p_group:groupId,p_active:true,p_video_ids:[id],p_notice:notice,p_delay_ms:0}),wasActive?'그룹 송출 변경':'그룹 송출 시작');}
  async function stopGroup(groupId){const gb=groupBroadcast(groupId);await runControl({groupId},()=>db.rpc('admin_set_group_broadcast',{p_group:groupId,p_active:false,p_video_ids:gb.video_ids||[],p_notice:gb.notice_text||null,p_delay_ms:0}),'그룹 송출 종료');}
  async function setRoomPlaylist(id){const playlist=qs(`[data-output-playlist="${id}"]`)?.value;if(!playlist)return toast('플레이리스트를 선택하세요.','error');await runControl({roomIds:[id]},()=>db.rpc('admin_set_room_playlist',{p_room:id,p_playlist:playlist}),'이 공간의 기본 플레이리스트를 변경했습니다.');}
  async function addRoomVideo(id){const video=qs(`[data-output-video="${id}"]`)?.value;if(!video)return toast('추가할 영상을 선택하세요.','error');await runControl({roomIds:[id]},()=>db.rpc('admin_add_room_video',{p_room:id,p_video:video}),'이 공간 재생목록에 영상 1개를 추가했습니다.');}
  async function applyTimedRoomOutput(id){const source=qs(`[data-timed-source="${id}"]`)?.value||'',start=qs(`[data-timed-start="${id}"]`)?.value||'',end=qs(`[data-timed-end="${id}"]`)?.value||'';if(!source)return toast('송출할 영상 또는 플레이리스트를 선택하세요.','error');if(start&&end&&new Date(end)<=new Date(start))return toast('종료 시각은 시작 시각보다 뒤여야 합니다.','error');if(end&&!start&&new Date(end)<=new Date())return toast('종료 시각은 현재보다 뒤여야 합니다.','error');let ids=[];if(source.startsWith('video:'))ids=[source.slice(6)];else if(source.startsWith('playlist:'))ids=playlistItems(source.slice(9)).map(x=>x.video_id).filter(Boolean);if(!ids.length)return toast('송출할 영상이 없습니다.','error');const future=!!start&&new Date(start)>new Date();await runControl({roomIds:[id]},()=>db.rpc('admin_set_rooms_manual_timed',{p_rooms:[id],p_video_ids:ids,p_active:true,p_starts_at:start?new Date(start).toISOString():null,p_ends_at:end?new Date(end).toISOString():null}),future?'개별 송출 예약':'개별 송출 시작',{ack:!future});}
  async function clearRoomVideo(id){await runControl({roomIds:[id]},()=>db.rpc('admin_set_rooms_manual',{p_rooms:[id],p_video_ids:[],p_active:false}),'자동 송출로 복귀');}
  async function setRoomVideoRule(room,video,enabled){if(isOverridden(room))return toast('전체/그룹 송출 중에는 개별 영상을 변경할 수 없습니다.','error');const current=state.roomRules.find(x=>x.room_id===room&&x.video_id===video);await runControl({roomIds:[room]},()=>db.rpc('admin_set_room_video_rule',{p_room:room,p_video:video,p_enabled:enabled,p_starts_at:current?.starts_at||null,p_ends_at:current?.ends_at||null}));}
  async function moveRoomVideo(room,video,dir){if(isOverridden(room))return toast('전체/그룹 송출 중에는 공간 목록 순서를 바꿀 수 없습니다.','error');const items=roomOutputItems(state.rooms.find(r=>r.id===room)||{});const from=items.findIndex(x=>x.id===video),to=from+dir;if(from<0||to<0||to>=items.length)return;[items[from],items[to]]=[items[to],items[from]];await runControl({roomIds:[room]},()=>db.rpc('admin_set_room_video_order',{p_room:room,p_video_ids:items.map(x=>x.id)}));}
  async function saveRoomVideoRuleSchedule(room,video){const start=qs(`[data-rule-start="${room}:${video}"]`)?.value||'',end=qs(`[data-rule-end="${room}:${video}"]`)?.value||'';if(start&&end&&start>=end)return toast('종료 시각은 시작 시각보다 뒤여야 합니다.','error');const current=state.roomRules.find(x=>x.room_id===room&&x.video_id===video);await runControl({roomIds:[room]},()=>db.rpc('admin_set_room_video_rule',{p_room:room,p_video:video,p_enabled:current?.enabled!==false,p_starts_at:start?new Date(start).toISOString():null,p_ends_at:end?new Date(end).toISOString():null}),'영상 기간을 저장했습니다.');}
  async function clearRoomRules(room){if(!confirm('이 공간의 영상 ON/OFF·순서·기간 설정을 초기화할까요?'))return;await runControl({roomIds:[room]},()=>db.rpc('admin_clear_room_video_rules',{p_room:room}));}
  async function batchRooms(active){const ids=qsa('[data-room-check]:checked').map(i=>i.dataset.roomCheck);if(!ids.length)return toast('공간을 선택하세요.','error');const video=qs('#batchVideo')?.value;if(active&&!video)return toast('영상을 선택하세요.','error');await runControl({roomIds:ids},()=>db.rpc('admin_set_rooms_manual',{p_rooms:ids,p_video_ids:active?[video]:[],p_active:active}),`${ids.length}곳 ${active?'송출 시작':'기본으로 변경'}`);}
  async function reloadPlayers(ids,label='플레이어',confirmAll=false){
    ids=[...new Set((ids||[]).filter(Boolean))];
    if(!ids.length)return toast('새로고침할 플레이어가 없습니다.','error');
    if(confirmAll&&!window.confirm(`${label} ${ids.length}곳을 새로고침할까요? 재생 화면이 잠깐 다시 열립니다.`))return;
    const nonce=randomReloadNonce();
    const ok=await runControl({roomIds:ids,all:confirmAll},()=>db.from('rooms').update({reload_nonce:nonce}).in('id',ids),`${label} ${ids.length}곳에 새로고침 명령을 보냈습니다.`);
    if(ok)ids.forEach(id=>{const r=state.rooms.find(x=>x.id===id);if(r)r.reload_nonce=nonce;});
  }
  async function roomAction(b){const r=state.rooms.find(x=>x.id===b.dataset.roomId);if(!r)return;await updateRoom(r.id,b.dataset.roomAction==='pause'?{paused:!r.paused}:{reload_nonce:randomReloadNonce()});}
  // Settings-only fields do not change what is on screen, so they skip the delivery check.
  const PLAYER_VISIBLE_FIELDS=['volume','paused','overlay_text','reload_nonce','force_mute','default_playlist_id','room_mode','group_id','operating_override','operating_weekday_enabled','operating_weekday_start','operating_weekday_end','operating_saturday_enabled','operating_saturday_start','operating_saturday_end','operating_sunday_enabled','operating_sunday_start','operating_sunday_end'];
  async function updateRoom(id,patch){const visible=Object.keys(patch).some(k=>PLAYER_VISIBLE_FIELDS.includes(k));const ok=await runControl({roomIds:[id]},()=>db.from('rooms').update(patch).eq('id',id),null,{ack:visible});if(ok)await load();}
  async function addSchedule(){const scope=qs('#scheduleScope').value,video=qs('#scheduleVideo').value,start=qs('#scheduleStart').value,end=qs('#scheduleEnd').value;if(!video||!start||!end)return toast('영상과 시작/종료 시각을 입력하세요.','error');const isGroup=scope.startsWith('group:'),group=isGroup?scope.slice(6):null;const {error}=await db.rpc('admin_create_schedule',{p_scope_type:isGroup?'group':'hospital',p_group:group,p_video_ids:[video],p_notice:qs('#scheduleNotice').value.trim()||null,p_starts_at:new Date(start).toISOString(),p_ends_at:new Date(end).toISOString()});if(error)toast(error.message,'error');else{toast('예약 송출 추가');await load();}}
  async function deleteSchedule(id){if(!confirm('예약을 삭제할까요?'))return;const {error}=await db.rpc('admin_delete_schedule',{p_id:id});if(error)toast(error.message,'error');else await load();}
  async function undoHistory(id){const h=state.history.find(x=>x.id===id);const scope=h?.scope_type==='group'&&h.scope_id?{groupId:h.scope_id}:h?.scope_type==='rooms'&&Array.isArray(h.before_state?.room_ids)?{roomIds:h.before_state.room_ids}:{all:true};const ok=await runControl(scope,()=>db.rpc('admin_undo_control',{p_history:id}),'되돌렸습니다');if(ok)await load();}
  async function undoLatest(type,id){const h=state.history.find(x=>x.scope_type===type&&(!id||x.scope_id===id)&&x.before_state);if(!h)return toast('복귀 가능한 이전 상태가 없습니다.','error');await undoHistory(h.id);}

  function renderVideos(){
    qs('#adminRoot').innerHTML=`<div class="page-head"><div><span class="eyebrow">MEDIA</span><h1>영상</h1><p class="page-intro">등록된 영상과 플레이리스트를 관리합니다. 영상 파일 업로드는 이 시스템에서 제공하지 않습니다.</p></div><div class="stat">영상 ${state.videos.length} · 플레이리스트 ${state.playlists.length}</div></div>
    <section class="panel playlist-manager"><div class="panel-head"><div><span class="eyebrow">PLAYLISTS</span><h2>플레이리스트</h2><p>용도별 묶음 안에서 영상과 순서를 관리합니다.</p></div></div><div class="playlist-create"><input id="newPlaylistName" placeholder="플레이리스트 이름"><select id="newPlaylistKind"><option value="default">기본 재생</option><option value="patient">환자 맞춤</option></select><select id="newPlaylistTreatment"><option value="">공통</option>${TREATMENT_OPTIONS.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><button id="addPlaylist" class="btn primary">만들기</button></div>${playlistGroupsHtml()}</section>
    <section class="panel"><div class="panel-head"><div><span class="eyebrow">LIBRARY</span><h2>영상 보관함</h2><p>영상의 제목과 사용 여부만 관리합니다.</p></div>${state.videos.some(v=>v.url&&!v.thumbnail_data_url)?'<button id="backfillThumbs" class="btn">누락 썸네일 생성</button>':''}</div><div class="media-list">${state.videos.map(videoRow).join('')||'<p class="muted">등록된 영상이 없습니다.</p>'}</div></section>`;
    qs('#addPlaylist')?.addEventListener('click',addPlaylist);
    qs('#backfillThumbs')?.addEventListener('click',backfillThumbnails);
    qsa('[data-thumbnail-regenerate]').forEach(b=>b.addEventListener('click',()=>regenerateThumbnail(b.dataset.thumbnailRegenerate)));
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
  function videoUsage(id){const playlists=state.playlistItems.filter(x=>x.video_id===id).length,rooms=state.rooms.filter(r=>Array.isArray(r.manual_video_ids)&&r.manual_video_ids.includes(id)).length,broadcast=(state.broadcast?.video_ids||[]).includes(id)?1:0,groups=state.groupBroadcasts.filter(g=>(g.video_ids||[]).includes(id)).length,schedules=state.schedules.filter(x=>(x.video_ids||[]).includes(id)).length,emergency=state.settings?.emergency_video_id===id?1:0;return {playlists,rooms,broadcast,groups,schedules,emergency,total:playlists+rooms+broadcast+groups+schedules+emergency};}
  function videoRow(v){
    const isR2=v.source==='r2',usage=videoUsage(v.id);
    return `<article class="media-row ${v.active?'':'inactive'}"><div class="media-library-thumb">${thumb(v)}</div><div class="grow"><div class="media-title-view" data-title-view="${v.id}"><button type="button" class="media-title-button" data-title-edit="${v.id}" title="제목 수정">${esc(v.title)}</button></div><div class="media-title-edit hidden" data-title-form="${v.id}"><input data-title-input="${v.id}" value="${esc(v.title)}" aria-label="영상 제목"></div><div class="meta">${formatBytes(v.size_bytes)}${v.duration_sec?` · ${formatDuration(v.duration_sec)}`:''}${v.width_px&&v.height_px?` · ${v.width_px}×${v.height_px}`:''}${v.validation_status==='warn'?` · 표준 경고`:v.validation_status==='ok'?` · 표준 확인`:''} · ${isR2?'Cloudflare R2':'기존 영상'}${usage.total?` · 사용 중 ${usage.total}곳/항목`:''}${v.url?` · <a href="${esc(v.url)}" target="_blank" rel="noopener">재생 확인</a>`:''}</div></div><div class="media-actions"><button class="text-action" data-thumbnail-regenerate="${v.id}">${v.thumbnail_data_url?'썸네일 다시 생성':'썸네일 생성'}</button><label class="toggle"><input type="checkbox" data-video-active="${v.id}" ${v.active?'checked':''}><span>사용</span></label><button class="text-action danger-text" data-delete-video="${v.id}">삭제</button></div></article>`;
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
    toggleTitleEdit(id,false);await signalAffectedRooms({all:true});toast('제목을 저장했습니다.');
  }
  async function updateVideo(id,patch){const {error}=await db.from('videos').update(patch).eq('id',id);if(error)return toast(error.message,'error');await signalAffectedRooms({all:true});await load();}
  async function deleteVideo(id){const v=state.videos.find(x=>x.id===id);if(!v)return;const usage=videoUsage(id);if(usage.total)return toast(`사용 중인 영상입니다. 플레이리스트/공간/예약에서 먼저 해제하세요. (${usage.total}개 참조)`,'error');if(!confirm(`${v.title} 영상을 삭제할까요?`))return;const {error}=await db.from('videos').delete().eq('id',id);if(error)return toast(error.message,'error');if(v.source==='r2'&&v.storage_path){apiJson('/api/r2-delete',{method:'POST',body:JSON.stringify({key:v.storage_path})}).catch(()=>toast('DB에서는 삭제됐지만 R2 파일 정리가 필요합니다.','error'));}toast('영상을 삭제했습니다.');await load();}
  async function addPlaylist(){const name=qs('#newPlaylistName').value.trim(),kind=qs('#newPlaylistKind').value,t=qs('#newPlaylistTreatment').value;if(!name)return toast('플레이리스트 이름을 입력하세요.','error');const max=state.playlists.reduce((m,p)=>Math.max(m,Number(p.sort_order)||0),0);const {error}=await db.from('playlists').insert({name,kind,target_treatment:kind==='patient'&&t?[t]:[],sort_order:max+10});if(error)return toast(error.message,'error');toast('플레이리스트를 만들었습니다.');await load();}
  async function updatePlaylist(id,patch){const {error}=await db.from('playlists').update({...patch,updated_at:new Date().toISOString()}).eq('id',id);if(error)toast(error.message,'error');else{await signalAffectedRooms({all:true});await load();}}
  async function deletePlaylist(id){if(!confirm('플레이리스트를 삭제할까요? 영상 파일은 삭제되지 않습니다.'))return;const {error}=await db.from('playlists').delete().eq('id',id);if(error)toast(error.message,'error');else{await signalAffectedRooms({all:true});await load();}}
  async function addPlaylistItem(id){const video=qs(`[data-playlist-video="${id}"]`)?.value;if(!video)return toast('추가할 영상을 선택하세요.','error');const items=playlistItems(id),max=items.reduce((m,x)=>Math.max(m,Number(x.sort_order)||0),0);const {error}=await db.from('playlist_items').insert({playlist_id:id,video_id:video,sort_order:max+10});if(error)toast(error.message,'error');else{await signalAffectedRooms({all:true});await load();}}
  async function removePlaylistItem(id,video){const {error}=await db.from('playlist_items').delete().eq('playlist_id',id).eq('video_id',video);if(error)toast(error.message,'error');else{await signalAffectedRooms({all:true});await load();}}
  async function movePlaylistItem(id,video,dir){const items=playlistItems(id),from=items.findIndex(x=>x.video_id===video),to=from+dir;if(from<0||to<0||to>=items.length)return;[items[from],items[to]]=[items[to],items[from]];const updates=items.map((x,i)=>db.from('playlist_items').update({sort_order:(i+1)*10}).eq('playlist_id',id).eq('video_id',x.video_id));const results=await Promise.all(updates);const error=results.find(x=>x.error)?.error;if(error)toast(error.message,'error');else{await signalAffectedRooms({all:true});await load();}}
  function probeRemoteThumbnail(video){return new Promise((resolve,reject)=>{if(!video?.url)return reject(new Error('영상 주소 없음'));const v=document.createElement('video');v.crossOrigin='anonymous';v.preload='auto';v.muted=true;v.playsInline=true;let done=false;const finish=(fn,arg)=>{if(done)return;done=true;v.removeAttribute('src');try{v.load();}catch(_){}fn(arg);};const fail=()=>finish(reject,new Error(`${video.title}: 썸네일을 만들 수 없습니다.`));v.onloadedmetadata=()=>{try{v.currentTime=Math.min(Math.max(.1,(v.duration||1)*.1),2);}catch(_){fail();}};v.onseeked=()=>{try{const c=document.createElement('canvas'),w=320,h=Math.max(180,Math.round(320*(v.videoHeight/v.videoWidth)));c.width=w;c.height=h;c.getContext('2d').drawImage(v,0,0,w,h);finish(resolve,c.toDataURL('image/jpeg',.62));}catch(_){fail();}};v.onerror=fail;v.src=video.url;});}
  async function backfillThumbnails(){if(uploadBusy)return;const targets=state.videos.filter(v=>v.url&&!v.thumbnail_data_url);if(!targets.length)return toast('누락된 썸네일이 없습니다.');uploadBusy=true;let done=0,failed=0;try{for(const v of targets){try{const thumbnail=await probeRemoteThumbnail(v);const {error}=await db.from('videos').update({thumbnail_data_url:thumbnail}).eq('id',v.id);if(error)throw error;done++;}catch(_){failed++;}}toast(`썸네일 ${done}개 생성${failed?` · 실패 ${failed}개`:''}`,failed?'error':'info');await load();}finally{uploadBusy=false;}}
  async function regenerateThumbnail(id){if(uploadBusy)return;const video=state.videos.find(v=>v.id===id);if(!video?.url)return toast('영상 주소가 없어 썸네일을 만들 수 없습니다.','error');uploadBusy=true;const button=qs(`[data-thumbnail-regenerate="${id}"]`);if(button){button.disabled=true;button.textContent='생성 중…';}try{const thumbnail=await probeRemoteThumbnail(video);const {error}=await db.from('videos').update({thumbnail_data_url:thumbnail}).eq('id',id);if(error)throw error;video.thumbnail_data_url=thumbnail;toast('썸네일을 생성했습니다.');renderVideos();}catch(e){toast(e?.message||'썸네일 생성에 실패했습니다.','error');}finally{uploadBusy=false;}}

  function groupKindLabel(kind){return GROUP_KINDS.find(([v])=>v===kind)?.[1]||'구역';}
  function groupAdminRow(g){
    const floor=floorNumber(g)||'',rooms=state.rooms.filter(r=>r.group_id===g.id);
    return `<details class="group-admin-card"><summary><span><b>${esc(g.name)}</b><small>${floor?`${floor}F · `:''}${esc(careTypeLabel(g.care_type))}${g.signage_purpose?` · ${esc(g.signage_purpose)}`:''}</small></span><em>운영 정보</em></summary><div class="group-admin-editor"><div class="group-admin-grid"><label class="field"><span>층/구역 이름</span><input data-group-name="${g.id}" value="${esc(g.name)}"></label><label class="field"><span>구분</span><select data-group-kind="${g.id}">${GROUP_KINDS.map(([v,l])=>`<option value="${v}" ${g.kind===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="field"><span>층 번호</span><input type="number" min="1" max="99" data-group-floor="${g.id}" value="${floor}"></label><label class="field"><span>진료/운영 성격</span><select data-group-care="${g.id}">${CARE_TYPES.map(([v,l])=>`<option value="${v}" ${g.care_type===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="field group-admin-wide"><span>송출 목적</span><input data-group-purpose="${g.id}" value="${esc(g.signage_purpose||'')}" placeholder="예: 진료 전 치료 이해도 향상"></label><label class="field group-admin-wide"><span>주요 대상</span><input data-group-audience="${g.id}" value="${esc(g.target_audience||'')}" placeholder="예: 미니쉬 상담·진료 고객"></label><label class="field group-admin-wide"><span>고객 대기공간</span><input data-group-waiting="${g.id}" value="${esc(g.waiting_area_note||'')}" placeholder="예: 엘리베이터 앞 공용 대기존 / 상담 전 라운지"></label><label class="field group-admin-wide"><span>송출 이유</span><textarea data-group-reason="${g.id}" rows="2" placeholder="누구나 이해할 수 있게 간단히 입력">${esc(g.signage_reason||'')}</textarea></label><label class="field group-admin-wide"><span>층 기본 플레이리스트</span><select data-group-playlist="${g.id}"><option value="">공간별 기본값 사용</option>${state.playlists.filter(p=>p.active).map(p=>`<option value="${p.id}" ${g.default_playlist_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label></div><div class="inline top-gap"><span class="muted">공간 ${rooms.length}곳</span><button class="btn small primary" data-save-group-meta="${g.id}">운영 정보 저장</button><button class="btn small danger-outline" data-delete-group="${g.id}">삭제</button></div></div></details>`;
  }

  function roomAdminRow(r){const ds=roomDisplayStatus(r);return `<details class="panel room-admin room-admin-compact"><summary><span class="room-admin-name"><span class="dot ${displayControlMode(r)==='manual'?'manual':adminIsOnline(r)?'on':''}"></span><b>${esc(r.name)}</b><em>${esc(groupById(r.group_id)?.name||'미분류')} · ${esc(roomModeLabel(r.room_mode))}</em></span><span class="status-text status-${ds.key}">${esc(ds.label)}</span></summary><div class="room-admin-body"><div class="inline"><div class="order"><button data-move-room="${r.id}" data-dir="-1">↑</button><button data-move-room="${r.id}" data-dir="1">↓</button></div><input class="title-input grow" data-room-name="${r.id}" value="${esc(r.name)}"></div><div class="grid-2"><label class="field"><span>층/구역</span><select data-room-group="${r.id}"><option value="">층/구역 없음</option>${state.groups.map(g=>`<option value="${g.id}" ${r.group_id===g.id?'selected':''}>${esc(g.name)}</option>`).join('')}</select></label><label class="field"><span>공간 유형</span><select data-room-mode="${r.id}">${ROOM_MODES.map(([v,l])=>`<option value="${v}" ${r.room_mode===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="field"><span>디스플레이 운영 방식</span><select data-display-control="${r.id}">${CONTROL_MODES.map(([v,l])=>`<option value="${v}" ${displayControlMode(r)===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="field"><span>기본 플레이리스트</span><select data-room-playlist="${r.id}"><option value="">자동 선택</option>${state.playlists.filter(p=>p.kind==='default'&&p.active).map(p=>`<option value="${p.id}" ${r.default_playlist_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label class="field"><span>맞춤 자동 종료(분)</span><input data-timeout="${r.id}" type="number" min="0" value="${r.session_timeout_min}"></label><label class="toggle room-mute-toggle"><input data-force-mute="${r.id}" type="checkbox" ${r.force_mute?'checked':''}><span>항상 음소거</span></label><label class="field field-span-2"><span>디스플레이 메모</span><input data-display-note="${r.id}" maxlength="120" value="${esc(r.display_note||'')}" placeholder="예: USB 수동 교체 / 리셉션 담당"></label></div>${roomOperatingEditor(r)}<div class="inline top-gap"><button class="btn small danger-outline" data-delete-room="${r.id}">삭제</button></div></div></details>`;}
  async function addGroup(){
    const input=qs('#newGroup'),button=qs('#addGroup'),name=input?.value.trim();
    if(!name||groupSaveBusy)return;
    if(state.groups.some(g=>String(g.name||'').trim().toLocaleLowerCase('ko-KR')===name.toLocaleLowerCase('ko-KR'))){toast('이미 같은 이름의 그룹이 있습니다.','error');input?.focus();return;}
    groupSaveBusy=true;if(button)button.disabled=true;
    try{
      const max=state.groups.reduce((m,g)=>Math.max(m,g.sort_order||0),0);
      const {error}=await db.from('signage_groups').insert({name,kind:qs('#newGroupKind').value,sort_order:max+10,site_id:state.currentSite?.id||null});
      if(error){if(error.code==='23505'||String(error.message||'').toLowerCase().includes('duplicate'))toast('이미 같은 이름의 그룹이 있습니다.','error');else toast(error.message,'error');return;}
      if(input)input.value='';await load();
    } finally {groupSaveBusy=false;if(button)button.disabled=false;}
  }
  async function updateGroup(id,patch){
    if(!patch.name&&Object.hasOwn(patch,'name'))return toast('그룹 이름을 입력하세요.','error');
    if(Object.hasOwn(patch,'name')){const name=String(patch.name||'').trim();if(state.groups.some(g=>g.id!==id&&String(g.name||'').trim().toLocaleLowerCase('ko-KR')===name.toLocaleLowerCase('ko-KR')))return toast('이미 같은 이름의 그룹이 있습니다.','error');patch.name=name;}
    const {error}=await db.from('signage_groups').update(patch).eq('id',id);
    if(error){if(error.code==='23505'||String(error.message||'').toLowerCase().includes('duplicate'))toast('이미 같은 이름의 그룹이 있습니다.','error');else toast(error.message,'error');}else await load();
  }
  async function saveGroupMeta(id){
    const floorRaw=qs(`[data-group-floor="${id}"]`)?.value||'',floor=floorRaw===''?null:Math.max(1,Math.min(99,Number(floorRaw)||1));
    const patch={floor_number:floor,care_type:qs(`[data-group-care="${id}"]`)?.value||'other',signage_purpose:qs(`[data-group-purpose="${id}"]`)?.value.trim()||null,target_audience:qs(`[data-group-audience="${id}"]`)?.value.trim()||null,waiting_area_note:qs(`[data-group-waiting="${id}"]`)?.value.trim()||null,signage_reason:qs(`[data-group-reason="${id}"]`)?.value.trim()||null,default_playlist_id:qs(`[data-group-playlist="${id}"]`)?.value||null};
    const {error}=await db.from('signage_groups').update(patch).eq('id',id);if(error)return toast(error.message,'error');try{await db.rpc('signal_signage_rooms',{p_group:id});}catch(_){}toast('층 운영 정보를 저장했습니다.');await load();
  }


  async function updateDisplayControl(id,mode){
    const r=state.rooms.find(x=>x.id===id);if(!r)return;
    const {error}=await db.rpc('staff_set_display_setup',{p_room:id,p_mode:mode,p_x:r.map_x_pct??null,p_y:r.map_y_pct??null,p_note:r.display_note||null});
    if(error)return toast(error.message||'디스플레이 운영 방식을 저장하지 못했습니다.','error');
    r.display_control_mode=mode;r.manual_check_status=mode==='manual'?(r.manual_check_status==='checked'?'checked':'needs_check'):'not_required';toast('디스플레이 운영 방식을 저장했습니다.');renderSettings();
  }

  async function markAdminManualChecked(roomId){
    const r=state.rooms.find(x=>x.id===roomId);if(!r)return;const checked=r.manual_check_status!=='checked';
    const {error}=await db.rpc('staff_mark_manual_display_checked',{p_room:roomId,p_checked:checked});if(error)return toast(error.message||'수동 확인 상태를 저장하지 못했습니다.','error');
    toast(checked?'수동 디스플레이 확인 완료':'미확인 상태로 변경했습니다.');await load();
  }

  async function deleteGroup(id){const g=groupById(id),count=state.rooms.filter(r=>r.group_id===id).length;if(!confirm(`${g?.name||'그룹'}을 삭제할까요?${count?` 소속 ${count}곳은 미분류로 이동합니다.`:''}`))return;const {error}=await db.from('signage_groups').delete().eq('id',id);if(error)toast(error.message,'error');else await load();}
  async function addRoom(){const name=qs('#newRoom').value.trim();if(!name)return;const max=state.rooms.reduce((m,r)=>Math.max(m,r.sort_order||0),0);const {error}=await db.from('rooms').insert({name,group_id:qs('#newRoomGroup').value||null,room_mode:qs('#newRoomMode').value,sort_order:max+10,site_id:state.currentSite?.id||null,display_control_mode:'remote'});if(error)toast(error.message,'error');else await load();}
  async function moveRoom(id,dir){const list=[...state.rooms],from=list.findIndex(x=>x.id===id),to=from+dir;if(from<0||to<0||to>=list.length)return;[list[from],list[to]]=[list[to],list[from]];const {error}=await db.rpc('admin_reorder_rooms',{p_ids:list.map(x=>x.id)});if(error)toast(error.message,'error');else await load();}
  function roomPlayerPath(id){const r=state.rooms.find(x=>x.id===id);return r?.player_key?`/player.html?key=${encodeURIComponent(r.player_key)}`:'';}function openRoomPlayer(id){const path=roomPlayerPath(id);if(!path)return toast('공간 플레이어 주소를 찾을 수 없습니다.','error');openAddress(path);}async function copyRoomPlayer(id){const path=roomPlayerPath(id);if(!path)return toast('공간 플레이어 주소를 찾을 수 없습니다.','error');await copyAddress(path,'공간 플레이어 링크');}
  async function copyAddress(path,label='주소'){
    const u=`${location.origin}${path}`;
    try{
      if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(u);}
      else{const ta=document.createElement('textarea');ta.value=u;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();const ok=document.execCommand('copy');ta.remove();if(!ok)throw new Error('COPY_FAILED');}
      toast(`${label} 복사됨`);
    }catch(_){window.prompt(`${label}를 복사하세요`,u);}
  }
  function openAddress(path){window.open(`${location.origin}${path}`,'_blank','noopener');}

  function accessLinksMarkup(){
    const site=state.currentSite,hospitalPath=site?siteAdminPath(site):'/hospital.html',adminPath='/admin.html',players=site?sitePlayerRooms(site):[];
    return `<section class="settings-section access-section"><div class="settings-section-head"><div><span class="eyebrow">ACCESS</span><h2>접속 주소</h2><p>${site?`${esc(site.name)}의 관리자와 실제 환자 송출 화면 주소입니다.`:'관리 화면 주소입니다.'}</p></div></div><div class="access-grid"><article class="access-card access-card-primary"><span class="access-label">병원 관리자</span><h3>${esc(absoluteAddress(hospitalPath))}</h3><div class="access-actions"><button class="btn primary" data-copy-address="${esc(hospitalPath)}" data-copy-label="병원 관리자 주소">주소 복사</button></div></article><article class="access-card"><span class="access-label">슈퍼어드민</span><h3>${esc(absoluteAddress(adminPath))}</h3><div class="access-actions"><button class="btn" data-open-address="${esc(adminPath)}">열기</button><button class="btn" data-copy-address="${esc(adminPath)}" data-copy-label="슈퍼어드민 주소">복사</button></div></article></div>${players.length?`<div class="access-player-list"><div class="settings-section-head compact"><div><span class="eyebrow">PATIENT DISPLAY</span><h3>환자 화면</h3><p>실제 디스플레이에서 사용하는 Player 주소입니다.</p></div><span>${players.length}개</span></div>${players.map(r=>{const path=`/player.html?key=${encodeURIComponent(r.player_key)}`;return `<div class="access-player-row"><span><b>${esc(r.name)}</b><code>${esc(absoluteAddress(path))}</code></span><div class="access-actions"><button class="btn small" data-open-address="${esc(path)}">열기</button><button class="btn small" data-copy-address="${esc(path)}" data-copy-label="${esc(r.name)} 환자 화면 주소">복사</button></div></div>`;}).join('')}</div>`:`<p class="muted top-gap">현재 병원에 웹 Player를 사용하는 원격/하이브리드 디스플레이가 없습니다.</p>`}</section>`;
  }

  function floorplanManagerMarkup(){
    const rows=Array.from({length:14},(_,i)=>i+1).map(floor=>{
      const meta=floorplanMeta(floor),versions=floorplanVersionsFor(floor),status=meta?'업로드 도면':'도면 없음';
      const detail=meta?`${esc(meta.filename||'업로드 이미지')} · ${formatBytes(meta.size||0)}`:(hasFallback?'기본 제공 도면을 사용 중입니다.':'도면을 업로드하세요.');
      return `<article class="floorplan-admin-row"><div class="floorplan-admin-copy"><b>${floor}F</b><span>${status}</span><small>${detail}${versions.length?` · 버전 ${versions.length}개`:''}</small></div><div class="floorplan-admin-actions"><label class="btn small floorplan-upload-btn"><input type="file" accept="image/png,image/jpeg,image/webp" data-floorplan-upload="${floor}"><span>${meta?'도면 교체':'도면 업로드'}</span></label>${meta?`<button class="btn small" type="button" data-floorplan-reset="${floor}">도면 제거</button>`:''}${versions.length>1?`<select class="compact-select" data-floorplan-version="${floor}">${versions.map(v=>`<option value="${v.id}" ${v.object_key===meta?.key?'selected':''}>${esc(v.filename||'도면')} · ${new Date(v.created_at).toLocaleDateString('ko-KR')}</option>`).join('')}</select><button class="btn small" type="button" data-floorplan-restore="${floor}">선택 버전 복원</button>`:''}</div><div class="floorplan-upload-progress" data-floorplan-progress="${floor}"><i></i></div></article>`;
    }).join('');
    return `<section class="settings-section floorplan-manager"><div class="settings-section-head"><div><span class="eyebrow">FLOOR PLAN</span><h2>층별 도면</h2><p>각 층의 실제 도면을 직접 업로드합니다. PNG·JPG·WebP, 최대 12MB. 업로드한 도면은 내부 관제에서만 표시됩니다.</p></div></div><div class="floorplan-admin-list">${rows}</div></section>`;
  }
  async function saveFloorplanAssets(next){
    const sid=state.currentSite?.id;if(!sid)throw new Error('SITE_NOT_SELECTED');const {error}=await db.from('site_settings').upsert({site_id:sid,floorplan_assets:next,updated_at:new Date().toISOString()},{onConflict:'site_id'});
    if(error){const msg=String(error.message||'');if(/floorplan_assets|schema cache|column/i.test(msg))throw new Error('층별 도면 저장용 DB 컬럼이 아직 적용되지 않았습니다. v2.33.2 migration을 먼저 실행하세요.');throw error;}
    state.settings.floorplan_assets=next;floorplanTextCache.clear();
  }
  async function pruneFloorplanVersions(siteId,floor,keep=5){
    try{
      const {data,error}=await db.from('floorplan_versions').select('*').eq('site_id',siteId).eq('floor_number',floor).order('created_at',{ascending:false});
      if(error)throw error;const stale=(data||[]).slice(keep).filter(v=>!v.active);
      for(const v of stale){try{await apiJson('/api/floorplan-delete',{method:'POST',body:JSON.stringify({siteId,key:v.object_key})});}catch(e){console.warn('[floorplan] old version R2 cleanup failed',e);}await db.from('floorplan_versions').delete().eq('id',v.id);}
    }catch(e){console.warn('[floorplan] version pruning skipped',e);}
  }
  async function uploadFloorplan(floor,file){
    if(!file)return;
    const mime=String(file.type||'').toLowerCase();
    if(!['image/png','image/jpeg','image/webp'].includes(mime))return toast('도면은 PNG, JPG, WebP만 업로드할 수 있습니다.','error');
    if(file.size<=0||file.size>12*1024*1024)return toast('도면 파일은 12MB 이하만 업로드할 수 있습니다.','error');
    const progress=qs(`[data-floorplan-progress="${floor}"]`),bar=progress?.querySelector('i');progress?.classList.add('is-active');if(bar)bar.style.width='2%';
    try{
      const signed=await apiJson('/api/floorplan-presign',{method:'POST',body:JSON.stringify({floor,filename:file.name,contentType:mime,size:file.size,siteId:state.currentSite?.id||null})});
      await uploadByXhr(signed.uploadUrl,file,mime,pct=>{if(bar)bar.style.width=`${pct}%`;});
      const old=floorplanMeta(floor),next={...floorplanAssets(),[String(floor)]:{key:signed.key,filename:file.name,mime,size:file.size,updated_at:new Date().toISOString()}};
      await db.from('floorplan_versions').update({active:false}).eq('site_id',state.currentSite.id).eq('floor_number',floor);
      await db.from('floorplan_versions').insert({site_id:state.currentSite.id,floor_number:floor,object_key:signed.key,filename:file.name,mime,size_bytes:file.size,active:true});
      await saveFloorplanAssets(next);await pruneFloorplanVersions(state.currentSite.id,floor);
      toast(`${floor}층 도면을 저장했습니다.`);await load();
    }catch(e){toast(e.message||'도면 업로드에 실패했습니다.','error');}
    finally{progress?.classList.remove('is-active');if(bar)bar.style.width='0%';}
  }
  async function resetFloorplan(floor){
    const old=floorplanMeta(floor);if(!old)return;
    if(!confirm(`${floor}층 업로드 도면을 제거할까요?`))return;
    try{
      const next={...floorplanAssets()};delete next[String(floor)];await saveFloorplanAssets(next);
      await db.from('floorplan_versions').update({active:false}).eq('site_id',state.currentSite.id).eq('floor_number',floor);
      toast(`${floor}층 도면을 제거했습니다.`);await load();
    }catch(e){toast(e.message||'도면을 제거하지 못했습니다.','error');}
  }
  async function restoreFloorplanVersion(floor){const id=qs(`[data-floorplan-version="${floor}"]`)?.value,v=state.floorplanVersions.find(x=>x.id===id);if(!v)return;try{const next={...floorplanAssets(),[String(floor)]:{key:v.object_key,filename:v.filename,mime:v.mime,size:Number(v.size_bytes||0),updated_at:new Date().toISOString()}};await db.from('floorplan_versions').update({active:false}).eq('site_id',state.currentSite.id).eq('floor_number',floor);await db.from('floorplan_versions').update({active:true}).eq('id',v.id);await saveFloorplanAssets(next);toast(`${floor}층 도면 이전 버전을 복원했습니다.`);await load();}catch(e){toast(e.message||String(e),'error');}}
  function bindFloorplanManager(){
    qsa('[data-floorplan-upload]').forEach(input=>input.addEventListener('change',()=>{const file=input.files?.[0];if(file)uploadFloorplan(Number(input.dataset.floorplanUpload),file);input.value='';}));
    qsa('[data-floorplan-reset]').forEach(btn=>btn.addEventListener('click',()=>resetFloorplan(Number(btn.dataset.floorplanReset))));
    qsa('[data-floorplan-restore]').forEach(btn=>btn.addEventListener('click',()=>restoreFloorplanVersion(Number(btn.dataset.floorplanRestore))));
  }

  function displayPositionSetupMarkup(){
    const floors=state.groups.filter(g=>floorAsset(g)).sort((a,b)=>floorNumber(a)-floorNumber(b));
    const total=state.rooms.filter(r=>r.group_id&&floorAsset(groupById(r.group_id))).length;
    const unplaced=state.rooms.filter(r=>r.group_id&&floorAsset(groupById(r.group_id))&&!roomMapPlaced(r)).length;
    const cards=floors.map((g,idx)=>{
      const rooms=state.rooms.filter(r=>r.group_id===g.id),missing=rooms.filter(r=>!roomMapPlaced(r)).length;
      if(!rooms.length)return '';
      const ordered=[...rooms].sort((a,b)=>Number(roomMapPlaced(a))-Number(roomMapPlaced(b))||String(a.name||'').localeCompare(String(b.name||''),'ko'));
      return `<details class="display-setup-floor" ${missing&&idx<3?'open':''}><summary><span><b>${esc(floorTitle(g))} · ${esc(g.name)}</b><small>디스플레이 ${rooms.length}대${missing?` · 위치 미설정 ${missing}대`:' · 설정 완료'}</small></span><em>${missing?'설정 필요':'완료'}</em></summary><div class="display-setup-body"><div class="display-setup-toolbar"><label><span>배치할 디스플레이</span><select data-map-room-select="${g.id}">${ordered.map(r=>`<option value="${r.id}" ${!roomMapPlaced(r)?'data-unplaced="1"':''}>${esc(r.name)} · ${esc(displayControlLabel(r))}${roomMapPlaced(r)?' · 배치됨':' · 위치 미설정'}</option>`).join('')}</select></label><label><span>운영 방식</span><select data-map-control-mode="${g.id}">${CONTROL_MODES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><p>위치는 자동으로 만들지 않습니다. 디스플레이를 선택한 뒤 실제 설치 위치를 클릭하세요. 배치 후에는 아이콘을 드래그해 수정할 수 있습니다.</p><button class="btn small" data-clear-display-position="${g.id}">선택 위치 지우기</button></div><div class="settings-map-stage display-setup-stage" data-map-stage="${g.id}"><div class="floorplan-svg-host" data-floorplan-svg="${floorAsset(g)}"></div>${rooms.map(r=>floorMapMarker(r,true)).join('')}</div></div></details>`;
    }).join('');
    return `<section class="settings-section display-position-setup"><div class="settings-section-head"><div><span class="eyebrow">DISPLAY MAP</span><h2>디스플레이 위치 설정</h2><p>모든 위치는 미설정이 기본입니다. 실제 설치 후 이 화면에서 직접 지정하거나 수정합니다.</p></div><div class="settings-count">${total}대 · 미설정 ${unplaced}대</div></div><div class="display-setup-guide"><b>설정 순서</b><span>1. 층 열기</span><span>2. 디스플레이 선택</span><span>3. 실제 위치 클릭</span><span>4. 드래그로 수정</span><button class="btn small" type="button" data-reset-all-display-positions ${total?'':'disabled'}>전체 위치 초기화</button></div><div class="display-setup-list">${cards||'<span class="muted empty-setting-message">먼저 층과 공간을 등록하세요.</span>'}</div></section>`;
  }

  function roomSettingsMarkup(){
    const grouped=[...state.groups.map(g=>({group:g,rooms:state.rooms.filter(r=>r.group_id===g.id)})),{group:null,rooms:state.rooms.filter(r=>!r.group_id)}].filter(x=>x.rooms.length);
    const groupSections=grouped.map(({group,rooms})=>`<details class="space-room-group"><summary><span><b>${esc(group?.name||'미분류')}</b><small>${group?.kind?esc(groupKindLabel(group.kind))+' · ':''}${rooms.length}곳</small></span><em>공간 보기</em></summary><div class="room-admin-list settings-room-list">${rooms.map(roomAdminRow).join('')}</div></details>`).join('');
    return `<section class="settings-section space-manager"><div class="settings-section-head"><div><span class="eyebrow">SPACE</span><h2>공간 관리</h2><p>층/구역과 실제 송출 공간을 필요할 때만 열어 관리합니다.</p></div><div class="settings-count">공간 ${state.rooms.length}곳 · 층/구역 ${state.groups.length}개</div></div><div class="space-control-grid"><details class="settings-card space-control-panel"><summary><span><b>층/구역 관리</b><small>${state.groups.length}개 등록</small></span><em>관리</em></summary><div class="space-control-body"><p class="muted">층 또는 여러 공간을 묶는 구역을 추가하거나 수정합니다.</p><div class="inline space-add-inline"><input id="newGroup" placeholder="예: 10F"><select id="newGroupKind">${GROUP_KINDS.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><button id="addGroup" class="btn primary">추가</button></div><div class="group-admin-list top-gap">${state.groups.map(groupAdminRow).join('')||'<span class="muted empty-setting-message">아직 등록된 층/구역이 없습니다.</span>'}</div></div></details><details class="settings-card space-control-panel"><summary><span><b>공간 추가</b><small>새 송출 위치 등록</small></span><em>추가</em></summary><div class="space-control-body"><p class="muted">실제로 영상이 재생되는 진료실, 상담실, 대기실, 로비 등을 등록합니다.</p><div class="settings-add-room"><input id="newRoom" placeholder="예: 10F-01"><select id="newRoomGroup"><option value="">층/구역 없음</option>${state.groups.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select><select id="newRoomMode">${ROOM_MODES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><button id="addRoom" class="btn primary">공간 추가</button></div></div></details></div><details class="settings-card registered-spaces registered-spaces-compact"><summary class="registered-spaces-summary"><span><b>등록된 공간</b><small>${state.rooms.length}곳 · 공간별 기본 플레이리스트와 세부 설정</small></span><em>관리</em></summary><div class="registered-spaces-body">${groupSections||'<span class="muted empty-setting-message">등록된 공간이 없습니다.</span>'}</div></details></section>`;
  }

  function displayMapSaveError(error){
    const msg=String(error?.message||'');
    const details=String(error?.details||'');
    const code=String(error?.code||'');
    if(code==='PGRST204'||/map_[xy]_pct|schema cache|column/i.test(`${msg} ${details}`)){
      return '디스플레이 위치 저장용 DB 컬럼이 아직 적용되지 않았습니다. v2.31.5 display-map migration을 먼저 실행하세요.';
    }
    return msg||'디스플레이 위치를 저장하지 못했습니다.';
  }
  async function saveDisplayPosition(roomId,x,y,{quiet=false}={}){
    const px=Number(Math.max(0,Math.min(100,x)).toFixed(2)),py=Number(Math.max(0,Math.min(100,y)).toFixed(2));
    const room=state.rooms.find(r=>r.id===roomId);if(!room)return false;
    const {error}=await db.rpc('staff_set_display_setup',{p_room:roomId,p_mode:displayControlMode(room),p_x:px,p_y:py,p_note:room.display_note||null});
    if(error){toast(displayMapSaveError(error),'error');return false;}
    room.map_x_pct=px;room.map_y_pct=py;
    if(!quiet)toast('디스플레이 위치를 저장했습니다.');
    return true;
  }
  function bindDisplayPositionSetup(){
    const syncSelectedMarker=(gid)=>{const stage=qs(`[data-map-stage="${gid}"]`),roomId=qs(`[data-map-room-select="${gid}"]`)?.value;if(!stage)return;const room=state.rooms.find(r=>r.id===roomId),mode=qs(`[data-map-control-mode="${gid}"]`);if(mode&&room)mode.value=displayControlMode(room);qsa('[data-display-marker]',stage).forEach(m=>m.classList.toggle('is-selected',m.dataset.displayMarker===roomId));};
    qsa('[data-map-room-select]').forEach(select=>{select.addEventListener('change',()=>syncSelectedMarker(select.dataset.mapRoomSelect));syncSelectedMarker(select.dataset.mapRoomSelect);});
    qsa('[data-map-control-mode]').forEach(select=>select.addEventListener('change',async()=>{const gid=select.dataset.mapControlMode,roomId=qs(`[data-map-room-select="${gid}"]`)?.value;if(roomId)await updateDisplayControl(roomId,select.value);}));
    qsa('[data-map-stage]').forEach(stage=>stage.addEventListener('click',async(e)=>{
      if(e.target.closest('[data-display-marker]'))return;
      const gid=stage.dataset.mapStage,roomId=qs(`[data-map-room-select="${gid}"]`)?.value;if(!roomId)return;
      const rect=stage.getBoundingClientRect(),x=((e.clientX-rect.left)/rect.width)*100,y=((e.clientY-rect.top)/rect.height)*100;
      if(await saveDisplayPosition(roomId,x,y)){const marker=stage.querySelector(`[data-display-marker="${roomId}"]`);if(marker){marker.style.left=`${x}%`;marker.style.top=`${y}%`;}else renderSettings();}
    }));
    qsa('[data-clear-display-position]').forEach(btn=>btn.addEventListener('click',async()=>{
      const gid=btn.dataset.clearDisplayPosition,roomId=qs(`[data-map-room-select="${gid}"]`)?.value;if(!roomId)return;
      const {error}=await db.from('rooms').update({map_x_pct:null,map_y_pct:null}).eq('id',roomId);if(error)return toast(displayMapSaveError(error),'error');
      const room=state.rooms.find(r=>r.id===roomId);if(room){room.map_x_pct=null;room.map_y_pct=null;}toast('디스플레이 위치를 지웠습니다.');renderSettings();
    }));
    qs('[data-reset-all-display-positions]')?.addEventListener('click',async()=>{
      if(!confirm('모든 디스플레이 위치를 초기화할까요? 실제 위치를 다시 설정해야 합니다.'))return;
      const {error}=await db.from('rooms').update({map_x_pct:null,map_y_pct:null}).eq('site_id',state.currentSite.id).not('id','is',null);
      if(error)return toast(displayMapSaveError(error),'error');
      state.rooms.forEach(r=>{r.map_x_pct=null;r.map_y_pct=null;});
      toast('모든 디스플레이 위치를 초기화했습니다.');renderSettings();
    });
    qsa('[data-display-marker]').forEach(marker=>{
      marker.addEventListener('pointerdown',e=>{
        e.preventDefault();e.stopPropagation();const stage=marker.closest('[data-map-stage]');if(!stage)return;marker.setPointerCapture?.(e.pointerId);marker.classList.add('is-dragging');
        const move=ev=>{const rect=stage.getBoundingClientRect(),x=Math.max(0,Math.min(100,((ev.clientX-rect.left)/rect.width)*100)),y=Math.max(0,Math.min(100,((ev.clientY-rect.top)/rect.height)*100));marker.style.left=`${x}%`;marker.style.top=`${y}%`;};
        const up=async ev=>{marker.removeEventListener('pointermove',move);marker.removeEventListener('pointerup',up);marker.removeEventListener('pointercancel',up);marker.classList.remove('is-dragging');const rect=stage.getBoundingClientRect(),x=Math.max(0,Math.min(100,((ev.clientX-rect.left)/rect.width)*100)),y=Math.max(0,Math.min(100,((ev.clientY-rect.top)/rect.height)*100));await saveDisplayPosition(marker.dataset.displayMarker,x,y);};
        marker.addEventListener('pointermove',move);marker.addEventListener('pointerup',up);marker.addEventListener('pointercancel',up);
      });
    });
  }

  function bindRoomSettings(){
    qs('#addGroup')?.addEventListener('click',addGroup); qs('#addRoom')?.addEventListener('click',addRoom);
    qsa('[data-group-name]').forEach(i=>i.addEventListener('change',()=>updateGroup(i.dataset.groupName,{name:i.value.trim()})));qsa('[data-group-kind]').forEach(i=>i.addEventListener('change',()=>updateGroup(i.dataset.groupKind,{kind:i.value})));qsa('[data-save-group-meta]').forEach(b=>b.addEventListener('click',()=>saveGroupMeta(b.dataset.saveGroupMeta)));bindDisplayPositionSetup();qsa('[data-delete-group]').forEach(b=>b.addEventListener('click',()=>deleteGroup(b.dataset.deleteGroup)));
    qsa('[data-room-name]').forEach(i=>i.addEventListener('change',()=>{const name=i.value.trim();if(!name){toast('공간 이름을 입력하세요.','error');i.value=state.rooms.find(r=>r.id===i.dataset.roomName)?.name||'';return;}updateRoom(i.dataset.roomName,{name});}));qsa('[data-room-group]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.roomGroup,{group_id:i.value||null})));qsa('[data-room-mode]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.roomMode,{room_mode:i.value})));qsa('[data-display-control]').forEach(i=>i.addEventListener('change',()=>updateDisplayControl(i.dataset.displayControl,i.value)));qsa('[data-display-note]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.displayNote,{display_note:i.value.trim()||null})));qsa('[data-force-mute]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.forceMute,{force_mute:i.checked})));qsa('[data-timeout]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.timeout,{session_timeout_min:Math.max(0,Number(i.value)||0)})));qsa('[data-room-playlist]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.roomPlaylist,{default_playlist_id:i.value||null})));qsa('[data-room-hours-override]').forEach(i=>i.addEventListener('change',async()=>{const id=i.dataset.roomHoursOverride,wrap=qs(`[data-room-hours-wrap="${id}"]`),btn=qs(`[data-room-hours-save="${id}"]`);wrap?.classList.toggle('is-disabled',!i.checked);if(btn)btn.disabled=!i.checked;const {error}=await db.from('rooms').update({operating_override:i.checked}).eq('id',id);if(error)toast(error.message,'error');else{const r=state.rooms.find(x=>x.id===id);if(r)r.operating_override=i.checked;try{await db.rpc('signal_signage_rooms',{p_room_ids:[id]});}catch(_){}}}));qsa('[data-room-hours-enabled]').forEach(i=>i.addEventListener('change',()=>{const key=i.dataset.roomHoursEnabled,wrap=qs(`[data-room-hours-fields="${key}"]`);wrap?.classList.toggle('is-disabled',!i.checked);qsa(`[data-room-hours-start="${key}"],[data-room-hours-end="${key}"]`).forEach(x=>x.disabled=!i.checked);}));qsa('[data-room-hours-save]').forEach(b=>b.addEventListener('click',async()=>{const id=b.dataset.roomHoursSave,patch={operating_override:true};for(const key of ['weekday','saturday','sunday']){const token=`${id}:${key}`,enabled=!!qs(`[data-room-hours-enabled="${token}"]`)?.checked,start=qs(`[data-room-hours-start="${token}"]`)?.value,end=qs(`[data-room-hours-end="${token}"]`)?.value;if(enabled&&(!start||!end||start>=end))return toast('공간 운영시간을 확인하세요.','error');patch[`operating_${key}_enabled`]=enabled;patch[`operating_${key}_start`]=start||'09:00';patch[`operating_${key}_end`]=end||'17:00';}const {error}=await db.from('rooms').update(patch).eq('id',id);if(error)return toast(error.message,'error');toast('공간 운영시간 저장 완료');await db.rpc('signal_signage_rooms',{p_room_ids:[id]}).catch(()=>{});await load();}));qsa('[data-delete-room]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('공간을 삭제할까요?'))return;const {error}=await db.from('rooms').delete().eq('id',b.dataset.deleteRoom);if(error)toast(error.message,'error');else await load();}));qsa('[data-move-room]').forEach(b=>b.addEventListener('click',()=>moveRoom(b.dataset.moveRoom,Number(b.dataset.dir))));
  }

  function operatingDayRow(key,label,enabled,start,end){return `<div class="operating-day-row"><label class="toggle"><input type="checkbox" data-hours-enabled="${key}" ${enabled?'checked':''}><span>${label}</span></label><div class="operating-time-fields ${enabled?'':'is-disabled'}" data-hours-fields="${key}"><input type="time" data-hours-start="${key}" value="${String(start).slice(0,5)}" ${enabled?'':'disabled'}><span>–</span><input type="time" data-hours-end="${key}" value="${String(end).slice(0,5)}" ${enabled?'':'disabled'}></div><b>${enabled?'운영':'휴무'}</b></div>`;}
  function roomOperatingDayRow(r,key,label){const enabled=r[`operating_${key}_enabled`]!==false,start=r[`operating_${key}_start`]||'09:00',end=r[`operating_${key}_end`]||'17:00';return `<div class="operating-day-row compact"><label class="toggle"><input type="checkbox" data-room-hours-enabled="${r.id}:${key}" ${enabled?'checked':''}><span>${label}</span></label><div class="operating-time-fields ${enabled?'':'is-disabled'}" data-room-hours-fields="${r.id}:${key}"><input type="time" data-room-hours-start="${r.id}:${key}" value="${String(start).slice(0,5)}" ${enabled?'':'disabled'}><span>–</span><input type="time" data-room-hours-end="${r.id}:${key}" value="${String(end).slice(0,5)}" ${enabled?'':'disabled'}></div></div>`;}
  function roomOperatingEditor(r){return `<details class="room-operating-editor"><summary>개별 운영시간 <span>${r.operating_override?'사용 중':'전체 운영시간 따름'}</span></summary><div class="room-operating-body"><label class="toggle"><input type="checkbox" data-room-hours-override="${r.id}" ${r.operating_override?'checked':''}><span>이 공간만 별도 운영시간 사용</span></label><div class="room-operating-days ${r.operating_override?'':'is-disabled'}" data-room-hours-wrap="${r.id}">${roomOperatingDayRow(r,'weekday','평일')}${roomOperatingDayRow(r,'saturday','토요일')}${roomOperatingDayRow(r,'sunday','일요일')}</div><button class="btn small primary" data-room-hours-save="${r.id}" ${r.operating_override?'':'disabled'}>운영시간 저장</button></div></details>`;}
  function roomProblemRank(r){const k=roomDisplayStatus(r).key;return ({error:0,update:1,offline:2,'manual-warn':3,idle:4,manual:5,live:6})[k]??7;}
  function cacheStatusText(r){const st=r.player_status||{},total=Number(st.offline_cache_total||0),count=Number(st.offline_cache_count||0),ready=st.offline_cache_ready===true;if(st.source==='offline-playlist-cache')return `오프라인 재생 중 · ${count}/${total||count}`;if(st.offline_cache_error)return `캐시 오류 · ${String(st.offline_cache_error).slice(0,80)}`;if(total&&ready)return `준비 완료 ${count}/${total}`;if(total)return `캐시 부족 ${count}/${total}`;return '캐시 부족 0/0';}



  function setupProgressMarkup(){const customPlans=Object.keys(floorplanAssets()).filter(k=>floorplanMeta(Number(k))?.key).length,spaces=state.floorSpaces.length,placed=state.rooms.filter(roomMapPlaced).length,total=state.rooms.length;const steps=[['병원 정보',!!state.currentSite?.name&&!!state.currentSite?.building_label],['도면 업로드',customPlans>0],['공간 구분',spaces>0],['디스플레이 위치',total>0&&placed===total],['콘텐츠 연결',state.playlists.some(p=>p.active)]];const done=steps.filter(x=>x[1]).length;return `<section class="settings-section setup-progress-section"><div class="settings-section-head"><div><span class="eyebrow">SETUP</span><h2>초기 설치 상태</h2><p>새 병원은 이 순서만 완료하면 운영을 시작할 수 있습니다.</p></div><div class="settings-count">${done}/${steps.length}</div></div><div class="setup-progress-grid">${steps.map(([label,ok],i)=>`<div class="setup-progress-item ${ok?'is-done':''}"><i>${ok?'✓':i+1}</i><span>${label}</span></div>`).join('')}</div></section>`;}
  function siteManagerMarkup(){
    const options=state.sites.map(s=>`<option value="${s.id}" ${state.currentSite?.id===s.id?'selected':''}>${esc(s.name)} · /${esc(siteSlug(s))}${s.active===false?' · 비활성':''}</option>`).join('');
    return `<section class="settings-section product-site-manager"><div class="settings-section-head"><div><span class="eyebrow">SUPER ADMIN</span><h2>관리 병원</h2><p>병원별 슬러그로 구분하고, 선택한 병원의 설정만 관리합니다.</p></div><div class="settings-count">${state.sites.length}개</div></div><div class="site-manager-grid"><div class="settings-card"><h3>현재 관리 병원</h3><label class="field"><span>병원 선택</span><select id="superAdminSiteSelect">${options}</select></label><label class="field"><span>슬러그</span><div class="slug-input"><i>/</i><input id="currentSiteSlug" maxlength="32" autocomplete="off" spellcheck="false" value="${esc(siteSlug(state.currentSite))}"></div></label><div class="inline"><button id="saveCurrentSiteSlug" class="btn small">슬러그 저장</button></div><p class="muted">선택한 병원의 층·공간·도면·디스플레이만 아래에 표시됩니다.</p></div><div class="settings-card"><h3>새 병원 추가</h3><label class="field"><span>병원명</span><input id="newSiteName" maxlength="60" placeholder="예: 강남 본원"></label><label class="field"><span>슬러그</span><div class="slug-input"><i>/</i><input id="newSiteSlug" maxlength="32" autocomplete="off" spellcheck="false" placeholder="gangnam"></div><small class="field-help">영문 소문자·숫자·하이픈(-)을 권장합니다. 병원을 구분하는 고유 주소입니다.</small></label><button id="addSite" class="btn primary">병원 추가</button></div><div class="settings-card"><h3>병원 관리자 PIN</h3><p class="muted">현재 선택한 병원의 관리자 로그인 PIN입니다.</p><label class="field"><span>PIN · 4~6자리</span><input id="siteStaffPin" type="password" inputmode="numeric" maxlength="6"></label><button id="saveSiteStaffPin" class="btn">PIN 변경</button></div></div></section>`;
  }
  async function switchSite(id){if(!id)return;hospitalFocusOpen=true;if(id===state.currentSite?.id){selectedFloorId=null;spaceEditorGroupId=null;render();return;}localStorage.setItem('clinic_signage_superadmin_site',id);selectedFloorId=null;spaceEditorGroupId=null;await load();}
  async function saveCurrentSiteSlug(){
    if(!state.currentSite?.id)return;
    const input=qs('#currentSiteSlug');
    const slug=String(input?.value||'').trim().toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').replace(/-{2,}/g,'-');
    if(slug.length<2)return toast('슬러그는 2자 이상 입력하세요.','error');
    if(state.sites.some(x=>x.id!==state.currentSite.id&&siteSlug(x)===slug))return toast('이미 사용 중인 슬러그입니다.','error');
    const {error}=await db.from('sites').update({code:slug}).eq('id',state.currentSite.id);
    if(error)return toast(error.code==='23505'?'이미 사용 중인 슬러그입니다.':error.message,'error');
    toast('병원 슬러그를 변경했습니다.');
    await load();
  }
  async function addSite(){
    const name=(qs('#newSiteName')?.value||'').trim(),code=(qs('#newSiteSlug')?.value||'').trim().toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').replace(/-{2,}/g,'-');
    if(!name||!code)return toast('병원명과 슬러그를 입력하세요.','error');
    if(code.length<2)return toast('슬러그는 2자 이상 입력하세요.','error');
    const {data,error}=await db.rpc('admin_create_site',{p_name:name,p_code:code,p_building_label:'MAIN BUILDING'});
    if(error)return toast(error.message||'병원을 추가하지 못했습니다.','error');
    if(!data?.ok)return toast(data?.message||'병원을 추가하지 못했습니다.','error');
    const site=data.site||{};
    if(site.id)localStorage.setItem('clinic_signage_superadmin_site',site.id);
    toast(data.existing?'이미 등록된 병원을 선택했습니다.':'병원을 추가했습니다.');
    await load();
  }
  async function saveSiteStaffPin(){const pin=(qs('#siteStaffPin')?.value||'').replace(/\D/g,'');if(pin.length<4||pin.length>6)return toast('병원 관리자 PIN은 4~6자리입니다.','error');if(!state.currentSite?.id)return;const {error}=await db.rpc('admin_set_site_staff_pin',{p_site:state.currentSite.id,p_pin:pin});if(error)return toast(error.message,'error');qs('#siteStaffPin').value='';toast('병원 관리자 PIN을 변경했습니다.');}

  function floorSpaceOverlay(space,editable=false){return `<button type="button" class="floor-space-overlay type-${esc(space.space_type||'other')} ${editable?'is-editable':''}" data-floor-space="${space.id}" style="left:${Number(space.x_pct)}%;top:${Number(space.y_pct)}%;width:${Number(space.width_pct)}%;height:${Number(space.height_pct)}%"><span>${esc(space.name)}</span></button>`;}
  function floorSpaceManagerMarkup(){
    const floors=state.groups.filter(g=>g.kind==='floor'&&floorAsset(g)).sort((a,b)=>floorNumber(a)-floorNumber(b));
    if(!floors.length)return `<section class="settings-section"><div class="settings-section-head"><div><span class="eyebrow">SPACE MAP</span><h2>도면 공간 구분</h2><p>먼저 층과 도면을 등록하세요.</p></div></div></section>`;
    const current=floors.find(g=>g.id===spaceEditorGroupId)||floors[0];spaceEditorGroupId=current.id;
    const spaces=state.floorSpaces.filter(x=>x.group_id===current.id),asset=floorAsset(current);
    return `<section class="settings-section floor-space-manager"><div class="settings-section-head"><div><span class="eyebrow">SPACE MAP</span><h2>도면 공간 구분</h2><p>도면 위에서 드래그해 실제 운영 공간을 사각형/직사각형으로 지정합니다. 진료실·대기실처럼 필요한 공간만 표시하세요.</p></div><div class="settings-count">${spaces.length}개</div></div><div class="floor-space-toolbar"><label><span>층</span><select id="spaceEditorFloor">${floors.map(g=>`<option value="${g.id}" ${g.id===current.id?'selected':''}>${esc(floorTitle(g))} · ${esc(g.name)}</option>`).join('')}</select></label><label><span>공간명</span><input id="newFloorSpaceName" maxlength="40" placeholder="예: 진료실 1"></label><label><span>유형</span><select id="newFloorSpaceType">${FLOOR_SPACE_TYPES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><span class="muted">이름과 유형을 입력한 뒤 도면에서 드래그하세요.</span></div><div class="settings-map-stage floor-space-stage" data-space-stage="${current.id}"><div class="floorplan-svg-host" data-floorplan-svg="${asset}"></div>${spaces.map(x=>floorSpaceOverlay(x,true)).join('')}</div><div class="floor-space-list">${spaces.map(x=>`<div><span><b>${esc(x.name)}</b><small>${esc(FLOOR_SPACE_TYPES.find(([v])=>v===x.space_type)?.[1]||'기타')}</small></span><button class="text-action danger-text" data-delete-floor-space="${x.id}">삭제</button></div>`).join('')||'<span class="muted">아직 지정한 공간이 없습니다.</span>'}</div></section>`;
  }
  async function createFloorSpace(groupId,x,y,w,h){const name=(qs('#newFloorSpaceName')?.value||'').trim();if(!name)return toast('공간명을 먼저 입력하세요.','error');const type=qs('#newFloorSpaceType')?.value||'other';const {error}=await db.from('floor_spaces').insert({site_id:state.currentSite?.id,group_id:groupId,name,space_type:type,x_pct:x,y_pct:y,width_pct:w,height_pct:h,sort_order:state.floorSpaces.length*10+10});if(error)return toast(error.message,'error');toast('공간 영역을 저장했습니다.');await load();}
  function bindFloorSpaceManager(){
    qs('#spaceEditorFloor')?.addEventListener('change',e=>{spaceEditorGroupId=e.target.value;renderSettings();});
    qsa('[data-delete-floor-space]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('이 공간 영역을 삭제할까요?'))return;const {error}=await db.from('floor_spaces').delete().eq('id',b.dataset.deleteFloorSpace);if(error)return toast(error.message,'error');await load();}));
    const stage=qs('[data-space-stage]');if(!stage)return;let start=null,preview=null;
    stage.addEventListener('pointerdown',e=>{if(e.target.closest('[data-floor-space]'))return;const name=(qs('#newFloorSpaceName')?.value||'').trim();if(!name)return toast('공간명을 먼저 입력하세요.','error');const r=stage.getBoundingClientRect();start={x:Math.max(0,Math.min(100,(e.clientX-r.left)/r.width*100)),y:Math.max(0,Math.min(100,(e.clientY-r.top)/r.height*100)),id:e.pointerId};preview=document.createElement('div');preview.className='floor-space-preview';stage.appendChild(preview);stage.setPointerCapture?.(e.pointerId);});
    stage.addEventListener('pointermove',e=>{if(!start||e.pointerId!==start.id||!preview)return;const r=stage.getBoundingClientRect(),x=Math.max(0,Math.min(100,(e.clientX-r.left)/r.width*100)),y=Math.max(0,Math.min(100,(e.clientY-r.top)/r.height*100)),l=Math.min(start.x,x),t=Math.min(start.y,y),w=Math.abs(x-start.x),h=Math.abs(y-start.y);Object.assign(preview.style,{left:`${l}%`,top:`${t}%`,width:`${w}%`,height:`${h}%`});});
    const finish=async e=>{if(!start||e.pointerId!==start.id)return;const r=stage.getBoundingClientRect(),x=Math.max(0,Math.min(100,(e.clientX-r.left)/r.width*100)),y=Math.max(0,Math.min(100,(e.clientY-r.top)/r.height*100)),l=Math.min(start.x,x),t=Math.min(start.y,y),w=Math.abs(x-start.x),h=Math.abs(y-start.y);preview?.remove();start=null;preview=null;if(w<2||h<2)return toast('공간 영역을 조금 더 크게 드래그하세요.','error');await createFloorSpace(stage.dataset.spaceStage,Number(l.toFixed(2)),Number(t.toFixed(2)),Number(w.toFixed(2)),Number(h.toFixed(2)));};
    stage.addEventListener('pointerup',finish);stage.addEventListener('pointercancel',()=>{preview?.remove();start=null;preview=null;});
  }

  function backupAuditMarkup(){
    const logs=state.audit.slice(0,12).map(x=>`<div class="audit-row"><span><b>${esc(x.summary||x.action)}</b><small>${esc(x.actor_role==='admin'?'슈퍼어드민':'병원 관리자')} · ${new Date(x.created_at).toLocaleString('ko-KR')}</small></span><em>${esc(x.entity_type||'')}</em></div>`).join('');
    return `<section class="settings-section"><div class="settings-section-head"><div><span class="eyebrow">BACKUP & AUDIT</span><h2>설정 백업 · 변경 이력</h2><p>도면/공간/디스플레이 설정을 백업하고 주요 변경 이력을 확인합니다.</p></div></div><div class="backup-grid"><div class="settings-card"><h3>설정 백업</h3><div class="inline"><button id="exportSiteConfig" class="btn">JSON 내보내기</button><label class="btn"><input id="importSiteConfig" type="file" accept="application/json,.json"><span>JSON 복원</span></label></div><p class="muted">복원은 기존 플레이어 키를 변경하지 않고 설정 정보만 복원합니다.</p></div><div class="settings-card audit-card"><h3>최근 변경</h3>${logs||'<span class="muted">변경 이력이 없습니다.</span>'}</div></div></section>`;
  }
  async function exportSiteConfig(){const {data,error}=await db.rpc('admin_export_site_config',{p_site:state.currentSite?.id||null});if(error)return toast(error.message,'error');const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`clinic-signage-${state.currentSite?.code||'site'}-${localDateKey()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
  async function importSiteConfig(file){if(!file)return;try{const json=JSON.parse(await file.text());if(!confirm('이 백업으로 현재 병원 설정을 복원할까요?'))return;const {data,error}=await db.rpc('admin_import_site_config',{p_config:json});if(error)throw error;toast(`설정 복원 완료 · 공간 ${data?.rooms||0}곳`);await load();}catch(e){toast(e.message||'백업 파일을 복원하지 못했습니다.','error');}}

  function renderSettings(){
    const emergencyVideos=state.videos.filter(v=>v.active&&v.available!==false&&v.url);
    const ready=storageHealth?.ok===true;
    if(scopedHospitalMode){
      qs('#adminRoot').innerHTML=`<div class="page-head"><div><span class="eyebrow">SETTINGS</span><h1>설정</h1><p class="page-intro">${esc(state.currentSite?.name||'병원')}에서 필요한 설정만 관리합니다.</p></div></div>${setupProgressMarkup()}${accessLinksMarkup()}<section class="settings-section"><div class="settings-section-head"><div><span class="eyebrow">HOSPITAL</span><h2>병원 정보</h2></div></div><div class="settings-system-grid"><div class="settings-card"><h3>이름</h3><label class="field"><span>병원명</span><input id="siteName" maxlength="40" value="${esc(state.settings.site_name||state.currentSite?.name||'')}"></label><label class="field"><span>건물 이름</span><input id="buildingLabel" maxlength="40" value="${esc(state.settings.building_label||state.currentSite?.building_label||'MAIN BUILDING')}"></label><button id="saveSiteIdentity" class="btn primary">저장</button></div><div class="settings-card"><h3>병원 관리자 PIN</h3><p class="muted">이 병원 관리자 전용 PIN입니다.</p><label class="field"><span>PIN · 4~6자리</span><input id="siteStaffPin" type="password" inputmode="numeric" maxlength="6"></label><button id="saveSiteStaffPin" class="btn">PIN 변경</button></div></div></section>${floorplanManagerMarkup()}${floorSpaceManagerMarkup()}${displayPositionSetupMarkup()}${roomSettingsMarkup()}${backupAuditMarkup()}`;
      bindRoomSettings();bindFloorplanManager();bindFloorSpaceManager();hydrateFloorplanImages();
      qsa('[data-open-address]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openAddress(b.dataset.openAddress)}));
      qsa('[data-copy-address]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();copyAddress(b.dataset.copyAddress,b.dataset.copyLabel||'주소')}));
      qs('#saveSiteIdentity')?.addEventListener('click',saveSiteIdentity);qs('#saveSiteStaffPin')?.addEventListener('click',saveSiteStaffPin);qs('#exportSiteConfig')?.addEventListener('click',exportSiteConfig);qs('#importSiteConfig')?.addEventListener('change',e=>{const f=e.target.files?.[0];if(f)importSiteConfig(f);e.target.value='';});
      return;
    }
    qs('#adminRoot').innerHTML=`<div class="page-head"><div><span class="eyebrow">SETTINGS</span><h1>설정</h1><p class="page-intro">층/구역과 공간, 운영시간, 비상 영상, PIN처럼 자주 바꾸지 않는 시스템 설정만 모았습니다.</p></div></div>${scopedHospitalMode?'':siteManagerMarkup()}${setupProgressMarkup()}${accessLinksMarkup()}${floorplanManagerMarkup()}${floorSpaceManagerMarkup()}${displayPositionSetupMarkup()}${roomSettingsMarkup()}${backupAuditMarkup()}<section class="settings-section"><div class="settings-section-head"><div><span class="eyebrow">SYSTEM</span><h2>시스템</h2></div></div><div class="settings-system-grid"><div class="settings-card"><h3>관제 화면 이름</h3><p class="muted">회사·병원마다 재사용할 수 있도록 건물 화면 명칭을 설정합니다.</p><label class="field"><span>병원명</span><input id="siteName" maxlength="40" value="${esc(state.settings.site_name||'미니쉬치과병원')}"></label><label class="field"><span>건물 이름</span><input id="buildingLabel" maxlength="40" value="${esc(state.settings.building_label||'MAIN BUILDING')}"></label><button id="saveSiteIdentity" class="btn primary">이름 저장</button></div><div class="settings-card operating-hours-card"><h3>${state.sites.length>1?'플랫폼 기본 운영시간':'운영시간'}</h3><p class="muted">${state.sites.length>1?'현재 플레이어 공통 기준입니다. 병원별 운영시간 확장 시 site 기준으로 분리됩니다. ':''}실제 영상 송출 시간입니다. 운영시간 밖에는 검정 화면으로 대기하고 다음 시작시간에 자동 재생합니다.</p><div class="operating-day-list">${operatingDayRow('weekday','평일',state.settings.operating_weekday_enabled!==false,state.settings.operating_weekday_start||state.settings.operating_start||'09:00',state.settings.operating_weekday_end||state.settings.operating_end||'20:00')}${operatingDayRow('saturday','토요일',state.settings.operating_saturday_enabled!==false,state.settings.operating_saturday_start||'09:00',state.settings.operating_saturday_end||'17:00')}${operatingDayRow('sunday','일요일',state.settings.operating_sunday_enabled===true,state.settings.operating_sunday_start||'09:00',state.settings.operating_sunday_end||'17:00')}</div><button id="saveOperatingHours" class="btn primary">운영시간 저장</button></div><div class="settings-card"><h3>영상 저장소</h3><div class="storage-status"><span class="dot ${ready?'on':''}"></span><div><b>${ready?'연결됨':'설정 필요'}</b><p>Cloudflare R2 영상 저장 상태</p></div></div><button id="testStorage" class="btn">연결 확인</button></div><div class="settings-card"><h3>비상 영상</h3><label class="field"><span>재생할 영상</span><select id="emergencyVideo"><option value="">사용 안 함</option>${emergencyVideos.map(v=>`<option value="${v.id}" ${state.settings.emergency_video_id===v.id?'selected':''}>${esc(v.title)} · ${formatBytes(v.size_bytes)}</option>`).join('')}</select></label><button id="saveEmergency" class="btn primary">저장</button></div><div class="settings-card"><h3>PIN</h3><label class="field"><span>관리자 PIN · 6자리</span><input id="newAdminPin" type="password" inputmode="numeric" maxlength="6"></label><button id="changeAdminPin" class="btn">관리자 PIN 변경</button><label class="field top-gap"><span>병원 관리자 PIN · 4~6자리</span><input id="newStaffPin" type="password" inputmode="numeric" maxlength="6"></label><button id="changeStaffPin" class="btn">병원 관리자 PIN 변경</button></div></div></section>`;
    bindRoomSettings();
    bindFloorplanManager();
    bindFloorSpaceManager();
    hydrateFloorplanImages();
    qs('#superAdminSiteSelect')?.addEventListener('change',e=>switchSite(e.target.value));
    qs('#saveCurrentSiteSlug')?.addEventListener('click',saveCurrentSiteSlug);
    qsa('[data-select-site]').forEach(b=>b.addEventListener('click',()=>switchSite(b.dataset.selectSite)));qsa('[data-close-hospital]').forEach(b=>b.addEventListener('click',()=>{if(scopedHospitalMode){location.href='/admin.html';return;}hospitalFocusOpen=false;selectedFloorId=null;dashboardView='building';render();}));qsa('[data-open-address]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openAddress(b.dataset.openAddress)}));qsa('[data-copy-address]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();copyAddress(b.dataset.copyAddress,b.dataset.copyLabel||'주소')}));
    qs('#addSite')?.addEventListener('click',addSite);
    qs('#saveSiteStaffPin')?.addEventListener('click',saveSiteStaffPin);
    qs('#exportSiteConfig')?.addEventListener('click',exportSiteConfig);
    qs('#importSiteConfig')?.addEventListener('change',e=>{const f=e.target.files?.[0];if(f)importSiteConfig(f);e.target.value='';});
    qsa('[data-hours-enabled]').forEach(i=>i.addEventListener('change',()=>{const key=i.dataset.hoursEnabled,wrap=qs(`[data-hours-fields="${key}"]`);wrap?.classList.toggle('is-disabled',!i.checked);qsa(`[data-hours-start="${key}"],[data-hours-end="${key}"]`).forEach(x=>x.disabled=!i.checked);const label=i.closest('.operating-day-row')?.querySelector('b');if(label)label.textContent=i.checked?'운영':'휴무';}));
    qs('#saveSiteIdentity')?.addEventListener('click',saveSiteIdentity);qs('#saveOperatingHours')?.addEventListener('click',saveOperatingHours);qs('#testStorage')?.addEventListener('click',async()=>{await checkStorageHealth(true);renderSettings();});qs('#saveEmergency')?.addEventListener('click',saveEmergency);qs('#changeAdminPin')?.addEventListener('click',()=>changePin('admin'));qs('#changeStaffPin')?.addEventListener('click',()=>changePin('staff'));qsa('#newAdminPin,#newStaffPin').forEach(i=>i.addEventListener('input',()=>{i.value=i.value.replace(/\D/g,'').slice(0,6);}));
  }
  async function saveSiteIdentity(){
    const site=(qs('#siteName')?.value||'').trim()||'미니쉬치과병원',building=(qs('#buildingLabel')?.value||'').trim()||'MAIN BUILDING',sid=state.currentSite?.id;
    if(!sid)return toast('병원을 선택하세요.','error');
    const {error}=await db.from('sites').update({name:site,building_label:building,updated_at:new Date().toISOString()}).eq('id',sid);
    if(error)return toast(error.message||'병원 이름 저장에 실패했습니다.','error');
    if(state.currentSite?.code==='default')await db.from('app_settings').update({site_name:site,building_label:building,updated_at:new Date().toISOString()}).eq('id',1).catch(()=>{});
    state.currentSite={...state.currentSite,name:site,building_label:building};state.settings.site_name=site;state.settings.building_label=building;toast('관제 화면 이름 저장 완료');
  }
  async function saveOperatingHours(){
    const patch={};
    for(const key of ['weekday','saturday','sunday']){
      const enabled=!!qs(`[data-hours-enabled="${key}"]`)?.checked,start=qs(`[data-hours-start="${key}"]`)?.value,end=qs(`[data-hours-end="${key}"]`)?.value;
      if(enabled&&(!start||!end||start>=end))return toast(`${key==='weekday'?'평일':key==='saturday'?'토요일':'일요일'} 운영시간을 확인하세요.`,'error');
      patch[`operating_${key}_enabled`]=enabled;patch[`operating_${key}_start`]=start||'09:00';patch[`operating_${key}_end`]=end||'17:00';
    }
    patch.operating_start=patch.operating_weekday_start;patch.operating_end=patch.operating_weekday_end;patch.updated_at=new Date().toISOString();
    const {error}=await db.from('app_settings').update(patch).eq('id',1);if(error)return toast(error.message,'error');try{await db.rpc('signal_signage_rooms',{p_all:true});}catch(_){}toast('운영시간을 저장했습니다.');await load();
  }
  async function changePin(role){const input=qs(role==='admin'?'#newAdminPin':'#newStaffPin'),pin=input.value.replace(/\D/g,'');if(role==='admin'&&pin.length!==6)return toast('슈퍼어드민 PIN은 6자리입니다.','error');if(role==='staff'&&(pin.length<4||pin.length>6))return toast('병원 관리자 PIN은 4~6자리입니다.','error');if(!confirm(`${role==='admin'?'슈퍼어드민':'병원 관리자'} PIN을 변경할까요?`))return;const result=role==='staff'?await db.rpc('admin_set_site_staff_pin',{p_site:state.currentSite?.id,p_pin:pin}):await db.rpc('admin_change_pin',{p_role:'admin',p_pin:pin});if(result.error)return toast(result.error.message,'error');input.value='';if(role==='admin'){Signage.clearPinSession();location.replace('/');}else toast('병원 관리자 PIN 변경 완료');}
  async function saveEmergency(){const id=qs('#emergencyVideo').value||null;if(id){const v=state.videos.find(x=>x.id===id);if(Number(v?.size_bytes||0)>MAX_EMERGENCY_BYTES)return toast('비상영상은 250MB 이하로 선택하세요.','error');}const {error}=await db.from('app_settings').update({emergency_video_id:id,updated_at:new Date().toISOString()}).eq('id',1);if(error)toast(error.message,'error');else{toast('비상영상 저장 완료');await load();}}
  async function checkStorageHealth(showToast=false){
    try{storageHealth=await apiJson('/api/r2-status',{method:'GET'});if(showToast)toast('영상 저장소 연결 정상');}
    catch(e){storageHealth=false;if(showToast)toast(e.message||'R2 연결 실패','error');}
    if(tab==='dashboard')paintAlerts();
    if(tab==='videos')renderVideos();
  }

  function paintLiveSummary(){
    if(tab!=='dashboard')return;
    const statuses=state.rooms.map(roomDisplayStatus),online=state.rooms.filter(r=>displayControlMode(r)!=='manual'&&adminIsOnline(r)).length;
    const live=statuses.filter(x=>x.key==='live').length,issues=statuses.filter(x=>['error','update','offline','manual-warn'].includes(x.key)).length;
    const offline=statuses.filter(x=>x.key==='offline').length,paused=statuses.filter(x=>x.key==='idle').length;
    const top=qs('#onlineStat');if(top)top.textContent=`${online}/${state.rooms.length}`;
    const totalEl=qs('[data-stat-total]');if(totalEl)totalEl.textContent=String(state.rooms.length);
    const liveEl=qs('[data-stat-live]');if(liveEl)liveEl.textContent=String(live);
    const issueEl=qs('[data-stat-issues]');if(issueEl)issueEl.textContent=String(issues);
    const o=qs('[data-stat-online]');if(o)o.textContent=`${online}/${state.rooms.length}`;
    const f=qs('[data-stat-offline]');if(f)f.textContent=String(offline);
    const p=qs('[data-stat-paused]');if(p)p.textContent=String(paused);
    state.groups.forEach(g=>paintGroupSummary(g.id));
    paintGroupSummary(null);
  }
  function paintGroupSummary(groupId){
    const key=groupId||'ungrouped',card=qs(`[data-group-card="${key}"]`);if(!card)return;
    const rooms=state.rooms.filter(r=>(r.group_id||null)===(groupId||null)),group=groupId?groupById(groupId):null,gb=groupId?groupBroadcast(groupId):null,summary=groupStatusSummary(rooms);
    const currentVideo=gb?.active?state.videos.find(v=>v.id===gb.video_ids?.[0])?.title||'':'';
    const nowText=summary.key==='live'?`${summary.live}곳 송출 중`:summary.key==='issue'?`문제 공간 ${summary.issues}곳`:summary.key==='offline'?'모든 공간 연결 끊김':summary.key==='idle'?'현재 재생 대기':'현재 상태 확인';
    const text=card.querySelector('[data-group-live-summary]');if(text)text.textContent=`${nowText}${gb?.active&&currentVideo?` · 그룹 송출 ${currentVideo}`:''}`;
    const badge=card.querySelector('[data-group-status]');if(badge){badge.textContent=summary.label;badge.className=`group-status-badge status-${summary.key}`;}
    const set=(sel,v)=>{const el=card.querySelector(sel);if(el)el.textContent=String(v);};set('[data-group-total]',summary.total);set('[data-group-live]',summary.live);set('[data-group-online]',summary.online);set('[data-group-issues]',summary.issues);
    card.className=card.className.replace(/group-state-(live|issue|offline|idle)/g,'').trim()+` group-state-${summary.key}`;
  }
  function queueSpatialRefresh(){if(spatialRefreshTimer)return;spatialRefreshTimer=setTimeout(()=>{spatialRefreshTimer=null;refreshSpatialDashboard();},120);}
  function refreshSpatialDashboard(){
    if(tab!=='dashboard'||dashboardView==='rooms')return;
    const el=qs('#dashboardSpatialView');if(!el)return;
    el.innerHTML=dashboardView==='floor'?floorDashboardMarkup(groupById(selectedFloorId)):buildingDashboardMarkup();
    qsa('[data-building-period]',el).forEach(b=>b.addEventListener('click',()=>{buildingPeriod=b.dataset.buildingPeriod||'live';renderDashboard();}));
    qsa('[data-open-floor]',el).forEach(b=>b.addEventListener('click',()=>{selectedFloorId=b.dataset.openFloor;dashboardView='floor';renderDashboard();}));
    qs('[data-building-view]',el)?.addEventListener('click',()=>{dashboardView='building';renderDashboard();});
    qsa('[data-floor-room]',el).forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.floorRoom;dashboardView='rooms';renderDashboard();requestAnimationFrame(()=>{const card=qs(`[data-room-card="${id}"]`);if(card){card.open=true;card.scrollIntoView({behavior:'smooth',block:'center'});}});}));
    hydrateFloorplanImages();
  }
  function mergeRealtimeRoom(next){
    if(!next?.id)return;
    const i=state.rooms.findIndex(r=>r.id===next.id);
    if(i<0){state.rooms.push({...next});state.rooms.sort((a,b)=>(Number(a.sort_order||0)-Number(b.sort_order||0))||String(a.created_at||'').localeCompare(String(b.created_at||'')));if(tab==='dashboard')renderDashboard();return;}
    state.rooms[i]={...state.rooms[i],...next};
    if(tab==='dashboard'){paintLiveRoom(state.rooms[i]);paintLiveSummary();paintAlerts();queueSpatialRefresh();}
    if(tab==='settings'){const el=qs(`[data-room-name="${next.id}"]`)?.closest('.room-admin')?.querySelector('.status-text');if(el){const ds=roomDisplayStatus(state.rooms[i]);el.textContent=ds.label;el.className=`status-text status-${ds.key}`;}}
  }
  function mergePlayerLiveStatus(live){
    if(!live?.room_id)return;
    const i=state.rooms.findIndex(r=>r.id===live.room_id);
    if(i<0)return;
    state.rooms[i]={...state.rooms[i],last_seen_at:live.last_seen_at||state.rooms[i].last_seen_at,player_status:live.player_status||state.rooms[i].player_status};
    if(tab==='dashboard'){paintLiveRoom(state.rooms[i]);paintLiveSummary();paintAlerts();queueSpatialRefresh();}
    if(tab==='settings'){const el=qs(`[data-room-name="${live.room_id}"]`)?.closest('.room-admin')?.querySelector('.status-text');if(el){const ds=roomDisplayStatus(state.rooms[i]);el.textContent=ds.label;el.className=`status-text status-${ds.key}`;}}
  }
  function removeRealtimeRoom(id){
    if(!id)return;
    const before=state.rooms.length;state.rooms=state.rooms.filter(r=>r.id!==id);
    if(before!==state.rooms.length&&tab==='dashboard')renderDashboard();
  }
  function paintLiveRoom(r){
    const card=qs(`[data-room-card="${r.id}"]`);if(!card)return;
    const st=r.player_status||{},on=adminIsOnline(r),current=Signage.estimatedCurrentTime(r,monitor.serverNow()),progress=st.duration?`${formatDuration(current)} / ${formatDuration(st.duration)}`:'',p=playlistInfo(st),h=roomHealth(r),cv=state.videos.find(v=>v.id===st.video_id)||null;
    card.className=card.className.replace(/health-(normal|delayed|offline|error|recovering)/g,'').trim()+` health-${h}`;card.dataset.health=h;
    const displayStatus=roomDisplayStatus(r),health=qs('.monitor-health',card);if(health){health.textContent=displayStatus.label;health.className=`monitor-health room-status-badge status-${displayStatus.key}`;}
    const th=qs('.monitor-current-thumb',card),isManual=displayControlMode(r)==='manual',thumbKey=isManual?'manual':String(cv?.id||'');if(th&&th.dataset.videoId!==thumbKey){th.innerHTML=isManual?'<span>수동</span>':thumb(cv);th.dataset.videoId=thumbKey;}
    const dot=qs('[data-live-dot]',card);if(dot){dot.classList.toggle('on',on);dot.classList.toggle('manual',displayControlMode(r)==='manual');}
    const mode=qs('[data-live-mode]',card);if(mode)mode.textContent=displayControlMode(r)==='manual'?'운영 방식 · 수동':`우선순위 · ${priorityLabel(st.priority||st.mode)}`;
    const title=qs('[data-live-title]',card);if(title)title.textContent=displayControlMode(r)==='manual'?'현장 수동 운영':(r.paused?'일시정지':(st.title||'대기 중'));
    const next=qs('[data-live-next]',card);if(next)next.textContent=p.next||((p.titles.length>1)?p.titles[(p.current+1)%p.titles.length]:'—');
    const detail=qs('[data-live-detail]',card);if(detail)detail.textContent=displayControlMode(r)==='manual'?roomIssueReason(r):(on?`${playbackLabel(st.playback_state)}${progress?` · ${progress}`:''}${st.muted?' · 음소거':''}${roomIssueReason(r)?` · ${roomIssueReason(r)}`:''}`:'오프라인 · 플레이어 연결 끊김');
  }

  // --- live status ------------------------------------------------------------
  function applyLiveResult(res){
    if(!res)return;
    const seen=new Map((res.seen||[]).map(x=>[x.room_id,x.last_seen_at]));
    (res.rows||[]).forEach(row=>{seen.delete(row.room_id);mergePlayerLiveStatus(row);settleAck(row);});
    seen.forEach((lastSeen,roomId)=>{const r=state.rooms.find(x=>x.id===roomId);if(r&&lastSeen)r.last_seen_at=lastSeen;});
  }
  function settleAck(row){
    const a=ackState.get(row.room_id);if(!a)return;
    const v=monitor.verdict(row,a.at);
    if(v==='ok')ackState.delete(row.room_id);
    else if(v==='error'&&a.status!=='pending')a.status='error';
  }
  function paintAllLive(){if(tab!=='dashboard')return;state.rooms.forEach(paintLiveRoom);paintLiveSummary();paintAlerts();}
  async function refreshAllLiveStatus(){
    const b=qs('#refreshLiveStatus');if(b){b.disabled=true;b.textContent='확인 중…';}
    try{
      await Promise.all([refreshLiveRooms(),refreshLiveControls()]);
      try{const [{data:today},{data:period}]=await Promise.all([db.rpc('admin_playback_today',{p_site:state.currentSite?.id||null}),db.rpc('admin_building_period_stats',{p_days:7,p_site:state.currentSite?.id||null})]);if(today)state.playbackToday=today;if(period)state.building7d=period;}catch(_){}
      if(tab==='dashboard')renderDashboard();
      toast('송출 상태를 다시 확인했습니다.');
    }finally{const b2=qs('#refreshLiveStatus');if(b2){b2.disabled=false;b2.textContent='상태 새로고침';}}
  }

  try{await load();}catch(e){qs('#adminRoot').innerHTML=`<p class="error">${esc(e.message||e)}</p>`;}

  // --- control delivery -------------------------------------------------------
  let controlSignalReady=false,controlSignalReadyPromise=null;
  function waitForControlSignal(timeoutMs=1800){
    if(controlSignalReady)return Promise.resolve(true);
    if(!controlSignalReadyPromise)return Promise.resolve(false);
    return Promise.race([controlSignalReadyPromise,new Promise(resolve=>setTimeout(()=>resolve(false),timeoutMs))]);
  }
  // Hospital-wide wake-up only. Room/group scoped actions are delivered by signal_signage_rooms
  // and the room:{key} triggers, so they no longer make all 30 players re-read their state.
  async function sendImmediateControlSignal(){
    try{
      if(!controlSignalChannel)return false;
      await waitForControlSignal();
      const result=await controlSignalChannel.send({type:'broadcast',event:'refresh',payload:{at:new Date().toISOString(),version:PLAYER_VERSION}});
      return result==='ok'||result===true||result===undefined;
    }catch(_){return false;}
  }
  async function signalAffectedRooms({roomIds=[],groupId=null,all=false}={}){
    try{
      const {error}=await db.rpc('signal_signage_rooms',{p_room_ids:roomIds.length?roomIds:null,p_group:groupId||null,p_all:!!all});
      if(error){console.warn('Clinic Signage control signal failed:',error.message||error);return false;}
      return true;
    }catch(e){console.warn('Clinic Signage control signal failed:',e);return false;}
  }
  function affectedRoomIds(scope={}){
    if(scope.all)return state.rooms.map(r=>r.id);
    if(scope.groupId)return state.rooms.filter(r=>r.group_id===scope.groupId).map(r=>r.id);
    return Array.isArray(scope.roomIds)?scope.roomIds.filter(Boolean):[];
  }
  /* One control action:
     1) capture server time BEFORE the write (issuedAt)
     2) write, wake the affected players
     3) poll only those rooms until each reports synced_at >= issuedAt (≈20s max), then stop. */
  async function runControl(scope,op,okMessage=null,{ack=true}={}){
    const issuedAt=monitor.markIssue();
    let result;
    try{result=await op();}catch(e){result={error:e};}
    if(result?.error){toast(result.error.message||String(result.error),'error');return false;}
    if(okMessage)toast(okMessage);
    await syncAfterControl(scope,ack?issuedAt:null);
    return true;
  }
  function rerenderDashboardPreserve(){
    if(tab!=='dashboard')return;
    const openRooms=qsa('.monitor-room[open]').map(x=>x.dataset.roomCard),openGroups=qsa('.monitor-group[open]').map(x=>x.dataset.groupCard),scrollY=window.scrollY;
    renderDashboard();
    openGroups.forEach(id=>qs(`[data-group-card="${id}"]`)?.setAttribute('open',''));
    openRooms.forEach(id=>qs(`[data-room-card="${id}"]`)?.setAttribute('open',''));
    window.scrollTo(0,scrollY);
  }
  async function syncAfterControl(scope={},issuedAt=null){
    await signalAffectedRooms(scope);
    if(scope.all)await sendImmediateControlSignal();
    if(document.hidden)return;
    if(Array.isArray(scope.roomIds)&&scope.roomIds.length){await refreshRoomConfigs(scope.roomIds);rerenderDashboardPreserve();}
    await refreshLiveControls();
    if(issuedAt!=null)void confirmDelivery(affectedRoomIds(scope),issuedAt);
  }
  async function refreshRoomConfigs(ids){
    const unique=[...new Set((ids||[]).filter(Boolean))];if(!unique.length)return;
    const {data,error}=await db.from('rooms').select('*').in('id',unique);if(error)return;
    (data||[]).forEach(row=>{const i=state.rooms.findIndex(r=>r.id===row.id);if(i>=0)state.rooms[i]={...state.rooms[i],...row};});
  }
  async function confirmDelivery(ids,issuedAt){
    if(!monitor.rpcSupported){await monitor.awaitAck(ids,issuedAt);return;}
    const targets=ids.filter(id=>{const r=state.rooms.find(x=>x.id===id);return r&&roomHealth(r)!=='offline';});
    const offline=ids.length-targets.length;
    if(!targets.length)return;
    targets.forEach(id=>ackState.set(id,{status:'pending',at:issuedAt}));
    paintAllLive();
    const {result}=await monitor.awaitAck(targets,issuedAt);
    let ok=0,tracked=0;const bad=[];
    targets.forEach(id=>{
      const a=ackState.get(id),v=result.get(id);
      if(a&&a.at!==issuedAt)return; // superseded by a newer action on this room
      tracked++;
      if(v==='ok'){ok++;ackState.delete(id);return;}
      if(a)a.status=v==='error'?'error':'unconfirmed';
      bad.push(state.rooms.find(r=>r.id===id)?.name||'공간');
    });
    paintAllLive();
    if(!tracked)return;
    const offlineText=offline?` · 오프라인 ${offline}곳 제외`:'';
    if(bad.length)toast(`송출 확인 ${ok}/${tracked}곳 · 미확인 ${bad.slice(0,3).join(', ')}${bad.length>3?' 외':''}${offlineText}`,'error');
    else toast(`송출 확인 ${ok}/${tracked}곳${offlineText}`);
  }

  async function refreshLiveRooms(){
    if(liveRefreshBusy)return;
    liveRefreshBusy=true;
    try{
      const [roomsResult,live]=await Promise.all([
        db.from('rooms').select('*').order('sort_order').order('created_at'),
        monitor.loadAll()
      ]);
      if(roomsResult.error)throw roomsResult.error;
      const liveByRoom=new Map((live.rows||[]).map(x=>[x.room_id,x]));
      const rows=(roomsResult.data||[]).map(r=>{const l=liveByRoom.get(r.id);return l?{...r,last_seen_at:l.last_seen_at||r.last_seen_at,player_status:l.player_status||r.player_status}:r;}),ids=new Set(rows.map(r=>r.id));
      rows.forEach(mergeRealtimeRoom);
      state.rooms.filter(r=>!ids.has(r.id)).forEach(r=>removeRealtimeRoom(r.id));
      (live.rows||[]).forEach(settleAck);
    }catch(e){toast(e?.message||'상태를 불러오지 못했습니다.','error');}finally{liveRefreshBusy=false;}
  }
  async function refreshLiveControls(){
    if(liveControlBusy||tab!=='dashboard'||document.hidden)return;
    liveControlBusy=true;
    try{
      const [rules,broadcast,groups]=await Promise.all([
        db.from('room_video_rules').select('*'),
        db.from('broadcast').select('*').eq('id',1).maybeSingle(),
        db.from('group_broadcasts').select('*')
      ]);
      if(rules.error||broadcast.error||groups.error)return;
      const sig=JSON.stringify([rules.data||[],broadcast.data||null,groups.data||[]]);
      if(sig!==liveControlSig){
        state.roomRules=rules.data||[];state.broadcast=broadcast.data||state.broadcast;state.groupBroadcasts=groups.data||[];
        rerenderDashboardPreserve();
      }
      liveControlSig=sig;
    }catch(_){}finally{liveControlBusy=false;}
  }

  async function refreshLiveRoom(roomId){
    if(!roomId||document.hidden)return;
    try{const res=await monitor.fetchStatus({roomIds:[roomId]});applyLiveResult(res);}catch(e){console.warn('Clinic Signage room status refresh failed:',e?.message||e);}
  }
  function queueLiveRoomRefresh(roomId){
    if(!roomId)return;clearTimeout(statusWakeTimers.get(roomId));
    statusWakeTimers.set(roomId,setTimeout(()=>{statusWakeTimers.delete(roomId);void refreshLiveRoom(roomId);},80));
  }
  function startRealtime(){
    // Controls wake players immediately. Player status uses a lightweight broadcast wake-up;
    // the admin then fetches only that room through signage_live_status (no status payload leak).
    try{
      controlSignalReadyPromise=new Promise(resolve=>{
        controlSignalChannel=db.channel('clinic-signage-control',{config:{broadcast:{ack:true}}});
        controlSignalChannel.subscribe(status=>{
          controlSignalReady=status==='SUBSCRIBED';
          if(status==='SUBSCRIBED')resolve(true);
          else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED')resolve(false);
        });
      });
      statusWakeChannel=db.channel('clinic-signage-status')
        .on('broadcast',{event:'changed'},({payload})=>queueLiveRoomRefresh(payload?.room_id))
        .subscribe();
    }catch(_){}
  }
  async function runMaintenance(){try{const key='clinic-signage:last-maintenance',last=Number(localStorage.getItem(key)||0);if(Date.now()-last<24*60*60*1000)return;const {error}=await db.rpc('admin_prune_signage_logs',{p_event_days:30,p_daily_days:400});if(!error)localStorage.setItem(key,String(Date.now()));}catch(_){}}
  startRealtime();
  void runMaintenance();
  checkStorageHealth();
  monitor.start(Signage.cfg.livePollMs);
  // Local-only clock/progress repaint. No network.
  const livePaintTimer=setInterval(()=>{if(!document.hidden)paintAllLive();},1000);
  window.addEventListener('beforeunload',()=>{clearInterval(livePaintTimer);statusWakeTimers.forEach(clearTimeout);monitor.stop();try{if(controlSignalChannel)db.removeChannel(controlSignalChannel);if(statusWakeChannel)db.removeChannel(statusWakeChannel);}catch(_){}});
})();
