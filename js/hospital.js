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
  let state={site:null,siteSettings:{},buildingAsset:{},floorplanAssets:{},floorSpaces:[],floorplanVersions:[],patients:[],rooms:[],groups:[],playlists:[],videos:[],playlistItems:[],roomRules:[],broadcast:{active:false}}, busy=false, signalChannel=null,statusWakeChannel=null,settingsOpen=false,spaceEditorGroupId=null,spaceRedrawId=null,layoutEditMode='display',layoutCopyOpen=false,layoutPlacementRoomId=null,selectedFloorId=null,selectedFloorArea=null,layoutPanelOpen=false,tab='videos',statusViewFilter='';
  // Preview stays click-to-load. Parked elements are capped and evicted LRU.
  const floorInlineVideoCache=new Map();
  const floorInlineVideoCacheLimit=3;
  const floorInlineVideoBin=document.createElement('div');
  floorInlineVideoBin.hidden=true;
  document.body.appendChild(floorInlineVideoBin);
  function warmFloorInlineVideo(url){
    url=String(url||'').trim();
    if(!url)return null;
    let video=floorInlineVideoCache.get(url);
    if(video){floorInlineVideoCache.delete(url);floorInlineVideoCache.set(url,video);return video;}
    if(floorInlineVideoCache.size>=floorInlineVideoCacheLimit){
      const [oldUrl,oldVideo]=floorInlineVideoCache.entries().next().value;
      floorInlineVideoCache.delete(oldUrl);
      try{oldVideo.pause();oldVideo.removeAttribute('src');oldVideo.load();oldVideo.remove();}catch(_){}
    }
    video=document.createElement('video');
    video.preload='none';
    video.playsInline=true;
    video.muted=true;
    video.src=url;
    floorInlineVideoCache.set(url,video);
    floorInlineVideoBin.appendChild(video);
    return video;
  }
  function parkFloorInlineVideo(video){
    if(!video)return;
    try{video.pause();video.currentTime=0;}catch(_){}
    video.removeAttribute('controls');
    video.muted=true;
    video.preload='none';
    floorInlineVideoBin.appendChild(video);
  }
  document.addEventListener('click',e=>{
    const a=e.target.closest?.('a[data-video-link]');
    if(a){e.stopPropagation();return;}
    const btn=e.target.closest?.('[data-floor-inline-video]');
    if(!btn)return;
    e.preventDefault();
    e.stopPropagation();
    const host=btn.closest('.floor-room-current,.floor-space-display-row');
    if(!host)return;
    const url=String(btn.dataset.floorInlineVideo||'').trim();
    if(!url)return;
    const title=String(btn.dataset.videoTitle||'현재 영상');
    const existing=host.querySelector(':scope > .floor-inline-video-panel');
    if(existing){
      const same=existing.dataset.videoUrl===url;
      parkFloorInlineVideo(existing.querySelector('video'));
      existing.remove();
      btn.setAttribute('aria-expanded','false');
      if(same)return;
    }
    document.querySelectorAll('.floor-inline-video-panel').forEach(panel=>{
      const owner=panel.parentElement?.querySelector('[data-floor-inline-video][aria-expanded="true"]');
      if(owner)owner.setAttribute('aria-expanded','false');
      parkFloorInlineVideo(panel.querySelector('video'));
      panel.remove();
    });
    const panel=document.createElement('div');
    panel.className='floor-inline-video-panel';
    panel.dataset.videoUrl=url;
    panel.innerHTML=`<div class="floor-inline-video-head"><b>${esc(title)}</b><button type="button" class="floor-inline-video-close" aria-label="영상 닫기">닫기</button></div>`;
    const video=warmFloorInlineVideo(url);
    if(!video)return;
    video.preload='auto';
    video.controls=true;
    video.playsInline=true;
    video.muted=false;
    panel.appendChild(video);
    host.appendChild(panel);
    btn.setAttribute('aria-expanded','true');
    video.play().catch(()=>{}); // muted/autoplay policy can require an explicit press of Play.
    panel.querySelector('.floor-inline-video-close')?.addEventListener('click',ev=>{ev.preventDefault();ev.stopPropagation();btn.setAttribute('aria-expanded','false');parkFloorInlineVideo(video);panel.remove();});
  });
  qsa('.nav-btn').forEach(b=>b.addEventListener('click',()=>{tab='videos';const target=b.dataset.tab==='output'?'unifiedTvOperations':b.dataset.tab==='settings'?'unifiedHospitalSettings':'unifiedMediaEditor';if(target!=='unifiedMediaEditor')qs('#'+target)?.setAttribute('open','');qs('#'+target)?.scrollIntoView({behavior:'smooth',block:'start'});}));
  const floorplanUrlCache=new Map();
  const buildingImageUrlCache=new Map();
  const statusWakeTimers=new Map();
  // roomId -> {status:'pending'|'unconfirmed'|'error', at:issuedAtServerMs}
  const ackState=new Map();
  const monitor=Signage.createLiveMonitor({onUpdate:(res)=>applyLiveResult(res),roomIds:()=>state.rooms.map(r=>r.id)});
  async function signalRoom(room){try{const {error}=await db.rpc('signal_signage_rooms',{p_room_ids:[room],p_group:null,p_all:false});if(error)throw error;return true;}catch(e){console.warn('Clinic Signage signal failed:',e);toast('송출 변경 신호 전달 실패 · 플레이어가 다음 자동 동기화에서 반영할 수 있습니다.','error');return false;}}

  const treatmentLabel=(v)=>TREATMENTS.find(([id])=>id===v)?.[1]||v||'일반 진료';
  const ageLabel=(v)=>AGE_OPTIONS.find(([id])=>id===v)?.[1]||'전체';
  const genderLabel=(v)=>GENDER_OPTIONS.find(([id])=>id===v)?.[1]||'전체';
  /* O(1) lookups. The live-status repaint calls these for every room every tick, so linear
     scans over rooms/videos/patients added up to O(rooms x videos) work per second. Each index
     is rebuilt only when load() replaces the underlying array. */
  const lookupCache={rooms:null,roomMap:new Map(),videos:null,videoMap:new Map(),patients:null,patientMap:new Map()};
  const roomById=(id)=>{if(lookupCache.rooms!==state.rooms){lookupCache.rooms=state.rooms;lookupCache.roomMap=new Map(state.rooms.map(r=>[r.id,r]));}return lookupCache.roomMap.get(id)||null;};
  async function roomPlayerPath(roomId){
    const {data,error}=await db.rpc('hospital_room_player_path',{p_room:roomId});
    if(error)throw error;
    return String(data||'');
  }
  async function openRoomPlayer(roomId){
    try{const path=await roomPlayerPath(roomId);if(!path)throw new Error('환자 화면 주소를 찾을 수 없습니다.');/* preview=1: this tab must not report as the real TV (closing it used to mark the TV "오프라인"). The copied TV URL stays without it. */window.open(`${path}${path.includes('?')?'&':'?'}preview=1`,'_blank','noopener,noreferrer');}
    catch(e){toast(e.message||String(e),'error');}
  }
  // Delegation covers inspector HTML inserted after initial bind().
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-staff-video-link-copy]');
    if(!button)return;
    event.preventDefault();
    event.stopPropagation();
    void copyOutputVideoLink(button);
  });
  function videoCopyButton(video,extraClass=''){
    if(!video)return '';
    const available=String(video.url||'').trim();
    return `<button type="button" class="staff-video-copy-btn ${extraClass}" data-staff-video-link-copy="${esc(video.id)}" aria-label="${esc(video.title||'영상')} 원본 MP4 주소 복사" title="원본 영상 파일 주소" ${available?'':'disabled'}>원본 주소</button>`;
  }
  async function copyOutputVideoLink(button){
    const video=state.videos.find(v=>String(v.id)===String(button.dataset.staffVideoLinkCopy));
    const raw=String(video?.url||'').trim();
    if(!raw){toast('복사할 영상 링크가 없습니다.','error');return;}
    let url;
    try{url=new URL(raw,location.origin);if(!['https:','http:'].includes(url.protocol))throw new Error('unsupported');}
    catch(_){toast('영상 주소가 올바르지 않습니다.','error');return;}
    try{
      if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(url.href);
      else{
        const ta=document.createElement('textarea');ta.value=url.href;ta.setAttribute('readonly','');
        ta.style.cssText='position:fixed;left:-9999px;top:0;opacity:0';document.body.appendChild(ta);
        try{ta.focus();ta.select();if(!document.execCommand('copy'))throw new Error('copy failed');}
        finally{ta.remove();}
      }
      toast('원본 영상 주소를 복사했습니다. 이 주소로 재생해도 TV 송출 현황에는 반영되지 않습니다.');
    }catch(e){toast('링크 복사에 실패했습니다. 브라우저 권한을 확인하세요.','error');}
  }
  async function copyRoomPlayer(roomId){
    try{const path=await roomPlayerPath(roomId);if(!path)throw new Error('환자 화면 주소를 찾을 수 없습니다.');const url=new URL(path,location.origin).href;if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(url);else{const ta=document.createElement('textarea');ta.value=url;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();}toast('TV 연결 주소를 복사했습니다. 이 주소를 TV 브라우저에 등록하세요.');}
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
  function staffThumbLink(v,className='',label='영상 열기'){
    const inner=staffThumb(v),cls=['video-thumb-link',className].filter(Boolean).join(' '),url=String(v?.url||'').trim();
    return url?`<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-video-link aria-label="${esc(v.title||label)} · ${esc(label)}" title="${esc(v.title||label)} · 클릭하여 영상 열기">${inner}</a>`:`<div class="${cls} is-disabled" aria-label="${esc(v?.title||'영상 없음')}">${inner}</div>`;
  }
  function staffFloorInlineThumb(v,className='',label='현재 영상 보기'){
    const inner=staffThumb(v),cls=['video-thumb-link','floor-inline-video-trigger',className].filter(Boolean).join(' '),url=String(v?.url||'').trim();
    return url?`<button type="button" class="${cls}" data-floor-inline-video="${esc(url)}" data-video-title="${esc(v?.title||'현재 영상')}" aria-expanded="false" aria-label="${esc(v?.title||label)} · ${esc(label)}" title="${esc(v?.title||label)} · 아래에서 영상 보기">${inner}</button>`:`<div class="${cls} is-disabled" aria-label="${esc(v?.title||'영상 없음')}">${inner}</div>`;
  }
  function roomPlaylistLabel(r){
    const mode=String(r.player_status?.mode||'');
    if(mode==='emergency')return '비상 영상';
    if(['broadcast','broadcast_schedule'].includes(mode))return '전체 송출';
    if(['group','group_schedule'].includes(mode))return '층/그룹 송출';
    if(r.manual_active&&r.manual_video_ids?.length)return '개별 영상';
    if(mode==='patient')return staffPatientPlaylist(r)?.name||'맞춤 송출';
    return playlistById(r.default_playlist_id)?.name||playlistById(state.groups.find(g=>g.id===r.group_id)?.default_playlist_id)?.name||'기본 재생목록';
  }
  function staffRoomVideoStripHtml(r){
    const ids=staffBaseIds(r).filter(Boolean),currentId=String(r.player_status?.video_id||'');
    const videos=ids.map(id=>state.videos.find(v=>v.id===id)).filter(Boolean).filter(v=>String(v.id)!==currentId);
    if(!videos.length)return '<div class="floor-video-strip-empty">다음 영상이 없습니다.</div>';
    return `<div class="floor-video-strip" aria-label="${esc(r.name)} 다음 영상">${videos.slice(0,6).map((v,i)=>`<div class="floor-video-thumb" title="${esc(v.title)}">${staffThumbLink(v,'floor-video-thumb-media','영상 열기')}<small>${i+1}. ${esc(v.title)}</small>${videoCopyButton(v,'floor-video-copy-btn')}</div>`).join('')}${videos.length>6?`<span class="floor-video-more">+${videos.length-6}</span>`:''}</div>`;
  }
  function roomBroadcastReason(r){
    const g=state.groups.find(x=>x.id===r.group_id)||null;
    const sp=roomSpace(r)||spaceContainingPoint(r.group_id,r.map_x_pct,r.map_y_pct);
    const reason=String(sp?.content_reason||g?.signage_reason||'').trim();
    if(reason)return reason;
    const purpose=String(g?.signage_purpose||'').trim();
    const target=String(g?.target_audience||'').trim();
    if(target&&purpose)return `${target}에게 ${purpose}을 위해 이 영상을 보여줍니다.`;
    if(purpose)return `${purpose}을 위해 이 영상을 보여줍니다.`;
    if(target)return `${target}에게 필요한 정보를 보여주기 위한 영상입니다.`;
    return `${r.name}에서 필요한 안내를 보여주기 위한 영상입니다.`;
  }
  function roomOperationalPurpose(r){
    const note=String(r?.display_note||'').trim();
    if(note)return note;
    const sp=roomSpace(r),type=sp?.space_type||r?.room_mode;
    const fallback={reception:'접수·안내 공간에서 필요한 정보를 보여주는 디스플레이',waiting:'대기 중인 고객에게 안내·브랜드 콘텐츠를 보여주는 디스플레이',lounge:'라운지 이용 고객에게 병원 콘텐츠를 보여주는 디스플레이',consultation:'상담 전후 고객에게 관련 콘텐츠를 보여주는 디스플레이',treatment:'진료 공간에서 필요한 콘텐츠를 보여주는 디스플레이',lobby:'이동 고객에게 병원 안내 콘텐츠를 보여주는 디스플레이',public:'공용 공간 안내용 디스플레이',staff:'직원 운영용 디스플레이',support:'지원 공간 디스플레이',other:'이 공간의 콘텐츠 송출 디스플레이'};
    return fallback[type]||fallback.other;
  }
  function spaceOperationalPurpose(sp){
    const g=state.groups.find(x=>x.id===sp?.group_id)||null;
    const groupPurpose=String(g?.signage_purpose||g?.content_intro||'').trim();
    if(groupPurpose)return groupPurpose;
    const fallback={reception:'접수와 첫 안내를 담당하는 공간',waiting:'대기 고객이 머무르며 안내·브랜드 콘텐츠를 접하는 공간',lounge:'고객이 머무르며 병원 콘텐츠를 접하는 공간',consultation:'상담 전후 설명과 안내가 이루어지는 공간',treatment:'진료와 치료가 이루어지는 공간',lobby:'이동과 방향 안내가 필요한 공용 공간',public:'고객이 공용으로 이용하는 공간',staff:'직원 운영 공간',support:'진료 지원 공간',other:'병원 운영 공간'};
    return fallback[String(sp?.space_type||'other')]||fallback.other;
  }

  function journeyCopyForType(type, meta={}){
    const topicText=(Array.isArray(meta.topics)?meta.topics:[]).map(x=>String(x||'').trim()).filter(Boolean).slice(0,3).join(' · ');
    const reasonText=String(meta.reason||'').trim();
    const waitingText=String(meta.waiting||'').trim();
    const fallback={
      reception:{stage:'도착 직후',need:'접수·문진·첫 안내가 필요한 순간',why:'처음 온 고객이 어디서 무엇을 해야 하는지 바로 이해해야 합니다.',content:'접수 방법 · 문진 안내 · 위치 안내'},
      waiting:{stage:'대기 중',need:'왜 기다리는지와 다음 순서를 알고 싶을 때',why:'대기 불안과 반복 질문을 줄이려면 현재 상황과 다음 단계를 쉽게 이해시켜야 합니다.',content:'대기 안내 · 현재 치료 설명 · 전후 사례'},
      lounge:{stage:'대기·휴식 중',need:'길지 않은 시간에 편하게 정보를 받아들이는 순간',why:'체류 시간이 있어 병원 이해와 치료 신뢰를 높이는 콘텐츠가 잘 맞습니다.',content:'브랜드 소개 · 치료 사례 · 관리 팁'},
      consultation:{stage:'상담 전·후',need:'치료를 이해하고 결정에 도움을 받아야 할 때',why:'상담 전후에는 이해와 신뢰 형성이 중요해 설명형 콘텐츠가 필요합니다.',content:'치료 원리 · 사례 · 과정 설명'},
      treatment:{stage:'진료 중·직후',need:'현재 치료 단계와 이후 관리가 궁금한 순간',why:'치료 맥락과 사후관리를 이해시키면 직원 설명이 쉬워지고 안내가 자연스럽습니다.',content:'현재 치료 설명 · 전후 사례 · 사후관리'},
      lobby:{stage:'이동 중',need:'위치와 방향을 빠르게 파악해야 할 때',why:'짧게 스쳐 지나가도 바로 이해되는 안내가 필요합니다.',content:'층 안내 · 위치 안내 · 공용 정보'},
      public:{stage:'공용 이동 중',need:'방향과 기본 정보를 빠르게 확인할 때',why:'공용 공간에서는 한눈에 들어오는 정보가 우선입니다.',content:'층 안내 · 공지 · 기본 안내'},
      staff:{stage:'직원 운영',need:'현장 운영 상태를 확인해야 할 때',why:'고객용보다는 운영 확인용 정보가 필요합니다.',content:'운영 상태 · 확인 항목'},
      support:{stage:'진료 지원',need:'내부 운영 흐름을 확인할 때',why:'지원 공간은 고객 안내보다 내부 운영 목적이 큽니다.',content:'운영 상태 · 지원 정보'},
      other:{stage:'공간 이용 중',need:'이 공간에서 필요한 정보를 빠르게 받아야 할 때',why:'공간 목적에 맞는 핵심 정보가 바로 보여야 합니다.',content:'공간 맞춤 안내'}
    };
    const base=fallback[String(type||'other')]||fallback.other;
    return {
      stage: base.stage,
      need: waitingText || base.need,
      why: reasonText || base.why,
      content: topicText || base.content
    };
  }
  function journeyMetaForSpace(sp){
    const g=state.groups.find(x=>x.id===sp?.group_id)||null;
    return journeyCopyForType(sp?.space_type||'other',{
      topics: groupContentTopics(g),
      reason: sp?.content_reason || g?.signage_reason,
      waiting: sp?.patient_context_note || g?.waiting_area_note
    });
  }
  function journeyMetaForRoom(r){
    const sp=roomSpace(r)||spaceContainingPoint(r.group_id,r.map_x_pct,r.map_y_pct);
    const g=state.groups.find(x=>x.id===r.group_id)||null;
    const roomReason=String(r?.display_note||'').trim();
    return journeyCopyForType(sp?.space_type||r?.room_mode||'other',{
      topics: groupContentTopics(g),
      reason: roomReason || sp?.content_reason || g?.signage_reason,
      waiting: sp?.patient_context_note || g?.waiting_area_note
    });
  }
  function journeyReasonPanel(meta){
    return `<div class="journey-summary"><div><small>환자 상황</small><b>${esc(meta.stage)}</b><span>${esc(meta.need)}</span></div><div><small>왜 이 콘텐츠인가</small><b>${esc(meta.content)}</b><span>${esc(meta.why)}</span></div></div>`;
  }
  function roomsForFloorSpace(sp){
    if(!sp)return [];
    return state.rooms.filter(r=>{
      if(r.group_id!==sp.group_id)return false;
      if(r.floor_space_id)return r.floor_space_id===sp.id;
      if(!roomMapPlaced(r))return false;
      return spaceContainingPoint(sp.group_id,r.map_x_pct,r.map_y_pct)?.id===sp.id;
    });
  }
  function floorSpaceBroadcastStatus(sp){
    const rooms=roomsForFloorSpace(sp);
    if(!rooms.length)return {key:'empty',label:'TV 없음'};
    // Only fresh, confirmed playback gets the blue state.
    if(rooms.some(r=>roomDisplayStatus(r).key==='live'))return {key:'live',label:'송출 중'};
    return {key:'offline',label:'송출 안 됨'};
  }
  function staffFloorSpacePreviewHtml(sp){
    const rooms=roomsForFloorSpace(sp),journey=journeyMetaForSpace(sp);
    const currentRows=rooms.map(r=>{const st=roomDisplayStatus(r),current=currentVideoForRoom(r),title=current?.title||r.player_status?.title||'현재 재생 영상 없음';return `<div class="floor-space-display-row"><span>${staffFloorInlineThumb(current,'floor-space-current-thumb','현재 영상 보기')}</span><span><small>${esc(r.name)}</small><b>${esc(title)}</b><em>${esc(roomOperationalPurpose(r))}</em>${videoCopyButton(current,'floor-space-copy-btn')}</span><i class="status-${st.key}">${esc(st.label)}</i></div>`;}).join('');
    return `<div class="floor-room-focus floor-space-focus">
      <div class="floor-room-focus-head"><div><small>공간</small><b>${esc(sp.name)}</b><span>${esc(FLOOR_SPACE_TYPES.find(([v])=>v===sp.space_type)?.[1]||'기타')}</span></div><em>${rooms.length}대</em></div>
      <div class="floor-room-purpose"><small>운영 목적</small><p>${esc(spaceOperationalPurpose(sp))}</p></div>
      <div class="floor-room-why floor-space-why"><small>콘텐츠 이유</small>${journeyReasonPanel(journey)}</div>
      <div class="floor-space-current-list"><small>현재 영상</small>${currentRows||'<p class="muted">이 공간에 연결된 디스플레이가 없습니다.</p>'}</div>
    </div>`;
  }
  function staffFloorRoomPreviewHtml(r){
    const status=roomDisplayStatus(r),current=currentVideoForRoom(r),isManual=displayControlMode(r)==='manual',st=r.player_status||{},journey=journeyMetaForRoom(r);
    const title=isManual?'현장 수동 운영':(current?.title||st.title||'현재 재생 영상 없음');
    const progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'';
    const playback=isManual?'원격 재생 상태 없음':(staffIsOnline(r)?`${playbackLabel(st.playback_state)}${progress?` · ${progress}`:''}`:'오프라인 · 플레이어 연결 끊김');
    return `<div class="floor-room-focus">
      <div class="floor-room-focus-head"><div><small>디스플레이</small><b>${esc(r.name)}</b><span>${esc(roomTypeLabel(r.room_mode))}</span></div><em class="status-${status.key}"><i></i>${esc(status.label)}</em></div>
      <div class="floor-room-current">${staffFloorInlineThumb(current,'floor-room-current-thumb','현재 영상 보기')}<div class="floor-room-current-copy"><small>현재 영상</small><b>${esc(title)}</b><span>${esc(playback)} · ${esc(roomPlaylistLabel(r))}</span>${videoCopyButton(current,'floor-current-copy-btn')}</div></div>
      <div class="floor-room-next"><small>다음 영상</small>${staffRoomVideoStripHtml(r)}</div>
      <div class="floor-room-why"><small>콘텐츠 이유</small>${journeyReasonPanel(journey)}</div>
      <div class="floor-room-purpose"><small>운영 목적</small><p>${esc(roomOperationalPurpose(r))}</p></div>
      <div class="floor-room-controls"><div class="floor-room-actions"><select data-staff-playlist="${r.id}">${playlistOptions(r.default_playlist_id||'')}</select><button type="button" class="btn primary" data-staff-playlist-apply="${r.id}">${isManual?'기본 영상 저장':'영상 바꾸기'}</button></div><div class="floor-room-subactions">${isManual?'':`<button type="button" class="text-btn" data-staff-player-open="${r.id}">실제 화면 보기</button><button type="button" class="text-btn" data-staff-player-copy="${r.id}">TV 연결 주소 복사</button>`}<button type="button" class="text-btn dark floor-room-preview-open" data-staff-open-room-detail="${r.id}">상세 설정</button></div>${isManual?'<small class="floor-room-local-note">수동 디스플레이는 설정만 저장되며 원격 재생 명령은 보내지 않습니다.</small>':''}</div>
    </div>`;
  }
  function staffOutputList(r){const items=staffRoomOutputItems(r);return `<div class="staff-output-list">${items.map((x,i)=>`<div class="staff-output-item ${x.rule?.enabled===false?'is-disabled':''}">${staffThumbLink(x.video,'staff-output-thumb','영상 열기')}<b>${esc(x.video.title)}</b>${videoCopyButton(x.video)}<label class="switch"><input type="checkbox" data-staff-video-toggle="${r.id}" data-video-id="${x.id}" ${x.rule?.enabled===false?'':'checked'} ${['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(String(r.player_status?.mode||''))?'disabled':''}><i></i></label><div><button data-staff-video-move="${r.id}" data-video-id="${x.id}" data-dir="-1" ${i===0?'disabled':''}>↑</button><button data-staff-video-move="${r.id}" data-video-id="${x.id}" data-dir="1" ${i===items.length-1?'disabled':''}>↓</button></div></div>`).join('')||'<span class="muted">재생 가능한 영상이 없습니다.</span>'}</div>`;}
  const displayControlMode=(r)=>String(r?.display_control_mode||'remote');
  const displayControlLabel=(r)=>CONTROL_MODES.find(([v])=>v===displayControlMode(r))?.[1]||'원격 제어';
  const roomHealth=(r)=>Signage.roomHealth(r,monitor.serverNow());
  const staffIsOnline=(r)=>{if(displayControlMode(r)==='manual'||!r?.last_seen_at)return false;const h=roomHealth(r),st=r.player_status||{};return st.online!==false&&['normal','error','recovering'].includes(h);};
  function roomDisplayStatus(r){
    const mode=displayControlMode(r);
    if(mode==='manual')return r.manual_check_status==='checked'?{key:'manual',label:'수동 운영'}:{key:'manual-warn',label:'수동 확인 필요'};
    const h=roomHealth(r),st=r.player_status||{},play=String(st.playback_state||'').toLowerCase(),ack=ackState.get(r.id);
    if(h==='offline'||play==='stopped')return {key:'offline',label:mode==='hybrid'?'원격 연결 끊김':'오프라인'};
    if(st.update_error||st.update_pending_version)return {key:'update',label:'업데이트 필요'};
    if(ack?.status==='error'||ack?.status==='unconfirmed'||h==='error'||h==='recovering'||st.error||st.offline_cache_error||Number(st.failed_video_count||0)>0)return {key:'error',label:'오류'};
    // A delayed heartbeat must not be reported as verified playback (or ordinary idle).
    // A pending control acknowledgement is separate from the playback telemetry.
    if(h==='delayed')return {key:'delayed',label:'상태 확인 지연'};
    if(st.mode==='closed'||play==='closed'||r.paused||play==='paused')return {key:'idle',label:'대기'};
    if(['playing','emergency'].includes(play))return {key:'live',label:'송출 중'};
    return {key:'idle',label:'대기'};
  }
  function lastReportLabel(r){
    if(!r?.last_seen_at)return '최근 연결 기록 없음';
    const ms=new Date(r.last_seen_at).getTime();
    if(!Number.isFinite(ms))return '최근 연결 기록 없음';
    const age=Math.max(0,Math.floor((monitor.serverNow()-ms)/1000));
    return age<60?`마지막 보고 ${age}초 전`:`마지막 보고 ${Math.floor(age/60)}분 전`;
  }
  function roomIssueReason(r){
    const mode=displayControlMode(r);
    if(mode==='manual')return r.manual_check_status==='checked'?(r.manual_checked_at?`수동 확인 · ${new Date(r.manual_checked_at).toLocaleDateString('ko-KR')}`:'수동 확인 완료'):'현장 수동 확인 필요';
    const h=roomHealth(r),st=r.player_status||{},ack=ackState.get(r.id);
    if(h==='offline'||String(st.playback_state||'').toLowerCase()==='stopped')return `플레이어 연결 종료 · ${lastReportLabel(r)}`;
    if(st.update_error||st.update_pending_version)return '업데이트 필요';
    if(st.offline_cache_error)return '캐시 오류';
    if(Number(st.failed_video_count||0)>0)return `재생 실패 ${Number(st.failed_video_count||0)}개 건너뜀`;
    if(st.error)return String(st.error).slice(0,60);
    if(ack?.status==='error'||ack?.status==='unconfirmed')return '최근 변경 적용 확인 실패';
    if(h==='delayed')return `상태 보고 지연 · ${lastReportLabel(r)}`;
    if(ack?.status==='pending')return `영상 변경 확인 중 · ${lastReportLabel(r)}`;
    if(st.mode==='closed')return '운영시간 외';
    return lastReportLabel(r);
  }
  const priorityLabel=(v)=>({broadcast:'전체',broadcast_schedule:'예약',manual:'개별',group:'층·구역',group_schedule:'예약',patient:'개별',session:'개별',default:'기본',emergency:'비상',closed:'운영시간 외'})[String(v||'').toLowerCase()]||'기본';
  function roomProblemRank(r){const k=roomDisplayStatus(r).key;return ({error:0,update:1,offline:2,delayed:3,'manual-warn':4,idle:5,manual:6,live:7})[k]??7;}
  function groupStatusSummary(rooms){
    const statuses=rooms.map(roomDisplayStatus);
    const count=(key)=>statuses.filter(x=>x.key===key).length;
    const live=count('live'),offline=count('offline'),manual=count('manual'),manualNeedsCheck=count('manual-warn'),errors=count('error'),updates=count('update'),idle=count('idle');
    const delayed=count('delayed'),issues=errors+updates+offline+manualNeedsCheck+delayed,online=rooms.filter(r=>displayControlMode(r)!=='manual'&&staffIsOnline(r)).length;
    let key='idle',label='대기';
    if(!rooms.length){label='공간 없음';}
    else if(offline===rooms.length-manual-manualNeedsCheck&&offline>0&&manual+manualNeedsCheck===0){key='offline';label='연결 안 됨';}
    else if(errors>0){key='issue';label='오류';}
    else if(updates>0){key='issue';label='업데이트 필요';}
    else if(offline>0){key='issue';label='연결 안 됨';}
    else if(manualNeedsCheck>0){key='issue';label='수동 확인';}
    else if(delayed>0){key='issue';label='상태 확인 지연';}
    else if(live>0){key='live';label='정상';}
    else if(manual>0){key='manual';label='수동 운영';}
    return {live,offline,manual,manualNeedsCheck,errors,updates,delayed,idle,issues,online,total:rooms.length,key,label};
  }
  function groupIssueParts(st){
    return [
      ['오류',st.errors],
      ['업데이트 필요',st.updates],
      ['연결 안 됨',st.offline],
      ['상태 확인 지연',st.delayed],
      ['수동 확인',st.manualNeedsCheck]
    ].filter(([,count])=>Number(count||0)>0);
  }
  function groupIssueText(st,{limit=2}={}){
    const parts=groupIssueParts(st);
    if(!parts.length)return st.total?'정상':'미사용';
    const visible=parts.slice(0,limit).map(([label,count])=>`${label} ${count}`);
    if(parts.length>limit)visible.push(`외 ${parts.length-limit}종`);
    return visible.join(' · ');
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
    if(!raw)return n?`${n}층`:'층 이름 미설정';
    const stripped=raw.replace(new RegExp(`^${n}\\s*(?:층|F)?\\s*[·._/\\-]*\\s*`,'i'),'').trim();
    if(stripped&&!/^\d+\s*(?:층|F)?$/i.test(stripped))return stripped;
    return raw;
  }
  const currentVideoForRoom=(r)=>{const id=r?.player_status?.video_id;if(!id)return null;if(lookupCache.videos!==state.videos){lookupCache.videos=state.videos;lookupCache.videoMap=new Map(state.videos.map(v=>[v.id,v]));}return lookupCache.videoMap.get(id)||null;};
  const playbackLabel=(v)=>({playing:'재생 중',paused:'일시정지',loading:'불러오는 중',error:'오류',connected:'연결됨',closed:'운영시간 외'})[String(v||'').toLowerCase()]||'상태 확인 안 됨';
  const activePatients=()=>state.patients.filter(p=>['waiting','assigned','in_progress'].includes(p.status));
  const elapsedMinutes=(start,end=Date.now())=>start?Math.max(0,Math.floor((new Date(end).getTime()-new Date(start).getTime())/60000)):0;
  const waitText=(p)=>`${elapsedMinutes(p.waiting_started_at||p.created_at,p.assigned_at||Date.now())}분 대기`;
  const patientForRoom=(id)=>{if(lookupCache.patients!==state.patients){lookupCache.patients=state.patients;lookupCache.patientMap=new Map();for(const p of activePatients()){if(p.room_id&&!lookupCache.patientMap.has(p.room_id))lookupCache.patientMap.set(p.room_id,p);}}return lookupCache.patientMap.get(id)||null;};
  const isQuickSession=(r)=>!!r.session_treatment&&!patientForRoom(r.id);

  let lastLoadStartedAt=0;
  async function load({background=false}={}){
    lastLoadStartedAt=Date.now();
    const [reception,building]=await Promise.all([db.rpc('hospital_reception_state',{p_site:targetSiteId}),db.rpc('hospital_building_asset',{p_site:targetSiteId})]);
    if(reception.error)throw reception.error;if(building.error)throw building.error;
    const data=reception.data||{},baseRooms=data.rooms||[];
    const liveStatuses=await monitor.fetchStatus({roomIds:baseRooms.map(r=>r.id)}).catch(()=>({rows:[]}));
    const liveByRoom=new Map((liveStatuses.rows||[]).map(x=>[x.room_id,x]));
    const rooms=baseRooms.map(r=>{const live=liveByRoom.get(r.id);return live?{...r,last_seen_at:live.last_seen_at||r.last_seen_at,player_status:live.player_status||r.player_status}:r;});
    const rawSpaces=Array.isArray(data.spaces)?data.spaces:[];
    const seenSpaceIds=new Set(),seenSpaceKeys=new Set(),floorSpaces=[];
    for(const sp of rawSpaces){
      if(!sp||!sp.id||seenSpaceIds.has(sp.id))continue;
      const key=[sp.site_id||'',sp.group_id||'',String(sp.name||'').trim().toLowerCase(),sp.space_type||'other',Number(sp.x_pct),Number(sp.y_pct),Number(sp.width_pct),Number(sp.height_pct)].join('|');
      if(seenSpaceKeys.has(key))continue;
      seenSpaceIds.add(sp.id);seenSpaceKeys.add(key);floorSpaces.push(sp);
    }
    state={site:data.site||null,siteSettings:{...(data.site_settings||{}),building_asset:building.data||{},floorplan_assets:data.floorplan_assets||{}},buildingAsset:building.data||{},floorplanAssets:data.floorplan_assets||{},floorSpaces,floorplanVersions:data.floorplan_versions||[],patients:data.patients||[],rooms,groups:data.groups||[],playlists:data.playlists||[],videos:data.videos||[],playlistItems:data.playlist_items||[],roomRules:data.room_video_rules||[],broadcast:data.broadcast||{active:false}};
    const actualSlug=String(state.site?.code||'').trim();
    if(actualSlug){const expected=`/hospital.html?site=${encodeURIComponent(actualSlug)}`;if(location.pathname!=='/hospital.html'||new URLSearchParams(location.search).get('site')!==actualSlug)history.replaceState(null,'',expected);}
    if(background&&isInteracting())return;
    renderPreservingUi(background);
  }
  function isInteracting(){
    if(tab==='videos'&&(mediaDirty||mediaSaving))return true;
    const a=document.activeElement,root=qs('#hospitalRoot');
    if(root?.querySelector('.floor-inline-video-panel'))return true;
    return !!(a&&root&&root.contains(a)&&['INPUT','SELECT','TEXTAREA'].includes(a.tagName));
  }
  function uiKey(el){
    const card=el.closest('[data-tv-id]')?.dataset.tvId||el.closest('[data-room-card]')?.dataset.roomCard||el.closest('[data-staff-group]')?.dataset.staffGroup||el.closest('[data-staff-map-floor]')?.dataset.staffMapFloor||'';
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
  function floorAreaKey(g){
    const care=String(g?.care_type||'').toLowerCase();
    const name=String(g?.name||'').toLowerCase();
    return care==='minish'||name.includes('미니쉬')||name.includes('minish')?'minish':'general';
  }
  // Presentation-only labels: do not alter heartbeat, presence, or control state.
  const visibleTvStatus=(status)=>({live:'송출 중',offline:'송출 미확인',delayed:'상태 확인 지연',idle:'재생 대기',manual:'수동 운영','manual-warn':'수동 운영',error:'재생 오류',update:'업데이트 필요'})[status.key]||status.label;
  // Compact per-TV indicator. The colors reflect telemetry, not proof that a physical display is on.
  function floorStatusDotKind(r){
    const key=roomDisplayStatus(r).key;
    if(key==='live')return 'live';
    if(key==='manual'||key==='manual-warn')return 'manual';
    return 'unverified';
  }
  function floorStatusDots(rooms){
    const list=[...rooms].sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0)||String(a.name||'').localeCompare(String(b.name||''),'ko'));
    if(!list.length)return '<span class="floor-dot floor-dot-empty" aria-hidden="true"></span><span class="sr-only">TV 등록 없음</span>';
    return list.map(r=>{
      const kind=floorStatusDotKind(r),status=roomDisplayStatus(r);
      const description=kind==='unverified'?`송출 확인 안 됨 · ${status.label}`:status.label;
      const label=`${r.name} · ${description}`;
      return `<span class="floor-dot floor-dot-${kind}" title="${esc(label)}" aria-label="${esc(label)}" data-floor-dot-room="${esc(r.id)}"></span>`;
    }).join('');
  }
  function staffBuildingFloor(g){
    const n=floorNumber(g),shortName=floorPurposeLabel(g);
    const rooms=g.rooms||state.rooms.filter(r=>r.group_id===g.id);
    const dots=floorStatusDots(rooms);
    const hasPlaybackIssue=rooms.some(r=>['error','update'].includes(roomDisplayStatus(r).key));
    const cls=`hospital-floor-row${selectedFloorId===g.id?' is-selected':''}${hasPlaybackIssue?' has-issue':''}`;
    return `<button type="button" class="${cls}" data-staff-select-floor="${esc(g.id)}" aria-pressed="${selectedFloorId===g.id?'true':'false'}">
      <span class="hospital-floor-number">${n}F</span>
      <span class="hospital-floor-name" title="${esc(shortName)}">${esc(shortName)}<span class="floor-ops-floor-state" data-ops-floor-status="${esc(g.id)}" role="group" aria-label="${esc(shortName)} TV별 송출 상태">${dots}</span></span>
      <span class="hospital-floor-chevron" aria-hidden="true">›</span>
    </button>`;
  }
  function floorAreaSelector(floorGroups){
    const general=floorGroups.filter(g=>floorAreaKey(g)==='general');
    const minish=floorGroups.filter(g=>floorAreaKey(g)==='minish');
    const card=(key,title,desc,groups)=>`<button type="button" class="hospital-area-card area-${key}" data-staff-select-area="${key}">
      <span class="hospital-area-card-copy"><small>진료 영역</small><b>${title}</b><em>${desc}</em></span>
      <span class="hospital-area-card-meta"><strong>${groups.length}</strong><small>개 층</small><i aria-hidden="true">→</i></span>
    </button>`;
    return `<div class="hospital-area-select">
      <div class="hospital-area-select-head"><span>콘텐츠 운영</span><h2>어느 진료 영역을 관리할까요?</h2><p>진료 성격을 먼저 선택하면 해당 층만 보여드립니다.</p></div>
      <div class="hospital-area-select-grid">
        ${card('general','일반진료층','일반 진료 · 예방 · 기초 · 공용 공간',general)}
        ${card('minish','미니쉬층','미니쉬 진료 · 상담 · 라운지',minish)}
      </div>
    </div>`;
  }
  function staffFloorMarker(r){
    if(!roomMapPlaced(r))return '';
    const st=roomDisplayStatus(r),x=Number(r.map_x_pct),y=Number(r.map_y_pct),current=currentVideoForRoom(r);
    const thumb=current?.thumbnail_data_url?`<img src="${esc(current.thumbnail_data_url)}" alt="">`:'<span class="display-screen-icon"></span>';
    const videoTitle=current?.title||r.player_status?.title||'현재 영상 없음';
    return `<button class="floor-display-pin control-${displayControlMode(r)} status-${st.key}" style="left:${x}%;top:${y}%" data-staff-floor-room="${r.id}" aria-label="${esc(r.name)} · ${esc(st.label)}" aria-expanded="false">
      <span class="floor-display-dot-only" aria-hidden="true"></span>
      <span class="floor-display-hover" role="tooltip"><span class="floor-display-hover-thumb">${thumb}</span><span><b>${esc(r.name)}</b><small>${esc(videoTitle)}</small></span></span>
    </button>`;
  }
  const groupContentTopics=(g)=>Array.isArray(g?.content_topics)?g.content_topics.map(x=>String(x||'').trim()).filter(Boolean):[];
  const groupContentTopicsMarkup=(g)=>{const items=groupContentTopics(g);return items.length?`<div class="floor-content-topics compact"><small>주요 콘텐츠</small><ul>${items.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:'';};
  function staffFloorPanelMarkup(g){
    if(!g)return `<section class="hospital-floor-detail hospital-floor-detail-empty"><div><b>층을 선택하세요.</b><p>확인할 층을 누르면 도면과 디스플레이 위치가 열립니다.</p></div></section>`;
    const rooms=g.rooms||state.rooms.filter(r=>r.group_id===g.id),sum=groupStatusSummary(rooms),asset=floorAsset(g),unplaced=rooms.filter(r=>!roomMapPlaced(r));
    const n=floorNumber(g),online=rooms.filter(staffIsOnline).length;
    return `<section class="hospital-floor-detail">
      <div class="hospital-floor-detail-head">
        <div class="hospital-floor-detail-intro"><b>${n}층 · ${esc(g.name||`${n}층`)}</b><span>${esc(g.content_intro||'도면에서 디스플레이나 공간을 누르면 운영 목적과 현재 영상을 확인할 수 있습니다.')}</span></div>
        <div class="hospital-floor-detail-actions"><div class="hospital-floor-detail-stats"><span>디스플레이 <b>${rooms.length}</b></span><span>연결 <b>${online}</b></span>${groupIssueParts(sum).map(([label,count])=>`<span class="is-alert">${esc(label)} <b>${count}</b></span>`).join('')}</div></div>
        ${(g.role_label||groupContentTopics(g).length)?`<div class="hospital-floor-detail-context">${g.role_label?`<span class="floor-role-chip">${esc(g.role_label)}</span>`:''}${groupContentTopicsMarkup(g)}</div>`:''}
      </div>
      ${asset?`<div class="building-floorplan-wrap floor-activation-shell">
        <div class="floor-plan-stage building-floor-plan-stage is-floor-activating">
          <div class="floorplan-svg-host" data-floorplan-svg="${asset}"></div>
          ${state.floorSpaces.filter(x=>x.group_id===g.id).map(x=>floorSpaceOverlay(x)).join('')}
          ${rooms.map(staffFloorMarker).join('')}
        </div>
        <div class="floor-zone-inspector building-zone-inspector" data-staff-floor-zone-inspector>
          <div class="floor-zone-inspector-empty"><div><b>디스플레이 또는 공간을 선택하세요.</b></div><p>운영 목적과 현재 영상을 확인할 수 있습니다.</p></div>
        </div>
      </div>`:`<div class="floor-plan-empty floor-plan-empty-action hospital-floor-empty"><b>등록된 도면이 없습니다.</b><p>송출 관리에서 이 층의 도면을 등록하세요.</p><button type="button" class="btn small" data-ops-layout-open>도면 등록</button></div>`}
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
  // Unified operations: one complete floor list; state always comes from player status,
  // not video URL visits or preview playback. All existing groups and content are retained.
  // Dashboard cards are navigational filters, not a claim that a screen is physically powered on.
  function tvStatusCategory(room){
    if(displayControlMode(room)==='manual')return 'manual';
    return roomDisplayStatus(room).key==='live'?'live':'unverified';
  }
  function hospitalStatusMatches(filter){return state.rooms.filter(r=>tvStatusCategory(r)===filter);}
  function hospitalStatusFilterMarkup(){
    if(!['live','unverified','manual'].includes(statusViewFilter))return '';
    const labels={live:'영상 나오는 TV',unverified:'확인이 필요한 TV',manual:'직접 관리하는 TV'};
    const rooms=hospitalStatusMatches(statusViewFilter);
    const rows=rooms.map(r=>{
      const group=state.groups.find(g=>g.id===r.group_id);
      const place=group?`${floorNumber(group)}층`:'층 미지정';
      const status=roomDisplayStatus(r);
      return `<button type="button" class="hospital-status-result" data-status-open-room="${esc(r.id)}" aria-label="${esc(place)} ${esc(r.name)} 상세보기"><span class="status-result-main"><b>${esc(r.name)}</b><small>${esc(place)} · ${esc(visibleTvStatus(status))}</small></span><span aria-hidden="true">›</span></button>`;
    }).join('');
    return `<section class="hospital-status-results" id="hospitalStatusResults" aria-label="${labels[statusViewFilter]} 목록"><div class="hospital-status-results-heading"><div><h2>${labels[statusViewFilter]}</h2><p>${rooms.length}대 · TV를 누르면 해당 층의 상세 설정으로 이동합니다.</p></div><button type="button" class="btn small" data-status-clear>닫기</button></div><div class="hospital-status-result-list">${rows||'<p class="hospital-status-none">해당하는 TV가 없습니다.</p>'}</div></section>`;
  }
  function hospitalOperationsSummary(){
    const live=hospitalStatusMatches('live').length;
    const unverified=hospitalStatusMatches('unverified').length;
    const manual=hospitalStatusMatches('manual').length;
    const cards=[
      ['live','영상 나오는 TV',live,'재생이 확인된 TV'],
      ['unverified','확인이 필요한 TV',unverified,'고장이 아닐 수도 있어요'],
      ['manual','직접 관리하는 TV',manual,'자동으로 확인할 수 없어요']
    ];
    return `<div class="hospital-ops-summary hospital-ops-summary-easy" aria-label="TV 상태별 목록">${cards.map(([key,label,num,desc])=>
      `<button type="button" class="ops-status-card ops-${key}${statusViewFilter===key?' is-active':''}" data-status-filter="${key}" aria-pressed="${statusViewFilter===key?'true':'false'}"><span class="ops-status-title"><i aria-hidden="true"></i>${label}</span><strong data-staff-stat-${key==='live'?'live':key==='unverified'?'issues':'idle'}>${num}</strong><span class="ops-status-help">${desc}</span><span class="ops-status-action">TV 목록 보기 ›</span></button>`
    ).join('')}</div><p class="hospital-ops-status-note">상태는 TV에서 보낸 정보를 기준으로 표시합니다. <b>확인이 필요</b>하다고 모두 고장 난 것은 아닙니다.</p>${hospitalStatusFilterMarkup()}`;
  }
  function floorQuickTvList(rooms){
    rooms=[...rooms].sort(layoutRoomSort);
    if(!rooms.length)return '<div class="floor-ops-empty">이 층에는 등록된 TV가 없습니다. 설정에서 TV를 추가하세요.</div>';
    return `<section class="floor-ops-tv-section"><div class="floor-ops-tv-heading"><h3>이 층의 TV</h3><small>≡ 손잡이를 드래그해 순서를 변경하세요. 모바일에서는 길게 누른 후 이동합니다.</small></div><div class="floor-ops-tv-grid" data-tv-sort-list>${rooms.map(r=>{
      const st=roomDisplayStatus(r),current=currentVideoForRoom(r),manual=displayControlMode(r)==='manual';
      // Existing roomCard is reused in-place, so video ordering and save handlers
      // are not duplicated or reimplemented. Its summary is visually hidden here.
      const controls=roomCard(r).replace('<details class="monitor-room ', '<details open class="monitor-room ');
      return `<details class="floor-ops-tv status-${st.key}" data-tv-id="${esc(r.id)}">
        <summary class="floor-ops-tv-summary"><button type="button" class="floor-tv-drag-handle" data-tv-drag-handle aria-label="${esc(r.name)} 순서 이동. 방향키 위아래로도 이동 가능" title="끌어서 TV 순서 변경" draggable="false">⠿</button><span class="floor-ops-tv-main"><b>${esc(r.name)}</b><span class="floor-ops-video" data-ops-video="${esc(r.id)}">${esc(manual?'현장 수동 운영':current?.title||r.player_status?.title||'현재 재생 영상 없음')}</span></span><span class="floor-ops-state status-${st.key}" data-ops-state="${esc(r.id)}">${esc(visibleTvStatus(st))}</span><span class="floor-ops-expand" aria-hidden="true">⌄</span></summary>
        <div class="floor-ops-tv-expanded"><p class="floor-ops-reason" data-ops-reason="${esc(r.id)}">${esc(roomIssueReason(r)||' ')}</p>
          <div class="floor-tv-manage-actions" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 14px;margin:4px 0 12px;background:var(--panel,#f7f8fb);border:1px solid var(--line,#e5e7eb);border-radius:12px;">
            <span style="flex:1;min-width:170px;font-size:12px;color:var(--muted,#64748b);">TV 관리 · ${roomMapPlaced(r)?'도면에 배치됨':'도면 미배치'} · ID ${esc(String(r.id).slice(0,8))}</span>
            <button type="button" class="btn small" data-tv-rename="${esc(r.id)}">이름 변경</button>
            ${roomMapPlaced(r)?`<button type="button" class="btn small" data-tv-unplace="${esc(r.id)}">위치 해제</button><button type="button" class="btn small danger-outline" disabled title="위치 해제 후 삭제할 수 있습니다">TV 삭제</button>`:`<button type="button" class="btn small danger-outline" data-tv-delete="${esc(r.id)}">TV 삭제</button>`}
          </div>${controls}</div>
      </details>`;
    }).join('')}</div></section>`;
  }
  // Floor TV display ordering: one pointer lifecycle owned by document, not a
  // reparented grip. Moving a captured DOM node loses capture in some browsers.
  // This changes only rooms.sort_order, never media/playlists or player control.
  let tvOrderSaving=false;
  let tvSortDispose=null;
  function floorTvIds(list){return qsa(':scope > [data-tv-id]',list).map(el=>el.dataset.tvId);}
  function restoreFloorTvOrder(list, ids){
    const map=new Map(qsa(':scope > [data-tv-id]',list).map(el=>[el.dataset.tvId,el]));
    ids.forEach(id=>{if(map.has(id))list.appendChild(map.get(id));});
  }
  async function persistFloorTvOrder(list, previousIds){
    if(tvOrderSaving)return false;
    const ids=floorTvIds(list);
    if(ids.length!==previousIds.length || new Set(ids).size!==ids.length ||
       ids.every((id,i)=>id===previousIds[i]))return false;
    tvOrderSaving=true;
    list.classList.add('is-saving-order');
    try{
      if(!targetSiteId)throw new Error('병원 정보가 없어 저장할 수 없습니다.');
      const {error}=await db.rpc('hospital_reorder_floor_displays',{p_site:targetSiteId,p_room_ids:ids});
      if(error)throw error;
      ids.forEach((id,i)=>{const room=roomById(id);if(room)room.sort_order=(i+1)*10;});
      toast('TV 표시 순서를 저장했습니다.');
      return true;
    }catch(e){
      restoreFloorTvOrder(list,previousIds);
      const msg=String(e?.message||'');
      toast('순서 저장 실패 · '+(/schema cache|Could not find the function|PGRST202/i.test(msg)?'Supabase SQL 파일을 먼저 실행하세요.':msg),'error');
      return false;
    }finally{tvOrderSaving=false;list.classList.remove('is-saving-order');}
  }
  function bindFloorTvDragSort(){
    tvSortDispose?.();tvSortDispose=null;
    const list=qs('[data-tv-sort-list]');if(!list)return;
    let active=null;
    const cards=()=>qsa(':scope > [data-tv-id]',list);
    const listeners=[];
    const on=(node,event,fn,opts)=>{node.addEventListener(event,fn,opts);listeners.push(()=>node.removeEventListener(event,fn,opts));};
    const end=()=>{
      const d=active;if(!d)return null;
      active=null;
      d.card.classList.remove('is-drag-placeholder');
      d.handle.classList.remove('is-holding');
      list.classList.remove('is-drag-active');
      d.ghost?.remove();
      document.body.classList.remove('floor-tv-is-dragging');
      return d;
    };
    const animateOtherCards=(before,skip)=>{
      cards().forEach(el=>{
        if(el===skip)return;
        const old=before.get(el);if(!old)return;
        const dy=old.top-el.getBoundingClientRect().top;
        if(Math.abs(dy)<1||!el.animate)return;
        el.getAnimations().filter(x=>x.id==='floor-tv-flip').forEach(x=>x.cancel());
        const a=el.animate([{transform:`translateY(${dy}px)`},{transform:'translateY(0)'}],
          {duration:170,easing:'cubic-bezier(.2,.8,.2,1)'});
        a.id='floor-tv-flip';
      });
    };
    const beginMove=(d,e)=>{
      const rect=d.card.getBoundingClientRect();
      const ghost=d.card.querySelector('.floor-ops-tv-summary').cloneNode(true);
      ghost.classList.add('floor-tv-drag-ghost');
      ghost.setAttribute('aria-hidden','true');
      ghost.style.left=rect.left+'px';ghost.style.top=rect.top+'px';
      ghost.style.width=rect.width+'px';ghost.style.height=rect.height+'px';
      document.body.appendChild(ghost);
      d.ghost=ghost;d.started=true;
      d.card.classList.add('is-drag-placeholder');
      list.classList.add('is-drag-active');
      document.body.classList.add('floor-tv-is-dragging');
    };
    const move=e=>{
      const d=active;
      if(!d||e.pointerId!==d.pointerId)return;
      e.preventDefault();
      if(!d.started){
        if(Math.hypot(e.clientX-d.startX,e.clientY-d.startY)<5)return;
        beginMove(d,e);
      }
      d.ghost.style.top=(e.clientY-d.offsetY)+'px';
      // Viewport edge auto-scroll for long floor lists; no forced rerender.
      const margin=65,step=e.clientY<margin?-13:e.clientY>innerHeight-margin?13:0;
      if(step)window.scrollBy(0,step);
      const others=cards().filter(el=>el!==d.card);
      const before=new Map(others.map(el=>[el,el.getBoundingClientRect()]));
      const target=others.find(el=>e.clientY<el.getBoundingClientRect().top+el.getBoundingClientRect().height/2);
      if(target){if(d.card.nextElementSibling!==target)list.insertBefore(d.card,target);}
      else if(d.card!==list.lastElementChild)list.appendChild(d.card);
      animateOtherCards(before,d.card);
    };
    const finish=e=>{
      if(!active||e.pointerId!==active.pointerId)return;
      e.preventDefault();
      const d=end();
      if(d.started)void persistFloorTvOrder(list,d.original);
    };
    const cancel=e=>{
      if(!active||e?.pointerId!==undefined&&active.pointerId!==e.pointerId)return;
      const d=end();if(d)restoreFloorTvOrder(list,d.original);
    };
    on(document,'pointermove',move,{passive:false});
    on(document,'pointerup',finish);
    on(document,'pointercancel',cancel);
    on(window,'blur',()=>cancel());
    on(document,'keydown',e=>{if(e.key==='Escape'&&active){e.preventDefault();cancel();}});
    qsa('[data-tv-drag-handle]',list).forEach(handle=>{
      on(handle,'click',e=>{e.preventDefault();e.stopPropagation();});
      on(handle,'pointerdown',e=>{
        if(tvOrderSaving||active||!e.isPrimary||e.button!==0)return;
        const card=handle.closest('[data-tv-id]');if(!card)return;
        e.preventDefault();e.stopPropagation();
        const box=card.getBoundingClientRect();
        active={card,handle,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,
          offsetY:e.clientY-box.top,original:floorTvIds(list),started:false,ghost:null};
        handle.classList.add('is-holding');
        // Do NOT setPointerCapture: this handle is reparented during sorting.
      });
      on(handle,'keydown',e=>{
        if(!['ArrowUp','ArrowDown'].includes(e.key)||tvOrderSaving||active)return;
        e.preventDefault();e.stopPropagation();
        const card=handle.closest('[data-tv-id]'),items=cards(),index=items.indexOf(card);
        const next=index+(e.key==='ArrowUp'?-1:1);
        if(index<0||next<0||next>=items.length)return;
        const original=floorTvIds(list),before=new Map(items.map(el=>[el,el.getBoundingClientRect()]));
        if(next<index)list.insertBefore(card,items[next]);else list.insertBefore(items[next],card);
        animateOtherCards(before,card);
        handle.focus({preventScroll:true});
        void persistFloorTvOrder(list,original);
      });
    });
    tvSortDispose=()=>{cancel();listeners.forEach(fn=>fn());};
  }
  function openInlineTvDetail(roomId){
    const item=qsa('[data-tv-id]').find(el=>el.dataset.tvId===roomId);
    if(!item)return false;
    item.open=true;
    const nested=qs('[data-room-card]',item);if(nested)nested.open=true;
    requestAnimationFrame(()=>item.scrollIntoView({behavior:'smooth',block:'center'}));
    return true;
  }
  function staffBuildingOverview(groups){
    const floors=groups.filter(g=>g.kind==='floor'&&Number(g.floor_number)>0).sort((a,b)=>Number(b.floor_number)-Number(a.floor_number));
    if(!floors.length)return `<section class="hospital-building-empty"><b>등록된 층이 없습니다.</b><p>층을 추가한 뒤 TV를 배치할 수 있습니다.</p>${layoutPanelOpen?`<div class="hospital-layout-setup">${structureSetupMarkup()}</div>`:'<button type="button" class="btn small" data-ops-layout-open>층 추가</button>'}</section>`;
    if(selectedFloorId&&!floors.some(g=>g.id===selectedFloorId))selectedFloorId=null;
    // Choose the first problematic floor on the first visit, otherwise the highest floor.
    if(!selectedFloorId){const firstIssue=floors.find(g=>(g.rooms||state.rooms.filter(r=>r.group_id===g.id)).some(r=>['offline','error','update','manual-warn','delayed'].includes(roomDisplayStatus(r).key)));selectedFloorId=(firstIssue||floors[0]).id;}
    const selected=floors.find(g=>g.id===selectedFloorId)||floors[0];
    return `<section class="hospital-building-dashboard hospital-unified-ops"><div class="hospital-building-console"><div class="hospital-floor-console-card">
      <div class="hospital-floor-console-title"><div><small>층 선택</small><h2>층별 TV</h2><p>층을 누르면 TV 위치와 상태를 볼 수 있어요.</p><div class="floor-status-legend" aria-label="상태 점 범례"><span><i class="live"></i>송출 중</span><span><i class="unverified"></i>미확인·오류</span><span><i class="manual"></i>수동</span><span><i class="empty"></i>TV 없음</span></div></div><button type="button" class="btn ${layoutPanelOpen?'primary':''} hospital-layout-edit-toggle" data-ops-layout-toggle aria-expanded="${layoutPanelOpen?'true':'false'}">${layoutPanelOpen?'배치 편집 종료':'TV 위치 바꾸기'}</button></div>
      <div class="hospital-floor-console-grid"><div class="hospital-floor-list" role="group" aria-label="층 선택">${floors.map(staffBuildingFloor).join('')}</div>
      <div class="hospital-floor-ops-content">${staffFloorPanelMarkup(selected)}${floorQuickTvList(selected.rooms||state.rooms.filter(r=>r.group_id===selected.id))}</div></div>
    </div>${layoutPanelOpen?operationsLayoutEditorMarkup():''}</div></section>`;
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
  function floorSpaceOverlay(x,editable=false){const st=floorSpaceBroadcastStatus(x);return `<button type="button" class="floor-space-overlay ${editable?'is-editable':`status-${st.key}`}" data-floor-space="${x.id}" title="${esc(x.name)} · ${esc(st.label)}" aria-label="${esc(x.name)} · ${esc(st.label)}" style="left:${Number(x.x_pct)}%;top:${Number(x.y_pct)}%;width:${Number(x.width_pct)}%;height:${Number(x.height_pct)}%"><span>${esc(x.name)}</span></button>`;}
  function displayMarker(r,editable=false){if(!roomMapPlaced(r))return '';const mode=displayControlMode(r),space=roomSpace(r),label=`${r.name} · ${space?space.name+' · ':''}${displayControlLabel(r)}`;return `<button type="button" class="display-map-marker control-${mode} ${editable?'is-editable':''}" data-display-marker="${r.id}" style="left:${Number(r.map_x_pct)}%;top:${Number(r.map_y_pct)}%" title="${esc(label)}" aria-label="${esc(label)}"><i></i></button>`;}
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
    /* The API signs on an hourly bucket, so the URL stays identical for up to an hour and the
       browser reuses the downloaded floor plan instead of fetching a new signed URL every 4 min. */
    const signedUntil=Date.parse(data.expiresAt||'');
    floorplanUrlCache.set(cacheKey,{url:data.url,expiresAt:Number.isFinite(signedUntil)?signedUntil-5*60*1000:Date.now()+240000});
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
  async function deleteSupersededFloorplans(siteId,floor,keepKey){
    const {data,error}=await db.from('floorplan_versions').select('*').eq('site_id',siteId).eq('floor_number',floor).order('created_at',{ascending:false});
    if(error)throw error;
    const old=(data||[]).filter(v=>String(v.object_key||'').trim()&&String(v.object_key).trim()!==String(keepKey||'').trim());
    for(const v of old){await apiJson('/api/floorplan-delete',{method:'POST',body:JSON.stringify({siteId,floor,key:v.object_key})});}
    if(old.length){const ids=old.map(v=>v.id);const {error:deleteError}=await db.from('floorplan_versions').delete().in('id',ids);if(deleteError)throw deleteError;}
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
  function buildingImageSettingsMarkup(){const a=state.buildingAsset||{};return `<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>건물 이미지</b><small>병원별로 보관하는 건물 이미지입니다. 현재 송출 현황 화면에는 표시되지 않습니다.</small></div></div><div class="building-image-settings">${a.key?`<div class="building-image-settings-preview" data-building-image><span>이미지 불러오는 중</span></div>`:`<div class="building-image-settings-empty">등록된 건물 이미지가 없습니다.</div>`}<div class="building-image-settings-actions"><label class="btn small"><input type="file" accept="image/png,image/jpeg,image/webp" data-staff-building-upload><span>${a.key?'교체':'업로드'}</span></label>${a.key?'<button type="button" class="btn small" data-staff-building-remove>삭제</button>':''}</div></div></div>`;}
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
      const {error:insertVersionError}=await db.from('floorplan_versions').insert({site_id:state.site.id,floor_number:floor,object_key:signed.key,filename:uploadFile.name,mime,size_bytes:uploadFile.size,active:true});if(insertVersionError)throw insertVersionError;
      await saveFloorplanAssets(next);
      await deleteSupersededFloorplans(state.site.id,floor,signed.key);
      const saved=Math.max(0,optimized.originalSize-uploadFile.size),rate=optimized.originalSize?Math.round(saved/optimized.originalSize*100):0;
      toast(optimized.optimized?`${floor}층 도면을 최적화해 저장했습니다. · ${rate}% 절감`:`${floor}층 도면을 저장했습니다.`);await load();
    }catch(e){toast(e.message||String(e),'error');}
  }
  async function resetFloorplan(floor){
    const old=floorplanMeta(floor);if(!old)return;
    if(!confirm(`${floor}층 도면을 완전히 삭제할까요?\n현재 도면과 이전 버전 파일까지 모두 삭제되며 복원할 수 없습니다.`))return;
    try{
      const versions=floorplanVersionsFor(floor),keys=[...new Set([floorplanMetaKey(old),...versions.map(v=>String(v.object_key||'').trim())].filter(Boolean))];
      for(const key of keys){await apiJson('/api/floorplan-delete',{method:'POST',body:JSON.stringify({siteId:state.site.id,floor,key})});}
      const {error:versionDeleteError}=await db.from('floorplan_versions').delete().eq('site_id',state.site.id).eq('floor_number',floor);if(versionDeleteError)throw versionDeleteError;
      const next={...state.floorplanAssets};delete next[String(floor)];await saveFloorplanAssets(next);
      toast(`${floor}층 도면을 완전히 삭제했습니다.`);await load();
    }catch(e){toast(`도면 삭제에 실패했습니다. ${e.message||String(e)}`,'error');}
  }
  function floorplanAdminMarkup(){const floors=[...new Set(state.groups.filter(g=>Number.isFinite(Number(g.floor_number))).map(g=>Number(g.floor_number)))].sort((a,b)=>b-a);return `<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>층별 도면</b><small>등록된 층을 기준으로 표시합니다. 업로드 시 화면용 크기로 자동 최적화합니다.</small></div></div><div class="floorplan-admin-list">${floors.length?floors.map(f=>{const m=floorplanMeta(f);return `<article class="floorplan-admin-row"><div class="floorplan-admin-copy"><b>${f>0?`${f}F`:f===0?'G':`B${Math.abs(f)}`}</b><span>${m?'업로드 도면':'도면 없음'}</span><small>${m?esc(m.filename||'사용자 도면'):'PNG, JPG, WebP · 업로드 시 자동 압축'}</small></div><div class="floorplan-admin-actions"><label class="btn small floorplan-upload-btn"><input type="file" accept="image/png,image/jpeg,image/webp" data-staff-floorplan-upload="${f}"><span>${m?'교체':'업로드'}</span></label>${m?`<button class="btn small" type="button" data-staff-floorplan-reset="${f}">완전 삭제</button>`:''}</div></article>`;}).join(''):'<p class="muted">먼저 층을 추가하세요.</p>'}</div></div>`;}
  function floorAssetFingerprint(group){
    const meta=floorplanMeta(floorNumber(group));if(!meta)return '';
    const w=Number(meta.source_width||meta.width||0),h=Number(meta.source_height||meta.height||0);
    return w>0&&h>0?`${w}x${h}`:'';
  }
  function floorLayoutCopyMarkup(current,floors){
    const sourceRooms=state.rooms.filter(r=>r.group_id===current.id);
    const sourceFingerprint=floorAssetFingerprint(current);
    const targets=floors.filter(g=>g.id!==current.id);
    if(!targets.length)return `<div class="floor-layout-copy-panel"><span class="muted">적용할 다른 층이 없습니다.</span></div>`;
    return `<div class="floor-layout-copy-panel">
      <div class="floor-layout-copy-head"><div><b>${esc(floorSettingsLabel(current))} 배치 복사</b><small>같은 구조의 도면을 사용하는 층만 선택하세요. 공간과 디스플레이 위치만 복사합니다. 디스플레이는 층 표기를 제외한 위치 코드로 매칭합니다. (예: 10F_01 ↔ 9층 01)</small></div><button type="button" class="text-action" id="staffLayoutCopyClose">닫기</button></div>
      <div class="floor-layout-copy-targets">${targets.map(g=>{const targetRooms=state.rooms.filter(r=>r.group_id===g.id),fp=floorAssetFingerprint(g),sameSize=!!sourceFingerprint&&fp===sourceFingerprint,countOk=targetRooms.length===sourceRooms.length;return `<label class="floor-layout-copy-target"><input type="checkbox" value="${g.id}" data-layout-copy-target><span><b>${esc(floorSettingsLabel(g))}</b><small>${targetRooms.length}개 디스플레이${sameSize?' · 도면 크기 일치':''} · 이름 기준 매칭</small></span></label>`;}).join('')}</div>
      <div class="floor-layout-copy-options"><label><input type="checkbox" id="staffCopySpaces" checked> 공간</label><label><input type="checkbox" id="staffCopyDisplays" checked> 디스플레이 위치</label></div>
      <div class="floor-layout-copy-actions"><span>공간과 디스플레이 위치를 함께 적용할 수 있습니다. 예: 10F_01 → 9F_01. 같은 위치 코드가 없을 때만 자동 생성합니다.</span><button type="button" class="btn" id="staffApplyLayoutCopy">선택한 층에 적용</button></div>
    </div>`;
  }
  const layoutRoomSort=(a,b)=>(Number(a.sort_order||0)-Number(b.sort_order||0))||String(a.name||'').localeCompare(String(b.name||''),'ko',{numeric:true});
  async function applyFloorLayoutCopy(sourceGroupId,targetGroupIds,{copySpaces=true,copyDisplays=true}={}){
    const {data,error}=await db.rpc('hospital_copy_floor_layout',{p_site:state.site.id,p_source_group:sourceGroupId,p_target_groups:targetGroupIds,p_copy_spaces:copySpaces,p_copy_displays:copyDisplays});
    if(error)throw error;
    const applied=Array.isArray(data?.applied)?data.applied:[],skipped=Array.isArray(data?.skipped)?data.skipped:[];
    return {applied,skipped};
  }

  function roomSpace(room){return room?.floor_space_id?state.floorSpaces.find(x=>x.id===room.floor_space_id)||null:null;}
  function spaceContainingPoint(groupId,x,y){
    if(x===null||x===undefined||y===null||y===undefined)return null;
    const px=Number(x),py=Number(y);
    return state.floorSpaces.filter(sp=>sp.group_id===groupId&&px>=Number(sp.x_pct)&&px<=Number(sp.x_pct)+Number(sp.width_pct)&&py>=Number(sp.y_pct)&&py<=Number(sp.y_pct)+Number(sp.height_pct)).sort((a,b)=>(Number(a.width_pct)*Number(a.height_pct))-(Number(b.width_pct)*Number(b.height_pct)))[0]||null;
  }
  function displaySpaceOptions(spaces,room){return `<option value="">자동 · 점 위치 기준</option>${spaces.map(sp=>`<option value="${sp.id}" ${room?.floor_space_id===sp.id?'selected':''}>${esc(sp.name)}</option>`).join('')}`;}
  function floorSettingsLabel(group){const floor=Number(group?.floor_number);const floorLabel=Number.isFinite(floor)&&floor>0?`${floor}F`:'';const name=String(group?.name||'').trim();return floorLabel&&name?`${floorLabel} · ${name}`:(floorLabel||name||'층');}
  function floorNumberForGroupId(groupId){const g=state.groups.find(x=>x.id===groupId);const n=Number(g?.floor_number);return Number.isFinite(n)&&n>0?n:null;}
  function floorNumberFromLabel(value){const text=String(value||'').trim();if(!text)return null;let m=text.match(/(?:^|[^0-9])(\d{1,2})\s*F(?:[_\s.-]|$)/i);if(!m)m=text.match(/(?:^|[^0-9])(\d{1,2})\s*층(?:[_\s.-]|$)/);const n=m?Number(m[1]):null;return Number.isFinite(n)&&n>0?n:null;}
  function physicalFloorForRoom(room){const linkedSpace=roomSpace(room),spaceFloor=floorNumberForGroupId(linkedSpace?.group_id);return spaceFloor||floorNumberForGroupId(room?.group_id)||floorNumberFromLabel(room?.group_name)||floorNumberFromLabel(room?.name)||null;}
  function displayLogicalKey(room,floor){
    const name=String(room?.name||'').trim().replace(/\s+/g,' ').toLocaleLowerCase('ko-KR');
    return `${Number(floor)||physicalFloorForRoom(room)||0}|${name||room?.id||''}`;
  }
  function displayCandidateScore(room,group){
    let score=0;
    if(room?.group_id===group?.id)score+=8;
    if(roomSpace(room)?.group_id===group?.id)score+=6;
    if(room?.floor_space_id)score+=4;
    if(roomMapPlaced(room))score+=4;
    if(room?.last_seen_at)score+=1;
    return score;
  }
  function dedupeFloorRooms(list,group){
    const floor=Number(group?.floor_number)||0,map=new Map();
    for(const room of list){
      const key=displayLogicalKey(room,floor),prev=map.get(key);
      if(!prev||displayCandidateScore(room,group)>displayCandidateScore(prev,group))map.set(key,room);
    }
    return [...map.values()].sort(layoutRoomSort);
  }
  function roomsForFloorGroup(group){
    const floor=Number(group?.floor_number);
    if(!Number.isFinite(floor)||floor<=0)return dedupeFloorRooms(state.rooms.filter(r=>r.group_id===group?.id||roomSpace(r)?.group_id===group?.id),group);
    const validGroupIds=new Set(state.groups.filter(g=>Number(g.floor_number)===floor).map(g=>g.id));
    validGroupIds.add(group.id);
    return dedupeFloorRooms(state.rooms.filter(r=>validGroupIds.has(r.group_id)||validGroupIds.has(roomSpace(r)?.group_id)||physicalFloorForRoom(r)===floor),group);
  }
  function canonicalFloorGroupIdForRoom(room){const linkedSpace=roomSpace(room);if(linkedSpace?.group_id)return linkedSpace.group_id;const floor=physicalFloorForRoom(room);if(!floor)return room?.group_id||null;return state.groups.find(g=>g.kind==='floor'&&Number(g.floor_number)===floor)?.id||room?.group_id||null;}

  function floorMetaEditorMarkup(g){
    if(!g)return '';
    const topics=groupContentTopics(g).join('\n');
    const playlists=state.playlists.filter(p=>p.active).map(p=>`<option value="${p.id}" ${g.default_playlist_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('');
    return `<details class="floor-meta-editor" open>
      <summary><span><b>${esc(floorSettingsLabel(g))} 층 정보</b><small>이름·역할·설명·콘텐츠를 여기서 한 번에 수정합니다.</small></span><em>수정</em></summary>
      <div class="floor-meta-editor-body">
        <div class="floor-meta-grid">
          <label class="field"><span>층 이름</span><input data-floor-meta-name="${g.id}" maxlength="60" value="${esc(g.name||'')}"></label>
          <label class="field"><span>운영 성격</span><select data-floor-meta-care="${g.id}">${[['general','일반진료'],['minish','MINISH'],['common','공용'],['support','지원'],['other','기타']].map(([v,l])=>`<option value="${v}" ${g.care_type===v?'selected':''}>${l}</option>`).join('')}</select></label>
          <label class="field"><span>역할</span><input data-floor-meta-role="${g.id}" maxlength="60" value="${esc(g.role_label||'')}" placeholder="예: 전문성"></label>
          <label class="field"><span>주요 대상</span><input data-floor-meta-audience="${g.id}" maxlength="120" value="${esc(g.target_audience||'')}" placeholder="예: 진료 고객"></label>
          <label class="field floor-meta-wide"><span>층 설명</span><textarea data-floor-meta-intro="${g.id}" rows="2" placeholder="이 층의 목적을 짧게 입력">${esc(g.content_intro||'')}</textarea></label>
          <label class="field floor-meta-wide"><span>주요 콘텐츠 · 한 줄에 하나</span><textarea data-floor-meta-topics="${g.id}" rows="4" placeholder="치료 안내&#10;전후 사례">${esc(topics)}</textarea></label>
          <label class="field floor-meta-wide"><span>송출 목적</span><input data-floor-meta-purpose="${g.id}" maxlength="160" value="${esc(g.signage_purpose||'')}"></label>
          <label class="field floor-meta-wide"><span>송출 이유</span><textarea data-floor-meta-reason="${g.id}" rows="2">${esc(g.signage_reason||'')}</textarea></label>
          <label class="field floor-meta-wide"><span>대기공간 메모</span><input data-floor-meta-waiting="${g.id}" maxlength="160" value="${esc(g.waiting_area_note||'')}"></label>
          <label class="field floor-meta-wide"><span>층 기본 플레이리스트</span><select data-floor-meta-playlist="${g.id}"><option value="">공간별 기본값 사용</option>${playlists}</select></label>
        </div>
        <div class="floor-meta-actions"><span>층 번호 ${Number(g.floor_number)||'-'}F는 물리 층 식별값으로 유지됩니다.</span><button type="button" class="btn primary" data-save-floor-meta="${g.id}">층 정보 저장</button></div>
      </div>
    </details>`;
  }
  async function saveHospitalFloorMeta(id){
    const g=state.groups.find(x=>x.id===id);if(!g)return;
    const val=(sel)=>(qs(sel)?.value||'').trim();
    const name=val(`[data-floor-meta-name="${id}"]`);if(!name)return toast('층 이름을 입력하세요.','error');
    const topics=val(`[data-floor-meta-topics="${id}"]`).split(/\n+/).map(x=>x.trim()).filter(Boolean);
    const payload={p_site:targetSiteId,p_group:id,p_name:name,p_care:val(`[data-floor-meta-care="${id}"]`)||'other',p_intro:val(`[data-floor-meta-intro="${id}"]`)||null,p_topics:topics,p_role:val(`[data-floor-meta-role="${id}"]`)||null,p_purpose:val(`[data-floor-meta-purpose="${id}"]`)||null,p_audience:val(`[data-floor-meta-audience="${id}"]`)||null,p_waiting:val(`[data-floor-meta-waiting="${id}"]`)||null,p_reason:val(`[data-floor-meta-reason="${id}"]`)||null,p_playlist:val(`[data-floor-meta-playlist="${id}"]`)||null};
    const {error}=await db.rpc('hospital_update_floor_meta',payload);if(error)return toast(error.message,'error');
    toast(`${Number(g.floor_number)||''}층 정보를 저장했습니다.`);await load();
  }
  function floorLayoutEditorMarkup(){
    const floors=[...state.groups].filter(g=>g.kind==='floor'&&Number(g.floor_number)>0).sort((a,b)=>Number(b.floor_number)-Number(a.floor_number));if(!floors.length)return '';
    const current=floors.find(g=>g.id===spaceEditorGroupId)||floors[0];spaceEditorGroupId=current.id;
    const rooms=roomsForFloorGroup(current),spaces=state.floorSpaces.filter(x=>x.group_id===current.id),asset=floorAsset(current);
    const editing=spaces.find(x=>x.id===spaceRedrawId)||null;if(spaceRedrawId&&!editing)spaceRedrawId=null;
    const unplaced=rooms.filter(r=>!roomMapPlaced(r));
    const pending=unplaced.find(r=>r.id===layoutPlacementRoomId)||null;if(layoutPlacementRoomId&&!pending)layoutPlacementRoomId=null;
    const placed=rooms.filter(roomMapPlaced);
    const spaceName=id=>spaces.find(x=>x.id===id)?.name||'공간 자동 연결';
    return `<div class="hospital-admin-block floor-layout-editor">
      <div class="hospital-admin-block-head"><div><b>도면 배치</b><small>영역은 드래그하고, 디스플레이는 이름을 누른 뒤 도면에 찍으면 끝입니다.</small></div></div>
      <div class="floor-layout-topbar">
        <label><span>층</span><select id="staffSpaceFloor">${floors.map(g=>`<option value="${g.id}" ${g.id===current.id?'selected':''}>${esc(floorSettingsLabel(g))}</option>`).join('')}</select></label>
        <div class="floor-layout-quick-actions">
          <button type="button" class="btn ${layoutEditMode==='space'?'primary':''}" id="staffAddSpace">+ 공간 추가</button>
          <button type="button" class="btn small floor-layout-copy-toggle" id="staffLayoutCopyToggle">같은 도면 층에 적용</button>
        </div>
      </div>
      ${layoutCopyOpen?floorLayoutCopyMarkup(current,floors):''}
      ${floorMetaEditorMarkup(current)}
      ${layoutEditMode==='space'?`<div class="floor-layout-space-create">
        <label><span>공간명</span><input id="staffSpaceName" maxlength="40" placeholder="예: 진료실 1" value="${editing?esc(editing.name):''}"></label>
        <label><span>유형</span><select id="staffSpaceType">${FLOOR_SPACE_TYPES.map(([v,l])=>`<option value="${v}" ${editing?.space_type===v?'selected':''}>${l}</option>`).join('')}</select></label>
        <div class="floor-layout-space-instruction"><b>${editing?'새 영역을 드래그하세요':'이름을 입력한 뒤 도면에서 영역을 드래그하세요'}</b><span>그리기가 끝나면 자동 저장됩니다.</span></div>
        <button class="btn small" id="staffCancelSpaceRedraw" type="button">취소</button>
      </div>`:`<div class="floor-layout-display-pick">
        <div class="floor-layout-display-pick-head"><span><b>미배치 디스플레이</b><small>${unplaced.length?`${unplaced.length}개 · 이름을 누른 뒤 도면을 클릭하세요.`:'모든 디스플레이가 배치되었습니다.'}</small></span>${pending?`<em>${esc(pending.name)} 위치를 찍어주세요</em>`:''}</div>
        <div class="floor-layout-display-chips">${unplaced.map(r=>`<div class="floor-layout-display-manage ${pending?.id===r.id?'is-active':''}"><button type="button" class="floor-layout-display-chip" data-place-display="${r.id}">${esc(r.name)}</button><div class="floor-layout-display-manage-actions"><button type="button" class="text-action" data-rename-display="${r.id}">이름 수정</button><button type="button" class="text-action danger-text" data-delete-display="${r.id}">삭제</button></div></div>`).join('')||'<span class="muted">미배치 디스플레이 없음</span>'}</div>
      </div>`}
      ${asset?`<div class="settings-map-stage floor-layout-stage ${layoutEditMode==='space'?'mode-space':'mode-display'} ${editing?'is-redrawing':''} ${pending?'is-awaiting-placement':''}" data-staff-map-stage="${current.id}" data-staff-space-stage="${current.id}"><div class="floorplan-svg-host" data-floorplan-svg="${asset}"></div>${spaces.map(x=>floorSpaceOverlay(x,true)).join('')}${rooms.map(r=>displayMarker(r,true)).join('')}</div>`:'<div class="floor-plan-empty">도면을 먼저 업로드하세요.</div>'}
      <div class="floor-layout-summary">
        <div><b>공간 ${spaces.length}</b><span>${spaces.length?'지정됨':'아직 없음'}</span></div>
        <div><b>디스플레이 ${placed.length}/${rooms.length}</b><span>${unplaced.length?`미배치 ${unplaced.length}`:'배치 완료'}</span></div>
      </div>
      ${placed.length?`<div class="floor-layout-placed"><div class="floor-layout-placed-head"><b>배치된 디스플레이</b><small>도면의 점을 끌어서 바로 이동할 수 있습니다.</small></div>${placed.map(r=>`<div class="floor-layout-placed-row"><span><b>${esc(r.name)}</b><small>${esc(spaceName(r.floor_space_id))}</small></span><label class="display-purpose-field"><span>운영 목적</span><input maxlength="120" data-display-purpose="${r.id}" value="${esc(r.display_note||'')}" placeholder="예: 상담 대기 고객에게 브랜드·사례 영상 노출"><button type="button" class="text-action" data-save-display-purpose="${r.id}">저장</button></label><button type="button" class="text-action danger-text" data-unplace-display="${r.id}">위치 해제</button></div>`).join('')}</div>`:''}
      <div class="floor-space-list-head"><div><b>공간 목록</b><small>도면에서 선택할 공간 이름과 유형을 관리합니다.</small></div></div>
      <div class="floor-space-list">${state.floorSpaces.filter(x=>x.group_id===current.id).sort((a,b)=>(Number(a.sort_order||0)-Number(b.sort_order||0))||(Number(a.x_pct||0)-Number(b.x_pct||0))).map(x=>{const linked=rooms.filter(r=>r.floor_space_id===x.id);return `<div class="floor-space-manage-row ${x.id===spaceRedrawId?'is-editing':''}"><div class="floor-space-manage-head"><span><b>${esc(x.name)}</b><small>${esc(FLOOR_SPACE_TYPES.find(([v])=>v===x.space_type)?.[1]||'기타')} · 디스플레이 ${linked.length}개${linked.length?` · ${linked.map(r=>esc(r.name)).join(', ')}`:''}</small></span><div class="floor-space-list-actions"><button class="text-action" type="button" data-staff-redraw-space="${x.id}">다시 그리기</button><button class="text-action danger-text" type="button" data-staff-delete-space="${x.id}">삭제</button></div></div><div class="floor-space-content-fields"><label><span>환자 상황</span><input maxlength="160" data-space-patient-context="${x.id}" value="${esc(x.patient_context_note||'')}" placeholder="예: 접수 직후, 문진과 이동 안내가 필요한 고객"></label><label><span>콘텐츠 이유</span><input maxlength="240" data-space-content-reason="${x.id}" value="${esc(x.content_reason||'')}" placeholder="예: 첫 방문 고객이 다음 행동을 바로 이해하도록 안내"></label><button type="button" class="text-action" data-save-space-content="${x.id}">문구 저장</button></div></div>`;}).join('')||'<span class="muted">지정한 공간이 없습니다.</span>'}</div>
    </div>`;
  }
  function operationsLayoutEditorMarkup(){
    const selected=state.groups.find(g=>g.id===selectedFloorId);
    if(selected&&selected.id!==spaceEditorGroupId)spaceEditorGroupId=selected.id;
    const floor=selected?floorNumber(selected):0;
    const meta=floor?floorplanMeta(floor):null;
    return `<section class="hospital-layout-workspace" id="hospitalLayoutWorkspace" aria-label="도면 공간 TV 배치 편집">
      <div class="hospital-layout-workspace-head"><div><small>배치 편집 모드</small><h3>${floor?`${floor}층 도면 · 공간 · TV 배치`:'도면 · 공간 · TV 배치'}</h3><p>송출 상태는 그대로 유지됩니다. 공간 그리기와 TV 위치 변경은 저장 즉시 적용되니 필요한 경우에만 편집하세요.</p></div><button type="button" class="btn small" data-ops-layout-toggle>편집 종료</button></div>
      ${floor?`<div class="hospital-layout-floorplan-actions"><div><b>이 층의 도면</b><small>${meta?esc(meta.filename||'도면 등록됨'):'등록된 도면 없음'}</small></div><label class="btn small"><input type="file" accept="image/png,image/jpeg,image/webp" data-staff-floorplan-upload="${floor}"><span>${meta?'도면 교체':'도면 업로드'}</span></label>${meta?`<button type="button" class="btn small" data-staff-floorplan-reset="${floor}">도면 삭제</button>`:''}</div>`:''}
      ${floorLayoutEditorMarkup()}
      <details class="hospital-layout-add-tools"><summary>층 추가 · TV 등록</summary>${structureSetupMarkup()}</details>
    </section>`;
  }
  function hospitalSetupProgress(){const custom=Object.values(state.floorplanAssets||{}).filter(x=>x?.key).length,spaces=state.floorSpaces.length,total=state.rooms.length,placed=state.rooms.filter(roomMapPlaced).length;const steps=[['병원 정보',!!state.site?.name&&!!state.site?.building_label],['도면',custom>0],['공간',spaces>0],['디스플레이',total>0&&placed===total]];const done=steps.filter(x=>x[1]).length;return `<div class="hospital-setup-progress"><div><b>초기 설치</b><span>${done}/${steps.length} 완료</span></div><div>${steps.map(([l,ok],i)=>`<span class="${ok?'is-done':''}"><i>${ok?'✓':i+1}</i>${l}</span>`).join('')}</div></div>`;}
  function structureSetupMarkup(){const floors=[...state.groups].filter(g=>Number(g.floor_number)>0).sort((a,b)=>Number(b.floor_number)-Number(a.floor_number));return `<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>층 · 디스플레이 만들기</b><small>처음 설치할 때 필요한 기본 구조만 추가합니다.</small></div></div><div class="grid-2"><div class="settings-card"><h3>층 추가</h3><label class="field"><span>층 번호</span><input id="staffNewFloorNumber" type="number" min="1" max="99" placeholder="예: 8"></label><label class="field"><span>표시 이름</span><input id="staffNewFloorName" maxlength="30" placeholder="비우면 8F"></label><button id="staffCreateFloor" class="btn" type="button">층 추가</button></div><div class="settings-card"><h3>디스플레이 추가</h3><label class="field"><span>층</span><select id="staffNewDisplayGroup"><option value="">층 선택</option>${floors.map(g=>`<option value="${g.id}">${esc(floorSettingsLabel(g))}</option>`).join('')}</select></label><label class="field"><span>이름</span><input id="staffNewDisplayName" maxlength="40" placeholder="예: 진료실 1"></label><label class="field"><span>운영 방식</span><select id="staffNewDisplayMode">${CONTROL_MODES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><button id="staffCreateDisplay" class="btn" type="button">디스플레이 추가</button></div><div class="settings-card" style="grid-column:1/-1"><h3>등록된 층 관리</h3><p class="muted">TV, 공간 또는 방송 설정이 연결된 층은 삭제할 수 없습니다. 다른 층의 데이터는 변경하지 않습니다.</p><div class="floor-delete-list">${floors.map(g=>{const tvCount=state.rooms.filter(r=>r.group_id===g.id).length,spaceCount=state.floorSpaces.filter(sp=>sp.group_id===g.id).length;return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--line,#ddd)"><div><b>${esc(floorSettingsLabel(g))}</b> <small class="muted">${g.kind!=='floor'?' · 이전 층 그룹':''} · TV ${tvCount}대 · 공간 ${spaceCount}개</small></div><button type="button" class="btn small" data-staff-delete-floor="${g.id}" ${tvCount||spaceCount?'disabled title="TV나 공간이 있는 층은 삭제할 수 없습니다"':''}>층 삭제</button></div>`;}).join('')||'<p class="muted">등록된 층 없음</p>'}</div></div></div></div></div>`;}
  async function createHospitalFloor(){const n=Number(qs('#staffNewFloorNumber')?.value),name=(qs('#staffNewFloorName')?.value||'').trim();if(!Number.isInteger(n)||n<1||n>99)return toast('층 번호는 1~99 사이로 입력하세요.','error');const {error}=await db.rpc('hospital_create_floor',{p_site:targetSiteId,p_floor:n,p_name:name||null});if(error)return toast(error.message,'error');toast(`${n}층을 추가했습니다.`);await load();}
  async function deleteHospitalFloor(groupId){
    const floor=state.groups.find(g=>g.id===groupId&&Number(g.floor_number)>0);
    if(!floor)return toast('층 정보를 다시 불러오세요.','error');
    const connectedTVs=state.rooms.filter(r=>r.group_id===groupId).length;
    const connectedSpaces=state.floorSpaces.filter(sp=>sp.group_id===groupId).length;
    if(connectedTVs||connectedSpaces)return toast('TV 또는 공간이 연결되어 있습니다. 다른 층으로 옮긴 뒤 삭제하세요.','error');
    const label=floorSettingsLabel(floor);
    if(!confirm(`${label}을(를) 삭제하시겠습니까?\nTV · 공간 · 방송 설정이 연결된 층은 서버에서 삭제를 차단합니다.\n이 작업은 되돌릴 수 없습니다.`))return;
    const button=qs(`[data-staff-delete-floor="${groupId}"]`);
    if(button)button.disabled=true;
    try{
      const {error}=await db.rpc('hospital_delete_floor',{p_site:targetSiteId,p_group:groupId});
      if(error)throw error;
      if(selectedFloorId===groupId)selectedFloorId=null;
      if(spaceEditorGroupId===groupId)spaceEditorGroupId=null;
      toast(`${label}을(를) 삭제했습니다.`);
      await load();
    }catch(error){toast(error.message||'층을 삭제하지 못했습니다.','error');if(button)button.disabled=false;}
  }
  async function createHospitalDisplay(){const group=qs('#staffNewDisplayGroup')?.value,name=(qs('#staffNewDisplayName')?.value||'').trim(),mode=qs('#staffNewDisplayMode')?.value||'remote';if(!group||!name)return toast('층과 디스플레이 이름을 입력하세요.','error');const {error}=await db.rpc('hospital_create_display',{p_site:targetSiteId,p_group:group,p_name:name,p_mode:mode});if(error)return toast(error.message,'error');toast('디스플레이를 추가했습니다.');await load();startRealtime();}
  function displayManageErrorMessage(error){
    const msg=String(error?.message||error||'').toLowerCase();
    if(msg.includes('display name required'))return '디스플레이 이름을 입력하세요.';
    if(msg.includes('same display name already exists on this floor'))return '같은 층에 동일한 디스플레이 이름이 이미 있습니다.';
    if(msg.includes('unplace display before deleting'))return '배치된 디스플레이는 위치를 먼저 해제하세요.';
    if(msg.includes('assigned patient exists')||msg.includes('active patient'))return '현재 환자가 배정된 디스플레이는 삭제할 수 없습니다. 환자 배정을 먼저 해제하세요.';
    if(msg.includes('display not found'))return '디스플레이를 찾을 수 없습니다.';
    if(msg.includes('not allowed'))return '이 병원의 디스플레이를 수정할 권한이 없습니다.';
    return error?.message||String(error);
  }
  async function renameHospitalDisplay(roomId){
    const room=roomById(roomId);if(!room)return;
    const name=window.prompt('디스플레이 이름을 입력하세요.',room.name||'');if(name===null)return;
    const next=name.trim();if(!next)return toast('디스플레이 이름을 입력하세요.','error');
    if(next===room.name)return;
    const {error}=await db.rpc('hospital_rename_display',{p_site:targetSiteId,p_room:roomId,p_name:next});if(error)return toast(displayManageErrorMessage(error),'error');
    toast('디스플레이 이름을 수정했습니다.');await load();
  }
  async function deleteHospitalDisplay(roomId){
    const room=roomById(roomId);if(!room)return;
    if(roomMapPlaced(room))return toast('배치된 디스플레이는 위치를 먼저 해제하세요.','error');
    if(!window.confirm(`'${room.name}' 디스플레이를 삭제할까요?\n\n삭제하면 이 디스플레이의 화면 링크가 더 이상 동작하지 않으며, 누적 송출 통계와 재생 로그도 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.`))return;
    const {error}=await db.rpc('hospital_delete_display',{p_site:targetSiteId,p_room:roomId});if(error)return toast(displayManageErrorMessage(error),'error');
    if(layoutPlacementRoomId===roomId)layoutPlacementRoomId=null;
    toast('디스플레이를 삭제했습니다.');await load();
  }
  // One-page media workspace. The ordered draft is independent of the server's playlist_items.
  // Never persist an incomplete drag/selection; publish only a complete ordered list.
  let mediaPlaylistId='',mediaDraft=[],mediaDirty=false,mediaSaving=false,mediaFilter='',mediaSaveTimer=null,mediaTargetFloor='',mediaTargetRoom='';
  function scheduleMediaSave(){clearTimeout(mediaSaveTimer);if(!mediaPlaylistId||!mediaDraft.length||mediaPlaylistSharingCount(mediaPlaylistId)>1)return;mediaSaveTimer=setTimeout(()=>{if(mediaDirty&&!mediaSaving&&tab==='videos')void saveHospitalPlaylist();},1100);}
  function mediaPlaylistSharingCount(id){if(!id)return 0;return state.rooms.filter(r=>String(r.default_playlist_id||state.groups.find(g=>g.id===r.group_id)?.default_playlist_id||'')===String(id)).length;}
  function mediaTargetInfo(){return state.rooms.find(r=>String(r.id)===mediaTargetRoom)||null;}
  function mediaSelectTarget(roomId){
    if(mediaDirty&&!confirm('저장되지 않은 영상 편성을 버리고 TV를 전환할까요?'))return false;
    clearTimeout(mediaSaveTimer);mediaTargetRoom=String(roomId||'');
    const room=mediaTargetInfo(),id=room?(room.default_playlist_id||state.groups.find(g=>g.id===room.group_id)?.default_playlist_id||''):'';
    mediaPlaylistId=String(id||'');mediaDraft=mediaPlaylistId?mediaPlaylistItems(mediaPlaylistId):[];mediaDirty=false;return true;
  }
  function mediaVideos(){return state.videos.filter(v=>v.active&&(v.site_id===null||v.site_id===undefined||String(v.site_id)===String(targetSiteId)));}
  function mediaPlaylistItems(id){return state.playlistItems.filter(x=>String(x.playlist_id)===String(id)).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(x=>String(x.video_id));}
  function mediaThumb(video){return video?.thumbnail_data_url?`<img src="${esc(video.thumbnail_data_url)}" alt="" loading="lazy">`:'<span class="media-no-thumb">▶</span>';}
  function mediaVideoRow(video,queued){return `<div class="media-work-library-item" draggable="true" data-media-source="${esc(video.id)}"><span class="media-work-thumb">${mediaThumb(video)}</span><span class="media-work-name"><strong title="${esc(video.title)}">${esc(video.title)}</strong><small>${video.duration_sec?formatDuration(video.duration_sec):'영상'}${video.site_id?' · 병원 영상':' · 공용 영상'}</small></span><button class="btn small" data-media-add="${esc(video.id)}" ${queued?'disabled':''} type="button">${queued?'추가됨':'+ 추가'}</button></div>`;}
  function mediaQueueRow(id,i){const v=state.videos.find(x=>String(x.id)===id);return `<div class="media-work-queue-item" draggable="true" data-media-queue-id="${esc(id)}"><span class="media-work-handle" aria-label="순서 변경">⠿</span><span class="media-work-index">${i+1}</span><span class="media-work-thumb">${mediaThumb(v)}</span><span class="media-work-name"><strong>${esc(v?.title||'삭제된 영상')}</strong><small>${v?.duration_sec?formatDuration(v.duration_sec):'재생 시간 미확인'}</small></span><div class="media-work-queue-actions"><button type="button" class="btn small" data-media-move="${esc(id)}" data-dir="-1" ${i===0?'disabled':''} aria-label="위로 이동">↑</button><button type="button" class="btn small" data-media-move="${esc(id)}" data-dir="1" ${i===mediaDraft.length-1?'disabled':''} aria-label="아래로 이동">↓</button><button type="button" class="btn small" data-media-remove="${esc(id)}" aria-label="재생목록에서 제거">×</button></div></div>`;}
  function hospitalPlaylistManagerMarkup(){
    const own=state.playlists.filter(p=>String(p.site_id)===String(targetSiteId)).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
    const videos=mediaVideos();
    if(mediaPlaylistId&&!own.some(p=>String(p.id)===mediaPlaylistId)){mediaPlaylistId='';mediaDraft=[];mediaDirty=false;}
    // Do not silently choose another TV's playlist. The user selects a TV or a list explicitly.
    const playlist=own.find(p=>String(p.id)===mediaPlaylistId);
    const queueSet=new Set(mediaDraft),filtered=videos.filter(v=>String(v.title||'').toLowerCase().includes(mediaFilter.toLowerCase()));
    const rooms=state.rooms.filter(r=>r&&r.id);
    const floorOptions=groupedRooms().filter(g=>(g.rooms||[]).length);
    const target=mediaTargetInfo(),activeTargetFloor=mediaTargetFloor||String(target?.group_id||''),floorRooms=rooms.filter(r=>String(r.group_id)===String(activeTargetFloor));
    const sharedCount=mediaPlaylistSharingCount(mediaPlaylistId),sharedNotice=sharedCount>1?`<p class="media-shared-warning" id="mediaSharedWarning">이 재생목록은 TV ${sharedCount}대가 함께 사용합니다. 순서를 바꾸면 해당 TV 모두에 영향을 줍니다. 공유 목록은 자동 저장하지 않고 확인 후 저장합니다.</p>`:'';
    const targetSelector=`<section class="media-target-picker"><div class="media-target-heading"><div><strong>어느 TV의 영상을 관리할까요?</strong><small>TV를 선택하면 연결된 재생목록이 바로 열립니다.</small></div><span class="media-target-current">${target?esc(target.name):'TV 선택 전'}</span></div><div class="media-target-fields"><label>층<select id="mediaTargetFloor"><option value="">층 선택</option>${floorOptions.map(g=>`<option value="${esc(g.id)}" ${String(g.id)===String(activeTargetFloor)?'selected':''}>${esc(groupDisplayName(g.name))} · ${g.rooms.length}대</option>`).join('')}</select></label><label>TV<select id="mediaTargetRoom" ${activeTargetFloor?'':'disabled'}><option value="">TV 선택</option>${floorRooms.map(r=>`<option value="${esc(r.id)}" ${String(r.id)===mediaTargetRoom?'selected':''}>${esc(r.name)}</option>`).join('')}</select></label></div>${target?`<p class="media-target-detail">현재 편성: <b>${esc(playlistById(mediaPlaylistId)?.name||'연결된 재생목록 없음')}</b> · ${esc(roomDisplayStatus(target).label||'상태 확인 중')}</p>`:'<p class="media-target-detail">TV를 먼저 선택하면 현재 편성과 편집 기능을 사용할 수 있습니다. 공통 재생목록을 만들려면 오른쪽의 재생목록 선택을 이용하세요.</p>'}</section>`;

    return `<section class="media-workspace">${targetSelector}<div class="media-work-toolbar"><div><h2>영상관리</h2><p>영상 선택, 재생 순서, TV 적용을 이 화면에서 관리합니다.</p></div><div class="media-work-controls"><select id="staffPlaylistSelect" aria-label="재생목록 선택"><option value="">새 재생목록</option>${own.map(p=>`<option value="${esc(p.id)}" ${String(p.id)===mediaPlaylistId?'selected':''}>${esc(p.name)}</option>`).join('')}</select><button type="button" class="btn" data-new-playlist>+ 재생목록</button><button type="button" class="btn primary" id="mediaOpenUpload">+ 영상 업로드</button></div></div><button type="button" id="mediaQuickUpload" class="media-quick-upload"><span>⇧ &nbsp; MP4를 여기에 끌어놓거나 눌러서 업로드</span><small>여러 파일 선택 가능 · 원본 1080p 유지 · 업로드 완료 후 목록에 표시</small></button>
    <div class="media-work-columns"><section class="media-work-panel"><div class="media-work-section-head"><div><h3>영상 보관함</h3><small>${videos.length}개 영상 · 클릭하여 추가</small></div></div><label class="media-work-search"><span>⌕</span><input id="mediaWorkSearch" type="search" placeholder="영상 검색" value="${esc(mediaFilter)}" autocomplete="off" aria-label="영상 검색"></label><div id="mediaWorkLibrary" class="media-work-scroll">${filtered.map(v=>mediaVideoRow(v,queueSet.has(String(v.id)))).join('')||'<p class="muted">검색 결과가 없습니다.</p>'}</div><p class="media-work-help">영상을 클릭해 추가하거나 오른쪽으로 드래그하세요.</p></section>
    <section class="media-work-panel"><div class="media-work-section-head"><div><h3>재생 순서</h3><small>카드를 드래그하면 순서가 바뀝니다.</small></div><span class="media-work-count" id="mediaWorkCount">${mediaDraft.length}개</span></div><label class="field media-work-name-field"><span>재생목록 이름</span><input id="staffPlaylistName" maxlength="60" value="${esc(playlist?.name||'')}" placeholder="예: 9층 대기실" autocomplete="off"></label>${sharedNotice}<div id="mediaWorkQueue" class="media-work-scroll media-work-queue" aria-label="재생 순서">${mediaDraft.map(mediaQueueRow).join('')||'<div class="media-work-dropempty">왼쪽에서 영상을 추가하세요.</div>'}</div><div class="media-work-foot"><span id="mediaWorkSaveStatus" role="status">${mediaDirty?'저장되지 않은 변경 사항':'현재 재생목록'}</span><div><button type="button" class="btn" id="mediaApplyCurrent" ${target&&mediaPlaylistId&&!mediaDirty?"":"disabled"}>이 TV에 적용</button><button id="staffDeletePlaylist" class="btn danger-outline" type="button" ${playlist?'':'disabled'}>삭제</button><button id="staffSavePlaylist" class="btn primary" type="button">${mediaDirty?'변경 저장':'저장'}</button></div></div></section></div>
    <section class="media-work-apply"><div class="media-work-section-head"><div><h3>TV 적용</h3><small>층을 선택한 뒤 필요한 TV만 체크하세요. 이미 재생 중인 영상은 바로 끊지 않습니다.</small></div><button class="btn primary" type="button" id="mediaWorkApplyTv" disabled>선택한 TV에 적용</button></div>
    <details class="media-bulk-apply"><summary>다른 TV에도 같은 재생목록 적용하기</summary><div class="media-work-tv-toolbar"><label class="media-work-floor-label">층 선택<select id="mediaWorkFloor"><option value="">층을 선택하세요</option>${floorOptions.map(g=>`<option value="${esc(g.id)}">${esc(groupDisplayName(g.name))} · TV ${g.rooms.length}대</option>`).join('')}</select></label><label class="media-work-tv-search-label">TV 검색<input id="mediaWorkTvSearch" type="search" placeholder="TV 이름 검색" autocomplete="off" disabled></label><span id="mediaWorkTvSelection" class="media-work-selected">선택한 TV 0대</span></div>
    <div class="media-work-tv-list" id="mediaWorkTvList" aria-label="TV 선택">${rooms.map(r=>`<label class="media-work-tv" data-media-tv-row data-media-floor="${esc(r.group_id||'')}" data-media-search="${esc(String(r.name||'').toLowerCase())}" hidden><input type="checkbox" data-media-tv="${esc(r.id)}"><span><strong>${esc(r.name)}</strong><small>${esc(playlistById(r.default_playlist_id)?.name||'기본 편성')}</small></span></label>`).join('')||'<span class="muted">등록된 TV가 없습니다.</span>'}</div><p class="media-work-tv-empty" id="mediaWorkTvEmpty">먼저 층을 선택하면 해당 층의 TV가 표시됩니다.</p><p class="media-work-help">체크한 TV에만 적용됩니다. 기존 TV 설정은 자동으로 선택하거나 변경하지 않습니다.</p></details></section>
    <section class="media-work-manage"><details id="mediaWorkManageDetails"><summary>영상 제목 변경 · 파일 업로드 · 파일 교체</summary><p>이 병원 영상의 제목 변경, MP4 업로드 및 파일 교체를 할 수 있습니다. 원본 영상 ID와 재생목록 연결은 유지됩니다.</p><div class="media-work-edit"><select id="mediaWorkEditVideo"><option value="">영상 선택</option>${videos.filter(v=>String(v.site_id)===String(targetSiteId)).map(v=>`<option value="${esc(v.id)}">${esc(v.title)}</option>`).join('')}</select><input id="mediaWorkEditName" placeholder="새 영상 이름" maxlength="100"><button type="button" class="btn" id="mediaWorkRename">이름 변경</button></div><div class="media-work-edit" id="mediaWorkUploadDrop"><input type="file" id="mediaWorkUploadFile" accept="video/mp4,.mp4" multiple><button class="btn" type="button" id="mediaWorkUpload">새 영상 업로드</button><button class="btn" type="button" id="mediaWorkReplace">선택 영상 파일 교체</button><progress id="mediaWorkUploadProgress" max="100" value="0" hidden></progress></div></details></section></section>`;
  }
  function refreshMediaWorkspace(){
    const panel=qs('#mediaWorkQueue'),library=qs('#mediaWorkLibrary'),counter=qs('#mediaWorkCount');
    if(panel)panel.innerHTML=mediaDraft.map(mediaQueueRow).join('')||'<div class="media-work-dropempty">왼쪽에서 영상을 추가하세요.</div>';
    if(library){const queued=new Set(mediaDraft);library.innerHTML=mediaVideos().filter(v=>String(v.title||'').toLowerCase().includes(mediaFilter.toLowerCase())).map(v=>mediaVideoRow(v,queued.has(String(v.id)))).join('')||'<p class="muted">검색 결과가 없습니다.</p>';}
    if(counter)counter.textContent=`${mediaDraft.length}개`;
    const status=qs('#mediaWorkSaveStatus');if(status)status.textContent=mediaSaving?'저장 중…':mediaDirty?(mediaPlaylistSharingCount(mediaPlaylistId)>1?'공유 목록 변경 · 저장 확인 필요':'자동 저장 대기'):'저장됨';
    const currentApply=qs('#mediaApplyCurrent');if(currentApply)currentApply.disabled=!mediaTargetRoom||!mediaPlaylistId||mediaDirty||mediaSaving;
    refreshMediaTvSelection();
    bindMediaDragAndButtons();
  }
  function fillHospitalPlaylistEditor(){
    const id=qs('#staffPlaylistSelect')?.value||'';
    clearTimeout(mediaSaveTimer);mediaPlaylistId=id;mediaDraft=id?mediaPlaylistItems(id):[];mediaDirty=false;
    const p=state.playlists.find(x=>String(x.id)===id),name=qs('#staffPlaylistName'),del=qs('#staffDeletePlaylist');
    if(name)name.value=p?.name||'';if(del)del.disabled=!p;
    qsa('[data-media-tv]').forEach(el=>{el.checked=false;});
    refreshMediaWorkspace();
  }
  async function saveHospitalPlaylist(){
    clearTimeout(mediaSaveTimer);if(mediaSaving)return false;
    const id=mediaPlaylistId||null,name=(qs('#staffPlaylistName')?.value||'').trim(),videoIds=[...mediaDraft];
    if(mediaPlaylistSharingCount(id)>1&&!confirm(`이 재생목록을 ${mediaPlaylistSharingCount(id)}대 TV가 함께 사용합니다. 모든 TV의 재생 순서가 바뀝니다. 저장할까요?`))return false;
    if(!name)return toast('재생목록 이름을 입력하세요.','error'),false;
    if(!videoIds.length)return toast('영상은 1개 이상 선택하세요.','error'),false;
    mediaSaving=true;refreshMediaWorkspace();
    try{
      const {data,error}=await db.rpc('hospital_save_site_playlist',{p_site:targetSiteId,p_id:id,p_name:name,p_video_ids:videoIds});
      if(error)throw error;
      mediaPlaylistId=String(data||id||'');mediaDirty=false;
      toast('재생목록을 저장했습니다.');await load();return true;
    }catch(e){mediaDirty=true;toast(e.message||'저장하지 못했습니다. 다시 시도하세요.','error');return false;}
    finally{mediaSaving=false;refreshMediaWorkspace();}
  }
  async function deleteHospitalPlaylist(){const id=mediaPlaylistId;if(!id)return;if(mediaPlaylistSharingCount(id)>0)return toast('TV에서 사용 중인 재생목록은 삭제할 수 없습니다. 먼저 TV 연결을 변경하세요.','error');if(!confirm('이 병원 플레이리스트를 삭제할까요?'))return;const {error}=await db.rpc('hospital_delete_site_playlist',{p_site:targetSiteId,p_id:id});if(error)return toast(error.message,'error');mediaPlaylistId='';mediaDraft=[];mediaDirty=false;toast('병원 플레이리스트를 삭제했습니다.');await load();}
  function mediaMove(from,to){if(from<0||to<0||from>=mediaDraft.length||to>=mediaDraft.length||from===to)return;const moved=mediaDraft.splice(from,1)[0];mediaDraft.splice(to,0,moved);mediaDirty=true;refreshMediaWorkspace();scheduleMediaSave();}
  function bindMediaDragAndButtons(){
    qsa('[data-media-add]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.mediaAdd;if(mediaDraft.includes(id))return;mediaDraft.push(id);mediaDirty=true;refreshMediaWorkspace();scheduleMediaSave();}));
    qsa('[data-media-remove]').forEach(b=>b.addEventListener('click',()=>{mediaDraft=mediaDraft.filter(x=>x!==b.dataset.mediaRemove);mediaDirty=true;refreshMediaWorkspace();scheduleMediaSave();}));
    qsa('[data-media-move]').forEach(b=>b.addEventListener('click',()=>{const i=mediaDraft.indexOf(b.dataset.mediaMove);mediaMove(i,i+Number(b.dataset.dir));}));
    qsa('[data-media-source], [data-media-queue-id]').forEach(el=>el.addEventListener('dragstart',e=>{
      const id=el.dataset.mediaSource||el.dataset.mediaQueueId;e.dataTransfer.setData('text/plain',id);e.dataTransfer.effectAllowed='move';
    }));
    // Touch/pen reordering: drag the handle without relying on HTML5 drag events.
    qsa('.media-work-handle').forEach(handle=>{
      handle.style.touchAction='none';
      handle.addEventListener('pointerdown',e=>{
        if(e.button!==0)return;
        const row=handle.closest('[data-media-queue-id]');if(!row)return;
        const fromId=row.dataset.mediaQueueId;let overId=null;
        handle.setPointerCapture(e.pointerId);row.classList.add('is-pointer-dragging');
        const move=ev=>{const found=document.elementFromPoint(ev.clientX,ev.clientY)?.closest('[data-media-queue-id]');overId=found?.dataset.mediaQueueId||null;};
        const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',cancel);row.classList.remove('is-pointer-dragging');if(overId&&overId!==fromId){const from=mediaDraft.indexOf(fromId),to=mediaDraft.indexOf(overId);mediaMove(from,to);}};
        const cancel=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',cancel);row.classList.remove('is-pointer-dragging');};
        handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',cancel);
      });
    });
    const queue=qs('#mediaWorkQueue');if(queue){
      queue.ondragover=e=>{e.preventDefault();e.dataTransfer.dropEffect='move';};
      queue.ondrop=e=>{e.preventDefault();const id=e.dataTransfer.getData('text/plain');if(!mediaVideos().some(v=>String(v.id)===id))return;const target=e.target.closest('[data-media-queue-id]');const to=target?mediaDraft.indexOf(target.dataset.mediaQueueId):mediaDraft.length;
        if(mediaDraft.includes(id)){const from=mediaDraft.indexOf(id);let pos=to;if(pos>from)pos--;if(pos===from)return;mediaDraft.splice(from,1);mediaDraft.splice(pos,0,id);}else{mediaDraft.splice(to,0,id);}mediaDirty=true;refreshMediaWorkspace();scheduleMediaSave();};
    }
  }
  function refreshMediaTvSelection(){
    const floor=qs('#mediaWorkFloor')?.value||'',search=(qs('#mediaWorkTvSearch')?.value||'').trim().toLowerCase();
    const searchInput=qs('#mediaWorkTvSearch');if(searchInput)searchInput.disabled=!floor;
    let visible=0;
    qsa('[data-media-tv-row]').forEach(row=>{
      const show=!!floor&&row.dataset.mediaFloor===floor&&(!search||row.dataset.mediaSearch.includes(search));
      row.hidden=!show;if(show)visible++;
    });
    const selected=qsa('[data-media-tv]:checked').length;
    const counter=qs('#mediaWorkTvSelection');if(counter)counter.textContent=`선택한 TV ${selected}대`;
    const apply=qs('#mediaWorkApplyTv');if(apply)apply.disabled=!selected||!mediaPlaylistId||mediaDirty||mediaSaving;
    const empty=qs('#mediaWorkTvEmpty');if(empty){empty.hidden=!!visible;empty.textContent=!floor?'먼저 층을 선택하면 해당 층의 TV가 표시됩니다.':'해당하는 TV가 없습니다.';}
  }
  async function mediaApplyTv(){
    if(mediaDirty||!mediaPlaylistId)return toast('재생목록을 먼저 저장하세요.','error');
    const ids=qsa('[data-media-tv]:checked').map(e=>e.dataset.mediaTv);if(!ids.length)return toast('TV를 선택하세요.','error');
    const button=qs('#mediaWorkApplyTv');if(button)button.disabled=true;
    let success=0,errors=[];
    for(const id of ids){const {error}=await db.rpc('staff_set_room_playlist',{p_room:id,p_playlist:mediaPlaylistId});if(error)errors.push(`${roomById(id)?.name||id}: ${error.message}`);else success++;}
    if(errors.length)toast(`${success}대 저장 · ${errors.length}대 실패: ${errors[0]}`,'error');else toast(`${success}대 TV에 재생목록을 적용했습니다.`);
    await load();
  }
  async function mediaRename(){const id=qs('#mediaWorkEditVideo')?.value,name=(qs('#mediaWorkEditName')?.value||'').trim();if(!id||!name)return toast('영상과 새 이름을 입력하세요.','error');const video=state.videos.find(v=>String(v.id)===id);if(!video||String(video.site_id)!==String(targetSiteId))return toast('이 병원 소유 영상만 수정할 수 있습니다.','error');const {error}=await db.from('videos').update({title:name}).eq('id',id).eq('site_id',targetSiteId);if(error)return toast(error.message,'error');toast('영상 이름을 변경했습니다.');await load();}
  async function mediaUpload(replace=false){
    const input=qs('#mediaWorkUploadFile'),files=Array.from(input?.files||[]);
    if(!files.length)return toast('MP4 파일을 선택하세요.','error');
    if(replace&&files.length!==1)return toast('파일 교체는 한 번에 하나만 가능합니다.','error');
    const maxSize=auth.role==='admin'?2*1024*1024*1024:350*1024*1024;
    const invalid=files.find(file=>!file.name.toLowerCase().endsWith('.mp4')||file.size>maxSize);
    if(invalid)return toast(`${invalid.name}: ${auth.role==='admin'?'2GB':'350MB'} 이하 MP4 파일만 업로드할 수 있습니다.`,'error');
    const target=replace?state.videos.find(v=>String(v.id)===qs('#mediaWorkEditVideo')?.value):null;
    if(replace&&(!target||String(target.site_id)!==String(targetSiteId)))return toast('교체할 병원 영상을 먼저 선택하세요.','error');
    if(replace&&!confirm(`'${target.title}'의 파일을 교체할까요? 기존 재생목록은 그대로 유지됩니다.`))return;
    const buttons=[qs('#mediaWorkUpload'),qs('#mediaWorkReplace'),qs('#mediaOpenUpload'),qs('#mediaQuickUpload')];
    const progress=qs('#mediaWorkUploadProgress');buttons.forEach(b=>{if(b)b.disabled=true;});
    if(progress){progress.hidden=false;progress.value=0;}
    let success=0,failed=[];
    try{
      for(let i=0;i<files.length;i++){
        const file=files[i];
        try{
          const signed=await apiJson('/api/r2-presign',{method:'POST',body:JSON.stringify({filename:file.name,contentType:'video/mp4',size:file.size,siteId:targetSiteId})});
          if(!/^https:\/\//i.test(String(signed.publicUrl||'')))throw new Error('R2 공개 영상 주소가 설정되지 않았습니다.');
          await uploadByXhr(signed.uploadUrl,file,'video/mp4',v=>{if(progress)progress.value=(i+v/100)/files.length*100;});
          const title=file.name.replace(/\.mp4$/i,'').trim(),url=signed.publicUrl||signed.url;
          if(!url)throw new Error('R2 공개 주소가 없습니다.');
          const next={source:'r2',storage_path:signed.key,url,size_bytes:file.size,active:true,available:true};
          const result=replace?await db.from('videos').update(next).eq('id',target.id).eq('site_id',targetSiteId):await db.from('videos').insert({...next,title,site_id:targetSiteId});
          if(result.error)throw result.error;
          success++;
        }catch(e){failed.push(`${file.name}: ${e.message||'전송 실패'}`);}
      }
      if(failed.length)toast(`${success}개 완료, ${failed.length}개 실패 · ${failed[0]}`,'error');
      else toast(replace?'기존 영상 파일을 교체했습니다.':`${success}개 영상 업로드 완료`);
      if(success)await load();
    }finally{buttons.forEach(b=>{if(b)b.disabled=false;});if(progress)progress.value=success===files.length?100:0;}
  }
  async function mediaApplyCurrent(){
    const room=mediaTargetInfo();if(!room||!mediaPlaylistId||mediaDirty||mediaSaving)return toast('TV와 저장된 재생목록을 선택하세요.','error');
    if(String(room.default_playlist_id)===mediaPlaylistId)return toast('이미 이 TV에 적용된 목록입니다.');
    if(!confirm(`${room.name}에 '${playlistById(mediaPlaylistId)?.name||'선택 목록'}'을 적용할까요?`))return;
    const {error}=await db.rpc('staff_set_room_playlist',{p_room:room.id,p_playlist:mediaPlaylistId});
    if(error)return toast(error.message||'TV 적용에 실패했습니다.','error');
    toast(`${room.name}에 재생목록을 적용했습니다.`);await load();
  }
  function bindMediaWorkspace(){
    qs('#mediaTargetFloor')?.addEventListener('change',e=>{
      const next=String(e.target.value||'');if(mediaDirty&&!confirm('저장되지 않은 변경 사항을 버리고 층을 변경할까요?')){e.target.value=mediaTargetFloor;return;}
      mediaTargetFloor=next;mediaSelectTarget('');renderPreservingUi(false);
    });
    qs('#mediaTargetRoom')?.addEventListener('change',e=>{
      const previous=mediaTargetRoom;if(!mediaSelectTarget(e.target.value)){e.target.value=previous;return;}
      renderPreservingUi(false);
    });
    qs('#mediaApplyCurrent')?.addEventListener('click',mediaApplyCurrent);
    qs('#staffPlaylistSelect')?.addEventListener('change',()=>{if(mediaDirty&&!confirm('저장하지 않은 변경 사항을 버릴까요?')){qs('#staffPlaylistSelect').value=mediaPlaylistId;return;}fillHospitalPlaylistEditor();});
    qs('[data-new-playlist]')?.addEventListener('click',()=>{if(mediaDirty&&!confirm('저장하지 않은 변경 사항을 버릴까요?'))return;qs('#staffPlaylistSelect').value='';fillHospitalPlaylistEditor();qs('#staffPlaylistName')?.focus();});
    qs('#staffPlaylistName')?.addEventListener('input',()=>{mediaDirty=true;refreshMediaWorkspace();scheduleMediaSave();});
    qs('#mediaWorkSearch')?.addEventListener('input',e=>{mediaFilter=e.target.value;refreshMediaWorkspace();});
    qs('#staffSavePlaylist')?.addEventListener('click',saveHospitalPlaylist);
    qs('#staffDeletePlaylist')?.addEventListener('click',deleteHospitalPlaylist);
    qs('#mediaWorkApplyTv')?.addEventListener('click',mediaApplyTv);
    qs('#mediaWorkFloor')?.addEventListener('change',()=>{qsa('[data-media-tv]').forEach(el=>{el.checked=false;});const search=qs('#mediaWorkTvSearch');if(search)search.value='';refreshMediaTvSelection();});
    qs('#mediaWorkTvSearch')?.addEventListener('input',refreshMediaTvSelection);
    qsa('[data-media-tv]').forEach(el=>el.addEventListener('change',refreshMediaTvSelection));
    refreshMediaTvSelection();
    qs('#mediaWorkEditVideo')?.addEventListener('change',e=>{const v=state.videos.find(v=>String(v.id)===e.target.value);const n=qs('#mediaWorkEditName');if(n)n.value=v?.title||'';});
    qs('#mediaWorkRename')?.addEventListener('click',mediaRename);
    qs('#mediaOpenUpload')?.addEventListener('click',()=>{const details=qs('#mediaWorkManageDetails');if(details){details.open=true;details.scrollIntoView({behavior:'smooth',block:'center'});}qs('#mediaWorkUploadFile')?.focus();});
    qs('#mediaQuickUpload')?.addEventListener('click',()=>{qs('#mediaWorkManageDetails')?.setAttribute('open','');qs('#mediaWorkUploadFile')?.click();});
    const uploadDrop=qs('#mediaQuickUpload')||qs('#mediaWorkUploadDrop');
    if(uploadDrop){
      uploadDrop.addEventListener('dragover',e=>{e.preventDefault();uploadDrop.classList.add('is-dragging');});
      uploadDrop.addEventListener('dragleave',()=>uploadDrop.classList.remove('is-dragging'));
      uploadDrop.addEventListener('drop',e=>{e.preventDefault();uploadDrop.classList.remove('is-dragging');const files=Array.from(e.dataTransfer?.files||[]),input=qs('#mediaWorkUploadFile');if(!files.length||!input)return;if(files.some(f=>!f.name.toLowerCase().endsWith('.mp4')))return toast('MP4 파일만 업로드할 수 있습니다.','error');const transfer=new DataTransfer();files.forEach(f=>transfer.items.add(f));input.files=transfer.files;qs('#mediaWorkManageDetails')?.setAttribute('open','');toast(`${files.length}개 선택 · 새 영상 업로드를 누르면 전송합니다.`);});
    }
    qs('#mediaWorkUploadFile')?.addEventListener('change',e=>{if(e.target.files?.length){qs('#mediaWorkManageDetails')?.setAttribute('open','');toast(`${e.target.files.length}개 선택 · 새 영상 업로드를 누르면 전송합니다.`);}});
    qs('#mediaWorkUpload')?.addEventListener('click',()=>mediaUpload(false));
    qs('#mediaWorkReplace')?.addEventListener('click',()=>mediaUpload(true));
    bindMediaDragAndButtons();
  }
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
  function hospitalSettingsPageMarkup(){const site=state.site||{};const custom=Object.values(state.floorplanAssets||{}).filter(x=>x?.key).length,placed=state.rooms.filter(roomMapPlaced).length,total=state.rooms.length;return `<section class="hospital-admin-settings-page">${hospitalSetupProgress()}<div class="hospital-settings-primary"><div class="hospital-settings-intro"><span class="eyebrow">ESSENTIAL</span><h2>기본 운영</h2><p>병원 이름과 운영시간처럼 자주 확인하는 항목만 먼저 보여줍니다.</p></div><div class="hospital-admin-block hospital-settings-card"><div class="hospital-admin-block-head"><div><b>병원 정보</b><small>관리 화면에 표시되는 병원명과 건물명입니다.</small></div></div><div class="grid-2"><label class="field"><span>병원명</span><input id="staffSiteName" maxlength="60" value="${esc(site.name||'')}"></label><label class="field"><span>건물명</span><input id="staffBuildingLabel" maxlength="60" value="${esc(site.building_label||'')}"></label></div><button id="staffSaveSiteIdentity" class="btn primary" type="button">병원 정보 저장</button></div><div class="hospital-settings-card">${operatingSettingsMarkup()}</div></div><div class="hospital-settings-layout-note"><b>도면 · 공간 · TV 위치 변경</b><p>이제 송출 관리에서 층을 선택한 뒤 ‘배치 편집’을 누르세요. 병원 전체 설정과 송출 배치를 분리했습니다.</p><button type="button" class="btn small" data-ops-go-layout>송출 관리에서 배치 편집</button></div></section>`;}
  function hospitalVideosPageMarkup(){
    const live=state.rooms.filter(r=>roomDisplayStatus(r).key==='live').length;
    return `<section class="hospital-content-page hospital-content-media unified-hospital-page" id="unifiedMediaEditor">
      <header class="unified-page-heading"><div><h1>Clinic Signage</h1><p>${esc(state.site?.name||'병원')} · TV 영상과 설정을 한 페이지에서 관리합니다.</p></div><div class="unified-quick-stats"><span>전체 TV <b>${state.rooms.length}</b></span><span>송출 확인 <b>${live}</b></span></div></header>
      ${hospitalPlaylistManagerMarkup()}
      <details class="unified-secondary-panel" id="unifiedTvOperations"><summary><span><b>TV 상태 · 층별 도면</b><small>송출 확인, TV 이름·위치 변경, 디스플레이 설정</small></span><span aria-hidden="true">펼치기 ▾</span></summary><div class="unified-secondary-content">${hospitalOperationsSummary()}${staffBuildingOverview(groupedRooms())}</div></details>
      <details class="unified-secondary-panel" id="unifiedHospitalSettings"><summary><span><b>병원 설정</b><small>운영시간, 병원 정보, 기본 송출 설정</small></span><span aria-hidden="true">펼치기 ▾</span></summary><div class="unified-secondary-content">${hospitalSettingsPageMarkup()}</div></details>
    </section>`;
  }
  async function saveHospitalIdentity(){const name=(qs('#staffSiteName')?.value||'').trim(),building=(qs('#staffBuildingLabel')?.value||'').trim();if(!name||!building)return toast('병원명과 건물명을 입력하세요.','error');const {error}=await db.rpc('hospital_update_site_identity',{p_site:targetSiteId,p_name:name,p_building_label:building});if(error)return toast(error.message,'error');toast('병원 정보를 저장했습니다.');await load();}
  const displaySetupRpcMissing=(error)=>String(error?.code||'')==='PGRST202'||/staff_set_display_setup|schema cache|function/i.test(String(error?.message||''))&&/could not find|not found/i.test(String(error?.message||''));
  async function saveDisplayPurpose(roomId){
    const r=roomById(roomId);if(!r)return;
    const input=qs(`[data-display-purpose="${roomId}"]`),note=String(input?.value||'').trim();
    const {error}=await db.rpc('staff_set_display_setup',{p_room:roomId,p_mode:displayControlMode(r),p_x:r.map_x_pct??null,p_y:r.map_y_pct??null,p_note:note||null,p_space:r.floor_space_id||null,p_group:canonicalFloorGroupIdForRoom(r)||r.group_id});
    if(error)return toast(error.message,'error');r.display_note=note||null;toast('운영 목적을 저장했습니다.');renderPreservingUi(true);
  }
  async function saveDisplaySetup(roomId,x,y,mode,spaceId){const r=state.rooms.find(x=>x.id===roomId);if(!r)return;const prev={x:r.map_x_pct,y:r.map_y_pct,mode:r.display_control_mode,space:r.floor_space_id,check:r.manual_check_status};const useMode=mode||displayControlMode(r),gid=canonicalFloorGroupIdForRoom(r)||r.group_id;let resolvedSpace=spaceId===undefined?r.floor_space_id||null:spaceId||null;if(spaceId===null||spaceId==='auto')resolvedSpace=(x===null||x===undefined||y===null||y===undefined)?null:spaceContainingPoint(gid,x,y)?.id||null;
    r.map_x_pct=x;r.map_y_pct=y;r.display_control_mode=useMode;r.floor_space_id=resolvedSpace;if(useMode==='manual'&&r.manual_check_status==='not_required')r.manual_check_status='needs_check';renderPreservingUi(true);
    let {error}=await db.rpc('staff_set_display_setup',{p_room:roomId,p_mode:useMode,p_x:x,p_y:y,p_note:r.display_note||null,p_space:resolvedSpace,p_group:gid}),legacy=false;if(error&&displaySetupRpcMissing(error)){const retry=await db.rpc('staff_set_display_setup',{p_room:roomId,p_mode:useMode,p_x:x,p_y:y,p_note:r.display_note||null});error=retry.error;legacy=!error;}
    if(error){r.map_x_pct=prev.x;r.map_y_pct=prev.y;r.display_control_mode=prev.mode;r.floor_space_id=prev.space;r.manual_check_status=prev.check;renderPreservingUi(true);return toast(error.message,'error');}
    if(legacy)r.floor_space_id=prev.space;if(legacy)toast('디스플레이 위치를 저장했습니다. 공간 연결은 DB 업데이트 후 함께 저장됩니다.');renderPreservingUi(true);}
  const DISPLAY_GRID_STEP=1,DISPLAY_ALIGN_THRESHOLD=1;
  const clampPct=v=>Math.max(0,Math.min(100,Number(v)||0));
  function snapLayoutPoint(raw,targets=[]){
    const x0=clampPct(raw.x),y0=clampPct(raw.y);
    let x=Math.round(x0/DISPLAY_GRID_STEP)*DISPLAY_GRID_STEP,y=Math.round(y0/DISPLAY_GRID_STEP)*DISPLAY_GRID_STEP,guideX=null,guideY=null;
    let bestX=DISPLAY_ALIGN_THRESHOLD+0.001,bestY=DISPLAY_ALIGN_THRESHOLD+0.001;
    targets.forEach(t=>{
      (t.xs||[]).forEach(px=>{const dx=Math.abs(Number(px)-x0);if(dx<=DISPLAY_ALIGN_THRESHOLD&&dx<bestX){bestX=dx;x=Number(px);guideX=Number(px);}});
      (t.ys||[]).forEach(py=>{const dy=Math.abs(Number(py)-y0);if(dy<=DISPLAY_ALIGN_THRESHOLD&&dy<bestY){bestY=dy;y=Number(py);guideY=Number(py);}});
    });
    return {x:clampPct(x),y:clampPct(y),guideX,guideY};
  }
  function snapSpacePoint(stage,rawX,rawY,ignoreId=null){
    const gid=stage?.dataset?.staffSpaceStage||stage?.dataset?.staffMapStage;
    const targets=state.floorSpaces.filter(sp=>sp.group_id===gid&&sp.id!==ignoreId).map(sp=>({
      xs:[Number(sp.x_pct),Number(sp.x_pct)+Number(sp.width_pct)],
      ys:[Number(sp.y_pct),Number(sp.y_pct)+Number(sp.height_pct)]
    }));
    return snapLayoutPoint({x:rawX,y:rawY},targets);
  }
  function snapDisplayPoint(stage,roomId,rawX,rawY){
    const gid=stage?.dataset?.staffMapStage,x0=clampPct(rawX),y0=clampPct(rawY);
    let x=Math.round(x0/DISPLAY_GRID_STEP)*DISPLAY_GRID_STEP,y=Math.round(y0/DISPLAY_GRID_STEP)*DISPLAY_GRID_STEP,guideX=null,guideY=null;
    const floorGroup=state.groups.find(g=>g.id===gid),peers=roomsForFloorGroup(floorGroup).filter(r=>r.id!==roomId&&roomMapPlaced(r));
    let bestX=DISPLAY_ALIGN_THRESHOLD+0.001,bestY=DISPLAY_ALIGN_THRESHOLD+0.001;
    peers.forEach(r=>{const px=Number(r.map_x_pct),py=Number(r.map_y_pct),dx=Math.abs(px-x0),dy=Math.abs(py-y0);if(dx<=DISPLAY_ALIGN_THRESHOLD&&dx<bestX){bestX=dx;x=px;guideX=px;}if(dy<=DISPLAY_ALIGN_THRESHOLD&&dy<bestY){bestY=dy;y=py;guideY=py;}});
    return {x:clampPct(x),y:clampPct(y),guideX,guideY};
  }
  function showDisplaySnapGuides(stage,point){
    if(!stage)return;stage.querySelectorAll('.display-snap-guide').forEach(x=>x.remove());
    if(point?.guideX!==null&&point?.guideX!==undefined){const g=document.createElement('i');g.className='display-snap-guide is-vertical';g.style.left=`${point.guideX}%`;stage.appendChild(g);}
    if(point?.guideY!==null&&point?.guideY!==undefined){const g=document.createElement('i');g.className='display-snap-guide is-horizontal';g.style.top=`${point.guideY}%`;stage.appendChild(g);}
  }
  function clearDisplaySnapGuides(stage){stage?.querySelectorAll('.display-snap-guide').forEach(x=>x.remove());}
  function bindDisplaySetup(){
    qs('#staffLayoutCopyToggle')?.addEventListener('click',()=>{layoutCopyOpen=!layoutCopyOpen;renderPreservingUi(true);});
    qs('#staffLayoutCopyClose')?.addEventListener('click',()=>{layoutCopyOpen=false;renderPreservingUi(true);});
    qs('#staffApplyLayoutCopy')?.addEventListener('click',async()=>{
      const targets=qsa('[data-layout-copy-target]:checked').map(x=>x.value),copySpaces=!!qs('#staffCopySpaces')?.checked,copyDisplays=!!qs('#staffCopyDisplays')?.checked;
      if(!targets.length)return toast('적용할 층을 선택하세요.','error');if(!copySpaces&&!copyDisplays)return toast('복사할 항목을 하나 이상 선택하세요.','error');
      if(!confirm(`선택한 ${targets.length}개 층의 ${copySpaces&&copyDisplays?'공간과 디스플레이 위치':copySpaces?'공간':'디스플레이 위치'}를 현재 층 기준으로 덮어쓸까요?`))return;
      const btn=qs('#staffApplyLayoutCopy');if(btn)btn.disabled=true;try{const result=await applyFloorLayoutCopy(spaceEditorGroupId,targets,{copySpaces,copyDisplays});const applied=result.applied.map(x=>{const parts=[];if(x.spaces_copied)parts.push('공간');if(x.displays_copied)parts.push(`디스플레이 위치 ${Number(x.displays_updated||0)+Number(x.displays_created||0)}개`);return `${x.name||'대상층'} · ${parts.join(' + ')||'적용'} 완료`;});const skipped=result.skipped.map(x=>`${x.name||'대상층'} · ${x.reason==='DISPLAY_COUNT_MISMATCH'?(x.spaces_copied?'공간은 복사됨 · 디스플레이 위치만 제외':'디스플레이 위치 제외 · 수 불일치'):x.reason||'조건 불일치'}`);toast([...applied,...skipped].join(' · ')||'변경 사항이 없습니다.');layoutCopyOpen=false;await load();}catch(e){toast(e.message||String(e),'error');if(btn)btn.disabled=false;}
    });
    qsa('[data-save-floor-meta]').forEach(b=>b.addEventListener('click',()=>saveHospitalFloorMeta(b.dataset.saveFloorMeta)));
    qs('#staffAddSpace')?.addEventListener('click',()=>{layoutEditMode='space';layoutPlacementRoomId=null;spaceRedrawId=null;renderPreservingUi(true);requestAnimationFrame(()=>qs('#staffSpaceName')?.focus());});
    qsa('[data-place-display]').forEach(b=>b.addEventListener('click',()=>{layoutEditMode='display';spaceRedrawId=null;layoutPlacementRoomId=b.dataset.placeDisplay||null;renderPreservingUi(true);}));
    qsa('[data-rename-display]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();renameHospitalDisplay(b.dataset.renameDisplay);}));
    qsa('[data-delete-display]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();deleteHospitalDisplay(b.dataset.deleteDisplay);}));
    qsa('[data-unplace-display]').forEach(b=>b.addEventListener('click',()=>{const r=roomById(b.dataset.unplaceDisplay);if(r)saveDisplaySetup(r.id,null,null,displayControlMode(r),null);}));
    qsa('[data-save-display-purpose]').forEach(b=>b.addEventListener('click',()=>saveDisplayPurpose(b.dataset.saveDisplayPurpose)));
    qsa('[data-staff-map-stage]').forEach(stage=>stage.addEventListener('click',e=>{if(layoutEditMode!=='display'||!layoutPlacementRoomId)return;if(e.target.closest('[data-display-marker]'))return;const roomId=layoutPlacementRoomId,r=roomById(roomId);if(!r)return;const rect=stage.getBoundingClientRect(),rawX=(e.clientX-rect.left)/rect.width*100,rawY=(e.clientY-rect.top)/rect.height*100,p=snapDisplayPoint(stage,roomId,rawX,rawY);layoutPlacementRoomId=null;saveDisplaySetup(roomId,p.x,p.y,displayControlMode(r),null);}));
    qsa('[data-display-marker]').forEach(marker=>marker.addEventListener('pointerdown',e=>{if(layoutEditMode!=='display')return;e.preventDefault();e.stopPropagation();const stage=marker.closest('[data-staff-map-stage]');if(!stage)return;const roomId=marker.dataset.displayMarker;marker.setPointerCapture?.(e.pointerId);const move=ev=>{const rect=stage.getBoundingClientRect(),rawX=(ev.clientX-rect.left)/rect.width*100,rawY=(ev.clientY-rect.top)/rect.height*100,p=snapDisplayPoint(stage,roomId,rawX,rawY);marker.style.left=`${p.x}%`;marker.style.top=`${p.y}%`;showDisplaySnapGuides(stage,p);};const up=ev=>{marker.removeEventListener('pointermove',move);marker.removeEventListener('pointerup',up);const rect=stage.getBoundingClientRect(),rawX=(ev.clientX-rect.left)/rect.width*100,rawY=(ev.clientY-rect.top)/rect.height*100,p=snapDisplayPoint(stage,roomId,rawX,rawY);clearDisplaySnapGuides(stage);saveDisplaySetup(roomId,p.x,p.y,displayControlMode(roomById(roomId)),null);};marker.addEventListener('pointermove',move);marker.addEventListener('pointerup',up);}));
  }
  async function saveSpaceContent(spaceId){
    const sp=state.floorSpaces.find(x=>x.id===spaceId);if(!sp)return;
    const patientContext=(qs(`[data-space-patient-context="${spaceId}"]`)?.value||'').trim();
    const contentReason=(qs(`[data-space-content-reason="${spaceId}"]`)?.value||'').trim();
    const {error}=await db.from('floor_spaces').update({patient_context_note:patientContext||null,content_reason:contentReason||null,updated_at:new Date().toISOString()}).eq('id',spaceId).eq('site_id',state.site.id);
    if(error)return toast(error.message||'공간 문구를 저장하지 못했습니다.','error');
    Object.assign(sp,{patient_context_note:patientContext||null,content_reason:contentReason||null});
    toast(`${sp.name} 문구를 저장했습니다.`);
  }
  function bindFloorSpaceManager(){
    qs('#staffSpaceFloor')?.addEventListener('change',e=>{spaceEditorGroupId=e.target.value;selectedFloorId=e.target.value;spaceRedrawId=null;layoutPlacementRoomId=null;layoutEditMode='display';layoutCopyOpen=false;renderPreservingUi(false);});
    qsa('[data-staff-redraw-space]').forEach(b=>b.addEventListener('click',()=>{const space=state.floorSpaces.find(x=>x.id===b.dataset.staffRedrawSpace);if(!space)return;spaceEditorGroupId=space.group_id;spaceRedrawId=space.id;layoutPlacementRoomId=null;layoutEditMode='space';layoutPanelOpen=true;selectedFloorId=space.group_id;renderPreservingUi(false);requestAnimationFrame(()=>qs('[data-staff-space-stage]')?.scrollIntoView({behavior:'smooth',block:'center'}));}));
    qs('#staffCancelSpaceRedraw')?.addEventListener('click',()=>{spaceRedrawId=null;layoutEditMode='display';renderPreservingUi(false);});
    qsa('[data-save-space-content]').forEach(b=>b.addEventListener('click',()=>saveSpaceContent(b.dataset.saveSpaceContent)));
    qsa('[data-staff-delete-space]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('공간 구분을 삭제할까요?'))return;const {error}=await db.from('floor_spaces').delete().eq('id',b.dataset.staffDeleteSpace);if(error)return toast(error.message,'error');if(spaceRedrawId===b.dataset.staffDeleteSpace)spaceRedrawId=null;await load();}));
    const stage=qs('[data-staff-space-stage]');if(!stage)return;let start=null,preview=null;
    stage.addEventListener('pointerdown',e=>{if(layoutEditMode!=='space')return;if(e.target.closest('[data-floor-space]')&&!spaceRedrawId)return;const name=(qs('#staffSpaceName')?.value||'').trim();if(!name)return toast('공간명을 먼저 입력하세요.','error');e.preventDefault();const rect=stage.getBoundingClientRect(),rawX=(e.clientX-rect.left)/rect.width*100,rawY=(e.clientY-rect.top)/rect.height*100,p=snapSpacePoint(stage,rawX,rawY,spaceRedrawId);start={x:p.x,y:p.y,id:e.pointerId};preview=document.createElement('div');preview.className='floor-space-draft';stage.appendChild(preview);showDisplaySnapGuides(stage,p);stage.setPointerCapture?.(e.pointerId);});
    stage.addEventListener('pointermove',e=>{if(!start||e.pointerId!==start.id||!preview)return;const rect=stage.getBoundingClientRect(),rawX=(e.clientX-rect.left)/rect.width*100,rawY=(e.clientY-rect.top)/rect.height*100,p=snapSpacePoint(stage,rawX,rawY,spaceRedrawId),l=Math.min(start.x,p.x),t=Math.min(start.y,p.y),w=Math.abs(p.x-start.x),h=Math.abs(p.y-start.y);Object.assign(preview.style,{left:`${l}%`,top:`${t}%`,width:`${w}%`,height:`${h}%`});showDisplaySnapGuides(stage,p);});
    stage.addEventListener('pointerup',async e=>{if(!start||e.pointerId!==start.id)return;const rect=stage.getBoundingClientRect(),rawX=(e.clientX-rect.left)/rect.width*100,rawY=(e.clientY-rect.top)/rect.height*100,p=snapSpacePoint(stage,rawX,rawY,spaceRedrawId),l=Math.min(start.x,p.x),t=Math.min(start.y,p.y),w=Math.abs(p.x-start.x),h=Math.abs(p.y-start.y);preview?.remove();preview=null;start=null;clearDisplaySnapGuides(stage);if(w<2||h<2)return toast('공간 영역을 조금 더 크게 드래그하세요.','error');const name=(qs('#staffSpaceName')?.value||'').trim(),type=qs('#staffSpaceType')?.value||'other',groupId=stage.dataset.staffSpaceStage;
      if(spaceRedrawId){const id=spaceRedrawId,{error}=await db.from('floor_spaces').update({name,space_type:type,x_pct:l,y_pct:t,width_pct:w,height_pct:h}).eq('id',id).eq('site_id',state.site.id);if(error)return toast(error.message,'error');const item=state.floorSpaces.find(x=>x.id===id);if(item)Object.assign(item,{name,space_type:type,x_pct:l,y_pct:t,width_pct:w,height_pct:h});spaceRedrawId=null;layoutEditMode='display';toast('공간을 다시 그렸습니다.');renderPreservingUi(true);return;}
      const nextOrder=Math.max(0,...state.floorSpaces.filter(x=>x.group_id===groupId).map(x=>Number(x.sort_order||0)))+10;const {data,error}=await db.from('floor_spaces').insert({site_id:state.site.id,group_id:groupId,name,space_type:type,x_pct:l,y_pct:t,width_pct:w,height_pct:h,sort_order:nextOrder}).select('*').single();if(error)return toast(error.message,'error');if(data)state.floorSpaces.push(data);layoutEditMode='display';toast('공간을 저장했습니다.');renderPreservingUi(true);
    });
    stage.addEventListener('pointercancel',()=>{preview?.remove();preview=null;start=null;clearDisplaySnapGuides(stage);});
  }
  function bindHospitalAdminSettings(){
    const details=qs('.hospital-admin-settings');
    qs('#staffSaveSiteIdentity')?.addEventListener('click',saveHospitalIdentity);
    qs('#staffSaveOperating')?.addEventListener('click',saveOperatingConfig);
    qs('#staffCreateFloor')?.addEventListener('click',createHospitalFloor);
    qsa('[data-staff-delete-floor]').forEach(b=>b.addEventListener('click',()=>deleteHospitalFloor(b.dataset.staffDeleteFloor)));
    qs('#staffCreateDisplay')?.addEventListener('click',createHospitalDisplay);
    qs('#staffCloseToday')?.addEventListener('click',async()=>{if(!confirm('오늘 남은 송출을 이 병원에서 종료할까요?'))return;const {error}=await db.rpc('hospital_close_today',{p_site:targetSiteId});if(error)return toast(error.message,'error');toast('오늘 송출을 종료했습니다.');await load();});
    qs('#staffReopenToday')?.addEventListener('click',async()=>{const {error}=await db.rpc('hospital_reopen_today',{p_site:targetSiteId});if(error)return toast(error.message,'error');toast('오늘 송출을 다시 열었습니다.');await load();});
    if(tab==='videos')bindMediaWorkspace();
    qsa('[data-staff-building-upload]').forEach(input=>input.addEventListener('change',()=>{const f=input.files?.[0];if(f)uploadBuildingImage(f);input.value='';}));qs('[data-staff-building-remove]')?.addEventListener('click',removeBuildingImage);qsa('[data-staff-floorplan-upload]').forEach(input=>input.addEventListener('change',()=>{const f=input.files?.[0];if(f)uploadFloorplan(Number(input.dataset.staffFloorplanUpload),f);input.value='';}));
    qsa('[data-staff-floorplan-reset]').forEach(b=>b.addEventListener('click',()=>resetFloorplan(Number(b.dataset.staffFloorplanReset))));
    qsa('details').forEach(d=>d.addEventListener('toggle',()=>{if(d.open)loadFloorplanSvgs(d).catch(()=>{});}));
    bindFloorSpaceManager();bindDisplaySetup();if(tab==='settings'||tab==='videos'){loadBuildingImages(qs('#hospitalRoot')).catch(()=>{});loadFloorplanSvgs(qs('#hospitalRoot')).catch(()=>{});}
  }



  function broadcastPlaylistId(){const ids=(state.broadcast?.video_ids||[]).map(String);if(!ids.length)return '';return state.playlists.filter(p=>p.active!==false&&p.site_id===targetSiteId).find(p=>{const pids=state.playlistItems.filter(x=>x.playlist_id===p.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(x=>String(x.video_id));return pids.length===ids.length&&pids.every((id,i)=>id===ids[i]);})?.id||'';}
  function hospitalBroadcastCard(){const active=!!state.broadcast?.active,selected=broadcastPlaylistId(),own=state.playlists.filter(p=>p.active!==false&&p.site_id===targetSiteId);return `<section class="hospital-broadcast-card ${active?'is-active':''}"><div><small>병원 전체 송출</small><b>${active?'전체 디스플레이에 송출 중':'필요할 때만 전체 송출'}</b><p>선택한 병원 플레이리스트를 모든 원격 디스플레이에 우선 송출합니다.</p></div><div class="hospital-broadcast-actions"><select id="hospitalBroadcastPlaylist" ${active?'disabled':''}><option value="">${active&&selected?'송출 중인 플레이리스트':'플레이리스트 선택'}</option>${own.map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join('')}</select>${active?'<button class="btn danger" id="hospitalBroadcastStop">전체 송출 종료</button>':'<button class="btn primary" id="hospitalBroadcastStart">전체 송출 시작</button>'}</div></section>`;}
  async function setHospitalBroadcast(active){const playlist=qs('#hospitalBroadcastPlaylist')?.value||null;if(active&&!playlist)return toast('전체 송출할 플레이리스트를 선택하세요.','error');if(!confirm(active?'이 병원의 모든 원격 디스플레이에 전체 송출할까요?':'병원 전체 송출을 종료할까요?'))return;const {error}=await db.rpc('hospital_set_broadcast',{p_site:targetSiteId,p_active:active,p_playlist:playlist,p_notice:null});if(error)return toast(error.message||'전체 송출을 변경하지 못했습니다.','error');toast(active?'병원 전체 송출을 시작했습니다.':'병원 전체 송출을 종료했습니다.');await load();}

  function render(){
    const statuses=state.rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length;
    const issues=statuses.filter(x=>['error','update','offline','manual-warn','delayed'].includes(x.key)).length;
    const groups=groupedRooms();
    qsa('.nav-btn').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
    const siteLabel=qs('#hospitalSiteLabel');if(siteLabel)siteLabel.textContent=state.site?.name||'';
    tab='videos';
    const head=tab==='videos'?'':tab==='output'
      ? `<div class="hospital-output-hero"><div class="hospital-output-copy"><span class="eyebrow">${esc(state.site?.name||'병원')}</span><h1>TV 상태</h1><p>우리 병원의 TV가 잘 나오고 있는지 확인하세요.</p></div><div class="hospital-output-side hospital-output-side-simple"><span class="hospital-display-total">전체 TV <b>${state.rooms.length}</b>대</span><button id="staffStatusRefresh" class="btn hospital-refresh-btn">새로고침</button></div></div>`
      : `<div class="reception-head reception-head-board hospital-simple-head"><div><span class="eyebrow">${esc(state.site?.name||'병원')}</span><h1>${tab==='videos'?'영상관리':'병원 설정'}</h1><p>${tab==='videos'?'이 병원에서 송출할 플레이리스트와 재생 영상을 정리합니다.':'운영시간과 병원 정보는 위에서, 도면·공간·디스플레이 설정은 필요할 때만 아래에서 관리합니다.'}</p></div></div>`;
    let content='';
    if(tab==='output')content=`${hospitalOperationsSummary()}${staffBuildingOverview(groups)}`;
    else if(tab==='videos')content=hospitalVideosPageMarkup();
    else content=hospitalSettingsPageMarkup();
    qs('#hospitalRoot').innerHTML=`${state.broadcast?.active&&tab==='output'?'<div class="broadcast-strip">전체 송출 중입니다.</div>':''}${head}${content}`;
    bind();
    loadFloorplanSvgs(qs('#hospitalRoot')).catch(()=>{});
  }

  function groupCard(group){
    const summary=groupStatusSummary(group.rooms),nowText=summary.key==='live'?`${summary.live}곳 송출 중`:summary.key==='issue'?`문제 공간 ${summary.issues}곳`:summary.key==='offline'?'모든 공간 연결 끊김':summary.key==='idle'?'현재 재생 대기':'현재 상태 확인';
    return `<details class="monitor-group staff-monitor-group group-state-${summary.key}" data-staff-group="${esc(group.id)}"><summary class="monitor-group-summary"><div class="monitor-group-overview"><div class="monitor-group-title-row"><h2>${esc(groupDisplayName(group.name))}</h2>${group.role_label?`<span class="floor-type-label">${esc(group.role_label)}</span>`:`<span class="floor-type-label">${esc(careTypeLabel(group.care_type))}</span>`}<span class="group-status-badge status-${summary.key}" data-staff-group-status>${esc(summary.label)}</span></div><p class="floor-purpose-summary">${esc(group.content_intro||group.signage_purpose||'송출 목적 미설정')}</p><div class="group-metric-row"><span>공간 <b data-staff-group-total>${summary.total}</b></span><span>송출 <b data-staff-group-live>${summary.live}</b></span><span>원격 정상 <b data-staff-group-online>${summary.online}</b></span><span>수동 <b>${summary.manual+summary.manualNeedsCheck}</b></span><span>문제 <b data-staff-group-issues>${summary.issues}</b></span></div><p data-staff-group-summary>${esc(nowText)}${group.target_audience?` · 대상 ${esc(group.target_audience)}`:''}</p></div><span class="group-detail-link">상세보기</span></summary><div class="monitor-group-body">${groupContentTopicsMarkup(group)}${group.waiting_area_note?`<div class="floor-reason-note"><b>고객 대기공간</b><span>${esc(group.waiting_area_note)}</span></div>`:''}${group.signage_reason?`<div class="floor-reason-note"><b>왜 송출하나요?</b><span>${esc(group.signage_reason)}</span></div>`:''}<div class="monitor-room-grid staff-monitor-room-grid">${[...group.rooms].sort((a,b)=>roomProblemRank(a)-roomProblemRank(b)||(a.sort_order||0)-(b.sort_order||0)).map(roomCard).join('')}</div></div></details>`;
  }

  function roomCard(r){
    const p=patientForRoom(r.id),quick=isQuickSession(r),st=r.player_status||{},display=roomDisplayStatus(r),health=roomHealth(r),current=st.title||'대기 중',next=st.next_title||'',activeTreatment=p?.treatment||r.session_treatment||'';
    const audience=[p?.age_group||r.session_age_group,p?.gender||r.session_gender].filter(Boolean).map((v,i)=>i===0?ageLabel(v):genderLabel(v)).filter(x=>x!=='전체').join(' · '),manual=!!r.manual_active&&Array.isArray(r.manual_video_ids)&&r.manual_video_ids.length>0,defaultPlaylist=playlistById(r.default_playlist_id),currentVideo=currentVideoForRoom(r),on=staffIsOnline(r);
    const progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'';
    return `<details class="monitor-room staff-monitor-room health-${health}" data-room-card="${r.id}" data-health="${health}"><summary><div class="monitor-room-top"><div class="monitor-room-name"><span data-staff-live-dot class="dot ${on?'on':''}"></span><b>${esc(r.name)}</b></div><span class="room-status-badge status-${display.key}" data-staff-room-status>${esc(display.label)}</span></div><div class="monitor-current-thumb" data-staff-live-thumb>${staffThumbLink(currentVideo,'monitor-current-thumb-link','현재 영상 열기')}</div><div class="monitor-now"><span>우선순위 · ${esc(priorityLabel(st.priority||st.mode))}</span><b data-staff-live-title>${esc(current)}</b><small data-staff-live-detail>${displayControlMode(r)==='manual'?esc(roomIssueReason(r)):(on?`${esc(playbackLabel(st.playback_state))}${progress?` · ${progress}`:''}${roomIssueReason(r)?` · ${esc(roomIssueReason(r))}`:''}`:'오프라인 · 플레이어 연결 끊김')}</small></div><div class="monitor-next"><span>다음</span><b data-staff-live-next>${esc(next||'—')}</b></div><div class="monitor-card-foot"><span>${esc(roomTypeLabel(r.room_mode))}${manual?' · 개별 영상':activeTreatment?` · ${esc(treatmentLabel(activeTreatment))}`:defaultPlaylist?` · ${esc(defaultPlaylist.name)}`:''}</span><b>관리</b></div></summary><div class="monitor-room-controls staff-room-control-body">
      ${audience?`<div class="room-output-note">맞춤 대상 · ${esc(audience)}</div>`:''}
      ${displayControlMode(r)==='manual'?`<div class="manual-display-panel"><b>수동 디스플레이</b><p>${esc(r.display_note||'현장에서 직접 영상 재생 상태를 확인합니다.')}</p><div class="staff-output-row manual-config-row"><span>기본 플레이리스트</span><select data-staff-playlist="${r.id}">${playlistOptions(r.default_playlist_id||'')}</select><button class="btn primary" data-staff-playlist-apply="${r.id}">설정 저장</button></div><small>원격 연결이 없어도 설정은 저장할 수 있습니다. 플레이어로 즉시 전송되지는 않습니다.</small><button class="btn ${r.manual_check_status==='checked'?'':'primary'}" data-manual-check="${r.id}">${r.manual_check_status==='checked'?'미확인으로 변경':'오늘 확인 완료'}</button></div>`:`<details class="staff-output-details"><summary>송출 영상 목록</summary>${staffOutputList(r)}</details><div class="staff-output-controls"><div class="staff-output-row"><span>플레이리스트</span><select data-staff-playlist="${r.id}">${playlistOptions(r.default_playlist_id||'')}</select><button class="btn primary" data-staff-playlist-apply="${r.id}">변경</button></div><div class="staff-output-row"><span>영상 추가</span><select data-staff-video="${r.id}">${videoOptions()}</select><button class="btn" data-staff-video-add="${r.id}">추가</button>${manual?`<button class="btn" data-staff-manual-clear="${r.id}">기본으로</button>`:''}</div></div><div class="room-player-actions hospital-room-player-actions"><span>환자 화면</span><div><button class="btn small" data-staff-player-open="${r.id}">실제 화면 보기</button><button class="btn small" data-staff-player-copy="${r.id}">TV 연결 주소 복사</button></div></div>`}
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
    bindFloorTvDragSort();
    qsa('[data-status-filter]').forEach(btn=>btn.addEventListener('click',()=>{
      const choice=btn.dataset.statusFilter;
      statusViewFilter=statusViewFilter===choice?'':choice;
      renderPreservingUi(false);
      if(statusViewFilter)requestAnimationFrame(()=>qs('#hospitalStatusResults')?.scrollIntoView({behavior:'smooth',block:'nearest'}));
    }));
    qs('[data-status-clear]')?.addEventListener('click',()=>{statusViewFilter='';renderPreservingUi(false);});
    qsa('[data-status-open-room]').forEach(btn=>btn.addEventListener('click',()=>{
      const room=roomById(btn.dataset.statusOpenRoom);
      if(!room)return;
      const floor=state.groups.find(g=>g.id===room.group_id&&g.kind==='floor');
      if(!floor){toast('이 TV는 층이 지정되지 않았습니다. 병원 설정에서 층을 먼저 배정해 주세요.','error');return;}
      selectedFloorId=floor.id;
      qs('#unifiedTvOperations')?.setAttribute('open','');
      statusViewFilter='';
      renderPreservingUi(false);
      requestAnimationFrame(()=>{if(!openInlineTvDetail(room.id))qs('.hospital-floor-console-card')?.scrollIntoView({behavior:'smooth',block:'start'});});
    }));

    qsa('[data-ops-layout-toggle],[data-ops-layout-open]').forEach(b=>b.addEventListener('click',()=>{
      layoutPanelOpen=b.hasAttribute('data-ops-layout-open')?true:!layoutPanelOpen;
      if(layoutPanelOpen){spaceEditorGroupId=selectedFloorId||state.groups.find(g=>g.kind==='floor')?.id||null;layoutEditMode='display';spaceRedrawId=null;layoutPlacementRoomId=null;layoutCopyOpen=false;}
      renderPreservingUi(false);
      if(layoutPanelOpen)requestAnimationFrame(()=>qs('#hospitalLayoutWorkspace')?.scrollIntoView({behavior:'smooth',block:'start'}));
    }));
    qs('[data-ops-go-layout]')?.addEventListener('click',()=>{
      tab='videos';qs('#unifiedTvOperations')?.setAttribute('open','');layoutPanelOpen=true;spaceEditorGroupId=selectedFloorId||state.groups.find(g=>g.kind==='floor')?.id||null;layoutEditMode='display';spaceRedrawId=null;layoutPlacementRoomId=null;layoutCopyOpen=false;
      renderPreservingUi(false);requestAnimationFrame(()=>qs('#hospitalLayoutWorkspace')?.scrollIntoView({behavior:'smooth',block:'start'}));
    });
    qs('#staffStatusRefresh')?.addEventListener('click',event=>{void refreshVisibleStatuses(event.currentTarget);});qs('#hospitalBroadcastStart')?.addEventListener('click',()=>setHospitalBroadcast(true));qs('#hospitalBroadcastStop')?.addEventListener('click',()=>setHospitalBroadcast(false));qsa('[data-staff-open-settings]').forEach(b=>b.addEventListener('click',()=>{qs('#unifiedHospitalSettings')?.setAttribute('open','');qs('#unifiedHospitalSettings')?.scrollIntoView({behavior:'smooth',block:'start'});}));qsa('[data-staff-select-area]').forEach(b=>b.addEventListener('click',()=>{selectedFloorArea=b.dataset.staffSelectArea||null;selectedFloorId=null;renderPreservingUi(false);}));qs('[data-staff-change-area]')?.addEventListener('click',()=>{selectedFloorArea=null;selectedFloorId=null;renderPreservingUi(false);});qsa('[data-staff-select-floor]').forEach(b=>{const open=()=>{const id=b.dataset.staffSelectFloor;if(selectedFloorId!==id){selectedFloorId=id;spaceEditorGroupId=id;spaceRedrawId=null;layoutPlacementRoomId=null;layoutEditMode='display';layoutCopyOpen=false;}renderPreservingUi(false);};b.addEventListener('click',open);b.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});});
    const floorStage=qs('.building-floor-plan-stage');
    const setFloorFocus=(kind,id,contextSpaceId=null)=>{if(!floorStage)return;floorStage.classList.add('has-map-focus');floorStage.dataset.focusKind=kind;floorStage.dataset.focusId=id;qsa('[data-staff-floor-room]',floorStage).forEach(x=>{const active=kind==='display'&&x.dataset.staffFloorRoom===id;const room=state.rooms.find(r=>r.id===x.dataset.staffFloorRoom);const linkedSpace=room?roomSpace(room)||spaceContainingPoint(room.group_id,room.map_x_pct,room.map_y_pct):null;const context=(kind==='space'&&linkedSpace?.id===id)||(kind==='display'&&contextSpaceId&&linkedSpace?.id===contextSpaceId);x.classList.toggle('is-selected',active);x.classList.toggle('is-focus-context',!!context);});qsa('[data-floor-space]',floorStage).forEach(x=>{const active=kind==='space'&&x.dataset.floorSpace===id;const context=kind==='display'&&contextSpaceId&&x.dataset.floorSpace===contextSpaceId;x.classList.toggle('is-selected-space',active);x.classList.toggle('is-focus-context',!!context);});};
    qsa('.floor-ops-tv [data-staff-open-room-detail]').forEach(b=>b.addEventListener('click',()=>openInlineTvDetail(b.dataset.staffOpenRoomDetail)));
    // Inline display management: same TV card as the user's playback controls.
    qsa('[data-tv-rename]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();void renameHospitalDisplay(b.dataset.tvRename);}));
    qsa('[data-tv-delete]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();void deleteHospitalDisplay(b.dataset.tvDelete);}));
    qsa('[data-tv-unplace]').forEach(b=>b.addEventListener('click',async e=>{
      e.stopPropagation();const r=roomById(b.dataset.tvUnplace);if(!r)return;
      if(!roomMapPlaced(r))return toast('이미 위치가 해제된 TV입니다.','error');
      if(!window.confirm(`'${r.name}'의 도면 위치만 해제할까요?\n\nTV와 영상 설정은 삭제되지 않습니다. 위치 해제가 완료되면 이 카드에서 TV 삭제가 가능합니다.`))return;
      b.disabled=true;
      try{await saveDisplaySetup(r.id,null,null,displayControlMode(r),null);await load();}
      catch(err){toast(err?.message||'위치 해제 중 오류가 발생했습니다.','error');b.disabled=false;}
    }));

    qsa('[data-staff-floor-room]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const id=b.dataset.staffFloorRoom,r=state.rooms.find(x=>x.id===id),inspector=qs('[data-staff-floor-zone-inspector]');if(r&&inspector){const linkedSpace=roomSpace(r)||spaceContainingPoint(r.group_id,r.map_x_pct,r.map_y_pct);setFloorFocus('display',id,linkedSpace?.id||null);inspector.innerHTML=staffFloorRoomPreviewHtml(r);const open=qs('[data-staff-open-room-detail]',inspector);if(open)open.addEventListener('click',()=>openInlineTvDetail(id));}}));
    qsa('.building-floor-plan-stage [data-floor-space]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const id=b.dataset.floorSpace,sp=state.floorSpaces.find(x=>x.id===id),inspector=qs('[data-staff-floor-zone-inspector]');if(!sp||!inspector)return;setFloorFocus('space',id);inspector.innerHTML=staffFloorSpacePreviewHtml(sp);}));
    floorStage?.addEventListener('click',e=>{if(e.target.closest('[data-staff-floor-room],[data-floor-space]'))return;floorStage.classList.remove('has-map-focus');delete floorStage.dataset.focusKind;delete floorStage.dataset.focusId;qsa('.is-selected,.is-selected-space,.is-focus-context',floorStage).forEach(x=>x.classList.remove('is-selected','is-selected-space','is-focus-context'));const inspector=qs('[data-staff-floor-zone-inspector]');if(inspector)inspector.innerHTML='<div class="floor-zone-inspector-empty"><div><b>디스플레이 또는 공간을 선택하세요.</b></div><p>운영 목적과 현재 영상을 확인할 수 있습니다.</p></div>';});

    qsa('#hospitalRoot select').forEach(el=>el.addEventListener('change',()=>{el.dataset.dirty='1';}));
    qsa('[data-staff-playlist-apply]').forEach(b=>b.addEventListener('click',()=>setRoomPlaylist(b.dataset.staffPlaylistApply,b)));
    qsa('[data-staff-player-open]').forEach(b=>b.addEventListener('click',()=>openRoomPlayer(b.dataset.staffPlayerOpen)));
    qsa('[data-staff-player-copy]').forEach(b=>b.addEventListener('click',()=>copyRoomPlayer(b.dataset.staffPlayerCopy)));
    qsa('[data-staff-video-add]').forEach(b=>b.addEventListener('click',()=>addRoomVideo(b.dataset.staffVideoAdd,b)));
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
    const signalled=signal&&room?await signalRoom(room):false;
    /* TVs poll (no Realtime): say when the change will show instead of implying it is instant. */
    const syncNote=signal&&signalled&&!Signage.playerRealtimeEnabled()?` · TV 반영까지 최대 약 ${Math.ceil(Math.max(30000,Number(Signage.cfg.pollMs)||120000)*1.15/60000)}분`:'';
    if(okMessage)toast(signalled||!signal?`${okMessage}${syncNote}`:'설정은 저장됐지만 화면에 변경 신호를 전달하지 못했습니다. 플레이어 자동 동기화를 확인하세요.',signalled||!signal?undefined:'error');
    await load().catch(e=>toast(e.message||String(e),'error'));
    if(room&&signal&&signalled)void confirmDelivery(room,issuedAt);
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
    let changed=0;
    (res.rows||[]).forEach(row=>{seen.delete(row.room_id);const a=ackState.get(row.room_id);if(a&&monitor.verdict(row,a.at)==='ok')ackState.delete(row.room_id);if(mergePlayerLiveStatus(row))changed++;});
    seen.forEach((lastSeen,roomId)=>{const r=roomById(roomId);if(r&&lastSeen)r.last_seen_at=lastSeen;});
    /* One summary repaint per result instead of one per row (was O(rows x rooms)). */
    if(changed)paintStaffSummary();
  }
  const roomForPatient=(id)=>state.patients.find(p=>p.id===id)?.room_id||null;

  async function setRoomPlaylist(room,source){
    const container=source?.closest('.floor-ops-tv,.floor-room-focus,.staff-room-control-body');
    const playlist=(container?.querySelector(`[data-staff-playlist="${room}"]`)||qs(`[data-staff-playlist="${room}"]`))?.value; if(!playlist)return toast('플레이리스트를 선택하세요.','error');
    await staffControl(room,()=>db.rpc('staff_set_room_playlist',{p_room:room,p_playlist:playlist}),displayControlMode(roomById(room))==='manual'?'수동 디스플레이 설정을 저장했습니다.':'공간 플레이리스트를 변경했습니다.',{signal:displayControlMode(roomById(room))!=='manual'});
  }
  async function addRoomVideo(room,source){
    const container=source?.closest('.floor-ops-tv,.staff-room-control-body');
    const video=(container?.querySelector(`[data-staff-video="${room}"]`)||qs(`[data-staff-video="${room}"]`))?.value; if(!video)return toast('추가할 영상을 선택하세요.','error');
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
    const thumb=qs('[data-staff-live-thumb]',card),thumbKey=String(video?.id||'');if(thumb&&thumb.dataset.videoId!==thumbKey){thumb.innerHTML=staffThumbLink(video,'monitor-current-thumb-link','현재 영상 열기');thumb.dataset.videoId=thumbKey;}
    const title=qs('[data-staff-live-title]',card);if(title)title.textContent=displayControlMode(r)==='manual'?'현장 수동 운영':(st.title||'대기 중');
    const next=qs('[data-staff-live-next]',card);if(next)next.textContent=st.next_title||'—';
    const detail=qs('[data-staff-live-detail]',card);if(detail)detail.textContent=displayControlMode(r)==='manual'?roomIssueReason(r):(on?`${playbackLabel(st.playback_state)}${progress?` · ${progress}`:''} · ${roomIssueReason(r)}`:`${display.label} · ${roomIssueReason(r)}`);
  }
  function paintStaffSummary(){
    const statuses=state.rooms.map(roomDisplayStatus),live=statuses.filter(x=>x.key==='live').length,offline=statuses.filter(x=>x.key==='offline').length,manual=state.rooms.filter(r=>displayControlMode(r)==='manual').length,unverified=state.rooms.length-manual-live;
    const set=(sel,val)=>{const el=qs(sel);if(el)el.textContent=String(val);};set('[data-staff-stat-total]',state.rooms.length);set('[data-staff-stat-live]',live);set('[data-staff-stat-issues]',unverified);set('[data-staff-stat-offline]',offline);set('[data-staff-stat-online]',state.rooms.filter(r=>displayControlMode(r)!=='manual'&&staffIsOnline(r)).length);
    set('[data-staff-stat-idle]',manual);
    qsa('[data-ops-state]').forEach(el=>{const r=roomById(el.dataset.opsState);if(!r)return;const s=roomDisplayStatus(r);el.className=`floor-ops-state status-${s.key}`;el.textContent=visibleTvStatus(s);el.closest('.floor-ops-tv')?.setAttribute('class',`floor-ops-tv status-${s.key}`);});
    qsa('[data-ops-video]').forEach(el=>{const r=roomById(el.dataset.opsVideo);if(r)el.textContent=displayControlMode(r)==='manual'?'현장 수동 운영':(currentVideoForRoom(r)?.title||r.player_status?.title||'현재 재생 영상 없음');});
    qsa('[data-ops-reason]').forEach(el=>{const r=roomById(el.dataset.opsReason);if(r)el.textContent=roomIssueReason(r)||(roomDisplayStatus(r).key==='idle'?'TV 연결됨 · 재생 대기':' ');});
    qsa('[data-ops-floor-status]').forEach(el=>{const group=state.groups.find(g=>g.id===el.dataset.opsFloorStatus);if(!group)return;const rs=state.rooms.filter(r=>r.group_id===group.id);const hasPlaybackIssue=rs.some(r=>['error','update'].includes(roomDisplayStatus(r).key));el.innerHTML=floorStatusDots(rs);el.closest('.hospital-floor-row')?.classList.toggle('has-issue',hasPlaybackIssue);});
    groupedRooms().forEach(g=>paintStaffGroup(g));
    /* Floor-plan space colours were computed only on full render, so they went stale while the
       TV badges next to them updated. Repaint them with the same 5s summary pass. */
    qsa('.building-floor-plan-stage .floor-space-overlay[data-floor-space]:not(.is-editable)').forEach(el=>{const sp=state.floorSpaces.find(x=>x.id===el.dataset.floorSpace);if(!sp)return;const st=floorSpaceBroadcastStatus(sp);el.classList.toggle('status-live',st.key==='live');el.classList.toggle('status-offline',st.key==='offline');el.classList.toggle('status-empty',st.key==='empty');const t=`${sp.name} · ${st.label}`;if(el.title!==t){el.title=t;el.setAttribute('aria-label',t);}});
  }
  function paintStaffGroup(group){
    const card=qs(`[data-staff-group="${group.id}"]`);if(!card)return;const x=groupStatusSummary(group.rooms),set=(sel,val)=>{const el=qs(sel,card);if(el)el.textContent=String(val);};
    card.className=`monitor-group staff-monitor-group group-state-${x.key}`;const badge=qs('[data-staff-group-status]',card);if(badge){badge.className=`group-status-badge status-${x.key}`;badge.textContent=x.label;}set('[data-staff-group-total]',x.total);set('[data-staff-group-live]',x.live);set('[data-staff-group-online]',x.online);set('[data-staff-group-issues]',x.issues);const p=qs('[data-staff-group-summary]',card);if(p)p.textContent=x.key==='live'?`${x.live}곳 송출 중`:x.key==='issue'?`문제 공간 ${x.issues}곳`:x.key==='offline'?'모든 공간 연결 끊김':'현재 재생 대기';
  }
  function mergePlayerLiveStatus(live){
    if(!live?.room_id)return false;const r=roomById(live.room_id);if(!r)return false;
    r.last_seen_at=live.last_seen_at||r.last_seen_at;r.player_status=live.player_status||r.player_status;
    updateStaffRoomDom(r);return true;
  }
  let stateReloadTimer=null;
  /* A staff action already reloads after its own write. Its player_control_signals echo
     arrives ~100ms later and used to trigger a second full reception-state load. Skip the
     echo when a load started after the signal was received. */
  function scheduleStaffStateReload(){const signalAt=Date.now();clearTimeout(stateReloadTimer);stateReloadTimer=setTimeout(()=>{if(document.hidden||busy||lastLoadStartedAt>=signalAt-50)return;load({background:true}).catch(()=>{});},250);}

  // User-initiated check reads current persisted player status without reloading
  // playlists, floor plans, or draft settings. It cannot force a disconnected TV
  // to report immediately; the displayed presence age remains authoritative.
  let manualStatusRefreshInFlight=false;
  async function refreshVisibleStatuses(button){
    if(manualStatusRefreshInFlight||document.hidden)return;
    manualStatusRefreshInFlight=true;
    if(button){button.disabled=true;button.textContent='확인 중…';}
    try{
      const result=await monitor.fetchStatus({roomIds:state.rooms.map(r=>r.id)});
      applyLiveResult(result);
      for(const r of state.rooms)updateStaffRoomDom(r);
      paintStaffSummary();
      toast('최근 보고된 TV 상태를 확인했습니다.');
    }catch(e){
      toast(`TV 상태 확인 실패 · ${e?.message||String(e)}`,'error');
    }finally{
      manualStatusRefreshInFlight=false;
      if(button?.isConnected){button.disabled=false;button.textContent='새로고침';}
    }
  }
  async function refreshLiveRoom(roomId){
    if(!roomId||document.hidden)return;
    try{applyLiveResult(await monitor.fetchStatus({roomIds:[roomId]}));}catch(e){console.warn('Clinic Signage hospital room status refresh failed:',e?.message||e);}
  }
  function queueLiveRoomRefresh(roomId){
    if(!roomId||!roomById(roomId))return;clearTimeout(statusWakeTimers.get(roomId));
    statusWakeTimers.set(roomId,setTimeout(()=>{statusWakeTimers.delete(roomId);void refreshLiveRoom(roomId);},80));
  }
  let verificationCursor=0;
  let verificationBusy=false;
  async function verifyUncertainPlayback(){
    if(document.hidden||busy||verificationBusy)return;
    const candidates=state.rooms.filter(r=>displayControlMode(r)!=='manual'&&['idle','delayed'].includes(roomDisplayStatus(r).key)&&roomHealth(r)!=='offline');
    if(!candidates.length)return;
    const start=verificationCursor%candidates.length;
    const ids=Array.from({length:Math.min(4,candidates.length)},(_,i)=>candidates[(start+i)%candidates.length].id);
    verificationCursor=(start+ids.length)%candidates.length;
    verificationBusy=true;
    try{applyLiveResult(await monitor.fetchStatus({roomIds:ids}));}
    catch(e){console.warn('Clinic Signage playback verification failed:',e?.message||e);}
    finally{verificationBusy=false;}
  }
  function stopRealtime(){
    try{if(signalChannel)db.removeChannel(signalChannel);if(statusWakeChannel)db.removeChannel(statusWakeChannel);}catch(_){}
    signalChannel=null;statusWakeChannel=null;
  }
  function startRealtime(){
    // Control changes reload staff configuration. Status changes wake a one-room RPC refresh;
    // the 30s delta poll remains only as loss recovery.
    stopRealtime();
    try{
      const siteId=state.site?.id||targetSiteId;
      if(siteId)signalChannel=db.channel(`clinic-hospital-signal:${siteId}`).on('postgres_changes',{event:'*',schema:'public',table:'player_control_signals',filter:`site_id=eq.${siteId}`},scheduleStaffStateReload).subscribe();
      statusWakeChannel=db.channel(`clinic-signage-status:${state.site?.id||'unknown'}`)
        .on('broadcast',{event:'changed'},({payload})=>queueLiveRoomRefresh(payload?.room_id))
        .subscribe();
    }catch(_){}
  }

  try{await load();startRealtime();monitor.start(Signage.cfg.livePollMs);}catch(e){qs('#hospitalRoot').innerHTML=`<p class="error">${esc(e.message||e)}</p>`;}
  /* Every second only playing rooms change (progress estimate). Age-based health
     (delayed/offline) and the summaries are refreshed every 5 seconds. */
  let uiTick=0;
  const uiTimer=setInterval(()=>{
    if(document.hidden)return;
    const full=(++uiTick%5)===0;
    for(const r of state.rooms){if(full||String(r.player_status?.playback_state||'').toLowerCase()==='playing')updateStaffRoomDom(r);}
    if(full)paintStaffSummary();
  },1000);
  const verifyTimer=setInterval(()=>{void verifyUncertainPlayback();},60000);
  function stopPageRuntime(){clearInterval(verifyTimer);clearTimeout(stateReloadTimer);statusWakeTimers.forEach(clearTimeout);statusWakeTimers.clear();monitor.stop();stopRealtime();}
  window.addEventListener('pagehide',stopPageRuntime);
  window.addEventListener('pageshow',e=>{if(e.persisted){startRealtime();monitor.start(Signage.cfg.livePollMs);void load({background:true}).catch(()=>{});}});
  window.addEventListener('beforeunload',()=>{clearInterval(uiTimer);stopPageRuntime();});
})();
