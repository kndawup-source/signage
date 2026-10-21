(async function () {
  'use strict';
  const { db, qs, qsa, esc, toast, formatBytes, formatDuration, titleFromPath } = Signage;
  await Signage.requireAuth('admin');
  qs('#signOut').addEventListener('click', Signage.signOut);

  const AGE_OPTIONS=[['teen','10대 이하'],['20-30','20~30대'],['40-50','40~50대'],['60+','60대 이상']];
  const GENDER_OPTIONS=[['female','여성'],['male','남성']];
  const TREATMENT_OPTIONS=[['minish','미니쉬'],['implant','임플란트'],['whitening','미백'],['orthodontics','교정'],['checkup','검진'],['aftercare','수술 후 관리'],['general','일반 진료']];
  const GROUP_KINDS=[['floor','층'],['zone','구역'],['consultation','구역'],['waiting','구역'],['vip','VIP'],['other','기타']];
  const ROOM_MODES=[['treatment','진료실'],['consultation','상담실'],['waiting','대기실'],['lobby','로비'],['vip','VIP'],['other','기타']];
  const MAX_EMERGENCY_BYTES=250*1024*1024;
  const PLAYER_VERSION='2.22.1';
  // datetime-local is local wall-clock time; avoid UTC conversion shifting KST by 9 hours.
  const toLocalInput=(value)=>{if(!value)return '';const d=new Date(value);if(Number.isNaN(d.getTime()))return '';const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;};

  let tab='dashboard', storageHealth=null, loadSeq=0, uploadBusy=false, groupSaveBusy=false, issuesOnly=false;
  let state={rooms:[],videos:[],playlists:[],playlistItems:[],roomRules:[],groups:[],groupBroadcasts:[],schedules:[],history:[],broadcast:null,settings:{emergency_video_id:null},playbackToday:null};
  let controlSignalChannel=null;

  qsa('.nav-btn').forEach((b)=>b.addEventListener('click',()=>{tab=b.dataset.tab;qsa('.nav-btn').forEach((x)=>x.classList.toggle('active',x===b));render();}));

  async function load(){
    const seq=++loadSeq;
    const [rooms,liveStatuses,videos,playlists,playlistItems,roomRules,groups,groupBroadcasts,schedules,history,broadcast,settings,playbackToday]=await Promise.all([
      db.from('rooms').select('*').order('sort_order').order('created_at'),
      db.from('player_live_status').select('*'),
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
      db.rpc('admin_playback_today')
    ]);
    const errors=[rooms.error,liveStatuses.error,videos.error,playlists.error,playlistItems.error,roomRules.error,groups.error,groupBroadcasts.error,schedules.error,history.error,broadcast.error,settings.error,playbackToday.error].filter(Boolean);
    if(errors.length)throw errors[0]; if(seq!==loadSeq)return;
    const liveByRoom=new Map((liveStatuses.data||[]).map(x=>[x.room_id,x]));
    const mergedRooms=(rooms.data||[]).map(r=>{const live=liveByRoom.get(r.id);return live?{...r,last_seen_at:live.last_seen_at||r.last_seen_at,player_status:live.player_status||r.player_status,__live_received_at:Date.now(),__live_verified_at:Date.now()}:r;});
    state={rooms:mergedRooms,videos:videos.data||[],playlists:playlists.data||[],playlistItems:playlistItems.data||[],roomRules:roomRules.data||[],groups:groups.data||[],groupBroadcasts:groupBroadcasts.data||[],schedules:schedules.data||[],history:history.data||[],broadcast:broadcast.data||{id:1,active:false,video_ids:[]},settings:settings.data||{emergency_video_id:null},playbackToday:playbackToday.data||null};
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
  function roomPlaylistOptions(selected=''){
    const list=state.playlists.filter(p=>p.active).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)||String(a.name).localeCompare(String(b.name),'ko'));
    return `<option value="">플레이리스트 선택</option>${list.map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}${p.kind==='patient'?' · 맞춤':''}</option>`).join('')}`;
  }
  function optionChips(kind,selected=[],options=[]){const allLabel=kind==='target_treatment'?'공통':'전체';return `<button type="button" class="chip ${!selected.length?'on':''}" data-target-kind="${kind}" data-target-value="">${allLabel}</button>${options.map(([v,l])=>`<button type="button" class="chip ${selected.includes(v)?'on':''}" data-target-kind="${kind}" data-target-value="${v}">${esc(l)}</button>`).join('')}`;}
  const videoOptions=(selected='')=>`<option value="">영상 선택</option>${activeVideos().map(v=>`<option value="${v.id}" ${selected===v.id?'selected':''}>${esc(v.title)}</option>`).join('')}`;
  const roomRules=(roomId)=>state.roomRules.filter(x=>x.room_id===roomId);
  const LIVE_DELAY_MS=70000, LIVE_OFFLINE_MS=180000;
  function roomAgeMs(r){
    const ts=r?.last_seen_at?new Date(r.last_seen_at).getTime():0;
    return ts>0?Math.max(0,Date.now()-ts):Infinity;
  }
  function roomHealth(r){
    const st=r.player_status||{},age=roomAgeMs(r);
    if(age>LIVE_OFFLINE_MS)return 'offline';
    if(st.error||String(st.playback_state||'').toLowerCase()==='error')return 'error';
    if(st.recovery_stage)return 'recovering';
    if(age>LIVE_DELAY_MS)return 'delayed';
    return 'normal';
  }
  const healthLabel=(h)=>({normal:'정상',delayed:'확인 중',offline:'오프라인',error:'오류',recovering:'복구 중'})[h]||h;
  const adminIsOnline=(r)=>roomHealth(r)!=='offline';
  function roomDisplayStatus(r){
    const h=roomHealth(r),st=r.player_status||{},play=String(st.playback_state||'').toLowerCase();
    if(h==='offline')return {key:'offline',label:'오프라인'};
    if(h==='error')return {key:'error',label:'오류'};
    if(h==='recovering')return {key:'recovering',label:'복구 중'};
    if(h==='delayed')return {key:'delayed',label:'확인 중'};
    if(r.paused||play==='paused')return {key:'paused',label:'일시정지'};
    if(['playing','emergency'].includes(play))return {key:'live',label:'송출 중'};
    return {key:'idle',label:'대기'};
  }
  function groupDisplayName(group){
    const name=String(group?.name||'미분류').trim();
    return group?.kind==='floor'&&/^\d+$/.test(name)?`${name}층`:name;
  }
  function groupStatusSummary(rooms){
    const statuses=rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length;
    const issues=statuses.filter(x=>['error','recovering','delayed'].includes(x.key)).length;
    const online=rooms.length-offline;
    let key='idle',label='대기';
    if(!rooms.length){key='idle';label='공간 없음';}
    else if(offline===rooms.length){key='offline';label='오프라인';}
    else if(issues>0){key='issue';label='확인 필요';}
    else if(live>0){key='live';label='송출 중';}
    return {live,offline,issues,online,total:rooms.length,key,label};
  }
  function patientPlaylistForRoom(r){const matches=state.playlists.filter(p=>p.active&&p.kind==='patient'&&(!(p.target_treatment||[]).length||(r.session_treatment&&(p.target_treatment||[]).includes(r.session_treatment)))&&(!(p.target_age||[]).length||(r.session_age_group&&(p.target_age||[]).includes(r.session_age_group)))&&(!(p.target_gender||[]).length||(r.session_gender&&(p.target_gender||[]).includes(r.session_gender))));return matches.sort((a,b)=>(((b.target_treatment||[]).length?100:0)+((b.target_age||[]).length?10:0)+((b.target_gender||[]).length?5:0))-(((a.target_treatment||[]).length?100:0)+((a.target_age||[]).length?10:0)+((a.target_gender||[]).length?5:0))||(a.sort_order||0)-(b.sort_order||0))[0]||null;}
  function roomBaseVideoIds(r){const mode=String(r.player_status?.mode||'');if(['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(mode)){const live=Array.isArray(r.player_status?.playlist_video_ids)?r.player_status.playlist_video_ids.filter(Boolean):[];if(live.length)return live;}if(r.manual_active&&Array.isArray(r.manual_video_ids)&&r.manual_video_ids.length)return r.manual_video_ids;if(mode==='patient'){const pp=patientPlaylistForRoom(r);if(pp)return playlistItems(pp.id).map(x=>x.video_id);}const fallback=r.default_playlist_id||state.playlists.filter(p=>p.active&&p.kind==='default').sort((a,b)=>(a.sort_order||0)-(b.sort_order||0))[0]?.id;return playlistItems(fallback).map(x=>x.video_id);}
  function roomOutputItems(r){
    const ids=roomBaseVideoIds(r);
    const rules=new Map(roomRules(r.id).map(x=>[x.video_id,x]));
    const now=Date.now();
    return ids.map((id,idx)=>{const video=state.videos.find(v=>v.id===id),rule=rules.get(id),ruleEnabled=rule?.enabled!==false;const scheduledOn=(!rule?.starts_at||new Date(rule.starts_at).getTime()<=now)&&(!rule?.ends_at||new Date(rule.ends_at).getTime()>now);return {id,video,rule,baseIndex:idx,ruleEnabled,scheduledOn,enabled:ruleEnabled&&scheduledOn};}).filter(x=>x.video).sort((a,b)=>(a.rule?.sort_order??((a.baseIndex+1)*10))-(b.rule?.sort_order??((b.baseIndex+1)*10))||a.baseIndex-b.baseIndex);
  }
  function thumb(v){return v?.thumbnail_data_url?`<img loading="lazy" decoding="async" src="${esc(v.thumbnail_data_url)}" alt="">`:`<span>${esc((v?.title||'VIDEO').slice(0,2))}</span>`;}
  function roomOutputListHtml(r,staff=false){
    const items=roomOutputItems(r);if(!items.length)return '<div class="room-output-empty">재생 가능한 영상이 없습니다.</div>';
    return `<div class="room-output-list">${items.map((x,i)=>`<div class="room-output-item ${x.enabled?'':'is-disabled'}"><div class="room-output-thumb">${thumb(x.video)}</div><div class="room-output-copy"><b>${esc(x.video.title)}</b><small>${formatDuration(x.video.duration_sec||0)}${x.rule?.starts_at||x.rule?.ends_at?(x.scheduledOn?' · 예약 적용':' · 예약 대기'):''}</small></div><label class="switch"><input type="checkbox" data-room-video-toggle="${r.id}" data-video-id="${x.id}" ${x.ruleEnabled?'checked':''} ${['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(String(r.player_status?.mode||''))?'disabled':''}><i></i></label><div class="room-output-order"><button data-room-video-move="${r.id}" data-video-id="${x.id}" data-dir="-1" ${i===0?'disabled':''}>↑</button><button data-room-video-move="${r.id}" data-video-id="${x.id}" data-dir="1" ${i===items.length-1?'disabled':''}>↓</button></div>${staff?'':`<details class="room-video-schedule"><summary>기간</summary><div><input type="datetime-local" data-rule-start="${r.id}:${x.id}" value="${toLocalInput(x.rule?.starts_at)}"><span>–</span><input type="datetime-local" data-rule-end="${r.id}:${x.id}" value="${toLocalInput(x.rule?.ends_at)}"><button class="btn small" data-rule-save="${r.id}" data-video-id="${x.id}">저장</button></div></details>`}</div>`).join('')}</div>`;
  }
  function contentWarnings(){return state.rooms.map(r=>{const items=roomOutputItems(r).filter(x=>x.enabled),known=items.filter(x=>Number(x.video.duration_sec)>0),sec=known.reduce((s,x)=>s+Number(x.video.duration_sec||0),0);if(items.length===0)return `${r.name}: 재생 영상 없음`;if(items.length===1)return `${r.name}: 재생 영상 1개`;if(known.length===items.length&&sec<180)return `${r.name}: 전체 길이 ${Math.ceil(sec/60)}분 미만`;return null;}).filter(Boolean);}
  function render(){if(tab==='dashboard')renderDashboard();else if(tab==='videos')renderVideos();else renderSettings();}

  function operationalAlerts(){
    const alerts=[];
    if(storageHealth===false)alerts.push({type:'danger',text:'영상 저장소 설정을 확인하세요.'});
    const offline=state.rooms.filter(r=>!adminIsOnline(r)); if(offline.length)alerts.push({type:'warn',text:`오프라인 ${offline.length}곳: ${offline.slice(0,6).map(r=>r.name).join(', ')}${offline.length>6?' 외':''}`});
    const errors=state.rooms.filter(r=>r.player_status?.error); if(errors.length)alerts.push({type:'warn',text:`재생 오류 ${errors.length}곳: ${errors.slice(0,4).map(r=>r.name).join(', ')}${errors.length>4?' 외':''}`});
    const oldVersion=state.rooms.filter(r=>r.player_status?.app_version&&r.player_status.app_version!==PLAYER_VERSION); if(oldVersion.length)alerts.push({type:'warn',text:`플레이어 버전 확인 ${oldVersion.length}곳: ${oldVersion.slice(0,4).map(r=>r.name).join(', ')}`});
    const shortages=contentWarnings();if(shortages.length)alerts.push({type:'warn',text:`콘텐츠 확인 ${shortages.length}곳: ${shortages.slice(0,4).join(' · ')}${shortages.length>4?' 외':''}`});
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

  function renderDashboard(){
    const videos=activeVideos(),selected=state.broadcast?.video_ids||[],online=state.rooms.filter(adminIsOnline).length;
    const grouped=[...state.groups.map(g=>({group:g,rooms:state.rooms.filter(r=>r.group_id===g.id)})),{group:null,rooms:state.rooms.filter(r=>!r.group_id)}].filter(x=>x.rooms.length||x.group);
    const roomStatuses=state.rooms.map(roomDisplayStatus),liveCount=roomStatuses.filter(x=>x.key==='live').length;
    const errors=roomStatuses.filter(x=>x.key==='error').length;
    const delayed=roomStatuses.filter(x=>x.key==='delayed'||x.key==='recovering').length;
    const offlineCount=roomStatuses.filter(x=>x.key==='offline').length;
    const issueCount=errors+delayed;
    const paused=roomStatuses.filter(x=>x.key==='paused').length;
    const activeGroups=state.groupBroadcasts.filter(g=>g.active).length;
    const storageState=storageHealth===false?'설정 필요':(storageHealth?.ok?'정상':'확인 중');
    const selectedTitles=selected.map(id=>state.videos.find(v=>v.id===id)?.title).filter(Boolean);
    const broadcastText=selectedTitles.length?selectedTitles.slice(0,2).join(' · ')+(selectedTitles.length>2?` 외 ${selectedTitles.length-2}개`:''):'기본 영상';
    qs('#adminRoot').innerHTML=`
      <div class="monitor-head"><div><span class="eyebrow">MONITOR</span><h1>송출 현황</h1></div><div class="monitor-clock-meta"><b id="onlineStat">${online}/${state.rooms.length}</b><span>온라인</span></div></div>
      <div class="monitor-status-strip monitor-status-primary">
        <div><span>전체 공간</span><b data-stat-total>${state.rooms.length}</b></div>
        <div class="status-live"><span>송출 중</span><b data-stat-live>${liveCount}</b></div>
        <div class="${issueCount?'status-issue':''}"><span>확인 필요</span><b data-stat-issues>${issueCount}</b></div>
        <div class="${offlineCount?'status-offline':''}"><span>오프라인</span><b data-stat-offline>${offlineCount}</b></div>
      </div>
      <div class="monitor-status-secondary"><span>온라인 <b data-stat-online>${online}/${state.rooms.length}</b></span><span>일시정지 <b data-stat-paused>${paused}</b></span><span>그룹 송출 <b>${activeGroups}</b></span><span>저장소 <b class="${storageHealth===false?'danger-text':''}">${storageState}</b></span></div>
      ${alertsHtml()}
      ${playbackAnalyticsMarkup()}
      <div class="monitor-tools"><button id="issuesOnly" class="btn ${issuesOnly?'primary':''}">${issuesOnly?'전체 공간 보기':'문제 공간만 보기'}</button><button id="refreshLiveStatus" class="btn">상태 새로고침</button><span>실시간 상태는 Realtime으로 반영되며, 필요할 때만 전체 상태를 다시 확인합니다.</span></div>
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
    const gid=group?.id||'',gb=group?groupBroadcast(gid):null,selectedId=gb?.video_ids?.[0]||'',summary=groupStatusSummary(rooms);
    const currentVideo=state.videos.find(v=>v.id===selectedId)?.title||'',visibleRooms=issuesOnly?rooms.filter(r=>roomDisplayStatus(r).key!=='live'&&roomDisplayStatus(r).key!=='idle'):rooms;
    const nowText=summary.key==='live'?`${summary.live}곳 송출 중`:summary.key==='issue'?`확인 필요한 공간 ${summary.issues}곳`:summary.key==='offline'?'모든 공간 연결 끊김':summary.key==='idle'?'현재 재생 대기':'현재 상태 확인';
    return `<details class="monitor-group group-state-${summary.key}" data-group-card="${gid||'ungrouped'}" ${issuesOnly||state.groups.length<=4?'open':''}><summary class="monitor-group-summary"><div class="monitor-group-overview"><div class="monitor-group-title-row"><h2>${esc(groupDisplayName(group))}</h2><span class="group-status-badge status-${summary.key}" data-group-status>${esc(summary.label)}</span></div><div class="group-metric-row"><span>공간 <b data-group-total>${summary.total}</b></span><span>송출 <b data-group-live>${summary.live}</b></span><span>온라인 <b data-group-online>${summary.online}</b></span><span>확인 <b data-group-issues>${summary.issues}</b></span></div><p data-group-live-summary>${esc(nowText)}${gb?.active&&currentVideo?` · 그룹 송출 ${esc(currentVideo)}`:''}</p></div><span class="group-detail-link">상세보기</span></summary><div class="monitor-group-body">${group?`<div class="monitor-group-control-row"><details class="monitor-group-control"><summary>그룹 송출</summary><div><select data-group-video="${gid}">${videoOptions(selectedId)}</select><button class="btn primary" data-group-apply="${gid}">${gb.active?'변경':'보내기'}</button>${gb.active?`<button class="btn danger-outline" data-group-stop="${gid}">중지</button>`:''}<button class="btn" data-undo-group="${gid}">되돌리기</button></div></details></div>`:''}<div class="monitor-room-grid">${visibleRooms.map(r=>roomCard(r,videos)).join('')||'<p class="muted">표시할 공간이 없습니다.</p>'}</div></div></details>`;
  }

  function roomCard(r,videos){
    const h=roomHealth(r),displayStatus=roomDisplayStatus(r),on=adminIsOnline(r),st=r.player_status||{},progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'',manual=r.manual_active&&r.manual_video_ids?.length;
    const p=playlistInfo(st),currentTitle=r.paused?'일시정지':(st.title||'대기 중'),nextTitle=p.next||((p.titles.length>1)?p.titles[(p.current+1)%p.titles.length]:'');
    const currentVideo=state.videos.find(v=>v.id===st.video_id)||null, manualCount=manual?(r.manual_video_ids||[]).length:0, output=roomOutputItems(r),enabledCount=output.filter(x=>x.enabled).length;
    return `<details class="monitor-room health-${h}" data-room-card="${r.id}" data-health="${h}"><summary><div class="monitor-room-top"><div class="monitor-room-name"><label class="room-check" onclick="event.stopPropagation()"><input type="checkbox" data-room-check="${r.id}"></label><span data-live-dot class="dot ${on?'on':''}"></span><b>${esc(r.name)}</b></div><span class="monitor-health room-status-badge status-${displayStatus.key}">${esc(displayStatus.label)}</span></div><div class="monitor-current-thumb">${thumb(currentVideo)}</div><div class="monitor-now"><span data-live-mode>지금 재생 · ${esc(modeLabel(st.mode))}</span><b data-live-title>${esc(currentTitle)}</b><small data-live-detail>${on?`${esc(playbackLabel(st.playback_state))}${progress?` · ${progress}`:''}${st.muted?' · 음소거':''}${st.error?` · ${esc(st.error)}`:''}`:'오프라인'}</small></div><div class="monitor-next"><span>다음</span><b data-live-next>${esc(nextTitle||'—')}</b></div><div class="monitor-card-foot"><span>송출 목록 ${enabledCount}/${output.length}</span><b>관리</b></div></summary><div class="monitor-room-controls room-output-editor"><div class="room-output-head"><div><b>실제 송출 목록</b><span>${['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(String(st.mode||''))?'상위 송출이 적용 중이라 목록은 보기 전용입니다.':'개별 영상을 끄거나 순서를 바꿀 수 있습니다.'}</span></div><button class="btn small" data-room-rules-clear="${r.id}">목록 설정 초기화</button></div>${roomOutputListHtml(r)}<div class="room-output-row"><span class="room-output-label">플레이리스트</span><select data-output-playlist="${r.id}" class="grow">${roomPlaylistOptions(r.default_playlist_id||'')}</select><button class="btn small primary" data-room-playlist-apply="${r.id}">변경</button></div><div class="room-output-row"><span class="room-output-label">영상 추가</span><select data-output-video="${r.id}" class="grow">${videoOptions()}</select><button class="btn small" data-room-video-add="${r.id}">추가</button>${manual?`<button class="btn small" data-room-auto="${r.id}">기본으로</button>`:''}</div>${manual?`<div class="room-output-note">이 공간에만 임시 영상 ${manualCount}개가 적용 중입니다.</div>`:''}<div class="room-player-actions"><span>공간 플레이어</span><div><button class="btn small" data-room-player-open="${r.id}">열기</button><button class="btn small" data-room-player-copy="${r.id}">링크 복사</button></div></div><div class="inline monitor-secondary-controls"><button class="btn small" data-room-action="pause" data-room-id="${r.id}">${r.paused?'재생':'일시정지'}</button><button class="btn small" data-room-action="reload" data-room-id="${r.id}">새로고침</button><span class="section-label">음량 ${r.volume}${r.force_mute?' · 항상 음소거':''}</span><input data-volume="${r.id}" type="range" min="0" max="100" value="${r.volume}"></div><div class="inline"><input class="grow" data-overlay="${r.id}" placeholder="화면 문구" value="${esc(r.overlay_text||'')}"><button class="btn small" data-overlay-save="${r.id}">문구 적용</button></div></div></details>`;
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
    qs('#issuesOnly')?.addEventListener('click',()=>{issuesOnly=!issuesOnly;renderDashboard();});qs('#refreshLiveStatus')?.addEventListener('click',async()=>{const b=qs('#refreshLiveStatus');if(b){b.disabled=true;b.textContent='확인 중…';}lastRoomSyncAt=0;lastControlSyncAt=0;await Promise.all([refreshLiveRooms(true),refreshLiveControls(true)]);try{const {data}=await db.rpc('admin_playback_today');if(data)state.playbackToday=data;}catch{}if(tab==='dashboard')renderDashboard();if(b){b.disabled=false;b.textContent='상태 새로고침';}toast('송출 상태를 다시 확인했습니다.');});
    qs('#broadcastPicks')?.addEventListener('click',async(e)=>{const b=e.target.closest('[data-video-id]');if(!b)return;let ids=[...(state.broadcast.video_ids||[])],id=b.dataset.videoId;ids=ids.includes(id)?ids.filter(x=>x!==id):[...ids,id];const result=state.broadcast.active?await db.rpc('admin_set_broadcast',{p_active:ids.length>0,p_video_ids:ids,p_notice:state.broadcast.notice_text||null,p_delay_ms:0}):await db.from('broadcast').update({video_ids:ids,updated_at:new Date().toISOString()}).eq('id',1);if(result.error)return toast(result.error.message,'error');await syncAfterControl({all:true});});
    qs('#broadcastToggle')?.addEventListener('click',async()=>{const next=!state.broadcast.active;if(next&&!state.broadcast.video_ids?.length)return;const result=next?await db.rpc('admin_set_broadcast',{p_active:true,p_video_ids:state.broadcast.video_ids||[],p_notice:state.broadcast.notice_text||null,p_delay_ms:0}):await db.rpc('admin_stop_broadcast',{p_resume:qs('#broadcastResume')?.value||'previous'});if(result.error)return toast(result.error.message,'error');toast(next?'전체 송출 시작':'전체 송출 종료');await syncAfterControl({all:true});});
    qs('#noticeSave')?.addEventListener('click',async()=>{const {error}=await db.from('broadcast').update({notice_text:qs('#notice').value.trim()||null,updated_at:new Date().toISOString()}).eq('id',1);if(error)toast(error.message,'error');else{toast('공지 적용 완료');await syncAfterControl({all:true});}});
    qsa('[data-group-apply]').forEach(b=>b.addEventListener('click',()=>applyGroup(b.dataset.groupApply)));qsa('[data-group-stop]').forEach(b=>b.addEventListener('click',()=>stopGroup(b.dataset.groupStop)));
    qsa('[data-room-playlist-apply]').forEach(b=>b.addEventListener('click',()=>setRoomPlaylist(b.dataset.roomPlaylistApply)));
    qsa('[data-room-video-add]').forEach(b=>b.addEventListener('click',()=>addRoomVideo(b.dataset.roomVideoAdd)));
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

  async function applyGroup(groupId){const sel=qs(`[data-group-video="${groupId}"]`),notice=qs(`[data-group-notice="${groupId}"]`)?.value.trim()||null,id=sel?.value;if(!id)return toast('그룹에 송출할 영상을 선택하세요.','error');const {error}=await db.rpc('admin_set_group_broadcast',{p_group:groupId,p_active:true,p_video_ids:[id],p_notice:notice,p_delay_ms:0});if(error)toast(error.message,'error');else{toast(groupBroadcast(groupId).active?'그룹 송출 변경':'그룹 송출 시작');await syncAfterControl({groupId});}}
  async function stopGroup(groupId){const gb=groupBroadcast(groupId);const {error}=await db.rpc('admin_set_group_broadcast',{p_group:groupId,p_active:false,p_video_ids:gb.video_ids||[],p_notice:gb.notice_text||null,p_delay_ms:0});if(error)toast(error.message,'error');else{toast('그룹 송출 종료');await syncAfterControl({groupId});}}
  async function setRoomPlaylist(id){const playlist=qs(`[data-output-playlist="${id}"]`)?.value;if(!playlist)return toast('플레이리스트를 선택하세요.','error');const {error}=await db.rpc('admin_set_room_playlist',{p_room:id,p_playlist:playlist});if(error)toast(error.message,'error');else{toast('이 공간의 기본 플레이리스트를 변경했습니다.');await syncAfterControl({roomIds:[id]});}}
  async function addRoomVideo(id){const video=qs(`[data-output-video="${id}"]`)?.value;if(!video)return toast('추가할 영상을 선택하세요.','error');const {error}=await db.rpc('admin_add_room_video',{p_room:id,p_video:video});if(error)toast(error.message,'error');else{toast('이 공간 재생목록에 영상 1개를 추가했습니다.');await syncAfterControl({roomIds:[id]});}}
  async function clearRoomVideo(id){const {error}=await db.rpc('admin_set_rooms_manual',{p_rooms:[id],p_video_ids:[],p_active:false});if(error)toast(error.message,'error');else{toast('자동 송출로 복귀');await syncAfterControl({roomIds:[id]});}}
  async function setRoomVideoRule(room,video,enabled){const rr=state.rooms.find(r=>r.id===room);if(['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(String(rr?.player_status?.mode||'')))return toast('전체/그룹 송출 중에는 개별 영상을 변경할 수 없습니다.','error');const current=state.roomRules.find(x=>x.room_id===room&&x.video_id===video);const {error}=await db.rpc('admin_set_room_video_rule',{p_room:room,p_video:video,p_enabled:enabled,p_starts_at:current?.starts_at||null,p_ends_at:current?.ends_at||null});if(error)return toast(error.message,'error');await syncAfterControl({roomIds:[room]});}
  async function moveRoomVideo(room,video,dir){const rr=state.rooms.find(r=>r.id===room);if(['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(String(rr?.player_status?.mode||'')))return toast('전체/그룹 송출 중에는 공간 목록 순서를 바꿀 수 없습니다.','error');const items=roomOutputItems(state.rooms.find(r=>r.id===room)||{});const from=items.findIndex(x=>x.id===video),to=from+dir;if(from<0||to<0||to>=items.length)return;[items[from],items[to]]=[items[to],items[from]];const {error}=await db.rpc('admin_set_room_video_order',{p_room:room,p_video_ids:items.map(x=>x.id)});if(error)return toast(error.message,'error');await syncAfterControl({roomIds:[room]});}
  async function saveRoomVideoRuleSchedule(room,video){const start=qs(`[data-rule-start="${room}:${video}"]`)?.value||'',end=qs(`[data-rule-end="${room}:${video}"]`)?.value||'';if(start&&end&&start>=end)return toast('종료 시각은 시작 시각보다 뒤여야 합니다.','error');const current=state.roomRules.find(x=>x.room_id===room&&x.video_id===video);const {error}=await db.rpc('admin_set_room_video_rule',{p_room:room,p_video:video,p_enabled:current?.enabled!==false,p_starts_at:start?new Date(start).toISOString():null,p_ends_at:end?new Date(end).toISOString():null});if(error)return toast(error.message,'error');toast('영상 기간을 저장했습니다.');await syncAfterControl({roomIds:[room]});}
  async function clearRoomRules(room){if(!confirm('이 공간의 영상 ON/OFF·순서·기간 설정을 초기화할까요?'))return;const {error}=await db.rpc('admin_clear_room_video_rules',{p_room:room});if(error)return toast(error.message,'error');await syncAfterControl({roomIds:[room]});}
  async function batchRooms(active){const ids=qsa('[data-room-check]:checked').map(i=>i.dataset.roomCheck);if(!ids.length)return toast('공간을 선택하세요.','error');const video=qs('#batchVideo')?.value;if(active&&!video)return toast('영상을 선택하세요.','error');const {error}=await db.rpc('admin_set_rooms_manual',{p_rooms:ids,p_video_ids:active?[video]:[],p_active:active});if(error)toast(error.message,'error');else{toast(`${ids.length}곳 ${active?'송출 시작':'기본으로 변경'}`);await syncAfterControl({roomIds:ids});}}
  async function roomAction(b){const r=state.rooms.find(x=>x.id===b.dataset.roomId);if(!r)return;await updateRoom(r.id,b.dataset.roomAction==='pause'?{paused:!r.paused}:{reload_nonce:(r.reload_nonce||0)+1});}
  async function updateRoom(id,patch){const {error}=await db.from('rooms').update(patch).eq('id',id);if(error)toast(error.message,'error');else await load();}
  async function addSchedule(){const scope=qs('#scheduleScope').value,video=qs('#scheduleVideo').value,start=qs('#scheduleStart').value,end=qs('#scheduleEnd').value;if(!video||!start||!end)return toast('영상과 시작/종료 시각을 입력하세요.','error');const isGroup=scope.startsWith('group:'),group=isGroup?scope.slice(6):null;const {error}=await db.rpc('admin_create_schedule',{p_scope_type:isGroup?'group':'hospital',p_group:group,p_video_ids:[video],p_notice:qs('#scheduleNotice').value.trim()||null,p_starts_at:new Date(start).toISOString(),p_ends_at:new Date(end).toISOString()});if(error)toast(error.message,'error');else{toast('예약 송출 추가');await load();}}
  async function deleteSchedule(id){if(!confirm('예약을 삭제할까요?'))return;const {error}=await db.rpc('admin_delete_schedule',{p_id:id});if(error)toast(error.message,'error');else await load();}
  async function undoHistory(id){const {error}=await db.rpc('admin_undo_control',{p_history:id});if(error)toast(error.message,'error');else{toast('되돌렸습니다');await load();}}
  async function undoLatest(type,id){const h=state.history.find(x=>x.scope_type===type&&(!id||x.scope_id===id)&&x.before_state);if(!h)return toast('복귀 가능한 이전 상태가 없습니다.','error');await undoHistory(h.id);}

  function renderVideos(){
    const ready=storageHealth?.ok===true;
    qs('#adminRoot').innerHTML=`<div class="page-head"><div><span class="eyebrow">MEDIA</span><h1>영상</h1><p class="page-intro">영상 파일과 플레이리스트만 관리합니다. 어느 공간에 무엇을 송출할지는 송출 메뉴에서 설정합니다.</p></div><div class="stat">영상 ${state.videos.length} · 플레이리스트 ${state.playlists.length}</div></div>
    <section class="panel upload-panel"><div class="panel-head"><div><h2>영상 업로드</h2><p>업로드한 영상은 보관함에 저장됩니다. 공간별 송출 설정은 송출 메뉴에서 관리합니다.</p></div><label class="btn primary ${ready?'':'disabled'}">파일 선택<input id="videoUpload" type="file" accept="video/mp4" multiple hidden ${ready?'':'disabled'}></label></div><div id="uploadQueue" class="upload-queue"></div><div class="storage-line"><span class="dot ${ready?'on':''}"></span><b>영상 저장소</b><span>${ready?'연결됨':'설정 필요'}</span></div></section>
    <section class="panel playlist-manager"><div class="panel-head"><div><span class="eyebrow">PLAYLISTS</span><h2>플레이리스트</h2><p>용도별 묶음 안에서 영상과 순서를 관리합니다.</p></div></div><div class="playlist-create"><input id="newPlaylistName" placeholder="플레이리스트 이름"><select id="newPlaylistKind"><option value="default">기본 재생</option><option value="patient">환자 맞춤</option></select><select id="newPlaylistTreatment"><option value="">공통</option>${TREATMENT_OPTIONS.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><button id="addPlaylist" class="btn primary">만들기</button></div>${playlistGroupsHtml()}</section>
    <section class="panel"><div class="panel-head"><div><span class="eyebrow">LIBRARY</span><h2>영상 보관함</h2><p>영상의 제목과 사용 여부만 관리합니다.</p></div>${state.videos.some(v=>v.url&&!v.thumbnail_data_url)?'<button id="backfillThumbs" class="btn">누락 썸네일 생성</button>':''}</div><div class="media-list">${state.videos.map(videoRow).join('')||'<p class="muted">등록된 영상이 없습니다.</p>'}</div></section>`;
    qs('#videoUpload')?.addEventListener('change',e=>uploadVideos([...e.target.files]));
    qs('#addPlaylist')?.addEventListener('click',addPlaylist);
    qs('#backfillThumbs')?.addEventListener('click',backfillThumbnails);
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
    return `<article class="media-row ${v.active?'':'inactive'}"><div class="media-library-thumb">${thumb(v)}</div><div class="grow"><div class="media-title-view" data-title-view="${v.id}"><button type="button" class="media-title-button" data-title-edit="${v.id}" title="제목 수정">${esc(v.title)}</button></div><div class="media-title-edit hidden" data-title-form="${v.id}"><input data-title-input="${v.id}" value="${esc(v.title)}" aria-label="영상 제목"></div><div class="meta">${formatBytes(v.size_bytes)}${v.duration_sec?` · ${formatDuration(v.duration_sec)}`:''} · ${isR2?'Cloudflare R2':'기존 영상'}${usage.total?` · 사용 중 ${usage.total}곳/항목`:''}${v.url?` · <a href="${esc(v.url)}" target="_blank" rel="noopener">재생 확인</a>`:''}</div></div><div class="media-actions"><label class="toggle"><input type="checkbox" data-video-active="${v.id}" ${v.active?'checked':''}><span>사용</span></label><button class="text-action danger-text" data-delete-video="${v.id}">삭제</button></div></article>`;
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
  function probeVideoFile(file){return new Promise((resolve,reject)=>{const url=URL.createObjectURL(file),v=document.createElement('video');v.preload='metadata';v.muted=true;v.playsInline=true;const cleanup=()=>URL.revokeObjectURL(url);const fail=(msg)=>{cleanup();reject(new Error(msg));};v.onloadedmetadata=()=>{if(!Number.isFinite(v.duration)||v.duration<1)return fail(`${file.name}: 영상 길이를 확인할 수 없습니다.`);if(!v.videoWidth||!v.videoHeight)return fail(`${file.name}: 영상 해상도를 확인할 수 없습니다.`);const t=Math.min(Math.max(.1,v.duration*.1),2);v.currentTime=t;};v.onseeked=()=>{try{const c=document.createElement('canvas'),w=320,h=Math.max(180,Math.round(320*(v.videoHeight/v.videoWidth)));c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.drawImage(v,0,0,w,h);const thumbnail=c.toDataURL('image/jpeg',.62);const data={duration_sec:Math.round(v.duration*10)/10,width:v.videoWidth,height:v.videoHeight,thumbnail_data_url:thumbnail};cleanup();resolve(data);}catch(e){fail(`${file.name}: 썸네일 생성 실패`);}};v.onerror=()=>fail(`${file.name}: 브라우저에서 재생할 수 없는 영상입니다.`);v.src=url;});}
  async function uploadVideos(files){
    if(uploadBusy||!files.length)return;
    const invalid=files.find(f=>f.type!=='video/mp4'&&!String(f.name).toLowerCase().endsWith('.mp4'));
    if(invalid)return toast('안정적인 현장 재생을 위해 MP4 영상만 업로드할 수 있습니다.','error');
    uploadBusy=true;
    const queue=qs('#uploadQueue');
    try{
      for(const file of files){
        const meta=await probeVideoFile(file);
        const row=document.createElement('div');row.className='upload-row';row.innerHTML=`<span>${esc(file.name)}</span><div><i></i></div><b>0%</b>`;queue?.appendChild(row);
        const contentType='video/mp4';
        const info=await apiJson('/api/r2-presign',{method:'POST',body:JSON.stringify({filename:file.name,contentType,size:file.size})});
        await uploadByXhr(info.uploadUrl,file,contentType,pct=>{const bar=row.querySelector('i'),label=row.querySelector('b');if(bar)bar.style.width=`${pct}%`;if(label)label.textContent=`${pct}%`;});
        const max=state.videos.reduce((m,v)=>Math.max(m,Number(v.sort_order)||0),0);
        const {error}=await db.from('videos').insert({title:titleFromPath(file.name)||file.name,source:'r2',storage_path:info.key,url:info.publicUrl,size_bytes:file.size,duration_sec:meta.duration_sec,thumbnail_data_url:meta.thumbnail_data_url,available:true,active:true,sort_order:max+10,tags:[],target_age:[],target_gender:[],target_treatment:[]});
        if(error){await apiJson('/api/r2-delete',{method:'POST',body:JSON.stringify({key:info.key})}).catch(()=>{});throw error;}
        row.classList.add('done');row.querySelector('b').textContent='완료';
        state.videos.push({id:'pending',sort_order:max+10});
      }
      toast(`${files.length}개 영상 업로드 완료`);await load();
    }catch(e){toast(e.message||String(e),'error');load().catch(()=>{});}
    finally{uploadBusy=false;}
  }

  function groupKindLabel(kind){return GROUP_KINDS.find(([v])=>v===kind)?.[1]||'구역';}
  function groupAdminRow(g){return `<div class="group-admin-row"><input data-group-name="${g.id}" value="${esc(g.name)}" aria-label="층 또는 구역 이름"><select data-group-kind="${g.id}" aria-label="층 또는 구역 유형">${GROUP_KINDS.map(([v,l])=>`<option value="${v}" ${g.kind===v?'selected':''}>${l}</option>`).join('')}</select><span class="muted">공간 ${state.rooms.filter(r=>r.group_id===g.id).length}곳</span><button class="btn small danger-outline" data-delete-group="${g.id}">삭제</button></div>`;}
  function roomAdminRow(r){return `<details class="panel room-admin room-admin-compact"><summary><span class="room-admin-name"><span class="dot ${adminIsOnline(r)?'on':''}"></span><b>${esc(r.name)}</b><em>${esc(groupById(r.group_id)?.name||'미분류')} · ${esc(roomModeLabel(r.room_mode))}</em></span><span class="status-text">${adminIsOnline(r)?'온라인':'오프라인'}</span></summary><div class="room-admin-body"><div class="inline"><div class="order"><button data-move-room="${r.id}" data-dir="-1">↑</button><button data-move-room="${r.id}" data-dir="1">↓</button></div><input class="title-input grow" data-room-name="${r.id}" value="${esc(r.name)}"></div><div class="grid-2"><label class="field"><span>층/구역</span><select data-room-group="${r.id}"><option value="">층/구역 없음</option>${state.groups.map(g=>`<option value="${g.id}" ${r.group_id===g.id?'selected':''}>${esc(g.name)}</option>`).join('')}</select></label><label class="field"><span>공간 유형</span><select data-room-mode="${r.id}">${ROOM_MODES.map(([v,l])=>`<option value="${v}" ${r.room_mode===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="field"><span>기본 플레이리스트</span><select data-room-playlist="${r.id}"><option value="">자동 선택</option>${state.playlists.filter(p=>p.kind==='default'&&p.active).map(p=>`<option value="${p.id}" ${r.default_playlist_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label class="field"><span>맞춤 자동 종료(분)</span><input data-timeout="${r.id}" type="number" min="0" value="${r.session_timeout_min}"></label><label class="toggle room-mute-toggle"><input data-force-mute="${r.id}" type="checkbox" ${r.force_mute?'checked':''}><span>항상 음소거</span></label></div><div class="inline top-gap"><button class="btn small danger-outline" data-delete-room="${r.id}">삭제</button></div></div></details>`;}
  async function addGroup(){
    const input=qs('#newGroup'),button=qs('#addGroup'),name=input?.value.trim();
    if(!name||groupSaveBusy)return;
    if(state.groups.some(g=>String(g.name||'').trim().toLocaleLowerCase('ko-KR')===name.toLocaleLowerCase('ko-KR'))){toast('이미 같은 이름의 그룹이 있습니다.','error');input?.focus();return;}
    groupSaveBusy=true;if(button)button.disabled=true;
    try{
      const max=state.groups.reduce((m,g)=>Math.max(m,g.sort_order||0),0);
      const {error}=await db.from('signage_groups').insert({name,kind:qs('#newGroupKind').value,sort_order:max+10});
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
  async function deleteGroup(id){const g=groupById(id),count=state.rooms.filter(r=>r.group_id===id).length;if(!confirm(`${g?.name||'그룹'}을 삭제할까요?${count?` 소속 ${count}곳은 미분류로 이동합니다.`:''}`))return;const {error}=await db.from('signage_groups').delete().eq('id',id);if(error)toast(error.message,'error');else await load();}
  async function addRoom(){const name=qs('#newRoom').value.trim();if(!name)return;const max=state.rooms.reduce((m,r)=>Math.max(m,r.sort_order||0),0);const {error}=await db.from('rooms').insert({name,group_id:qs('#newRoomGroup').value||null,room_mode:qs('#newRoomMode').value,sort_order:max+10});if(error)toast(error.message,'error');else await load();}
  async function moveRoom(id,dir){const list=[...state.rooms],from=list.findIndex(x=>x.id===id),to=from+dir;if(from<0||to<0||to>=list.length)return;[list[from],list[to]]=[list[to],list[from]];const {error}=await db.rpc('admin_reorder_rooms',{p_ids:list.map(x=>x.id)});if(error)toast(error.message,'error');else await load();}
  function roomPlayerPath(id){const r=state.rooms.find(x=>x.id===id);return r?.player_key?`/player.html?key=${encodeURIComponent(r.player_key)}`:'';}function openRoomPlayer(id){const path=roomPlayerPath(id);if(!path)return toast('공간 플레이어 주소를 찾을 수 없습니다.','error');openAddress(path);}async function copyRoomPlayer(id){const path=roomPlayerPath(id);if(!path)return toast('공간 플레이어 주소를 찾을 수 없습니다.','error');await copyAddress(path,'공간 플레이어 링크');}async function copyLink(type,id){return copyRoomPlayer(id);}
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
    const staffPath='/staff.html',adminPath='/admin.html';
    return `<section class="settings-section access-section"><div class="settings-section-head"><div><span class="eyebrow">ACCESS</span><h2>관리 화면</h2><p>관리자와 리셉션 스태프 화면만 관리합니다. 각 공간 플레이어의 열기/링크 복사는 송출 화면에서 합니다.</p></div></div><div class="access-grid"><article class="access-card access-card-primary"><span class="access-label">리셉션 스태프</span><h3>환자 배정 · 대기 · 진료 관리</h3><div class="access-actions"><button class="btn primary" data-open-address="${staffPath}">열기</button><button class="btn" data-copy-address="${staffPath}" data-copy-label="리셉션 스태프 주소">복사</button></div></article><article class="access-card"><span class="access-label">관리자</span><h3>전체 송출 · 영상 · 설정</h3><div class="access-actions"><button class="btn" data-open-address="${adminPath}">열기</button><button class="btn" data-copy-address="${adminPath}" data-copy-label="관리자 주소">복사</button></div></article></div></section>`;
  }

  function roomSettingsMarkup(){
    const grouped=[...state.groups.map(g=>({group:g,rooms:state.rooms.filter(r=>r.group_id===g.id)})),{group:null,rooms:state.rooms.filter(r=>!r.group_id)}].filter(x=>x.rooms.length);
    const groupSections=grouped.map(({group,rooms})=>`<details class="space-room-group"><summary><span><b>${esc(group?.name||'미분류')}</b><small>${group?.kind?esc(groupKindLabel(group.kind))+' · ':''}${rooms.length}곳</small></span><em>공간 보기</em></summary><div class="room-admin-list settings-room-list">${rooms.map(roomAdminRow).join('')}</div></details>`).join('');
    return `<section class="settings-section space-manager"><div class="settings-section-head"><div><span class="eyebrow">SPACE</span><h2>공간 관리</h2><p>층/구역과 실제 송출 공간을 필요할 때만 열어 관리합니다.</p></div><div class="settings-count">공간 ${state.rooms.length}곳 · 층/구역 ${state.groups.length}개</div></div><div class="space-control-grid"><details class="settings-card space-control-panel"><summary><span><b>층/구역 관리</b><small>${state.groups.length}개 등록</small></span><em>관리</em></summary><div class="space-control-body"><p class="muted">층 또는 여러 공간을 묶는 구역을 추가하거나 수정합니다.</p><div class="inline space-add-inline"><input id="newGroup" placeholder="예: 10F"><select id="newGroupKind">${GROUP_KINDS.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><button id="addGroup" class="btn primary">추가</button></div><div class="group-admin-list top-gap">${state.groups.map(groupAdminRow).join('')||'<span class="muted empty-setting-message">아직 등록된 층/구역이 없습니다.</span>'}</div></div></details><details class="settings-card space-control-panel"><summary><span><b>공간 추가</b><small>새 송출 위치 등록</small></span><em>추가</em></summary><div class="space-control-body"><p class="muted">실제로 영상이 재생되는 진료실, 상담실, 대기실, 로비 등을 등록합니다.</p><div class="settings-add-room"><input id="newRoom" placeholder="예: 10F-01"><select id="newRoomGroup"><option value="">층/구역 없음</option>${state.groups.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select><select id="newRoomMode">${ROOM_MODES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><button id="addRoom" class="btn primary">공간 추가</button></div></div></details></div><details class="settings-card registered-spaces registered-spaces-compact"><summary class="registered-spaces-summary"><span><b>등록된 공간</b><small>${state.rooms.length}곳 · 공간별 기본 플레이리스트와 세부 설정</small></span><em>관리</em></summary><div class="registered-spaces-body">${groupSections||'<span class="muted empty-setting-message">등록된 공간이 없습니다.</span>'}</div></details></section>`;
  }

  function bindRoomSettings(){
    qs('#addGroup')?.addEventListener('click',addGroup); qs('#addRoom')?.addEventListener('click',addRoom);
    qsa('[data-group-name]').forEach(i=>i.addEventListener('change',()=>updateGroup(i.dataset.groupName,{name:i.value.trim()})));qsa('[data-group-kind]').forEach(i=>i.addEventListener('change',()=>updateGroup(i.dataset.groupKind,{kind:i.value})));qsa('[data-delete-group]').forEach(b=>b.addEventListener('click',()=>deleteGroup(b.dataset.deleteGroup)));
    qsa('[data-room-name]').forEach(i=>i.addEventListener('change',()=>{const name=i.value.trim();if(!name){toast('공간 이름을 입력하세요.','error');i.value=state.rooms.find(r=>r.id===i.dataset.roomName)?.name||'';return;}updateRoom(i.dataset.roomName,{name});}));qsa('[data-room-group]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.roomGroup,{group_id:i.value||null})));qsa('[data-room-mode]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.roomMode,{room_mode:i.value})));qsa('[data-force-mute]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.forceMute,{force_mute:i.checked})));qsa('[data-timeout]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.timeout,{session_timeout_min:Math.max(0,Number(i.value)||0)})));qsa('[data-room-playlist]').forEach(i=>i.addEventListener('change',()=>updateRoom(i.dataset.roomPlaylist,{default_playlist_id:i.value||null})));qsa('[data-delete-room]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('공간을 삭제할까요?'))return;const {error}=await db.from('rooms').delete().eq('id',b.dataset.deleteRoom);if(error)toast(error.message,'error');else await load();}));qsa('[data-move-room]').forEach(b=>b.addEventListener('click',()=>moveRoom(b.dataset.moveRoom,Number(b.dataset.dir))));
  }

  function operatingDayRow(key,label,enabled,start,end){return `<div class="operating-day-row"><label class="toggle"><input type="checkbox" data-hours-enabled="${key}" ${enabled?'checked':''}><span>${label}</span></label><div class="operating-time-fields ${enabled?'':'is-disabled'}" data-hours-fields="${key}"><input type="time" data-hours-start="${key}" value="${String(start).slice(0,5)}" ${enabled?'':'disabled'}><span>–</span><input type="time" data-hours-end="${key}" value="${String(end).slice(0,5)}" ${enabled?'':'disabled'}></div><b>${enabled?'운영':'휴무'}</b></div>`;}

  function renderSettings(){
    const emergencyVideos=state.videos.filter(v=>v.active&&v.available!==false&&v.url);
    const ready=storageHealth?.ok===true;
    qs('#adminRoot').innerHTML=`<div class="page-head"><div><span class="eyebrow">SETTINGS</span><h1>설정</h1><p class="page-intro">층/구역과 공간, 운영시간, 비상 영상, PIN처럼 자주 바꾸지 않는 시스템 설정만 모았습니다.</p></div></div>${accessLinksMarkup()}${roomSettingsMarkup()}<section class="settings-section"><div class="settings-section-head"><div><span class="eyebrow">SYSTEM</span><h2>시스템</h2></div></div><div class="settings-system-grid"><div class="settings-card operating-hours-card"><h3>운영시간</h3><p class="muted">재생률과 통계 계산에 사용하는 전체 병원 기준입니다.</p><div class="operating-day-list">${operatingDayRow('weekday','평일',state.settings.operating_weekday_enabled!==false,state.settings.operating_weekday_start||state.settings.operating_start||'09:00',state.settings.operating_weekday_end||state.settings.operating_end||'20:00')}${operatingDayRow('saturday','토요일',state.settings.operating_saturday_enabled!==false,state.settings.operating_saturday_start||'09:00',state.settings.operating_saturday_end||'17:00')}${operatingDayRow('sunday','일요일',state.settings.operating_sunday_enabled===true,state.settings.operating_sunday_start||'09:00',state.settings.operating_sunday_end||'17:00')}</div><button id="saveOperatingHours" class="btn primary">운영시간 저장</button></div><div class="settings-card"><h3>영상 저장소</h3><div class="storage-status"><span class="dot ${ready?'on':''}"></span><div><b>${ready?'연결됨':'설정 필요'}</b><p>Cloudflare R2 영상 저장 상태</p></div></div><button id="testStorage" class="btn">연결 확인</button></div><div class="settings-card"><h3>비상 영상</h3><label class="field"><span>재생할 영상</span><select id="emergencyVideo"><option value="">사용 안 함</option>${emergencyVideos.map(v=>`<option value="${v.id}" ${state.settings.emergency_video_id===v.id?'selected':''}>${esc(v.title)} · ${formatBytes(v.size_bytes)}</option>`).join('')}</select></label><button id="saveEmergency" class="btn primary">저장</button></div><div class="settings-card"><h3>PIN</h3><label class="field"><span>관리자 PIN · 6자리</span><input id="newAdminPin" type="password" inputmode="numeric" maxlength="6"></label><button id="changeAdminPin" class="btn">관리자 PIN 변경</button><label class="field top-gap"><span>스텝 PIN · 4~6자리</span><input id="newStaffPin" type="password" inputmode="numeric" maxlength="6"></label><button id="changeStaffPin" class="btn">스텝 PIN 변경</button></div></div></section>`;
    bindRoomSettings();
    qsa('[data-hours-enabled]').forEach(i=>i.addEventListener('change',()=>{const key=i.dataset.hoursEnabled,wrap=qs(`[data-hours-fields="${key}"]`);wrap?.classList.toggle('is-disabled',!i.checked);qsa(`[data-hours-start="${key}"],[data-hours-end="${key}"]`).forEach(x=>x.disabled=!i.checked);const label=i.closest('.operating-day-row')?.querySelector('b');if(label)label.textContent=i.checked?'운영':'휴무';}));
    qsa('[data-open-address]').forEach(b=>b.addEventListener('click',()=>openAddress(b.dataset.openAddress)));
    qsa('[data-copy-address]').forEach(b=>b.addEventListener('click',()=>copyAddress(b.dataset.copyAddress,b.dataset.copyLabel||'주소')));
    qs('#saveOperatingHours')?.addEventListener('click',saveOperatingHours);qs('#testStorage')?.addEventListener('click',async()=>{await checkStorageHealth(true);renderSettings();});qs('#saveEmergency')?.addEventListener('click',saveEmergency);qs('#changeAdminPin')?.addEventListener('click',()=>changePin('admin'));qs('#changeStaffPin')?.addEventListener('click',()=>changePin('staff'));qsa('#newAdminPin,#newStaffPin').forEach(i=>i.addEventListener('input',()=>{i.value=i.value.replace(/\D/g,'').slice(0,6);}));
  }
  async function saveOperatingHours(){
    const patch={};
    for(const key of ['weekday','saturday','sunday']){
      const enabled=!!qs(`[data-hours-enabled="${key}"]`)?.checked,start=qs(`[data-hours-start="${key}"]`)?.value,end=qs(`[data-hours-end="${key}"]`)?.value;
      if(enabled&&(!start||!end||start>=end))return toast(`${key==='weekday'?'평일':key==='saturday'?'토요일':'일요일'} 운영시간을 확인하세요.`,'error');
      patch[`operating_${key}_enabled`]=enabled;patch[`operating_${key}_start`]=start||'09:00';patch[`operating_${key}_end`]=end||'17:00';
    }
    patch.operating_start=patch.operating_weekday_start;patch.operating_end=patch.operating_weekday_end;patch.updated_at=new Date().toISOString();
    const {error}=await db.from('app_settings').update(patch).eq('id',1);if(error)return toast(error.message,'error');toast('운영시간을 저장했습니다.');await load();
  }
  async function changePin(role){const input=qs(role==='admin'?'#newAdminPin':'#newStaffPin'),pin=input.value.replace(/\D/g,'');if(role==='admin'&&pin.length!==6)return toast('관리자 PIN은 6자리입니다.','error');if(role==='staff'&&(pin.length<4||pin.length>6))return toast('스텝 PIN은 4~6자리입니다.','error');if(!confirm(`${role==='admin'?'관리자':'스텝'} PIN을 변경할까요?`))return;const {error}=await db.rpc('admin_change_pin',{p_role:role,p_pin:pin});if(error)return toast(error.message,'error');input.value='';if(role==='admin'){Signage.clearPinSession();location.replace('/');}else toast('스텝 PIN 변경 완료');}
  async function saveEmergency(){const id=qs('#emergencyVideo').value||null;if(id){const v=state.videos.find(x=>x.id===id);if(Number(v?.size_bytes||0)>MAX_EMERGENCY_BYTES)return toast('비상영상은 250MB 이하로 선택하세요.','error');}const {error}=await db.from('app_settings').update({emergency_video_id:id,updated_at:new Date().toISOString()}).eq('id',1);if(error)toast(error.message,'error');else{toast('비상영상 저장 완료');await load();}}
  async function checkStorageHealth(showToast=false){
    try{storageHealth=await apiJson('/api/r2-status',{method:'GET'});if(showToast)toast('영상 저장소 연결 정상');}
    catch(e){storageHealth=false;if(showToast)toast(e.message||'R2 연결 실패','error');}
    if(tab==='dashboard')paintAlerts();
    if(tab==='videos')renderVideos();
  }

  function estimatedCurrentTime(r){
    const st=r?.player_status||{};
    let current=Math.max(0,Number(st.current_time)||0);
    const duration=Math.max(0,Number(st.duration)||0);
    const playing=String(st.playback_state||'').toLowerCase()==='playing'&&!r.paused;
    if(playing){
      const base=Number(r.__live_received_at||0)||new Date(st.reported_at||r.last_seen_at||0).getTime();
      if(base>0)current+=(Date.now()-base)/1000;
    }
    if(duration>0)current=Math.min(duration,current);
    return current;
  }
  function paintLiveSummary(){
    if(tab!=='dashboard')return;
    const statuses=state.rooms.map(roomDisplayStatus),online=state.rooms.filter(adminIsOnline).length;
    const live=statuses.filter(x=>x.key==='live').length,issues=statuses.filter(x=>['delayed','recovering','error'].includes(x.key)).length;
    const offline=statuses.filter(x=>x.key==='offline').length,paused=statuses.filter(x=>x.key==='paused').length;
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
    const nowText=summary.key==='live'?`${summary.live}곳 송출 중`:summary.key==='issue'?`확인 필요한 공간 ${summary.issues}곳`:summary.key==='offline'?'모든 공간 연결 끊김':summary.key==='idle'?'현재 재생 대기':'현재 상태 확인';
    const text=card.querySelector('[data-group-live-summary]');if(text)text.textContent=`${nowText}${gb?.active&&currentVideo?` · 그룹 송출 ${currentVideo}`:''}`;
    const badge=card.querySelector('[data-group-status]');if(badge){badge.textContent=summary.label;badge.className=`group-status-badge status-${summary.key}`;}
    const set=(sel,v)=>{const el=card.querySelector(sel);if(el)el.textContent=String(v);};set('[data-group-total]',summary.total);set('[data-group-live]',summary.live);set('[data-group-online]',summary.online);set('[data-group-issues]',summary.issues);
    card.className=card.className.replace(/group-state-(live|issue|offline|idle)/g,'').trim()+` group-state-${summary.key}`;
  }
  function mergeRealtimeRoom(next){
    if(!next?.id)return;
    const i=state.rooms.findIndex(r=>r.id===next.id);
    if(i<0){state.rooms.push({...next,__live_received_at:Date.now()});state.rooms.sort((a,b)=>(Number(a.sort_order||0)-Number(b.sort_order||0))||String(a.created_at||'').localeCompare(String(b.created_at||'')));if(tab==='dashboard')renderDashboard();return;}
    state.rooms[i]={...state.rooms[i],...next,__live_received_at:Date.now(),__live_verified_at:Date.now()};
    if(tab==='dashboard'){paintLiveRoom(state.rooms[i]);paintLiveSummary();paintAlerts();}
    if(tab==='settings'){const el=qs(`[data-room-name="${next.id}"]`)?.closest('.room-admin')?.querySelector('.status-text');if(el)el.textContent=adminIsOnline(state.rooms[i])?'온라인':'오프라인';}
  }
  function mergePlayerLiveStatus(live){
    if(!live?.room_id)return;
    const i=state.rooms.findIndex(r=>r.id===live.room_id);
    if(i<0)return;
    state.rooms[i]={...state.rooms[i],last_seen_at:live.last_seen_at||state.rooms[i].last_seen_at,player_status:live.player_status||state.rooms[i].player_status,__live_received_at:Date.now(),__live_verified_at:Date.now()};
    if(tab==='dashboard'){paintLiveRoom(state.rooms[i]);paintLiveSummary();paintAlerts();}
    if(tab==='settings'){const el=qs(`[data-room-name="${live.room_id}"]`)?.closest('.room-admin')?.querySelector('.status-text');if(el)el.textContent=adminIsOnline(state.rooms[i])?'온라인':'오프라인';}
  }
  function removeRealtimeRoom(id){
    if(!id)return;
    const before=state.rooms.length;state.rooms=state.rooms.filter(r=>r.id!==id);
    if(before!==state.rooms.length&&tab==='dashboard')renderDashboard();
  }
  function paintLiveRoom(r){
    const card=qs(`[data-room-card="${r.id}"]`);if(!card)return;
    const st=r.player_status||{},on=adminIsOnline(r),current=estimatedCurrentTime(r),progress=st.duration?`${formatDuration(current)} / ${formatDuration(st.duration)}`:'',p=playlistInfo(st),h=roomHealth(r),cv=state.videos.find(v=>v.id===st.video_id)||null;
    card.className=card.className.replace(/health-(normal|delayed|offline|error|recovering)/g,'').trim()+` health-${h}`;card.dataset.health=h;
    const displayStatus=roomDisplayStatus(r),health=qs('.monitor-health',card);if(health){health.textContent=displayStatus.label;health.className=`monitor-health room-status-badge status-${displayStatus.key}`;}
    const th=qs('.monitor-current-thumb',card),thumbKey=String(cv?.id||'');if(th&&th.dataset.videoId!==thumbKey){th.innerHTML=thumb(cv);th.dataset.videoId=thumbKey;}
    qs('[data-live-dot]',card)?.classList.toggle('on',on);
    const mode=qs('[data-live-mode]',card);if(mode)mode.textContent=`지금 재생 · ${modeLabel(st.mode)}`;
    const title=qs('[data-live-title]',card);if(title)title.textContent=r.paused?'일시정지':(st.title||'대기 중');
    const next=qs('[data-live-next]',card);if(next)next.textContent=p.next||((p.titles.length>1)?p.titles[(p.current+1)%p.titles.length]:'—');
    const detail=qs('[data-live-detail]',card);if(detail)detail.textContent=on?`${playbackLabel(st.playback_state)}${progress?` · ${progress}`:''}${st.muted?' · 음소거':''}${st.error?` · ${st.error}`:''}`:'오프라인';
  }

  const staleVerifyMeta=new Map();
  let staleVerifyBusy=false;
  async function verifyStaleLiveStatuses(){
    if(staleVerifyBusy||tab!=='dashboard'||document.hidden)return;
    const now=Date.now(),candidates=[];
    for(const r of state.rooms){
      const age=roomAgeMs(r);if(age<LIVE_DELAY_MS-5000)continue;
      const seen=String(r.last_seen_at||''),meta=staleVerifyMeta.get(r.id)||{};
      if(meta.seen!==seen){meta.seen=seen;meta.checkedAt=0;}
      if(now-Number(meta.checkedAt||0)<60000)continue;
      meta.checkedAt=now;staleVerifyMeta.set(r.id,meta);candidates.push(r.id);
    }
    if(!candidates.length)return;
    staleVerifyBusy=true;
    try{
      const {data,error}=await db.from('player_live_status').select('room_id,last_seen_at,player_status').in('room_id',candidates);
      if(!error)(data||[]).forEach(live=>mergePlayerLiveStatus(live));
    }catch(_){}finally{staleVerifyBusy=false;}
  }

  try{const pruneKey='clinic-signage:event-prune-day',today=new Date().toISOString().slice(0,10);if(localStorage.getItem(pruneKey)!==today){db.rpc('admin_prune_player_events',{p_days:30}).then(()=>localStorage.setItem(pruneKey,today)).catch(()=>{});}await load();}catch(e){qs('#adminRoot').innerHTML=`<p class="error">${esc(e.message||e)}</p>`;}

  let controlSignalReady=false,controlSignalReadyPromise=null;
  function waitForControlSignal(timeoutMs=1800){
    if(controlSignalReady)return Promise.resolve(true);
    if(!controlSignalReadyPromise)return Promise.resolve(false);
    return Promise.race([controlSignalReadyPromise,new Promise(resolve=>setTimeout(()=>resolve(false),timeoutMs))]);
  }
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
  async function syncAfterControl(scope={}){
    // A room-row revision is the canonical wake-up path. It survives UI moves and does not depend on a specific menu DOM.
    await signalAffectedRooms(scope);
    if(document.hidden)return;
    // Broadcast is only a low-latency assist; room revision + Postgres Realtime is the durable path.
    await sendImmediateControlSignal();
    lastRoomSyncAt=0;lastControlSyncAt=0;
    await Promise.all([refreshLiveControls(true),refreshLiveRooms(true)]);
    // Short acknowledgement burst only after a control action. No background polling.
    [450,1400,3200,6500].forEach(delay=>window.setTimeout(()=>{
      if(document.hidden||tab!=='dashboard')return;
      lastRoomSyncAt=0;
      refreshLiveRooms(true);
    },delay));
  }

  let liveRefreshBusy=false,lastRoomSyncAt=0;
  async function refreshLiveRooms(force=false){
    if(liveRefreshBusy||document.hidden)return;
    if(!force)return;
    liveRefreshBusy=true;
    try{
      const [roomsResult,liveResult]=await Promise.all([
        db.from('rooms').select('*').order('sort_order').order('created_at'),
        db.from('player_live_status').select('*')
      ]);
      if(roomsResult.error)throw roomsResult.error;if(liveResult.error)throw liveResult.error;
      const liveByRoom=new Map((liveResult.data||[]).map(x=>[x.room_id,x]));
      const rows=(roomsResult.data||[]).map(r=>{const live=liveByRoom.get(r.id);return live?{...r,last_seen_at:live.last_seen_at||r.last_seen_at,player_status:live.player_status||r.player_status}:r;}),ids=new Set(rows.map(r=>r.id));
      rows.forEach(mergeRealtimeRoom);
      state.rooms.filter(r=>!ids.has(r.id)).forEach(r=>removeRealtimeRoom(r.id));
      lastRoomSyncAt=Date.now();
    }catch(_){}finally{liveRefreshBusy=false;}
  }
  let liveControlBusy=false,liveControlSig='',lastControlSyncAt=0;
  async function refreshLiveControls(force=false){
    if(liveControlBusy||tab!=='dashboard'||document.hidden)return;
    if(!force)return;
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
        const openRooms=qsa('.monitor-room[open]').map(x=>x.dataset.roomCard),openGroups=qsa('.monitor-group[open]').map(x=>x.dataset.groupCard),scrollY=window.scrollY;
        renderDashboard();
        openGroups.forEach(id=>qs(`[data-group-card="${id}"]`)?.setAttribute('open',''));
        openRooms.forEach(id=>qs(`[data-room-card="${id}"]`)?.setAttribute('open',''));
        window.scrollTo(0,scrollY);
      }
      liveControlSig=sig;lastControlSyncAt=Date.now();
    }catch(_){}finally{liveControlBusy=false;}
  }
  function scheduleRealtimeControlSync(){
    lastControlSyncAt=0;
    if(!document.hidden&&tab==='dashboard')refreshLiveControls(true);
  }
  function startRealtime(){
    try{
      controlSignalReadyPromise=new Promise(resolve=>{
        controlSignalChannel=db.channel('clinic-signage-control',{config:{broadcast:{ack:true}}});
        controlSignalChannel.subscribe(status=>{
          controlSignalReady=status==='SUBSCRIBED';
          if(status==='SUBSCRIBED')resolve(true);
          else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED')resolve(false);
        });
      });
      db.channel('clinic-admin-live-v22111')
        .on('postgres_changes',{event:'INSERT',schema:'public',table:'player_live_status'},payload=>mergePlayerLiveStatus(payload.new||{}))
        .on('postgres_changes',{event:'UPDATE',schema:'public',table:'player_live_status'},payload=>mergePlayerLiveStatus(payload.new||{}))
        .on('postgres_changes',{event:'INSERT',schema:'public',table:'rooms'},payload=>mergeRealtimeRoom(payload.new||{}))
        .on('postgres_changes',{event:'DELETE',schema:'public',table:'rooms'},payload=>removeRealtimeRoom(payload.old?.id))
        .on('postgres_changes',{event:'*',schema:'public',table:'broadcast'},scheduleRealtimeControlSync)
        .on('postgres_changes',{event:'*',schema:'public',table:'group_broadcasts'},scheduleRealtimeControlSync)
        .on('postgres_changes',{event:'*',schema:'public',table:'room_video_rules'},scheduleRealtimeControlSync)
        .subscribe();
    }catch(_){}
  }
  // Initial load is the only automatic full-state read. After this, Realtime handles changes.
  startRealtime();
  checkStorageHealth();
  // Local-only clock/progress repaint. This does not query Supabase or R2.
  let staleVerifyTick=0;
  setInterval(()=>{if(tab==='dashboard'){state.rooms.forEach(paintLiveRoom);paintLiveSummary();if(++staleVerifyTick%5===0)verifyStaleLiveStatuses();}},1000);
})();
