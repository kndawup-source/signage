(async function () {
  'use strict';
  // TV 업데이트 상태 (common.js 버전과 무관하게 동작하도록 이 파일 안에 둔다)
  // 'pending'은 TV가 현재 영상이 끝나면 알아서 적용하는 정상 대기라 문제로 세지 않는다.
  function playerUpdateState(st){
    const err=String(st?.update_error||'');
    if(err.startsWith('version_mismatch'))return {key:'mismatch',issue:true,label:'배포 버전 불일치',detail:'새로고침해도 이전 버전이 실행됨 · 배포 파일 확인 필요'};
    if(err)return {key:'error',issue:true,label:'업데이트 확인 실패',detail:'버전 확인이 계속 실패함 · 네트워크 확인'};
    if(st?.update_pending_version)return {key:'pending',issue:false,label:'업데이트 대기',detail:`v${st.update_pending_version} · 현재 영상이 끝나면 자동 적용`};
    return null;
  }

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
  const CONTROL_MODES=[['remote','원격 관리'],['manual','수동 운영'],['hybrid','원격·현장 관리']];
  let state={site:null,siteSettings:{},buildingAsset:{},floorplanAssets:{},floorSpaces:[],floorplanVersions:[],patients:[],rooms:[],groups:[],playlists:[],videos:[],playlistItems:[],roomRules:[],broadcast:{active:false}}, busy=false, signalChannel=null,statusWakeChannel=null,settingsOpen=false,spaceEditorGroupId=null,spaceRedrawId=null,layoutEditMode='display',layoutCopyOpen=false,layoutPlacementRoomId=null,selectedFloorId=null,layoutPanelOpen=false,combinedCreateMode='both',combinedPlacementQueue=[],combinedSourceSpaceId=null,tab='videos',statusViewFilter='',tvOperationsExpanded=true;
  const Catalog=window.SignageCatalog;
  const catalogConfig=()=>state.site?.catalog_config||null;
  const catalogEntries=(category,selected)=>Catalog.entries(catalogConfig(),category,selected);
  let catalogDraft=null,catalogDirty=false,catalogSaving=false;
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
  async function signalRoom(room){try{const {error}=await db.rpc('signal_signage_rooms',{p_room_ids:[room],p_group:null,p_all:false});if(error)throw error;return true;}catch(e){console.warn('Clinic Signage signal failed:',e);toast('영상 변경 알림을 TV에 보내지 못했습니다. TV가 다시 연결되면 변경될 수 있습니다.','error');return false;}}

  const treatmentLabel=(v)=>Catalog.label(catalogConfig(),'treatments',v,'일반 진료');
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
    return `<button type="button" class="staff-video-copy-btn ${extraClass}" data-staff-video-link-copy="${esc(video.id)}" aria-label="${esc(video.title||'영상')} 영상 주소 복사" title="영상 파일 주소 복사" ${available?'':'disabled'}>영상 주소 보기</button>`;
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
      toast('영상 주소를 복사했습니다. 이 주소를 따로 열어도 TV 재생 상태에는 표시되지 않습니다.');
    }catch(e){toast('링크 복사에 실패했습니다. 브라우저 권한을 확인하세요.','error');}
  }
  // 설치형 플레이어: TV 화면의 6자리 코드로 이 디스플레이에 연결
  // 설치형 플레이어: TV 화면의 6자리 코드로 이 디스플레이에 연결.
  // 이미 기기가 연결된 적 있는 디스플레이는 '디스플레이당 1대' 원칙에 따라 기존 기기를 해제하고 교체한다(확인창).
  async function pairRoomPlayer(roomId,button){
    if(!dbFeature('pairing_v2'))return toast(dbVersionMessage(),'error');
    const input=qsa('[data-tv-pair-input]').find(x=>x.dataset.tvPairInput===roomId);
    const code=String(input?.value||'').replace(/\D/g,'');
    if(code.length!==6){toast('TV 화면에 표시된 6자리 숫자를 입력하세요.','error');input?.focus();return;}
    const r=roomById(roomId);
    if(button)button.disabled=true;
    try{
      let {data,error}=await db.rpc('hospital_pair_display',{p_room:roomId,p_code:code,p_replace:false});
      if(error)throw error;
      if(data?.error==='replace_required'){
        if(!confirm(`${r?.name||'TV'}\n\n기존 연결 주소와 기기를 해제하고 새 기기로 교체할까요?`))return;
        ({data,error}=await db.rpc('hospital_pair_display',{p_room:roomId,p_code:code,p_replace:true}));
        if(error)throw error;
      }
      if(!data?.ok){toast(data?.message||'연결하지 못했습니다.','error');input?.focus();return;}
      if(input)input.value='';
      toast(`${data.room_name||'디스플레이'}의 연결을 승인했습니다${data.replaced?' (기존 기기 해제됨)':''}. 몇 초 안에 TV에서 영상이 시작됩니다.`);
      await load();
    }catch(e){
      toast(Signage.isMissingFunction?.(e)?dbVersionMessage():String(e?.message||e).replace(/^.*?ERROR:\s*/,''),'error');
    }finally{if(button)button.disabled=false;}
  }
  async function resetRoomPlayerKey(roomId,button){
    if(!dbFeature('display_key_reset'))return toast(dbVersionMessage(),'error');
    const r=roomById(roomId);if(!r)return;
    if(!confirm(`${r.name}\n\n기존 기기의 연결을 해제합니다.\n이 디스플레이에 연결된 설치형 플레이어와 기존 TV 연결 주소는 서버 접근이 차단됩니다. 오프라인 기기는 서버에 다시 연결하면 송출을 중단합니다.\n다시 송출하려면 새 연결 코드로 연결하거나 새 TV 연결 주소를 사용해야 합니다.\n\n연결을 해제할까요?`))return;
    if(button)button.disabled=true;
    try{
      const {data,error}=await db.rpc('hospital_reset_display_key',{p_room:roomId});
      if(error)throw error;
      if(!data?.ok)return toast(data?.message||'연결을 해제하지 못했습니다.','error');
      toast(`${data.room_name||'디스플레이'}의 기존 기기 연결을 해제했습니다.`);
      await load();
    }catch(e){toast(Signage.isMissingFunction?.(e)?dbVersionMessage():String(e?.message||e),'error');}
    finally{if(button)button.disabled=false;}
  }
  async function copyRoomPlayer(roomId){
    try{const path=await roomPlayerPath(roomId);if(!path)throw new Error('환자 화면 주소를 찾을 수 없습니다.');const url=new URL(path,location.origin).href;if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(url);else{const ta=document.createElement('textarea');ta.value=url;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();}toast('TV 연결 주소를 복사했습니다. 이 주소를 TV 브라우저에 등록하세요.');}
    catch(e){toast(e.message||String(e),'error');}
  }
  const playlistById=(id)=>state.playlists.find(p=>p.id===id)||null;
  const roomTypeLabel=(v)=>({treatment:'진료실',consultation:'상담실',waiting:'대기실',lounge:'라운지',reception:'접수/안내',lobby:'로비',public:'공용 모니터',staff:'스탭 공간',vip:'VIP',other:'기타'})[v]||'공간';
  const isPatientRoom=(r)=>['treatment','consultation'].includes(r.room_mode);
  const playlistOptions=(selected='')=>`<option value="">재생목록 선택</option>${state.playlists.filter(p=>p.active!==false).map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}${p.kind==='patient'?' · 맞춤':''}</option>`).join('')}`;
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
    if(['broadcast','broadcast_schedule'].includes(mode))return '병원 전체 영상';
    if(['group','group_schedule'].includes(mode))return '층 전체 영상';
    if(r.manual_active&&r.manual_video_ids?.length)return '개별 영상';
    if(mode==='patient')return staffPatientPlaylist(r)?.name||'환자 맞춤 영상';
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
    const fallback={reception:'접수하는 곳에서 안내 영상을 보여주는 TV입니다.',waiting:'기다리는 고객에게 안내 영상을 보여주는 TV입니다.',lounge:'라운지에서 병원 안내 영상을 보여주는 TV입니다.',consultation:'상담에 도움이 되는 영상을 보여주는 TV입니다.',treatment:'진료 중 필요한 안내 영상을 보여주는 TV입니다.',lobby:'길 안내와 병원 소식을 보여주는 TV입니다.',public:'여러 사람이 함께 보는 안내 TV입니다.',staff:'직원이 필요한 정보를 확인하는 TV입니다.',support:'직원 업무에 필요한 정보를 보여주는 TV입니다.',other:'이곳에서 안내 영상을 보여주는 TV입니다.'};
    return fallback[type]||fallback.other;
  }
  function spaceOperationalPurpose(sp){
    const g=state.groups.find(x=>x.id===sp?.group_id)||null;
    const groupPurpose=String(g?.signage_purpose||g?.content_intro||'').trim();
    if(groupPurpose)return groupPurpose;
    const fallback={reception:'고객이 접수하고 안내를 받는 곳입니다.',waiting:'고객이 차례를 기다리는 곳입니다.',lounge:'고객이 잠시 쉬는 곳입니다.',consultation:'고객이 상담받는 곳입니다.',treatment:'고객이 진료받는 곳입니다.',lobby:'고객이 이동하며 안내를 확인하는 곳입니다.',public:'여러 사람이 함께 쓰는 곳입니다.',staff:'직원이 일하는 곳입니다.',support:'직원 업무를 돕는 곳입니다.',other:'병원 안의 공간입니다.'};
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
  function journeyReasonPanel(meta, purpose){
    return `<div class="journey-summary"><div><small>어떤 곳인가요?</small><b>${esc(meta.stage)}</b><span>${esc(meta.need)}</span></div><div><small>무슨 내용을 보여주나요?</small><b>${esc(meta.content)}</b><span>${esc(meta.why)}</span></div></div><div class="journey-operating-purpose"><small>왜 보여주나요?</small><p>${esc(purpose||'이곳에서 필요한 정보를 알려주기 위해서입니다.')}</p></div>`;
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
    const c=tvCounts(rooms);
    const key=c.issue?'issue':c.live?'live':c.standby?'standby':c.unpaired?'unpaired':'manual';
    return {key,label:TV_CAT_LABEL[key]};
  }
  // One shared inspector for both map selection targets. A space selects its TVs,
  // while a display selects one TV. All controls operate on a specific display.
  // Space marker and TV marker share the same layout, explanation, and controls.
  // A TV marker only highlights that TV; it never switches to an unrelated detail card.
  function mapSelectionInspector({space=null,room=null}={}){
    // Both map markers render the same place. TV selection changes only the highlighted row.
    const linkedSpace=space||(room?(roomSpace(room)||spaceContainingPoint(room.group_id,room.map_x_pct,room.map_y_pct)):null);
    const rooms=linkedSpace?roomsForFloorSpace(linkedSpace):(room?[room]:[]);
    if(room&&!rooms.some(r=>String(r.id)===String(room.id)))rooms.push(room);
    const group=state.groups.find(g=>g.id===(linkedSpace?.group_id||room?.group_id))||null;
    const heading=linkedSpace?.name||room?.name||'TV 정보';
    const location=group?.name||'병원';
    const overall=linkedSpace?floorSpaceBroadcastStatus(linkedSpace):room?roomDisplayStatus(room):{key:'empty',label:'TV 없음'};
    const rows=rooms.map(r=>{
      const summary=roomVideoSummary(r),current=summary.video,status=roomDisplayStatus(r),isManual=displayControlMode(r)==='manual';
      const videoTitle=isManual?'현장에서 관리하는 TV':summary.title;
      const configured=String(r.default_playlist_id||group?.default_playlist_id||'');
      const opts=state.playlists.filter(p=>p.active!==false&&(p.site_id===targetSiteId||p.site_id==null)).map(p=>`<option value="${esc(p.id)}" ${String(p.id)===configured?'selected':''}>${esc(p.name)}${p.site_id==null?' · 공용':''}</option>`).join('');
      const selected=room&&String(r.id)===String(room.id);
      const panelId=`mapTvManage-${r.id}`;
      return `<article class="space-simple-tv-card ${selected?'is-map-selected-tv':''}" data-map-tv-row="${esc(r.id)}">
        <div class="space-simple-tv-row">
          <div class="space-simple-tv-thumb">${staffFloorInlineThumb(current,'floor-space-current-thumb','현재 영상 보기')}</div>
          <div class="space-simple-tv-info"><strong>${esc(r.name)}</strong><span class="space-simple-video-title">${esc(videoTitle)}</span><small>${esc(isManual?'현장에서 관리하는 TV':summary.detail)} · ${esc(playlistById(configured)?.name||'재생목록 미지정')}</small><small>${esc(status.label)}</small></div>
          <button type="button" class="btn small map-tv-toggle" data-map-tv-toggle="${esc(r.id)}" aria-expanded="false" aria-controls="${esc(panelId)}">TV 관리 <span aria-hidden="true">▾</span></button>
        </div>
        <div class="map-tv-manage-body" id="${esc(panelId)}" data-map-tv-panel="${esc(r.id)}" hidden>
          <div class="map-tv-manage-heading"><strong>${esc(r.name)} · 영상 바꾸기</strong><small>선택한 재생목록을 이 TV에 적용합니다.</small></div>
          <label for="mapPlaylist-${esc(r.id)}">보여줄 재생목록</label>
          <div class="map-tv-manage-picker"><select id="mapPlaylist-${esc(r.id)}" data-staff-playlist="${esc(r.id)}"><option value="">재생목록 선택</option>${opts}</select><button type="button" class="btn primary small" data-staff-playlist-apply="${esc(r.id)}">이 TV에 적용</button></div>
          <small class="map-tv-manage-help">이곳의 영상만 바뀝니다. 원본 영상은 삭제되지 않습니다.</small>
          <details class="map-tv-extra"><summary>다른 설정 보기</summary><div class="map-tv-extra-actions"><button type="button" class="btn small" data-tv-edit-playlist="${esc(r.id)}">재생목록 영상·순서 수정</button><button type="button" class="btn small" data-staff-open-room-detail="${esc(r.id)}">TV 이름·화면 문구·진단</button></div></details>
        </div>
      </article>`;
    }).join('');
    const journey=linkedSpace?journeyMetaForSpace(linkedSpace):room?journeyMetaForRoom(room):journeyCopyForType('other');
    const groupReason=String(linkedSpace?.content_reason||group?.signage_reason||'').trim();
    const reason=groupReason||(room?roomBroadcastReason(room):'이 공간을 이용하는 분들에게 필요한 안내 영상을 보여주기 위해서입니다.');
    const more=`<details class="space-simple-more"><summary>공간 설명 더 보기</summary><div class="space-simple-more-grid"><div><small>이곳은</small><b>${esc(journey.stage||'공간 이용 중')}</b><span>${esc(journey.need||'')}</span></div><div><small>주로 보여주는 내용</small><b>${esc(journey.content||'안내 영상')}</b><span>${esc(journey.why||'')}</span></div></div></details>`;
    return `<div class="floor-room-focus floor-space-focus floor-map-unified-inspector space-simple-inspector" data-map-inspector-kind="place">
      <div class="space-simple-header"><div class="space-simple-heading"><small>${esc(location)}</small><h3>${esc(heading)}</h3><span class="space-simple-heading-sub">TV ${rooms.length}대</span></div><div class="space-simple-header-end"><span class="space-simple-status status-${overall.key}">${esc(overall.label)}</span></div></div>
      <section class="space-simple-main" aria-label="이곳의 TV"><div class="space-simple-section-title">이곳의 TV</div><div class="space-simple-tv-list">${rows||'<div class="space-simple-empty">등록된 TV가 없습니다.</div>'}</div></section>
      ${linkedSpace?`<div class="space-simple-actions"><button type="button" class="btn small" data-map-edit-space="${esc(linkedSpace.id)}">공간 편집</button><button type="button" class="btn small primary" data-map-add-tv="${esc(linkedSpace.id)}">+ TV 추가</button></div>`:''}<details class="space-simple-more"><summary>송출 설명</summary><p>${esc(reason)}</p></details>
    </div>`;
  }
  function staffFloorSpacePreviewHtml(sp){return mapSelectionInspector({space:sp});}
  function staffFloorRoomPreviewHtml(r){return mapSelectionInspector({room:r});}
  // Every visible output has an action. Its source determines what can safely be changed.
  function staffOutputList(r){
    const items=staffRoomOutputItems(r);
    const mode=String(r.player_status?.mode||'');
    const overridden=['broadcast','broadcast_schedule','group','group_schedule','emergency'].includes(mode);
    const manualIds=new Set((r.manual_active&&Array.isArray(r.manual_video_ids)?r.manual_video_ids:[]).map(String));
    const playlistId=r.default_playlist_id||state.groups.find(g=>g.id===r.group_id)?.default_playlist_id||state.playlists.filter(p=>p.active!==false&&p.kind==='default').sort((a,b)=>(a.sort_order||0)-(b.sort_order||0))[0]?.id||'';
    const baseIds=new Set(playlistId?state.playlistItems.filter(x=>String(x.playlist_id)===String(playlistId)).map(x=>String(x.video_id)):[]);
    return `<div class="staff-output-list staff-output-readonly">${items.map((x,i)=>{
      const id=String(x.id);
      const kind=overridden?'override':manualIds.has(id)?'manual':baseIds.has(id)?'playlist':'other';
      const label=kind==='override'?'송출 설정 확인':kind==='other'?'편집 위치 확인':'목록에서 제거';
      return `<div class="staff-output-item">${staffThumbLink(x.video,'staff-output-thumb','영상 열기')}<span class="staff-output-item-name"><b>${esc(x.video.title)}</b><small>${x.rule?.enabled===false?'TV에서 제외됨':`${i+1}번 영상`}${kind==='manual'?' · TV에 따로 지정한 영상':kind==='override'?' · 우선 재생':''}</small></span><button type="button" class="btn small staff-output-remove" data-tv-remove-video="${esc(id)}" data-room="${esc(r.id)}" data-remove-kind="${kind}" aria-label="${esc(x.video.title)} · ${label}">${label}</button></div>`;
    }).join('')||'<span class="muted">재생 가능한 영상이 없습니다.</span>'}</div>`;
  }

  const displayControlMode=(r)=>String(r?.display_control_mode||'remote');
  const displayControlLabel=(r)=>CONTROL_MODES.find(([v])=>v===displayControlMode(r))?.[1]||'원격 관리';
  const roomHealth=(r)=>Signage.roomHealth(r,monitor.serverNow());
  const staffIsOnline=(r)=>{if(displayControlMode(r)==='manual'||!r?.last_seen_at)return false;const h=roomHealth(r),st=r.player_status||{};return st.online!==false&&['normal','error','recovering'].includes(h);};
  // TV 상태는 Signage.tvStatus 하나로 판정한다 (대시보드·층별·상세·필터 공통).
  // 반환: {cat: live|standby|unpaired|issue|manual, key: 상세 상태, label: 상세 문구, catLabel: 분류 문구}
  function roomDisplayStatus(r){
    return Signage.tvStatus(r,{now:monitor.serverNow(),ack:ackState.get(r?.id),settings:state.site?.active===false?{weekday_enabled:false,saturday_enabled:false,sunday_enabled:false}:(state.siteSettings||{})});
  }
  const tvCat=(r)=>roomDisplayStatus(r).cat;
  const tvCounts=(rooms)=>{const c={live:0,standby:0,unpaired:0,issue:0,manual:0,total:0};(rooms||[]).forEach(r=>{c[tvCat(r)]+=1;c.total+=1;});return c;};
  const TV_CAT_LABEL=Signage.TV_CATEGORY_LABEL;
  const TV_CAT_ORDER=Signage.TV_CATEGORY_ORDER;

  // Classification uses only fresh player telemetry; a missing heartbeat cannot prove an internet fault.
  function playerCause(r){
    const s=r?.player_status||{};
    if(displayControlMode(r)==='manual')return {label:'현장 수동 운영',detail:'자동 진단 대상이 아닙니다.',action:'현장 담당자에게 확인하세요.'};
    const seen=r?.last_seen_at?new Date(r.last_seen_at).getTime():NaN;
    const age=Number.isFinite(seen)?monitor.serverNow()-seen:Infinity;
    if(age>12*60*1000)return {label:'플레이어 응답 없음',detail:'최근 상태 보고가 없습니다. 인터넷 장애·PC 종료·브라우저 종료 등을 구분할 수 없습니다.',action:'PC 전원, Edge 실행 여부, 네트워크를 현장에서 확인하세요.'};
    const play=String(s.playback_state||'').toLowerCase();
    if(s.online===false)return {label:'PC 네트워크 연결 없음',detail:'마지막 플레이어 보고에서 브라우저가 오프라인 상태였습니다.',action:'PC의 인터넷 연결과 네트워크 장비를 확인하세요.'};
    if(s.visibility_state==='hidden')return {label:'플레이어 탭 숨김',detail:'브라우저가 탭 숨김 또는 최소화 상태를 보고했습니다. 다른 창의 실제 가림 여부는 확인할 수 없습니다.',action:'플레이어 창을 전면에 표시하고 전체화면 상태를 확인하세요.'};
    if(s.visibility_state==='visible'&&s.window_focused===false)return {label:'플레이어 포커스 없음',detail:'다른 창이 활성화됐을 가능성이 있지만 실제 가림 여부는 확인되지 않았습니다.',action:'PC에서 다른 창이 플레이어를 가리는지 확인하세요.'};
    if(s.mode==='closed'||play==='closed'||s.operating_active===false)return {label:'운영시간 외',detail:'운영시간 설정에 따라 재생하지 않는 상태입니다.',action:'병원 운영시간과 예외 휴무 설정을 확인하세요.'};
    if(r.paused||play==='paused')return {label:'일시정지',detail:'TV가 일시정지 상태입니다.',action:'TV 일시정지 설정을 확인하세요.'};
    if(s.error||play==='error'||Number(s.failed_video_count||0)>0)return {label:'영상 재생 오류',detail:String(s.error||'일부 영상이 재생되지 않았습니다.').slice(0,140),action:'영상 파일·재생목록·코덱을 확인하세요.'};
    if(s.offline_cache_error)return {label:'영상 다운로드·캐시 문제',detail:String(s.offline_cache_error).slice(0,140),action:'영상 주소, 디스크 여유 공간, 인터넷 속도를 확인하세요.'};
    if(s.update_error)return {label:'업데이트 오류',detail:String(s.update_error).slice(0,140),action:'플레이어 업데이트 및 네트워크 상태를 확인하세요.'};
    if(play==='loading')return {label:'영상 준비 중',detail:'플레이어가 영상을 준비하는 중입니다.',action:'오래 지속되면 캐시와 파일 접근을 확인하세요.'};
    if(play==='stopped')return {label:'플레이어 중지 보고',detail:'플레이어가 종료 상태를 보고했습니다.',action:'브라우저와 자동 실행 프로그램을 확인하세요.'};
    if(['playing','emergency'].includes(play))return {label:'재생 중 보고',detail:'플레이어는 재생 중으로 보고했습니다. 실제 화면 출력 여부는 원격으로 확정할 수 없습니다.',action:'화면이 보이지 않으면 모니터 입력·창 겹침을 확인하세요.'};
    return {label:'원인 추가 확인 필요',detail:'최근 보고만으로 원인을 특정할 수 없습니다.',action:'PC의 플레이어와 TV 입력 상태를 확인하세요.'};
  }
  // Read-only diagnostics. These are reported by the player; no control RPCs are sent.
  function playerDiagnostics(r){
    const s=r?.player_status||{}, manual=String(r?.display_control_mode||'remote')==='manual';
    if(manual)return [{label:'진단',value:'현장 수동 운영 · 자동 보고 없음'}];
    const n=(v)=>Number.isFinite(Number(v))?Math.max(0,Math.min(500,Math.floor(Number(v)))):0;
    const total=n(s.pending_total),done=n(s.pending_count),cacheTotal=n(s.offline_cache_total),cacheDone=n(s.offline_cache_count);
    const raw=String(s.offline_cache_error||s.error||s.update_error||'').slice(0,160);
    const diskFull=/disk[_ -]?full|no space left|ENOSPC|저장 공간 부족/i.test(raw);
    const active=String(s.active_hash||'').trim(),pending=String(s.pending_hash||'').trim();
    let sync='보고 없음';
    if(diskFull)sync='저장 공간 부족';
    else if(raw){
      const translations={pending_stuck:'새 목록 준비 지연',playlist_missing_videos_excluded:'일부 영상을 제외하고 재생 중',
        streaming_fallback_storage_full:'저장 공간 부족 · 온라인 재생 중',offline_cache_quota:'저장 공간 부족',
        playlist_switch_failed_kept_previous:'새 목록 적용 실패 · 이전 영상 유지'};
      sync='오류 · '+(translations[raw]||raw);
    }
    else if(pending&&pending!==active)sync=total?`새 목록 준비 중 ${Math.min(done,total)}/${total}`:'새 목록 적용 대기';
    else if(cacheTotal&&!s.offline_cache_ready)sync=`영상 다운로드 중 ${Math.min(cacheDone,cacheTotal)}/${cacheTotal}`;
    else if(s.offline_cache_ready===true)sync=cacheTotal?`영상 준비 완료 ${Math.min(cacheDone,cacheTotal)}/${cacheTotal}`:'영상 준비 완료';
    else if(active)sync='현재 목록 적용됨';
    const last=r?.last_seen_at?new Date(r.last_seen_at):null;
    const seen=last&&Number.isFinite(last.getTime())?last.toLocaleString('ko-KR'):'보고 없음';
    const stale=!last||!Number.isFinite(last.getTime())||Date.now()-last.getTime()>12*60*1000;
    if(stale)sync='최근 보고 없음 · 이전 상태는 확인 불가';
    const cause=playerCause(r);
    const items=[{label:'무슨 문제인가요?',value:cause.label},{label:'왜 이렇게 표시되나요?',value:cause.detail},{label:'어떻게 해결하나요?',value:cause.action},{label:'영상 다운로드',value:sync},{label:'마지막 연결 시간',value:seen}];
    if(s.failed_video_count>0)items.push({label:'실패한 영상',value:`${n(s.failed_video_count)}개`});
    for(const failure of (Array.isArray(s.failed_videos)?s.failed_videos:[]).slice(0,5)){
      items.push({label:'제외된 영상',value:`${String(failure.title||failure.id||'영상').slice(0,60)} · ${String(failure.code||'오류').slice(0,40)}`});
    }
    if(s.storage_persisted===false)items.push({label:'오프라인 저장소',value:'영구 저장 미보장'});
    if(s.update_pending_version)items.push({label:'업데이트 대기',value:String(s.update_pending_version).slice(0,24)});
    return items;
  }
  // A short, evidence-based summary. Never imply that monitor output is remotely verified.
  function playerDiagnosticsHtml(r){
    const manual=displayControlMode(r)==='manual', s=r?.player_status||{}, cause=playerCause(r);
    const seen=r?.last_seen_at?new Date(r.last_seen_at).getTime():NaN;
    const fresh=Number.isFinite(seen)&&monitor.serverNow()-seen<=12*60*1000;
    const play=String(s.playback_state||'').toLowerCase();
    const cacheTotal=Number(s.offline_cache_total)||0,cacheDone=Number(s.offline_cache_count)||0;
    const pendingTotal=Number(s.pending_total)||0,pendingDone=Number(s.pending_count)||0;
    let conn={value:'응답 없음',tone:'bad'};
    if(manual)conn={value:'수동 운영',tone:'neutral'};
    else if(fresh&&s.online===false)conn={value:'인터넷 끊김 보고',tone:'bad'};
    else if(fresh)conn={value:'최근 보고 수신',tone:'good'};
    let playback={value:'확인 불가',tone:'neutral'};
    if(manual)playback={value:'현장 확인',tone:'neutral'};
    else if(fresh){
      if(s.visibility_state==='hidden')playback={value:'탭 숨김',tone:'warn'};
      else if(s.visibility_state==='visible'&&s.window_focused===false)playback={value:'포커스 없음',tone:'warn'};
      else if(s.error||play==='error'||Number(s.failed_video_count||0)>0)playback={value:'재생 오류',tone:'bad'};
      else if(s.mode==='closed'||play==='closed')playback={value:'운영시간 외',tone:'neutral'};
      else if(r.paused||play==='paused')playback={value:'일시정지',tone:'warn'};
      else if(['playing','emergency'].includes(play))playback={value:'재생 중 보고',tone:'good'};
      else if(play==='loading')playback={value:'준비 중',tone:'neutral'};
      else if(play==='stopped')playback={value:'재생 중단',tone:'bad'};
      else playback={value:'대기',tone:'neutral'};
    }
    let cache={value:'확인 불가',tone:'neutral'};
    if(manual)cache={value:'자동 확인 제외',tone:'neutral'};
    else if(fresh){
      if(s.offline_cache_error)cache={value:'준비 오류',tone:'bad'};
      else if(pendingTotal>0&&s.pending_hash&&s.pending_hash!==s.active_hash)cache={value:`새 목록 ${Math.min(pendingDone,pendingTotal)}/${pendingTotal}`,tone:'warn'};
      else if(s.offline_cache_ready===true)cache={value:cacheTotal>0?`${Math.min(cacheDone,cacheTotal)}/${cacheTotal} 완료`:'준비 완료',tone:'good'};
      else if(cacheTotal>0)cache={value:`${Math.min(cacheDone,cacheTotal)}/${cacheTotal} 준비 중`,tone:'warn'};
      else if(s.active_hash)cache={value:'목록 적용됨',tone:'good'};
    }
    // Keep the primary view task-oriented: connection, playback, preparation.
    // Actual monitor output cannot be remotely verified, even when playback is reported.
    const issue=!manual&&(!fresh||conn.tone==='bad'||['bad','warn'].includes(playback.tone)||['bad','warn'].includes(cache.tone));
    const summary=manual?'현장 수동 운영':!fresh?'플레이어 응답 없음':conn.tone==='bad'?'인터넷 연결 문제':
      playback.tone==='bad'?playback.value:playback.tone==='warn'?playback.value:cache.tone==='bad'?'영상 준비 오류':
      playback.tone==='good'?'재생 중 보고':cache.tone==='warn'?'영상 준비 중':'재생 상태 확인 중';
    const headline=issue?'무엇을 확인하면 되나요?':'현재 상태';
    const action=issue?(cause.action||'플레이어와 인터넷 연결을 확인하세요.'):
      playback.tone==='good'?'플레이어는 재생 중으로 보고했습니다. 실제 모니터 화면은 원격에서 확인할 수 없습니다.':
      manual?'이 TV는 자동 상태 보고 대상이 아닙니다. 현장에서 확인하세요.':
      '최신 보고만으로 실제 모니터 출력 여부는 확인할 수 없습니다.';
    const mainItems=[['연결',conn],['영상 재생',playback],['영상 준비',cache]];
    const detailItems=[...playerDiagnostics(r),{label:'실제 화면 출력',value:'원격 확인 불가 · 모니터 입력 및 다른 창 가림은 현장에서 확인'}];
    const seenLabel=Number.isFinite(seen)?new Date(seen).toLocaleString('ko-KR'):'보고 없음';
    const tone=issue?'problem':playback.tone==='good'?'ok':'unknown';
    return `<section class="tv-diagnostics tv-diagnostics-simple" data-player-diagnostics="${esc(r.id)}" aria-label="TV 상태 확인">
      <div class="tv-diag-top"><div class="tv-diag-heading"><span class="tv-diag-eyebrow">TV 상태 확인</span><strong> ${esc(summary)}</strong></div><span class="tv-diag-indicator tv-diag-${tone}">${esc(issue?'확인 필요':playback.tone==='good'?'재생 보고':'상태 확인')}</span></div>
      <div class="tv-diag-steps">${mainItems.map(([label,item])=>`<div class="tv-diag-step"><span class="tv-diag-dot tone-${esc(item.tone)}" aria-hidden="true"></span><span class="tv-diag-step-label">${esc(label)}</span><strong>${esc(item.value)}</strong></div>`).join('')}</div>
      ${issue?`<div class="tv-diag-help"><span class="tv-diag-help-icon" aria-hidden="true">!</span><div><b>${headline}</b><p>${esc(action)}</p></div></div>`:''}
      <div class="tv-diag-footer"><span>${esc(lastReportLabel(r))}</span><details class="tv-diagnostics-more"><summary>자세히 보기</summary><div class="tv-diagnostics-more-body"><p class="tv-diag-limitation">실제 모니터 출력 여부는 원격에서 확인할 수 없습니다.</p>${detailItems.map(x=>`<div class="tv-diagnostics-item"><span>${esc(x.label)}</span><strong>${esc(x.value)}</strong></div>`).join('')}</div></details></div>
    </section>`;
  }
  function repaintPlayerDiagnostics(r){
    qsa('[data-player-diagnostics]').filter(el=>el.dataset.playerDiagnostics===String(r.id)).forEach(el=>{
      const wasOpen=!!el.querySelector('.tv-diagnostics-more[open]');
      const holder=document.createElement('div');holder.innerHTML=playerDiagnosticsHtml(r);
      const next=holder.firstElementChild;
      if(next){if(wasOpen){const more=next.querySelector('.tv-diagnostics-more');if(more)more.open=true;}el.replaceWith(next);}
    });
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
    const status=roomDisplayStatus(r);
    if(status.cat==='unpaired')return '아직 플레이어가 연결되지 않았습니다';
    if(status.cat==='standby'&&h==='offline')return `운영시간 외 · ${lastReportLabel(r)}`;
    const diagnosis=playerCause(r);
    if(h==='offline')return `${diagnosis.label} · ${lastReportLabel(r)}`;
    if(st.online===false||st.visibility_state==='hidden'||(st.visibility_state==='visible'&&st.window_focused===false))return diagnosis.label;
    if(String(st.playback_state||'').toLowerCase()==='stopped')return `플레이어 연결 종료 · ${lastReportLabel(r)}`;
    const upd=playerUpdateState(st);
    if(upd?.issue)return `${upd.label} · ${upd.detail}`;
    if(st.offline_cache_error)return '캐시 오류';
    if(Number(st.failed_video_count||0)>0)return `재생 실패 ${Number(st.failed_video_count||0)}개 건너뜀`;
    if(st.error)return String(st.error).slice(0,60);
    if(ack?.status==='error'||ack?.status==='unconfirmed')return '최근 변경 적용 확인 실패';
    if(h==='delayed')return `상태 보고 지연 · ${lastReportLabel(r)}`;
    if(ack?.status==='pending')return `영상 변경 확인 중 · ${lastReportLabel(r)}`;
    if(st.mode==='closed')return '운영시간 외';
    if(upd?.key==='pending')return `${upd.label} · ${lastReportLabel(r)}`;
    return lastReportLabel(r);
  }
  const priorityLabel=(v)=>({broadcast:'전체',broadcast_schedule:'예약',manual:'개별',group:'층·구역',group_schedule:'예약',patient:'개별',session:'개별',default:'기본',emergency:'비상',closed:'운영시간 외'})[String(v||'').toLowerCase()]||'기본';
  function roomProblemRank(r){return ({issue:0,unpaired:1,standby:2,manual:3,live:4})[tvCat(r)]??4;}
  // 층·구역 요약: 다섯 분류 합계가 항상 TV 수와 같다. 직접 관리 TV는 장애(issues)에 넣지 않는다.
  function groupStatusSummary(rooms){
    const c=tvCounts(rooms);
    const online=rooms.filter(r=>displayControlMode(r)!=='manual'&&staffIsOnline(r)).length;
    let key='standby',label=TV_CAT_LABEL.standby;
    if(!rooms.length){key='empty';label='TV 없음';}
    else if(c.issue>0){key='issue';label=`${TV_CAT_LABEL.issue} ${c.issue}`;}
    else if(c.live>0){key='live';label=TV_CAT_LABEL.live;}
    else if(c.standby>0){key='standby';label=TV_CAT_LABEL.standby;}
    else if(c.unpaired>0){key='unpaired';label=TV_CAT_LABEL.unpaired;}
    else if(c.manual>0){key='manual';label=TV_CAT_LABEL.manual;}
    return {...c,issues:c.issue,online,key,label};
  }
  function groupIssueParts(st){
    return [['확인 필요',st.issue],['미연결',st.unpaired]].filter(([,count])=>Number(count||0)>0);
  }
  const groupNowText=(x)=>!x.total?'TV 없음':TV_CAT_ORDER.filter(cat=>x[cat]).map(cat=>`${TV_CAT_LABEL[cat]} ${x[cat]}`).join(' · ');
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
  // Never display legacy title/next_title from player_status after a media reset.
  // Only catalog-backed media names may appear as current/next content.
  // A TV going offline stops live reporting, NOT its configured playlist.
  // Use persisted playlist membership when playback cannot be confirmed.
  function configuredVideoForRoom(r){
    const ids=staffBaseIds(r).map(String);
    return ids.map(id=>state.videos.find(v=>String(v.id)===id)).find(Boolean)||null;
  }
  // DB에 등록된 콘텐츠 (TV 연결 상태와 무관). 오프라인·미연결 TV도 이 정보를 그대로 보여준다.
  function configuredContentForRoom(r){
    const byOrder=(a,b)=>(a.sort_order||0)-(b.sort_order||0);
    const itemsOf=(pid)=>state.playlistItems.filter(x=>x.playlist_id===pid).sort(byOrder).map(x=>x.video_id);
    if(r.manual_active&&r.manual_video_ids?.length)return {label:'개별 영상',ids:r.manual_video_ids};
    const own=playlistById(r.default_playlist_id);
    if(own)return {label:own.name||'TV 재생목록',ids:itemsOf(own.id)};
    const floor=playlistById(state.groups.find(g=>g.id===r.group_id)?.default_playlist_id);
    if(floor)return {label:`${floor.name||'층 재생목록'} (층 기본)`,ids:itemsOf(floor.id)};
    // TV가 실제로 쓰는 규칙과 같게: 이 병원 기본 재생목록을 공용보다 먼저 (player_get_state와 동일)
    const siteId=state.site?.id;
    const site=state.playlists.filter(p=>p.active!==false&&p.kind==='default'&&(!p.site_id||p.site_id===siteId))
      .sort((a,b)=>(b.site_id===siteId)-(a.site_id===siteId)||byOrder(a,b)||String(a.created_at||'').localeCompare(String(b.created_at||'')))[0];
    let content=site?{label:`${site.name||'기본 재생목록'} (병원 기본)`,ids:itemsOf(site.id)}:{label:'',ids:[]};
    if(!content.ids.length){
      // 재생목록이 비어 있으면 TV는 기본 태그 영상으로 대체 재생한다
      const tags=new Set(r.default_tags||[]);
      const ids=state.videos.filter(v=>v.active!==false&&(v.tags||[]).some(t=>tags.has(t))).sort(byOrder).map(v=>v.id);
      if(ids.length)content={label:'기본 태그 영상',ids};
    }
    return content;
  }
  function roomVideoSummary(r){
    const live=staffIsOnline(r);
    const current=live?currentVideoForRoom(r):null;
    const playing=live&&String(r.player_status?.playback_state||'').toLowerCase()==='playing';
    if(current&&playing)return {video:current,title:current.title,detail:'현재 재생 중이라고 보고된 영상'};
    const content=configuredContentForRoom(r);
    const videos=content.ids.map(id=>state.videos.find(v=>String(v.id)===String(id))).filter(Boolean);
    if(videos.length)return {video:videos[0],title:`${content.label} · 영상 ${videos.length}개`,detail:'등록된 콘텐츠 (연결 상태와 별개)'};
    return {video:null,title:'등록된 영상 없음',detail:'이 TV에 재생목록을 지정하세요.'};
  }
  const currentVideoTitle=(r)=>roomVideoSummary(r).title;
  function nextVideoTitle(r){
    const ids=staffBaseIds(r).map(String);
    const currentId=String(r?.player_status?.video_id||'');
    const idx=ids.indexOf(currentId);
    if(idx<0||ids.length<2)return '—';
    return state.videos.find(v=>String(v.id)===ids[(idx+1)%ids.length])?.title||'—';
  }
  const playbackLabel=(v)=>({playing:'재생 중',paused:'일시정지',loading:'불러오는 중',error:'오류',connected:'연결됨',closed:'운영시간 외'})[String(v||'').toLowerCase()]||'상태 확인 안 됨';
  const activePatients=()=>state.patients.filter(p=>['waiting','assigned','in_progress'].includes(p.status));
  const elapsedMinutes=(start,end=Date.now())=>start?Math.max(0,Math.floor((new Date(end).getTime()-new Date(start).getTime())/60000)):0;
  const waitText=(p)=>`${elapsedMinutes(p.waiting_started_at||p.created_at,p.assigned_at||Date.now())}분 대기`;
  const patientForRoom=(id)=>{if(lookupCache.patients!==state.patients){lookupCache.patients=state.patients;lookupCache.patientMap=new Map();for(const p of activePatients()){if(p.room_id&&!lookupCache.patientMap.has(p.room_id))lookupCache.patientMap.set(p.room_id,p);}}return lookupCache.patientMap.get(id)||null;};
  const isQuickSession=(r)=>!!r.session_treatment&&!patientForRoom(r.id);

  let lastLoadStartedAt=0;
  // ---- DB 버전 확인: 화면이 필요로 하는 DB 기능이 없으면 해당 버튼만 막고 구체적으로 안내한다 (TV 송출과 무관) ----
  const REQUIRED_DB_VERSION='2.36.1';
  let dbInfo={checked:false,version:null,features:[],error:null};
  const dbVersionCmp=(a,b)=>{const pa=String(a||'0').split('.').map(Number),pb=String(b||'0').split('.').map(Number);for(let i=0;i<3;i++){const d=(pa[i]||0)-(pb[i]||0);if(d)return d;}return 0;};
  const dbFeature=(f)=>dbInfo.features.includes('pairing_v3')&&dbInfo.features.includes(f);
  const dbOutdated=()=>dbInfo.checked&&dbInfo.error!=='network'&&(dbVersionCmp(dbInfo.version,REQUIRED_DB_VERSION)<0||!dbFeature('site_catalog_v1')||!dbInfo.features.includes('video_delete_impact_v1'));
  function dbVersionMessage(){
    if(dbInfo.error==='network')return 'DB 버전을 확인하지 못했습니다. 새로고침 후 다시 시도하세요.';
    const files=[];
    if(dbVersionCmp(dbInfo.version,'2.35.86')<0||!dbInfo.features.includes('pairing_v2'))files.push('v2.35.86-pairing-hardening.sql');
    if(dbVersionCmp(dbInfo.version,'2.35.87')<0||!dbInfo.features.includes('pairing_v3'))files.push('v2.35.87-pairing-hardening.sql');
    if(!dbInfo.features.includes('site_catalog_v1'))files.push('v2.36.0-site-catalog.sql');
    if(!dbInfo.features.includes('video_delete_impact_v1'))files.push('v2.36.1-video-delete-impact.sql');
    return `Supabase SQL Editor에서 ${files.map(f=>'supabase/'+f).join(' → ')}${files.length>1?' 순서로':''} 실행하세요. (현재 DB ${dbInfo.version||'2.35.85 이하'} · 필요 ${REQUIRED_DB_VERSION})`;
  }
  async function checkDbVersion(){
    try{
      const {data,error}=await db.rpc('app_db_version');
      if(error)throw error;
      dbInfo={checked:true,version:String(data?.version||''),features:Array.isArray(data?.features)?data.features:[],error:null};
    }catch(e){
      dbInfo={checked:true,version:null,features:[],error:Signage.isMissingFunction?.(e)?'missing':'network'};
    }
  }
  const dbVersionBanner=()=>dbOutdated()?`<div class="db-version-banner" role="alert"><b>DB 업데이트 필요</b><span>${esc(dbVersionMessage())}</span><small>${dbFeature('pairing_v3')?'새 관리 기능은 DB 업데이트 후 사용할 수 있습니다. 기존 송출과 기기 연결 기능은 유지됩니다.':'DB 업데이트 전까지 신규 병원별 설정과 설치형 플레이어 연결·해제는 제한됩니다. 기존 TV 송출은 계속됩니다.'}</small></div>`:'';
  async function load({background=false}={}){
    lastLoadStartedAt=Date.now();
    if(!dbInfo.checked||dbInfo.error==='network'||dbOutdated())await checkDbVersion();
    const [reception,building,overlayLookup]=await Promise.all([db.rpc('hospital_reception_state',{p_site:targetSiteId}),db.rpc('hospital_building_asset',{p_site:targetSiteId}),db.rpc('hospital_get_room_overlays',{p_site:targetSiteId})]);
    if(reception.error)throw reception.error;if(building.error)throw building.error;
    const data=reception.data||{},overlayByRoom=new Map((Array.isArray(overlayLookup.data)?overlayLookup.data:[]).map(x=>[String(x.id),x.overlay_text])),baseRooms=(data.rooms||[]).map(r=>({...r,overlay_text:overlayByRoom.get(String(r.id))??null}));
    if(overlayLookup.error)console.warn('TV 화면 문구 조회 실패:',overlayLookup.error.message);
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
  let layoutDraft=null,layoutDraftSaving=false;
  function isInteracting(){
    if(layoutPanelOpen||layoutDraftSaving||floorBulkBusy||qs('#floorTvSearch')?.value||qs('#floorTvFilter')?.value||qs('[data-floor-tv-select]:checked'))return true;
    if(catalogDirty||catalogSaving||deletingHospitalVideo||videoUsageBusy||tab==='videos'&&(mediaDirty||mediaSaving))return true;
    const a=document.activeElement,root=qs('#hospitalRoot');
    if(root?.querySelector('.floor-inline-video-panel'))return true;
    return !!(a&&root&&root.contains(a)&&['INPUT','SELECT','TEXTAREA'].includes(a.tagName));
  }
  function uiKey(el){
    const card=el.closest('[data-tv-id]')?.dataset.tvId||el.closest('[data-room-card]')?.dataset.roomCard||el.closest('[data-staff-group]')?.dataset.staffGroup||el.closest('[data-staff-map-floor]')?.dataset.staffMapFloor||'';
    return `${card}|${el.className}`;
  }
  function renderPreservingUi(keepInputs=true){
    if(layoutDraft&&!layoutDraftSaving){layoutDraft.cancel();layoutDraft=null;}
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

  const careTypeLabel=(v)=>Catalog.label(catalogConfig(),'floor_types',v);
  const floorNumber=(g)=>Number(g?.floor_number||String(g?.name||'').match(/(\d+)/)?.[1]||0);
  function groupedRooms(){
    const groups=[...state.groups].sort((a,b)=>(Number(a.sort_order||0)-Number(b.sort_order||0))||(floorNumber(a)-floorNumber(b)));
    if(!groups.length){const map=new Map(),order=[];for(const r of state.rooms){const key=r.group_id||'ungrouped';if(!map.has(key)){map.set(key,{id:key,name:r.group_name||'미분류',rooms:[]});order.push(key);}map.get(key).rooms.push(r);}return order.map(k=>map.get(k));}
    const out=groups.map(g=>({...g,rooms:state.rooms.filter(r=>r.group_id===g.id)}));
    const ungrouped=state.rooms.filter(r=>!r.group_id);if(ungrouped.length)out.push({id:'ungrouped',name:'미분류',rooms:ungrouped});
    return out.filter(g=>g.rooms.length||g.id!=='ungrouped');
  }
  const visibleTvStatus=(status)=>status.cat==='live'?status.catLabel:`${status.catLabel} · ${status.label}`;
  // 목록 배지: 분류는 항상, 상세 사유는 넓은 화면에서만 표시(좁은 화면 잘림 방지)
  const tvBadgeHtml=(status)=>status.cat==='live'?esc(status.catLabel):`${esc(status.catLabel)}<span class="st-detail"> · ${esc(status.label)}</span>`;
  function floorStatusDots(rooms){
    const list=[...rooms].sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0)||String(a.name||'').localeCompare(String(b.name||''),'ko'));
    if(!list.length)return '<span class="floor-dot floor-dot-empty" aria-hidden="true"></span><span class="sr-only">TV 등록 없음</span>';
    return list.map(r=>{
      const status=roomDisplayStatus(r);
      const label=`${r.name} · ${visibleTvStatus(status)}`;
      return `<span class="floor-dot floor-dot-${status.cat}" title="${esc(label)}" aria-label="${esc(label)}" data-floor-dot-room="${esc(r.id)}"></span>`;
    }).join('');
  }
  function staffBuildingFloor(g){
    const n=floorNumber(g),shortName=floorPurposeLabel(g);
    const rooms=g.rooms||state.rooms.filter(r=>r.group_id===g.id);
    
    const hasPlaybackIssue=rooms.some(r=>tvCat(r)==='issue');
    const cls=`hospital-floor-row${selectedFloorId===g.id?' is-selected':''}${hasPlaybackIssue?' has-issue':''}`;
    return `<button type="button" class="${cls}" data-staff-select-floor="${esc(g.id)}" aria-pressed="${selectedFloorId===g.id?'true':'false'}">
      <span class="hospital-floor-number">${n}F</span>
      <span class="hospital-floor-name" title="${esc(shortName)}">${esc(shortName)}<small>${rooms.length}대</small></span>
      <span class="hospital-floor-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></span>
    </button>`;
  }
  function staffFloorMarker(r){
    if(!roomMapPlaced(r))return '';
    const st=roomDisplayStatus(r),x=Number(r.map_x_pct),y=Number(r.map_y_pct),current=roomVideoSummary(r).video;
    const thumb=current?.thumbnail_data_url?`<img src="${esc(current.thumbnail_data_url)}" alt="">`:'<span class="display-screen-icon"></span>';
    const videoTitle=currentVideoTitle(r);
    return `<button class="floor-display-pin control-${displayControlMode(r)} status-${st.key} cat-${st.cat}" style="left:${x}%;top:${y}%" data-staff-floor-room="${r.id}" aria-label="${esc(r.name)} · ${esc(st.label)}" aria-expanded="false">
      <span class="floor-display-dot-only" aria-hidden="true"></span>
      <span class="floor-display-hover" role="tooltip"><span class="floor-display-hover-thumb">${thumb}</span><span><b>${esc(r.name)}</b><small>${esc(videoTitle)}</small></span></span>
    </button>`;
  }
  const groupContentTopics=(g)=>Array.isArray(g?.content_topics)?g.content_topics.map(x=>String(x||'').trim()).filter(Boolean):[];
  const groupContentTopicsMarkup=(g)=>{const items=groupContentTopics(g);return items.length?`<div class="floor-content-topics compact"><small>주로 보여주는 영상</small><ul>${items.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:'';};
  function staffFloorPanelMarkup(g){
    if(!g)return `<section class="hospital-floor-detail hospital-floor-detail-empty"><div><b>층을 선택하세요.</b><p>층을 누르면 도면과 TV 위치가 나옵니다.</p></div></section>`;
    const rooms=g.rooms||state.rooms.filter(r=>r.group_id===g.id),sum=groupStatusSummary(rooms),asset=floorAsset(g),unplaced=rooms.filter(r=>!roomMapPlaced(r));
    const n=floorNumber(g),online=rooms.filter(staffIsOnline).length;
    return `<section class="hospital-floor-detail">
      <div class="hospital-floor-detail-head">
        <div class="hospital-floor-detail-intro"><b>${n}층 · ${esc(g.name||`${n}층`)}</b><span>${esc(g.content_intro||'도면에서 TV나 공간을 누르면 지금 영상과 설명을 볼 수 있습니다.')}</span></div>
        <div class="hospital-floor-detail-actions"><div class="hospital-floor-detail-stats" data-floor-stats="${esc(g.id)}">${tvCountChips(sum)}</div></div>
        ${(g.role_label||groupContentTopics(g).length)?`<div class="hospital-floor-detail-context">${g.role_label?`<span class="floor-role-chip">${esc(g.role_label)}</span>`:''}${groupContentTopicsMarkup(g)}</div>`:''}
      </div>
      ${asset?`<div class="building-floorplan-wrap floor-activation-shell">
        <div class="floor-plan-stage building-floor-plan-stage is-floor-activating">
          <div class="floorplan-svg-host" data-floorplan-svg="${asset}"></div>
          ${state.floorSpaces.filter(x=>x.group_id===g.id).map(x=>floorSpaceOverlay(x)).join('')}
          ${rooms.map(staffFloorMarker).join('')}
        </div>
        <div class="floor-zone-inspector building-zone-inspector" data-staff-floor-zone-inspector>
          <div class="floor-zone-inspector-empty"><div><b>도면에서 TV나 공간을 눌러주세요.</b></div><p>어떤 영상이 나오는지, 왜 나오는지 볼 수 있습니다.</p></div>
        </div>
      </div>`:`<div class="floor-plan-empty floor-plan-empty-action hospital-floor-empty"><b>등록된 도면이 없습니다.</b><p>도면 편집에서 이 층의 도면을 추가하세요.</p><button type="button" class="btn small" data-ops-layout-open>도면 등록</button></div>`}
      ${unplaced.length?`<div class="building-plan-foot"><span>위치 미설정 ${unplaced.length}</span></div>`:''}
    </section>`;
  }
  // 상태 요약 칩: TV 수 + 0이 아닌 분류만 (정상 송출은 항상 표시)
  function tvCountChips(c){
    const chips=[`<span>TV <b>${c.total}</b></span>`];
    TV_CAT_ORDER.forEach(cat=>{if(cat==='live'||c[cat])chips.push(`<span class="tv-chip tv-chip-${cat}">${TV_CAT_LABEL[cat]} <b>${c[cat]}</b></span>`);});
    return chips.join('');
  }
  const tvStatusCategory=(room)=>tvCat(room);
  // 접힌 상태에서도 보이는 한 줄 요약 (0인 분류는 생략, 정상 송출은 항상 표시)
  const tvSummaryLine=(c)=>`TV ${c.total}대 · `+TV_CAT_ORDER.filter(cat=>cat==='live'||c[cat]).map(cat=>`${TV_CAT_LABEL[cat]} ${c[cat]}`).join(' · ');
  function hospitalStatusMatches(filter){return state.rooms.filter(r=>tvCat(r)===filter);}
  function hospitalStatusFilterMarkup(){
    if(!TV_CAT_ORDER.includes(statusViewFilter))return '';
    const rooms=hospitalStatusMatches(statusViewFilter).sort((a,b)=>roomProblemRank(a)-roomProblemRank(b));
    const rows=rooms.map(r=>{
      const group=state.groups.find(g=>g.id===r.group_id);
      const place=group?`${floorNumber(group)}층`:'층 미지정';
      const status=roomDisplayStatus(r);
      return `<button type="button" class="hospital-status-result" data-status-open-room="${esc(r.id)}" aria-label="${esc(place)} ${esc(r.name)} 상세보기"><span class="status-result-main"><b>${esc(r.name)}</b><small>${esc(place)} · ${esc(status.cat==='live'?status.label:roomIssueReason(r)||status.label)}</small></span><span aria-hidden="true">›</span></button>`;
    }).join('');
    return `<section class="hospital-status-results" id="hospitalStatusResults" aria-label="${TV_CAT_LABEL[statusViewFilter]} 목록"><div class="hospital-status-results-heading"><div><h2>${TV_CAT_LABEL[statusViewFilter]}</h2><p>${rooms.length}대${rooms.length?' · TV를 누르면 해당 층의 상세 설정으로 이동합니다.':''}</p></div><button type="button" class="btn small" data-status-clear>닫기</button></div><div class="hospital-status-result-list">${rows||'<p class="hospital-status-none">해당하는 TV가 없습니다.</p>'}</div></section>`;
  }
  function hospitalOperationsSummary(){
    const c=tvCounts(state.rooms);
    const desc={live:'영상 재생 중',standby:'운영시간 외 · 일시정지',unpaired:'최초 기기 연결 전',issue:'오프라인 · 오류 · 지연',manual:'현장 직접 관리'};
    return `<div class="hospital-ops-summary hospital-ops-summary-easy hospital-ops-summary-5" aria-label="TV 상태별 목록">${TV_CAT_ORDER.map(key=>
      `<button type="button" class="ops-status-card ops-${key}${c[key]>0?' has-count':''}${statusViewFilter===key?' is-active':''}" data-status-filter="${key}" aria-pressed="${statusViewFilter===key?'true':'false'}"><span class="ops-status-title"><i aria-hidden="true"></i>${TV_CAT_LABEL[key]}</span><strong data-tv-count="${key}">${c[key]}</strong><span class="ops-status-help">${desc[key]}</span><span class="ops-status-action">목록 보기 <span aria-hidden="true">›</span></span></button>`
    ).join('')}</div>${hospitalStatusFilterMarkup()}`;
  }
  let floorBulkBusy=false;
  function floorQuickTvList(rooms){
    rooms=[...rooms].sort(layoutRoomSort);
    if(!rooms.length)return '<div class="floor-ops-empty">이 층에는 등록된 TV가 없습니다. 설정에서 TV를 추가하세요.</div>';
    return `<section class="floor-ops-tv-section"><div class="floor-ops-tv-heading"><h3>이 층의 TV</h3><small>≡ 손잡이를 끌어 순서 변경</small></div><div class="floor-tv-tools"><input type="search" id="floorTvSearch" placeholder="TV 이름 검색" aria-label="TV 검색"><select id="floorTvFilter" aria-label="상태 필터"><option value="">전체 상태</option>${TV_CAT_ORDER.map(c=>`<option value="${c}">${TV_CAT_LABEL[c]}</option>`).join('')}</select><label><input type="checkbox" id="floorTvSelectAll"> 전체 선택</label><select id="floorTvBulkPlaylist" aria-label="재생목록"><option value="">재생목록 선택</option>${state.playlists.filter(p=>p.active!==false&&(p.site_id==null||p.site_id===targetSiteId)).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select><button class="btn small" type="button" id="floorTvApply">일괄 적용</button><button class="btn small" type="button" id="floorTvReload">선택 TV 새로고침</button></div><div class="floor-ops-tv-grid" data-tv-sort-list>${rooms.map(r=>{
      const st=roomDisplayStatus(r),current=currentVideoForRoom(r),manual=displayControlMode(r)==='manual';
      // Existing roomCard is reused in-place, so video ordering and save handlers
      // are not duplicated or reimplemented. Its summary is visually hidden here.
      const controls=roomCard(r).replace('<details class="monitor-room ', '<details open class="monitor-room ');
      return `<details class="floor-ops-tv status-${st.key} cat-${st.cat}" data-tv-id="${esc(r.id)}">
        <summary class="floor-ops-tv-summary"><input type="checkbox" data-floor-tv-select="${esc(r.id)}" aria-label="${esc(r.name)} 선택"><button type="button" class="floor-tv-drag-handle" data-tv-drag-handle aria-label="${esc(r.name)} 순서 이동. 방향키 위아래로도 이동 가능" title="끌어서 TV 순서 변경" draggable="false">⠿</button><span class="floor-ops-tv-main"><b>${esc(r.name)}</b><span class="floor-ops-video" data-ops-video="${esc(r.id)}">${esc(manual?'현장 수동 운영':currentVideoTitle(r))}</span></span><span class="floor-ops-state status-${st.key} cat-${st.cat}" data-ops-state="${esc(r.id)}" title="${esc(visibleTvStatus(st))}">${tvBadgeHtml(st)}</span><span class="floor-ops-expand" aria-hidden="true">⌄</span></summary>
        <div class="floor-ops-tv-expanded"><p class="floor-ops-reason" data-ops-reason="${esc(r.id)}">${esc(roomIssueReason(r)||' ')}</p>
          <div class="floor-tv-manage-actions" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 14px;margin:4px 0 12px;background:var(--panel,#f7f8fb);border:1px solid var(--line,#e5e7eb);border-radius:12px;">
            <span style="flex:1;min-width:170px;font-size:12px;color:var(--muted,#64748b);">TV 설정 변경 · ${roomMapPlaced(r)?'도면에 배치됨':'도면 미배치'} · ID ${esc(String(r.id).slice(0,8))}</span>
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
    if(!selectedFloorId){const firstIssue=floors.find(g=>(g.rooms||state.rooms.filter(r=>r.group_id===g.id)).some(r=>tvCat(r)==='issue'));selectedFloorId=(firstIssue||floors[0]).id;}
    const selected=floors.find(g=>g.id===selectedFloorId)||floors[0];
    const floorLayout=floors.length===1?'single-floor':floors.length<=3?'few-floors':'many-floors';
    return `<section class="hospital-building-dashboard hospital-unified-ops ${floorLayout}"><div class="hospital-building-console"><div class="hospital-floor-console-card">
      <div class="hospital-floor-console-title"><div><h2>${floors.length===1?'병원 TV 현황':'층별 TV'}</h2><p>${floors.length===1?'도면에서 TV를 누르면 영상과 상태를 확인할 수 있습니다.':'층별 TV 위치와 송출 상태를 확인합니다.'}</p><div class="floor-status-legend" aria-label="상태 점 범례">${TV_CAT_ORDER.map(cat=>`<span><i class="${cat}"></i>${TV_CAT_LABEL[cat]}</span>`).join('')}</div></div><div class="hospital-floor-fast-actions"><button type="button" class="btn small" data-ops-quick-add="space">+ 공간·TV</button><button type="button" class="btn small primary" data-ops-quick-add="display">+ TV 추가</button><button type="button" class="btn ${layoutPanelOpen?'primary':''} hospital-layout-edit-toggle" data-ops-layout-toggle aria-expanded="${layoutPanelOpen?'true':'false'}">${layoutPanelOpen?'보기로 돌아가기':'도면에서 배치 수정'}</button></div></div>
      <div class="hospital-floor-console-grid">${floors.length===1?'':`<div class="hospital-floor-list" role="group" aria-label="층 선택">${floors.map(staffBuildingFloor).join('')}</div>`}
      <div class="hospital-floor-ops-content">${layoutPanelOpen?operationsLayoutEditorMarkup():`${staffFloorPanelMarkup(selected)}${floorQuickTvList(selected.rooms||state.rooms.filter(r=>r.group_id===selected.id))}`}</div></div>
    </div></div></section>`;
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
    if(floorplanMeta(floor)){const count=state.rooms.filter(r=>Number(state.groups.find(g=>g.id===r.group_id)?.floor_number)===floor&&roomMapPlaced(r)).length;const spaces=state.floorSpaces.filter(sp=>Number(state.groups.find(g=>g.id===sp.group_id)?.floor_number)===floor).length;if((count||spaces)&&!confirm(`${floor}층 도면을 교체할까요?\n기존 공간 ${spaces}개와 TV 위치 ${count}개는 유지됩니다. 도면의 비율이나 구조가 달라지면 위치를 다시 조정해야 합니다.`))return;}
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
      <div class="floor-layout-copy-head"><div><b>${esc(floorSettingsLabel(current))} 배치 복사</b><small>같은 구조의 도면을 사용하는 층만 선택하세요. 공간과 TV 위치만 복사합니다. TV는 층 이름을 뺀 번호가 같을 때 같은 위치로 봅니다. (예: 10F_01 ↔ 9층 01)</small></div><button type="button" class="text-action" id="staffLayoutCopyClose">닫기</button></div>
      <div class="floor-layout-copy-targets">${targets.map(g=>{const targetRooms=state.rooms.filter(r=>r.group_id===g.id),fp=floorAssetFingerprint(g),sameSize=!!sourceFingerprint&&fp===sourceFingerprint,countOk=targetRooms.length===sourceRooms.length;return `<label class="floor-layout-copy-target"><input type="checkbox" value="${g.id}" data-layout-copy-target><span><b>${esc(floorSettingsLabel(g))}</b><small>${targetRooms.length}대의 TV${sameSize?' · 도면 크기 일치':''} · 이름 기준 매칭</small></span></label>`;}).join('')}</div>
      <div class="floor-layout-copy-options"><label><input type="checkbox" id="staffCopySpaces" checked> 공간</label><label><input type="checkbox" id="staffCopyDisplays" checked> TV 위치</label></div>
      <div class="floor-layout-copy-actions"><span>공간과 TV 위치를 함께 적용할 수 있습니다. 예: 10F_01 → 9F_01. 같은 위치 코드가 없을 때만 자동 생성합니다.</span><button type="button" class="btn" id="staffApplyLayoutCopy">선택한 층에 적용</button></div>
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
    return `<details class="floor-meta-editor">
      <summary><span><b>${esc(floorSettingsLabel(g))} 층 정보</b><small>층 이름과 안내 문구를 여기서 바꿀 수 있습니다.</small></span><em>수정</em></summary>
      <div class="floor-meta-editor-body">
        <div class="floor-meta-grid">
          <label class="field"><span>층 이름</span><input data-floor-meta-name="${g.id}" maxlength="60" value="${esc(g.name||'')}"></label>
          <label class="field"><span>운영 성격</span><select data-floor-meta-care="${g.id}">${catalogEntries('floor_types',g.care_type).map(([v,l])=>`<option value="${esc(v)}" ${g.care_type===v?'selected':''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="field"><span>역할</span><input data-floor-meta-role="${g.id}" maxlength="60" value="${esc(g.role_label||'')}" placeholder="예: 전문성"></label>
          <label class="field"><span>주요 대상</span><input data-floor-meta-audience="${g.id}" maxlength="120" value="${esc(g.target_audience||'')}" placeholder="예: 진료 고객"></label>
          <label class="field floor-meta-wide"><span>층 설명</span><textarea data-floor-meta-intro="${g.id}" rows="2" placeholder="이 층의 목적을 짧게 입력">${esc(g.content_intro||'')}</textarea></label>
          <label class="field floor-meta-wide"><span>주로 보여주는 영상 · 한 줄에 하나</span><textarea data-floor-meta-topics="${g.id}" rows="4" placeholder="치료 안내&#10;전후 사례">${esc(topics)}</textarea></label>
          <label class="field floor-meta-wide"><span>송출 목적</span><input data-floor-meta-purpose="${g.id}" maxlength="160" value="${esc(g.signage_purpose||'')}"></label>
          <label class="field floor-meta-wide"><span>왜 이 영상을 보여주나요?</span><textarea data-floor-meta-reason="${g.id}" rows="2">${esc(g.signage_reason||'')}</textarea></label>
          <label class="field floor-meta-wide"><span>대기공간 메모</span><input data-floor-meta-waiting="${g.id}" maxlength="160" value="${esc(g.waiting_area_note||'')}"></label>
          <label class="field floor-meta-wide"><span>이 층의 기본 재생목록</span><select data-floor-meta-playlist="${g.id}"><option value="">각 TV의 기존 설정 사용</option>${playlists}</select></label>
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
      <div class="hospital-admin-block-head"><div><b>도면 배치</b><small>기존 공간은 끌어서 이동하거나 눌러서 이름·영역을 수정하세요. TV 점은 끌어서 옮길 수 있습니다.</small></div></div>
      <div class="floor-layout-topbar">
        <label><span>층</span><select id="staffSpaceFloor">${floors.map(g=>`<option value="${g.id}" ${g.id===current.id?'selected':''}>${esc(floorSettingsLabel(g))}</option>`).join('')}</select></label>
        <div class="floor-layout-quick-actions">
          <button type="button" class="btn ${layoutEditMode==='space'?'primary':''}" id="staffAddSpace">${layoutEditMode==='space'?'공간 그리는 중':'+ 공간·TV'}</button>
          <button type="button" class="btn ${layoutEditMode==='display'?'primary':''}" id="staffPlaceDisplayMode">TV 배치 · 이동</button>
          <button type="button" class="btn small floor-layout-copy-toggle" id="staffLayoutCopyToggle">같은 도면 층에 적용</button>
        </div>
      </div>
      ${layoutCopyOpen?floorLayoutCopyMarkup(current,floors):''}
      ${floorMetaEditorMarkup(current)}
      ${layoutEditMode==='space'?`<div class="floor-layout-space-create">
        <label><span>공간명</span><input id="staffSpaceName" maxlength="40" placeholder="예: 진료실 1" value="${editing?esc(editing.name):''}"></label>
        <label hidden><span>유형</span><select id="staffSpaceType">${catalogEntries('space_types',editing?.space_type).map(([v,l])=>`<option value="${esc(v)}" ${editing?.space_type===v?'selected':''}>${esc(l)}</option>`).join('')}</select></label>
        ${!editing?`<label><span>함께 추가할 TV</span><select id="staffCombinedTvCount"><option value="0" ${combinedCreateMode==='space'?'selected':''}>공간만</option>${[1,2,3,4,5,6].map(n=>`<option value="${n}" ${combinedCreateMode!=='space'&&n===1?'selected':''}>${n}대 · 이름 자동 생성</option>`).join('')}</select></label>`:''}
        <div class="floor-layout-space-instruction"><b>${editing?'도면 빈 곳에서 새 영역을 드래그하세요':'공간 이름을 입력하고 도면에서 영역을 그리세요'}</b><span>${editing?'기존 TV 위치는 유지됩니다.':'공간을 만든 뒤 TV를 함께 선택했다면 도면을 클릭해 위치를 차례대로 지정합니다. 이름은 공간명 + TV 번호로 자동 생성됩니다.'}</span></div>
        ${editing?`<button class="btn small primary" id="staffSaveSpaceName" type="button">이름 저장</button>`:''}<button class="btn small" id="staffCancelSpaceRedraw" type="button">취소</button>
      </div>`:`<div class="floor-layout-display-pick">
        <div class="floor-layout-display-pick-head"><span><b>위치를 정하지 않은 TV</b><small>${unplaced.length?`${unplaced.length}개 · 이름을 누른 뒤 도면을 클릭하세요.`:'모든 TV의 위치가 정해졌습니다.'}</small></span>${pending?`<em>${esc(pending.name)} 위치를 찍어주세요</em>`:''}</div>
        <div class="floor-layout-quick-create"><label><span>새 TV 이름</span><input type="text" id="staffQuickDisplayName" maxlength="40" placeholder="예: 대기실 TV 1"></label><label><span>운영 방식</span><select id="staffQuickDisplayMode">${CONTROL_MODES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><button type="button" class="btn primary" id="staffQuickCreateDisplay">+ 등록하고 위치 지정</button></div>
        <div class="floor-layout-display-chips">${unplaced.map(r=>`<div class="floor-layout-display-manage ${pending?.id===r.id?'is-active':''}"><button type="button" class="floor-layout-display-chip" data-place-display="${r.id}">${esc(r.name)}</button><div class="floor-layout-display-manage-actions"><button type="button" class="text-action" data-rename-display="${r.id}">이름 수정</button><button type="button" class="text-action danger-text" data-delete-display="${r.id}">삭제</button></div></div>`).join('')||'<span class="muted">위치를 정하지 않은 TV 없음</span>'}</div>
      </div>`}
      ${asset?`<div class="settings-map-stage floor-layout-stage ${layoutEditMode==='space'?'mode-space':'mode-display'} ${editing?'is-redrawing':''} ${pending?'is-awaiting-placement':''}" data-staff-map-stage="${current.id}" data-staff-space-stage="${current.id}"><div class="floorplan-svg-host" data-floorplan-svg="${asset}"></div>${spaces.map(x=>floorSpaceOverlay(x,true)).join('')}${rooms.map(r=>displayMarker(r,true)).join('')}</div>`:'<div class="floor-plan-empty">도면을 먼저 업로드하세요.</div>'}
      <div class="layout-draft-actions" id="layoutDraftActions" hidden><span>변경 내용을 확인하세요.</span><button type="button" class="btn" id="layoutDraftCancel">취소</button><button type="button" class="btn primary" id="layoutDraftSave">저장</button></div><div class="floor-layout-summary">
        <div><b>공간 ${spaces.length}</b><span>${spaces.length?'지정됨':'아직 없음'}</span></div>
        <div><b>디스플레이 ${placed.length}/${rooms.length}</b><span>${unplaced.length?`미배치 ${unplaced.length}`:'배치 완료'}</span></div>
      </div>
      ${placed.length?`<div class="floor-layout-placed"><div class="floor-layout-placed-head"><b>도면에 배치된 TV</b><small>점을 끌어 위치 수정</small></div>${placed.map(r=>`<div class="floor-layout-placed-row"><span><b>${esc(r.name)}</b><small>${esc(spaceName(r.floor_space_id))}</small></span><div class="display-purpose-field"><label><span>송출 목적</span><input maxlength="120" data-display-purpose="${r.id}" value="${esc(r.display_note||'')}" placeholder="예: 상담 대기 중 브랜드 영상"></label><button type="button" class="text-action" data-save-display-purpose="${r.id}">저장</button></div><button type="button" class="text-action danger-text" data-unplace-display="${r.id}">위치 해제</button></div>`).join('')}</div>`:''}
      <div class="floor-space-list-head"><div><b>공간 목록</b><small>도면에서 공간을 선택해 수정</small></div></div>
      <div class="floor-space-list">${state.floorSpaces.filter(x=>x.group_id===current.id).sort((a,b)=>(Number(a.sort_order||0)-Number(b.sort_order||0))||(Number(a.x_pct||0)-Number(b.x_pct||0))).map(x=>{const linked=rooms.filter(r=>r.floor_space_id===x.id);return `<div class="floor-space-manage-row ${x.id===spaceRedrawId?'is-editing':''}"><div class="floor-space-manage-head"><span><b>${esc(x.name)}</b><small>TV ${linked.length}개${linked.length?` · ${linked.map(r=>esc(r.name)).join(', ')}`:''}</small></span><div class="floor-space-list-actions"><button class="text-action" type="button" data-staff-redraw-space="${x.id}">영역 수정</button><button class="text-action danger-text" type="button" data-staff-delete-space="${x.id}">삭제</button></div></div><div class="floor-space-content-fields"><label><span>공간 설명</span><input maxlength="160" data-space-patient-context="${x.id}" value="${esc(x.patient_context_note||'')}" placeholder="예: 접수 및 이동 안내"></label><label><span>송출 목적</span><input maxlength="240" data-space-content-reason="${x.id}" value="${esc(x.content_reason||'')}" placeholder="예: 첫 방문 안내"></label><button type="button" class="text-action" data-save-space-content="${x.id}">저장</button></div></div>`;}).join('')||'<span class="muted">지정한 공간이 없습니다.</span>'}</div>
    </div>`;
  }
  function operationsLayoutEditorMarkup(){
    const selected=state.groups.find(g=>g.id===selectedFloorId);
    if(selected&&selected.id!==spaceEditorGroupId)spaceEditorGroupId=selected.id;
    const floor=selected?floorNumber(selected):0;
    const meta=floor?floorplanMeta(floor):null;
    return `<section class="hospital-layout-workspace" id="hospitalLayoutWorkspace" aria-label="도면 공간 TV 배치 편집">
      <div class="hospital-layout-workspace-head"><div><small>배치 편집 모드</small><h3>${floor?`${floor}층 도면 · 공간 · TV 배치`:'도면 · 공간 · TV 배치'}</h3><p>현재 재생 설정은 그대로 유지됩니다. 도면을 교체하거나, 공간을 드래그해 그리거나, TV 점을 끌어서 위치를 바꾸세요. 도면에서 변경한 뒤 저장 또는 취소를 선택하세요.</p></div><button type="button" class="btn small" data-ops-layout-toggle>완료 · 보기로</button></div>
      ${floor?`<div class="hospital-layout-floorplan-actions"><div><b>이 층의 도면</b><small>${meta?esc(meta.filename||'도면 등록됨'):'등록된 도면 없음'}</small></div><label class="btn small"><input type="file" accept="image/png,image/jpeg,image/webp" data-staff-floorplan-upload="${floor}"><span>${meta?'도면 교체':'도면 업로드'}</span></label>${meta?`<button type="button" class="btn small" data-staff-floorplan-reset="${floor}">도면 삭제</button>`:''}</div>`:''}
      ${floorLayoutEditorMarkup()}
      <details class="hospital-layout-add-tools"><summary>층 추가 · TV 등록</summary>${structureSetupMarkup()}</details>
    </section>`;
  }
  function structureSetupMarkup(){const floors=[...state.groups].filter(g=>Number(g.floor_number)>0).sort((a,b)=>Number(b.floor_number)-Number(a.floor_number));return `<div class="hospital-admin-block"><div class="hospital-admin-block-head"><div><b>층 · TV 추가</b><small>처음 설치할 때 필요한 기본 구조만 추가합니다.</small></div></div><div class="grid-2"><div class="settings-card"><h3>층 추가</h3><label class="field"><span>층 번호</span><input id="staffNewFloorNumber" type="number" min="1" max="99" placeholder="예: 8"></label><label class="field"><span>표시 이름</span><input id="staffNewFloorName" maxlength="30" placeholder="비우면 8F"></label><button id="staffCreateFloor" class="btn" type="button">층 추가</button></div><div class="settings-card"><h3>TV 추가</h3><label class="field"><span>층</span><select id="staffNewDisplayGroup"><option value="">층 선택</option>${floors.map(g=>`<option value="${g.id}">${esc(floorSettingsLabel(g))}</option>`).join('')}</select></label><label class="field"><span>이름</span><input id="staffNewDisplayName" maxlength="40" placeholder="예: 진료실 1"></label><label class="field"><span>운영 방식</span><select id="staffNewDisplayMode">${CONTROL_MODES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><button id="staffCreateDisplay" class="btn" type="button">TV 추가</button></div><div class="settings-card" style="grid-column:1/-1"><h3>등록된 층 관리</h3><p class="muted">TV, 공간 또는 방송 설정이 연결된 층은 삭제할 수 없습니다. 다른 층의 데이터는 변경하지 않습니다.</p><div class="floor-delete-list">${floors.map(g=>{const tvCount=state.rooms.filter(r=>r.group_id===g.id).length,spaceCount=state.floorSpaces.filter(sp=>sp.group_id===g.id).length;return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--line,#ddd)"><div><b>${esc(floorSettingsLabel(g))}</b> <small class="muted">${g.kind!=='floor'?' · 이전 층 그룹':''} · TV ${tvCount}대 · 공간 ${spaceCount}개</small></div><button type="button" class="btn small" data-staff-delete-floor="${g.id}" ${tvCount||spaceCount?'disabled title="TV나 공간이 있는 층은 삭제할 수 없습니다"':''}>층 삭제</button></div>`;}).join('')||'<p class="muted">등록된 층 없음</p>'}</div></div></div></div></div>`;}
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
  // A guided workflow uses the existing hospital_create_display RPC; it does not
  // change any room schema or existing placement. Record partial failures visibly.
  async function addTvToSelectedSpace(space,name){
    if(name.length>40)return toast('TV 이름은 40자 이내로 입력하세요.','error');
    const before=new Set(state.rooms.map(r=>r.id));
    const {error}=await db.rpc('hospital_create_display',{p_site:targetSiteId,p_group:space.group_id,p_name:name,p_mode:'remote'});if(error)return toast(error.message,'error');
    await load();const room=state.rooms.find(r=>r.group_id===space.group_id&&!before.has(r.id)&&r.name===name);if(!room)return toast('등록된 TV를 미배치 목록에서 선택하세요.','error');
    combinedSourceSpaceId=space.id;combinedPlacementQueue=[room.id];layoutPlacementRoomId=room.id;renderPreservingUi(false);toast('도면에서 TV 위치를 선택하고 저장하세요.');
  }
  async function createDisplaysForSpace(space,count){
    const group=space.group_id, names=Array.from({length:count},(_,i)=>`${space.name} TV${count>1?` ${i+1}`:''}`);
    const existing=new Set(state.rooms.filter(r=>r.group_id===group).map(r=>String(r.name||'').trim().toLowerCase()));
    if(names.some(n=>existing.has(n.toLowerCase())))return toast('같은 이름의 TV가 있습니다. 공간은 저장됐습니다. TV 이름을 확인한 뒤 개별 추가하세요.','error');
    const created=[];
    for(const name of names){
      const before=new Set(state.rooms.map(r=>r.id));
      const {error}=await db.rpc('hospital_create_display',{p_site:targetSiteId,p_group:group,p_name:name,p_mode:'remote'});
      if(error){toast(`공간은 저장됐지만 TV ${created.length}/${count}대만 등록됐습니다. 나머지는 추가해 주세요. ${error.message}`,'error');break;}
      // Reload only after each successful insert to obtain its server-generated ID.
      await load();
      const room=state.rooms.find(r=>r.group_id===group&&!before.has(r.id)&&r.name===name);
      if(!room){toast(`${name}을 등록했으나 ID를 확인하지 못했습니다. 미배치 TV에서 선택해 주세요.`,'error');break;}
      created.push(room.id);
    }
    if(!created.length)return;
    combinedPlacementQueue=[...created];combinedSourceSpaceId=space.id;
    spaceEditorGroupId=group;selectedFloorId=group;layoutPanelOpen=true;layoutEditMode='display';
    layoutPlacementRoomId=combinedPlacementQueue[0];
    renderPreservingUi(false);
    toast(`TV ${created.length}대를 등록했습니다. 도면을 클릭해 ${created.length}대의 위치를 차례로 지정하세요.`);
    requestAnimationFrame(()=>qs('[data-staff-map-stage]')?.scrollIntoView({behavior:'smooth',block:'center'}));
  }
  function syncMediaTargetFromMap(roomId){
    const r=roomById(roomId);if(!r)return false;
    const floor=physicalFloorForRoom(r);
    const group=state.groups.find(g=>g.kind==='floor'&&Number(g.floor_number)===floor)||state.groups.find(g=>g.id===r.group_id);
    if(!group)return false;
    if(!mediaSelectTarget(roomId))return false;
    mediaTargetFloor=String(group.id);
    // Keep floorplan inspector open; update the existing media editor without rerendering it away.
    const selector=qs('#staffPlaylistSelect');if(selector)selector.value=mediaPlaylistId;
    const name=qs('#staffPlaylistName');if(name)name.value=playlistById(mediaPlaylistId)?.name||'';
    const floorSelect=qs('#mediaTargetFloor');if(floorSelect)floorSelect.value=mediaTargetFloor;
    const label=qs('#mediaLinkedTarget');if(label)label.textContent=`영상 편집 대상: ${r.name}${mediaPlaylistSharingCount(mediaPlaylistId)>1?` · 공유 목록 TV ${mediaPlaylistSharingCount(mediaPlaylistId)}대`:""}`;
    const current=qs('#mediaTargetRoom');if(current){const option=Array.from(current.options).find(o=>o.value===String(roomId));if(option)current.value=String(roomId);}
    refreshMediaWorkspace();
    return true;
  }
  async function createQuickDisplay(){
    const group=spaceEditorGroupId||selectedFloorId;
    const name=(qs('#staffQuickDisplayName')?.value||'').trim();
    const mode=qs('#staffQuickDisplayMode')?.value||'remote';
    if(!group||!name)return toast('디스플레이 이름을 입력하세요.','error');
    if(state.rooms.some(r=>r.group_id===group&&r.name?.trim().toLowerCase()===name.toLowerCase()))return toast('같은 층에 같은 이름이 있습니다.','error');
    const button=qs('#staffQuickCreateDisplay');if(button)button.disabled=true;
    try{
      const before=new Set(state.rooms.map(r=>r.id));
      const {error}=await db.rpc('hospital_create_display',{p_site:targetSiteId,p_group:group,p_name:name,p_mode:mode});
      if(error)throw error;
      // load() returns the canonical room ID; no guessed identifiers or local-only record.
      await load();
      const created=state.rooms.find(r=>r.group_id===group&&!before.has(r.id)&&r.name===name);
      layoutPanelOpen=true;spaceEditorGroupId=group;selectedFloorId=group;layoutEditMode='display';
      layoutPlacementRoomId=created?.id||null;
      renderPreservingUi(false);
      toast(created?'등록했습니다. 이제 도면에서 TV 위치를 클릭하세요.':'등록했습니다. 미배치 TV에서 이름을 눌러 위치를 지정하세요.');
      requestAnimationFrame(()=>qs('[data-staff-map-stage]')?.scrollIntoView({behavior:'smooth',block:'center'}));
    }catch(error){toast(displayManageErrorMessage(error),'error');if(button)button.disabled=false;}
  }
  function displayManageErrorMessage(error){
    const msg=String(error?.message||error||'').toLowerCase();
    if(msg.includes('display name required'))return '디스플레이 이름을 입력하세요.';
    if(msg.includes('same display name already exists on this floor'))return '같은 층에 동일한 디스플레이 이름이 이미 있습니다.';
    if(msg.includes('unplace display before deleting'))return '도면에 배치된 TV는 위치를 먼저 해제하세요.';
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
    if(roomMapPlaced(room))return toast('도면에 배치된 TV는 위치를 먼저 해제하세요.','error');
    if(!window.confirm(`'${room.name}' 디스플레이를 삭제할까요?\n\n삭제하면 이 디스플레이의 화면 링크가 더 이상 동작하지 않으며, 누적 송출 통계와 재생 로그도 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.`))return;
    const {error}=await db.rpc('hospital_delete_display',{p_site:targetSiteId,p_room:roomId});if(error)return toast(displayManageErrorMessage(error),'error');
    if(layoutPlacementRoomId===roomId)layoutPlacementRoomId=null;
    toast('디스플레이를 삭제했습니다.');await load();
  }
  // One-page media workspace. The ordered draft is independent of the server's playlist_items.
  // Never persist an incomplete drag/selection; publish only a complete ordered list.
  let mediaPlaylistId='',mediaDraft=[],mediaDirty=false,mediaSaving=false,mediaFilter='',mediaSaveTimer=null,mediaTargetFloor='',mediaTargetRoom='';
  let bulkPlaylistDeleting=false;
  let videoUsageCounts=null,videoUsageFilter='all',videoUsageBusy=false;
  const selectedVideoDeletes=new Set();
  function scheduleMediaSave(){/* Explicit save only: never publish a draft automatically. */}
  window.addEventListener('beforeunload',e=>{
    if(!mediaDirty&&!mediaSaving)return;
    e.preventDefault();e.returnValue='';
  });
  function mediaPlaylistSharingCount(id){if(!id)return 0;return state.rooms.filter(r=>String(r.default_playlist_id||state.groups.find(g=>g.id===r.group_id)?.default_playlist_id||'')===String(id)).length;}
  function mediaTargetInfo(){return state.rooms.find(r=>String(r.id)===mediaTargetRoom)||null;}
  function mediaSelectTarget(roomId){
    if(mediaDirty&&!confirm('저장되지 않은 영상 편성을 버리고 TV를 전환할까요?'))return false;
    clearTimeout(mediaSaveTimer);mediaTargetRoom=String(roomId||'');
    const room=mediaTargetInfo(),id=room?(room.default_playlist_id||state.groups.find(g=>g.id===room.group_id)?.default_playlist_id||''):'';
    mediaPlaylistId=String(id||'');mediaDraft=mediaPlaylistId?mediaPlaylistItems(mediaPlaylistId):[];mediaDirty=false;return true;
  }
  function mediaVideos(){return state.videos.filter(v=>v.active&&(v.site_id===null||v.site_id===undefined||String(v.site_id)===String(targetSiteId)));}
  const isSuperadmin=auth.role==='admin';
  function mediaIsGlobalPlaylist(id){const p=playlistById(id);return !!p&&p.site_id==null;}
  function mediaGlobalReadonly(id){return mediaIsGlobalPlaylist(id)&&!isSuperadmin;}
  function mediaCanEditVideo(video){return !!video&&(String(video.site_id)===String(targetSiteId)||(isSuperadmin&&video.site_id==null));}
  function mediaVideoUpdateQuery(query,video){return video.site_id==null?query.is('site_id',null):query.eq('site_id',targetSiteId);}
  function mediaPlaylistItems(id){return state.playlistItems.filter(x=>String(x.playlist_id)===String(id)).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(x=>String(x.video_id));}
  function mediaThumb(video){return video?.thumbnail_data_url?`<img src="${esc(video.thumbnail_data_url)}" alt="" loading="lazy">`:'<span class="media-no-thumb">▶</span>';}
  function mediaVideoRow(video,queued){const own=String(video.site_id)===String(targetSiteId);return `<div class="media-work-library-item" draggable="true" data-media-source="${esc(video.id)}">${mediaCanEditVideo(video)?`<input type="checkbox" class="video-delete-select" data-video-delete-select="${esc(video.id)}" ${selectedVideoDeletes.has(String(video.id))?'checked':''} aria-label="${esc(video.title)} 삭제 선택">`:''}<span class="media-work-thumb">${mediaThumb(video)}</span><span class="media-work-name"><strong title="${esc(video.title)}">${esc(video.title)}</strong><small>${video.duration_sec?formatDuration(video.duration_sec):'영상'}${video.site_id?' · 병원 영상':' · 공용 영상'}${videoUsageCounts&&Object.hasOwn(videoUsageCounts,String(video.id))?` · ${Number(videoUsageCounts[String(video.id)])?`연결 ${Number(videoUsageCounts[String(video.id)])}개`:'미사용'}`:''}</small></span><button class="btn small" data-media-add="${esc(video.id)}" ${queued?'disabled':''} type="button">${queued?'추가됨':'+ 추가'}</button>${(own||(isSuperadmin&&video.site_id==null))?`<button type="button" class="media-video-delete" data-media-delete="${esc(video.id)}" title="사용 위치 확인 및 원본 삭제" aria-label="${esc(video.title)} 사용 위치 확인 및 삭제">삭제</button>`:''}</div>`;}
  let mediaThumbBusy=false;
  function captureHospitalVideoThumbnail(video){return new Promise((resolve,reject)=>{
    if(!video?.url)return reject(new Error('영상 주소가 없습니다.'));
    const el=document.createElement('video');el.crossOrigin='anonymous';el.preload='auto';el.muted=true;el.playsInline=true;
    let finished=false;const timer=setTimeout(()=>finish(new Error('영상 로딩 시간이 초과됐습니다.')),15000);
    function finish(err,result){if(finished)return;finished=true;clearTimeout(timer);el.pause();el.removeAttribute('src');try{el.load();}catch(_){}err?reject(err):resolve(result);}
    el.addEventListener('error',()=>finish(new Error('영상 파일에 접근할 수 없습니다. 주소 또는 CORS 설정을 확인하세요.')),{once:true});
    el.addEventListener('loadedmetadata',()=>{if(finished)return;try{el.currentTime=Math.min(Math.max(.1,(Number.isFinite(el.duration)?el.duration:1)*.1),2);}catch(_){finish(new Error('영상 프레임을 선택하지 못했습니다.'));}},{once:true});
    el.addEventListener('seeked',()=>{if(finished)return;try{const c=document.createElement('canvas');c.width=320;c.height=180;const ctx=c.getContext('2d',{alpha:false});if(!ctx)throw new Error('Canvas 지원 없음');ctx.fillStyle='#111';ctx.fillRect(0,0,320,180);const w=el.videoWidth,h=el.videoHeight;if(!w||!h)throw new Error('영상 프레임 없음');const scale=Math.min(320/w,180/h);ctx.drawImage(el,(320-w*scale)/2,(180-h*scale)/2,w*scale,h*scale);finish(null,c.toDataURL('image/jpeg',.65));}catch(_){finish(new Error('썸네일 캡처 실패: 영상 서버의 CORS 허용을 확인하세요.'));}},{once:true});
    el.src=video.url;el.load();
  });}
  async function createHospitalThumb(video){
    if(!mediaCanEditVideo(video))throw new Error('이 영상을 수정할 권한이 없습니다.');
    const data=await captureHospitalVideoThumbnail(video);
    const {error}=await mediaVideoUpdateQuery(db.from('videos').update({thumbnail_data_url:data}).eq('id',video.id),video);
    if(error)throw error;video.thumbnail_data_url=data;
  }
  async function generateHospitalThumbnails(videoId){
    if(mediaThumbBusy)return;
    const targets=videoId?state.videos.filter(v=>String(v.id)===String(videoId)):mediaVideos().filter(v=>mediaCanEditVideo(v)&&v.url&&!v.thumbnail_data_url);
    if(!targets.length)return toast('생성할 썸네일이 없습니다.');
    mediaThumbBusy=true;const batch=qs('#mediaGenerateMissingThumbs');const label=batch?.textContent;if(batch){batch.disabled=true;batch.textContent='썸네일 생성 중…';}
    let ok=0,fail=0,firstError='';
    try{for(const v of targets){try{await createHospitalThumb(v);ok++;}catch(e){fail++;if(!firstError)firstError=e?.message||'알 수 없는 오류';}refreshMediaWorkspace();}
      toast(`썸네일 ${ok}개 생성${fail?` · 실패 ${fail}개 (${firstError})`:''}`,fail?'error':'info');
    }finally{mediaThumbBusy=false;if(batch){batch.disabled=false;batch.textContent=label||'누락 썸네일 생성';}refreshMediaWorkspace();}
  }

  function mediaFilteredVideos(){return mediaVideos().filter(v=>String(v.title||'').toLowerCase().includes(mediaFilter.toLowerCase())&&(videoUsageFilter!=='unused'||videoUsageCounts&&Object.hasOwn(videoUsageCounts,String(v.id))&&Number(videoUsageCounts[String(v.id)])===0));}
  async function refreshVideoUsage(){
    if(videoUsageBusy)return;
    videoUsageBusy=true;const button=qs('#videoUsageRefresh');if(button)button.disabled=true;
    try{
      if(!dbInfo.features.includes('video_delete_impact_v1'))await checkDbVersion();
      if(!dbInfo.features.includes('video_delete_impact_v1'))throw new Error('먼저 supabase/v2.36.1-video-delete-impact.sql을 실행하세요.');
      const ids=mediaVideos().filter(mediaCanEditVideo).map(v=>String(v.id));const counts={};
      for(let i=0;i<ids.length;i+=1000){const {data,error}=await db.rpc('video_usage_counts',{p_site:targetSiteId,p_ids:ids.slice(i,i+1000)});if(error)throw error;Object.assign(counts,data||{});}
      videoUsageCounts=counts;refreshMediaWorkspace();
    }catch(e){videoUsageCounts=null;videoUsageFilter='all';refreshMediaWorkspace();toast(e.message||'사용 현황 조회 실패','error');}
    finally{videoUsageBusy=false;const b=qs('#videoUsageRefresh');if(b)b.disabled=false;}
  }
  function updateVideoDeleteControls(){
    const b=qs('#videoDeleteSelected');if(b){b.textContent=`선택 ${selectedVideoDeletes.size}개 삭제`;b.disabled=!selectedVideoDeletes.size||deletingHospitalVideo;}
    const filter=qs('#videoUsageFilter');if(filter){filter.value=videoUsageFilter;filter.disabled=!videoUsageCounts;}
  }
  function mediaQueueRow(id,i){const v=state.videos.find(x=>String(x.id)===id);return `<div class="media-work-queue-item" draggable="true" data-media-queue-id="${esc(id)}"><span class="media-work-handle" aria-label="순서 변경">⠿</span><span class="media-work-index">${i+1}</span><span class="media-work-thumb">${mediaThumb(v)}</span><span class="media-work-name"><strong>${esc(v?.title||'삭제된 영상')}</strong><small>${v?.duration_sec?formatDuration(v.duration_sec):''}</small></span><div class="media-work-queue-actions"><button type="button" class="btn small" data-media-move="${esc(id)}" data-dir="-1" ${i===0?'disabled':''} aria-label="위로 이동">↑</button><button type="button" class="btn small" data-media-move="${esc(id)}" data-dir="1" ${i===mediaDraft.length-1?'disabled':''} aria-label="아래로 이동">↓</button><button type="button" class="btn small" data-media-remove="${esc(id)}" title="재생목록에서만 제거 (원본 유지)" aria-label="재생목록에서 제거">×</button></div></div>`;}
  function hospitalPlaylistManagerMarkup(){
    const own=state.playlists.filter(p=>p.active!==false&&(p.site_id==null||String(p.site_id)===String(targetSiteId))).sort((a,b)=>Number(a.site_id==null)-Number(b.site_id==null)||(a.sort_order||0)-(b.sort_order||0));
    const videos=mediaVideos();
    if(mediaPlaylistId&&!own.some(p=>String(p.id)===mediaPlaylistId)){mediaPlaylistId='';mediaDraft=[];mediaDirty=false;}
    // Do not silently choose another TV's playlist. The user selects a TV or a list explicitly.
    const playlist=own.find(p=>String(p.id)===mediaPlaylistId);
    const globalSelected=!!playlist&&playlist.site_id==null;
    const queueSet=new Set(mediaDraft),filtered=mediaFilteredVideos();
    const rooms=state.rooms.filter(r=>r&&r.id);
    // One navigation row per *physical floor*, not per care type / display group.
    // Legacy data can contain multiple groups on the same floor (e.g. general and orthodontics).
    const rawFloors=state.groups.filter(g=>g.kind==='floor'&&Number(g.floor_number)>0);
    const floorPool=rawFloors.length?rawFloors:state.groups.filter(g=>Number(g.floor_number)>0);
    const floorByNumber=new Map();
    for(const g of floorPool.sort((a,b)=>Number(b.floor_number)-Number(a.floor_number))){
      const n=Number(g.floor_number);
      if(!floorByNumber.has(n))floorByNumber.set(n,{...g,name:`${n}층`,rooms:[]});
    }
    const floorOptions=[...floorByNumber.values()].sort((a,b)=>Number(b.floor_number)-Number(a.floor_number));
    for(const g of floorOptions)g.rooms=roomsForFloorGroup(g);
    const target=mediaTargetInfo();
    const overviewGroup=state.groups.find(g=>String(g.id)===String(selectedFloorId));
    const overviewFloor=floorOptions.find(g=>Number(g.floor_number)===Number(overviewGroup?.floor_number));
    const activeTargetFloor=mediaTargetFloor||String(overviewFloor?.id||floorOptions.find(g=>g.rooms.some(r=>String(r.id)===String(target?.id)))?.id||'');
    const activeGroup=floorOptions.find(g=>String(g.id)===String(activeTargetFloor));
    const floorRooms=activeGroup?.rooms||[];
    const sharedCount=mediaPlaylistSharingCount(mediaPlaylistId),sharedNotice=sharedCount>1?`<p class="media-shared-warning" id="mediaSharedWarning">TV ${sharedCount}대가 사용 중입니다. 저장하면 모두 변경됩니다.</p>`:'';
    // Floor-first navigation: a single click narrows every subsequent operation to that floor.
    // Keep the existing select in the DOM for the tested change handler and accessibility fallback.
    // Restore the original building metaphor: floors in ONE vertical stack, highest first.
    // The selected floor controls the TV and playlist editor alongside it.
    const buildingFloors=floorOptions;
    const floorsMarkup=`<section class="media-floor-first" aria-label="건물 층별 관리"><div class="media-floor-first-head"><div><h2>층별 관리</h2><p></p></div><span>전체 ${buildingFloors.length}개 층</span></div><div class="media-floor-cards" role="group" aria-label="건물 층별 목록">${buildingFloors.map(g=>{const live=g.rooms.filter(r=>roomDisplayStatus(r).key==='live').length;const chosen=String(g.id)===String(activeTargetFloor);const issue=g.rooms.length>0&&live<g.rooms.length;return `<button type="button" class="media-floor-card${chosen?' is-active':''}${issue?' has-issue':''}" data-media-floor-quick="${esc(g.id)}" aria-pressed="${chosen?'true':'false'}"><strong>${Number(g.floor_number)}층</strong><span class="media-floor-room-count">TV ${g.rooms.length}대</span><span class="media-floor-live">송출 ${live}대</span><i class="media-floor-status-dot${issue?' is-issue':live?' is-live':''}" aria-hidden="true"></i></button>`;}).join('')}</div></section>`;
    const tvSelector=`<section class="media-target-picker"><div class="media-target-heading"><div><strong>${activeTargetFloor?'TV를 선택하세요':'건물에서 층을 선택하세요'}</strong><small></small></div><span class="media-target-current">${target?esc(target.name):'TV 선택 전'}</span></div><select id="mediaTargetFloor" class="media-target-floor-fallback" aria-label="관리할 층"><option value="">층 선택</option>${buildingFloors.map(g=>`<option value="${esc(g.id)}" ${String(g.id)===String(activeTargetFloor)?'selected':''}>${Number(g.floor_number)}층 · ${g.rooms.length}대</option>`).join('')}</select><div id="mediaLinkedTarget" class="media-linked-target" role="status">${target?`영상 편집 대상: ${esc(target.name)}`:'TV 선택 전'}</div><div class="media-target-fields media-target-room-only"><label>TV<select id="mediaTargetRoom" ${activeTargetFloor?'':'disabled'}><option value="">TV 선택</option>${floorRooms.map(r=>`<option value="${esc(r.id)}" ${String(r.id)===mediaTargetRoom?'selected':''}>${esc(r.name)}</option>`).join('')}</select></label></div>${target?`<p class="media-target-detail">현재 편성: <b>${esc(playlistById(mediaPlaylistId)?.name||'연결된 재생목록 없음')}</b> · ${esc(roomDisplayStatus(target).label||'상태 확인 중')}</p>`:''}</section>`;
    const targetSelector=`<div class="media-building-layout media-building-layout-secondary"><div class="media-building-detail">${tvSelector}</div></div>`;

    const bulkOwn=own.filter(p=>p.site_id!=null&&String(p.site_id)===String(targetSiteId));
    const bulkShared=isSuperadmin?own.filter(p=>p.site_id==null):[];
    const bulkRows=(items)=>items.map(p=>`<label class="media-bulk-playlist-row"><input type="checkbox" data-bulk-playlist-id="${esc(p.id)}"><span><strong>${esc(p.name)}</strong><small>${p.site_id==null?'공용 · 전체 병원 영향':'병원 전용'} · TV 연결 ${mediaPlaylistSharingCount(p.id)}대</small></span></label>`).join('');
    const bulkManager=`<details class="media-bulk-playlists" id="mediaBulkPlaylists"><summary>재생목록 여러 개 삭제</summary><p>목록 삭제 시 TV·층 연결만 해제됩니다. 영상 원본은 유지됩니다.</p><div class="media-bulk-playlist-controls"><label><input type="checkbox" id="mediaBulkSelectOwn"> 병원 전용 전체 선택</label><span id="mediaBulkSelectedCount">선택 0개</span></div><div class="media-bulk-playlist-list">${bulkRows(bulkOwn)||'<p class="muted">병원 전용 재생목록이 없습니다.</p>'}</div>${isSuperadmin?`<details class="media-bulk-global"><summary>공용 재생목록 (슈퍼어드민 전용 · 별도 선택)</summary><p>공용 목록은 모든 병원에 영향을 줄 수 있습니다. 삭제는 슈퍼어드민만 가능합니다.</p><div class="media-bulk-playlist-list">${bulkRows(bulkShared)}</div></details>`:''}<div class="media-bulk-playlist-actions"><button type="button" class="btn danger-outline" id="mediaBulkDeletePlaylists" disabled>선택한 재생목록 삭제</button><span id="mediaBulkPlaylistResult" role="status"></span></div></details>`;
    return `<section class="media-workspace"><div class="media-work-toolbar"><h2>재생목록</h2><div class="media-work-controls"><label class="media-playlist-select-label"><select id="staffPlaylistSelect" aria-label="재생목록 선택"><option value="">새 재생목록</option>${own.map(p=>`<option value="${esc(p.id)}" ${String(p.id)===mediaPlaylistId?'selected':''}>${esc(p.name)}${p.site_id==null?' · 공용':''}</option>`).join('')}</select></label><button type="button" class="btn primary" data-new-playlist>+ 새 목록</button><button type="button" class="btn" id="mediaOpenUpload">영상 업로드</button></div></div><details id="mediaUploadQuickDetails" class="media-upload-collapse"><summary>빠른 업로드</summary><button type="button" id="mediaQuickUpload" class="media-quick-upload"><span>⇧ &nbsp; MP4를 여기에 끌어놓거나 눌러서 업로드</span><small>여러 파일 선택 가능 · 원본 1080p 유지 · 업로드 완료 후 목록에 표시</small></button></details>
    <div class="media-work-columns"><section class="media-work-panel"><div class="media-work-section-head"><div><h3>영상 보관함</h3><small>전체 ${videos.length}개</small></div></div><label class="media-work-search"><span>⌕</span><input id="mediaWorkSearch" type="search" placeholder="영상 검색" value="${esc(mediaFilter)}" autocomplete="off" aria-label="영상 검색"></label><div class="video-usage-toolbar"><button class="btn small" type="button" id="videoUsageRefresh">사용 현황 조회</button><select id="videoUsageFilter" aria-label="영상 사용 필터" ${videoUsageCounts?'':'disabled'}><option value="all" ${videoUsageFilter==='all'?'selected':''}>전체 영상</option><option value="unused" ${videoUsageFilter==='unused'?'selected':''}>미사용 영상</option></select><button class="btn small" type="button" id="videoDeleteSelected" ${selectedVideoDeletes.size?'':'disabled'}>선택 ${selectedVideoDeletes.size}개 삭제</button></div><div id="mediaWorkLibrary" class="media-work-scroll">${filtered.map(v=>mediaVideoRow(v,queueSet.has(String(v.id)))).join('')||'<p class="muted">검색 결과가 없습니다.</p>'}</div><p class="media-work-help">원본 삭제와 목록에서 제거(×)는 다릅니다.</p></section>
    <section class="media-work-panel media-work-editor"><div class="media-work-section-head media-work-editor-head"><div><h3>재생 순서</h3></div><div class="media-work-editor-actions"><span class="media-work-count" id="mediaWorkCount">${mediaDraft.length}개</span><button type="button" class="btn primary media-work-save-top" id="mediaSaveTop" ${globalSelected&&!isSuperadmin?'disabled':''}>변경 저장</button></div></div><label class="field media-work-name-field"><span>재생목록 이름</span><input id="staffPlaylistName" maxlength="60" value="${esc(playlist?.name||'')}" ${globalSelected&&!isSuperadmin?'readonly':''} placeholder="예: 9층 대기실" autocomplete="off"></label>${globalSelected?`<p class="media-shared-warning">${isSuperadmin?'슈퍼어드민: 공용 재생목록을 수정하면 사용하는 모든 병원에 영향을 줍니다.':'공용 재생목록입니다. 원본은 수정할 수 없습니다.'} <button type="button" class="btn small" id="mediaCopyGlobal">이 병원에 복사해서 수정</button></p>`:''}${sharedNotice}<div id="mediaWorkQueue" class="media-work-scroll media-work-queue" aria-label="재생 순서">${mediaDraft.map(mediaQueueRow).join('')||'<div class="media-work-dropempty">영상 보관함에서 추가하세요.</div>'}</div><div class="media-work-foot"><span id="mediaWorkSaveStatus" role="status" aria-live="polite">${mediaDirty?'저장되지 않은 변경 사항 · 변경 저장 필요':'현재 재생목록 · 저장 상태'}</span><div><button id="staffDeletePlaylist" class="btn danger-outline" type="button" ${playlist&&(!globalSelected||isSuperadmin)?'':'disabled'}>삭제</button><button id="staffSavePlaylist" class="btn primary" type="button" ${globalSelected&&!isSuperadmin?'disabled':''}>${mediaDirty?'변경 저장':'저장'}</button></div></div></section></div>
    <section class="media-work-apply"><div class="media-work-section-head"><div><h3>TV에 적용</h3><small>기존 목록을 수정한 경우 다시 적용할 필요가 없습니다.</small></div><button class="btn primary" type="button" id="mediaWorkApplyTv" disabled>선택한 TV에 적용</button></div>${targetSelector}<div class="media-work-apply-current"><button type="button" class="btn" id="mediaApplyCurrent" ${target&&mediaPlaylistId&&!mediaDirty?"":"disabled"}>이 TV에 적용</button></div>
    <details class="media-bulk-apply"><summary>여러 TV에 적용</summary><div class="media-work-tv-toolbar"><label class="media-work-floor-label">층 선택<select id="mediaWorkFloor"><option value="">층을 선택하세요</option>${floorOptions.map(g=>`<option value="${esc(g.id)}">${Number(g.floor_number)}층 · TV ${g.rooms.length}대</option>`).join('')}</select></label><label class="media-work-tv-search-label">TV 검색<input id="mediaWorkTvSearch" type="search" placeholder="TV 이름 검색" autocomplete="off" disabled></label><span id="mediaWorkTvSelection" class="media-work-selected">선택한 TV 0대</span></div>
    <div class="media-work-tv-list" id="mediaWorkTvList" aria-label="TV 선택">${rooms.map(r=>`<label class="media-work-tv media-work-tv-compact" data-media-tv-row data-media-floor="${esc(floorOptions.find(g=>g.rooms.some(x=>String(x.id)===String(r.id)))?.id||'')}" data-media-search="${esc(String(r.name||'').toLowerCase())}" hidden><input type="checkbox" data-media-tv="${esc(r.id)}"><span><strong>${esc(r.name)}</strong><small>${esc(playlistById(r.default_playlist_id)?.name||'기본 편성')}</small></span></label>`).join('')||'<span class="muted">등록된 TV가 없습니다.</span>'}</div><p class="media-work-tv-empty" id="mediaWorkTvEmpty">층을 선택하세요.</p><p class="media-work-help">선택한 TV에만 적용됩니다.</p></details></section>
    <section class="media-work-manage"><details id="mediaWorkManageDetails"><summary>영상 관리</summary><button type="button" class="btn small" id="mediaR2CleanupRetry">R2 정리 재시도</button><p>${isSuperadmin?'병원 영상과 공용 영상의 제목·파일을 관리할 수 있습니다. 공용 영상 변경은 모든 병원에 적용됩니다.':'이 병원 영상의 제목 변경, MP4 업로드 및 파일 교체를 할 수 있습니다.'} 원본 영상 ID와 재생목록 연결은 유지됩니다.</p><div class="media-work-edit"><select id="mediaWorkEditVideo"><option value="">영상 선택</option>${videos.filter(mediaCanEditVideo).map(v=>`<option value="${esc(v.id)}">${esc(v.title)}${v.site_id==null?' · 공용':''}</option>`).join('')}</select><input id="mediaWorkEditName" placeholder="새 영상 이름" maxlength="100"><button type="button" class="btn" id="mediaWorkRename">이름 변경</button><button type="button" class="btn" id="mediaSelectedThumb">선택 영상 썸네일 재생성</button><button type="button" class="btn small" id="mediaGenerateMissingThumbs" ${videos.some(v=>mediaCanEditVideo(v)&&v.url&&!v.thumbnail_data_url)?'':'disabled'}>누락 썸네일 생성</button></div><div class="media-work-edit" id="mediaWorkUploadDrop"><input type="file" id="mediaWorkUploadFile" accept="video/mp4,.mp4" multiple><button class="btn" type="button" id="mediaWorkUpload">새 영상 업로드</button><button class="btn" type="button" id="mediaWorkReplace">선택 영상 파일 교체</button><progress id="mediaWorkUploadProgress" max="100" value="0" hidden></progress></div></details></section>${bulkManager}</section>`;
  }
  function refreshMediaWorkspace(){
    const panel=qs('#mediaWorkQueue'),library=qs('#mediaWorkLibrary'),counter=qs('#mediaWorkCount');
    if(panel)panel.innerHTML=mediaDraft.map(mediaQueueRow).join('')||'<div class="media-work-dropempty">영상 보관함에서 추가하세요.</div>';
    if(library){const queued=new Set(mediaDraft);library.innerHTML=mediaFilteredVideos().map(v=>mediaVideoRow(v,queued.has(String(v.id)))).join('')||'<p class="muted">검색 결과가 없습니다.</p>';}
    if(counter)counter.textContent=`${mediaDraft.length}개`;
    const status=qs('#mediaWorkSaveStatus');if(status){status.textContent=mediaSaving?'저장 중…':mediaDirty?'● 저장하지 않은 변경 사항':'✓ 저장 완료 · TV 송출 적용은 별도 확인';status.classList.toggle('is-unsaved',!!mediaDirty);}
    const globalReadonly=mediaGlobalReadonly(mediaPlaylistId);
    const saveBtn=qs('#staffSavePlaylist');if(saveBtn)saveBtn.disabled=globalReadonly||mediaSaving;
    const saveTop=qs('#mediaSaveTop');if(saveTop){saveTop.disabled=globalReadonly||mediaSaving;saveTop.textContent=mediaSaving?'저장 중…':mediaDirty?'변경 저장':'저장됨';saveTop.disabled=globalReadonly||mediaSaving||!mediaDirty&&!!mediaPlaylistId;}
    const nameInput=qs('#staffPlaylistName');if(nameInput)nameInput.readOnly=globalReadonly;
    qsa('[data-media-add],[data-media-remove],[data-media-move]').forEach(el=>{el.disabled=globalReadonly||el.hasAttribute('data-media-add')&&mediaDraft.includes(el.dataset.mediaAdd);});
    const currentApply=qs('#mediaApplyCurrent');if(currentApply)currentApply.disabled=!mediaTargetRoom||!mediaPlaylistId||mediaDirty||mediaSaving;
    refreshMediaTvSelection();
    bindMediaDragAndButtons();updateVideoDeleteControls();
  }
  function fillHospitalPlaylistEditor(){
    const id=qs('#staffPlaylistSelect')?.value||'';
    clearTimeout(mediaSaveTimer);mediaPlaylistId=id;mediaDraft=id?mediaPlaylistItems(id):[];mediaDirty=false;
    const p=state.playlists.find(x=>String(x.id)===id),name=qs('#staffPlaylistName'),del=qs('#staffDeletePlaylist');
    if(name){name.value=p?.name||'';name.readOnly=mediaGlobalReadonly(id);}if(del)del.disabled=!p||mediaGlobalReadonly(id);
    qsa('[data-media-tv]').forEach(el=>{el.checked=false;});
    refreshMediaWorkspace();
  }
  async function saveHospitalPlaylist(){
    clearTimeout(mediaSaveTimer);if(mediaSaving)return false;
    if(mediaGlobalReadonly(mediaPlaylistId))return toast('공용 재생목록은 슈퍼어드민만 수정할 수 있습니다.','error'),false;
    const id=mediaPlaylistId||null,name=(qs('#staffPlaylistName')?.value||'').trim(),videoIds=[...mediaDraft];
    if(mediaPlaylistSharingCount(id)>1&&!confirm(`이 재생목록을 ${mediaPlaylistSharingCount(id)}대 TV가 함께 사용합니다. 모든 TV의 재생 순서가 바뀝니다. 저장할까요?`))return false;
    if(!name)return toast('재생목록 이름을 입력하세요.','error'),false;
    if(!videoIds.length)return toast('빈 재생목록은 저장할 수 없습니다. 다른 영상을 추가하거나 목록 자체를 삭제하세요.','error'),false;
    mediaSaving=true;refreshMediaWorkspace();
    try{
      const isGlobal=mediaIsGlobalPlaylist(id);
      if(isGlobal&&!confirm('공용 재생목록 수정은 사용 중인 모든 병원에 영향을 줍니다. 저장할까요?'))return false;
      const {data,error}=isGlobal?await db.rpc('superadmin_save_global_playlist',{p_id:id,p_name:name,p_video_ids:videoIds}):await db.rpc('hospital_save_site_playlist',{p_site:targetSiteId,p_id:id,p_name:name,p_video_ids:videoIds});
      if(error)throw error;
      mediaPlaylistId=String(data||id||'');mediaDirty=false;
      toast('DB에 재생목록을 저장했습니다. TV 반영 상태는 송출 현황에서 확인하세요.');await load();return true;
    }catch(e){mediaDirty=true;toast(e.message||'저장하지 못했습니다. 다시 시도하세요.','error');return false;}
    finally{mediaSaving=false;refreshMediaWorkspace();}
  }
  let deletingHospitalVideo=false;
  function confirmVideoImpact(impacts,globalVideo){
    const labels={playlist:'재생목록',rule:'개별 TV 영상 규칙',manual:'TV 수동 송출',site:'병원 송출',group:'층 송출',schedule:'예약 송출',emergency_site:'병원 긴급 영상',emergency_global:'전체 긴급 영상',legacy:'기존 공통 송출'};
    const all=Array.isArray(impacts)?impacts:[impacts];const tvs=[...new Map(all.flatMap(i=>i.tvs||[]).map(x=>[x.id,x])).values()];const refs=new Map();
    for(const i of all)for(const l of i.links||[]){const key=l.kind+':'+l.id;const old=refs.get(key);refs.set(key,{...l,removed:(old?.removed||0)+1});}
    const links=[...refs.values()];const dialog=document.createElement('dialog');dialog.className='video-impact-dialog';dialog.setAttribute('aria-label','영상 삭제');
    const details=all.map(i=>`<section><h4>${esc(i.title)}</h4>${i.links?.length?`<ul>${i.links.map(l=>{const combined=refs.get(l.kind+':'+l.id);const remaining=l.remaining==null?null:Math.max(0,Number(l.remaining)-(combined.removed-1));return `<li><b>${esc(l.label)}</b><small>${esc(labels[l.kind]||l.kind)}${globalVideo?` · ${esc(l.site)}`:""}</small>${remaining===0?'<small class="video-impact-warning">삭제 후 비워집니다.</small>':remaining!=null?`<small>남는 영상 ${remaining}개</small>`:''}</li>`;}).join('')}</ul>`:'<p>사용 중인 연결 없음</p>'}</section>`).join('');
    dialog.innerHTML=`<form method="dialog"><header><h3>영상 삭제</h3>${all.length>1?`<p>${all.length}개 선택</p>`:""}</header><div class="video-impact-body">${links.length?`<p><strong>연결 ${links.length}개 · 확인된 TV ${tvs.length}대</strong></p>`:""}${globalVideo?'<p class="video-impact-warning">공용 영상 · 다른 병원에도 적용됩니다.</p>':''}${details}${tvs.length?`<details><summary>연결 대상 TV ${tvs.length}대 보기</summary><ul>${tvs.map(t=>`<li>${esc(t.site)} · ${esc(t.label)}</li>`).join('')}</ul></details>`:''}${links.length?`<p class="video-impact-note">${tvs.length||globalVideo||links.some(l=>l.kind!=='playlist')?'송출이 변경될 수 있습니다. ':''}다른 영상과 재생목록은 유지됩니다.</p>`:""}<p class="video-impact-note">삭제 후 복구할 수 없습니다.</p></div><footer><button class="btn" value="cancel" autofocus>취소</button><button class="btn video-impact-delete" value="delete">${links.length?'연결 해제 및 삭제':'삭제'}</button></footer></form>`;
    document.body.append(dialog);
    return new Promise(resolve=>{dialog.addEventListener('close',()=>{const ok=dialog.returnValue==='delete';dialog.remove();resolve(ok);},{once:true});try{dialog.showModal();}catch(e){dialog.remove();resolve(false);toast('삭제 확인 창을 열지 못했습니다. 최신 브라우저에서 다시 시도하세요.','error');}});
  }
  async function deleteHospitalVideo(videoId){return deleteHospitalVideos([videoId]);}
  async function deleteHospitalVideos(ids){
    if(deletingHospitalVideo||mediaSaving||mediaDirty){toast(mediaDirty?'재생목록 변경을 먼저 저장하거나 취소하세요.':'다른 작업이 끝난 뒤 삭제하세요.','error');return;}
    const unique=[...new Set(ids.map(String))];if(!unique.length||unique.length>10)return toast('영상은 1~10개씩 삭제하세요.','error');
    const videos=unique.map(id=>state.videos.find(v=>String(v.id)===id));
    if(videos.some(v=>!mediaCanEditVideo(v)))return toast('영상이 없거나 삭제 권한이 없습니다.','error');
    deletingHospitalVideo=true;updateVideoDeleteControls();
    try{
      if(!dbInfo.features.includes('video_delete_impact_v1'))await checkDbVersion();
      if(!dbInfo.features.includes('video_delete_impact_v1'))throw new Error('영상 사용 위치 확인 기능을 사용하려면 supabase/v2.36.1-video-delete-impact.sql을 먼저 실행하세요.');
      const post=body=>apiJson('/api/video-delete',{method:'POST',body:JSON.stringify({...body,siteId:targetSiteId})});
      const impacts=await Promise.all(unique.map(videoId=>post({action:'preview',videoId})));
      if(!await confirmVideoImpact(impacts,videos.some(v=>v.site_id==null)))return;
      const items=unique.map((videoId,i)=>({videoId,signature:impacts[i].signature}));
      const result=await post(items.length===1?{action:'confirm',...items[0]}:{action:'batch-confirm',items});
      const pending=items.length===1?!!result.cleanup_pending:(result.results||[]).some(x=>x.cleanup_pending);
      mediaDraft=mediaDraft.filter(x=>!unique.includes(String(x)));unique.forEach(id=>selectedVideoDeletes.delete(id));videoUsageCounts=null;videoUsageFilter='all';
      toast(pending?'영상은 보관함에서 삭제됐지만 R2 정리가 대기 중입니다. 「R2 정리 재시도」를 눌러주세요.':`영상 ${unique.length}개 삭제가 완료됐습니다.`,pending?'error':undefined);
      await load();
    }catch(e){toast(e.message||'영상 삭제에 실패했습니다.','error');}
    finally{deletingHospitalVideo=false;updateVideoDeleteControls();}
  }
  // 서버 미리보기 결과를 경고창에 표시하고, 동일한 상태 지문으로 원자적 삭제한다.
  async function requestPlaylistDelete(ids){
    const unique=[...new Set(ids.map(String).filter(Boolean))];
    if(!unique.length)return;
    const selected=unique.map(id=>playlistById(id));
    if(selected.some(p=>!p))return toast('삭제할 재생목록을 다시 선택해 주세요.','error');
    if(selected.some(p=>p.site_id==null)&&!isSuperadmin)return toast('공용 재생목록은 슈퍼어드민만 삭제할 수 있습니다.','error');
    if(selected.some(p=>p.site_id!=null&&String(p.site_id)!==String(targetSiteId)))return toast('다른 병원의 재생목록은 삭제할 수 없습니다.','error');
    const args={p_site:targetSiteId,p_ids:unique,p_dry_run:true,p_expected_signature:null};
    const preview=await db.rpc('hospital_bulk_delete_playlists',args);
    if(preview.error){
      if(preview.error.code==='PGRST202')return toast('재생목록 일괄 삭제 SQL이 아직 적용되지 않았습니다.','error');
      return toast('삭제 영향 확인 실패: '+preview.error.message,'error');
    }
    const impact=preview.data||{};
    if(impact.playlist_count!==unique.length)return toast('선택한 재생목록 수가 변경되었습니다. 새로고침 후 다시 시도해 주세요.','error');
    const label=selected.map(p=>p.name).slice(0,5).join(', ')+(selected.length>5?` 외 ${selected.length-5}개`:'');
    const warning=`재생목록 ${impact.playlist_count}개를 삭제하시겠습니까?\n\n${label}\n\n연결 해제 대상\n- 병원 ${impact.site_count||0}곳\n- TV ${impact.tv_count||0}대\n- 층 기본 연결 ${impact.group_count||0}개\n\n삭제하면 연결된 TV·층의 기본 재생목록 지정이 해제됩니다. 남은 기본 목록 또는 다른 송출 설정에 따라 재생될 수 있으며, 영상이 없으면 송출이 중단될 수 있습니다.\n공용 목록은 직접 연결되지 않은 병원에도 영향을 줄 수 있습니다.\n영상 원본과 R2 파일은 삭제되지 않습니다.\n\n이 작업은 되돌릴 수 없습니다.`;
    if(!window.confirm(warning))return;
    const result=await db.rpc('hospital_bulk_delete_playlists',{
      ...args,p_dry_run:false,p_expected_signature:impact.signature
    });
    if(result.error){
      const stale=String(result.error.message||'').includes('목록 연결 상태가 변경');
      return toast(stale?'TV 연결 상태가 변경되었습니다. 다시 시도하면 최신 영향 범위를 보여줍니다.':'삭제 실패: '+result.error.message,'error');
    }
    if(unique.includes(String(mediaPlaylistId))){mediaPlaylistId='';mediaDraft=[];mediaDirty=false;}
    clearTimeout(mediaSaveTimer);
    toast(`${result.data?.deleted_count||unique.length}개 재생목록을 삭제하고 TV 연결을 해제했습니다.`);
    await load();
    const details=qs('#mediaBulkPlaylists');if(details)details.open=true;
    const summary=qs('#mediaBulkPlaylistResult');if(summary)summary.textContent=`${result.data?.deleted_count||unique.length}개 삭제 완료 · TV ${result.data?.tv_count||0}대 연결 해제`;
  }
  async function deleteHospitalPlaylist(){
    if(!mediaPlaylistId||bulkPlaylistDeleting)return;
    if(mediaDirty)return toast('편집 중인 재생목록을 먼저 저장하거나 취소하세요.','error');
    bulkPlaylistDeleting=true;
    try{await requestPlaylistDelete([mediaPlaylistId]);}
    finally{bulkPlaylistDeleting=false;}
  }
  async function deleteSelectedPlaylists(){
    if(bulkPlaylistDeleting||mediaSaving)return;
    if(mediaDirty)return toast('편집 중인 재생목록을 먼저 저장하거나 취소하세요.','error');
    const ids=[...new Set(qsa('[data-bulk-playlist-id]:checked').map(el=>String(el.dataset.bulkPlaylistId||'')))];
    if(!ids.length)return toast('삭제할 재생목록을 선택하세요.','error');
    bulkPlaylistDeleting=true;
    const action=qs('#mediaBulkDeletePlaylists');if(action)action.disabled=true;
    try{await requestPlaylistDelete(ids);}
    finally{bulkPlaylistDeleting=false;if(action)action.disabled=false;}
  }
  function bindBulkPlaylistDelete(){
    const root=qs('#mediaBulkPlaylists');if(!root)return;
    const update=()=>{const checked=root.querySelectorAll('[data-bulk-playlist-id]:checked').length;const count=qs('#mediaBulkSelectedCount'),button=qs('#mediaBulkDeletePlaylists');if(count)count.textContent=`선택 ${checked}개`;if(button)button.disabled=!checked||bulkPlaylistDeleting;};
    qs('#mediaBulkSelectOwn')?.addEventListener('change',e=>{root.querySelectorAll('[data-bulk-playlist-id]').forEach(box=>{const p=playlistById(box.dataset.bulkPlaylistId);if(p&&String(p.site_id)===String(targetSiteId))box.checked=e.target.checked;});update();});
    root.querySelectorAll('[data-bulk-playlist-id]').forEach(box=>box.addEventListener('change',()=>{const own=[...root.querySelectorAll('[data-bulk-playlist-id]')].filter(el=>String(playlistById(el.dataset.bulkPlaylistId)?.site_id)===String(targetSiteId));const check=qs('#mediaBulkSelectOwn');if(check)check.checked=own.length>0&&own.every(el=>el.checked);update();}));
    qs('#mediaBulkDeletePlaylists')?.addEventListener('click',()=>void deleteSelectedPlaylists());
    update();
  }
  function mediaMove(from,to){if(mediaGlobalReadonly(mediaPlaylistId))return;if(from<0||to<0||from>=mediaDraft.length||to>=mediaDraft.length||from===to)return;const moved=mediaDraft.splice(from,1)[0];mediaDraft.splice(to,0,moved);mediaDirty=true;refreshMediaWorkspace();scheduleMediaSave();}
  document.addEventListener('click',e=>{if(e.target.closest?.('#mediaR2CleanupRetry')){e.preventDefault();void retryVideoR2Cleanup();}});
  async function retryVideoR2Cleanup(){
    try{const d=await apiJson('/api/video-delete',{method:'POST',body:JSON.stringify({action:'retry',siteId:targetSiteId})});
      const failed=(d.results||[]).filter(x=>x.cleanup_pending).length;
      toast(failed?`R2 정리 ${d.retried}건 재시도, ${failed}건은 아직 실패했습니다.`:`R2 정리 작업 ${d.retried}건 확인 완료.`,failed?'error':undefined);
    }catch(e){toast('R2 정리 재시도 실패: '+(e.message||String(e)),'error');}
  }
  function bindMediaDragAndButtons(){
    qsa('[data-video-delete-select]').forEach(b=>b.onchange=()=>{const id=b.dataset.videoDeleteSelect;if(b.checked){if(selectedVideoDeletes.size>=10){b.checked=false;toast('영상은 최대 10개씩 선택하세요.','error');return;}selectedVideoDeletes.add(id);}else selectedVideoDeletes.delete(id);updateVideoDeleteControls();});
    qsa('[data-media-delete]').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();void deleteHospitalVideo(b.dataset.mediaDelete);}));
    qsa('[data-media-add]').forEach(b=>b.addEventListener('click',()=>{if(mediaGlobalReadonly(mediaPlaylistId))return toast('공용 재생목록을 복사해서 수정하세요.','error');const id=b.dataset.mediaAdd;if(mediaDraft.includes(id))return;mediaDraft.push(id);mediaDirty=true;refreshMediaWorkspace();scheduleMediaSave();}));
    qsa('[data-media-remove]').forEach(b=>b.addEventListener('click',()=>{if(mediaGlobalReadonly(mediaPlaylistId))return;mediaDraft=mediaDraft.filter(x=>x!==b.dataset.mediaRemove);mediaDirty=true;refreshMediaWorkspace();scheduleMediaSave();}));
    qsa('[data-media-move]').forEach(b=>b.addEventListener('click',()=>{const i=mediaDraft.indexOf(b.dataset.mediaMove);mediaMove(i,i+Number(b.dataset.dir));}));
    qsa('[data-media-source], [data-media-queue-id]').forEach(el=>el.addEventListener('dragstart',e=>{if(mediaGlobalReadonly(mediaPlaylistId)){e.preventDefault();return;}
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
    const empty=qs('#mediaWorkTvEmpty');if(empty){empty.hidden=!!visible;empty.textContent=!floor?'층을 선택하세요.':'해당하는 TV가 없습니다.';}
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
  async function mediaRename(){const id=qs('#mediaWorkEditVideo')?.value,name=(qs('#mediaWorkEditName')?.value||'').trim();if(!id||!name)return toast('영상과 새 이름을 입력하세요.','error');const video=state.videos.find(v=>String(v.id)===id);if(!mediaCanEditVideo(video))return toast('이 영상을 수정할 권한이 없습니다.','error');if(video.site_id==null&&!confirm('공용 영상 제목 변경은 모든 병원에 반영됩니다. 계속할까요?'))return;const {error}=await mediaVideoUpdateQuery(db.from('videos').update({title:name}).eq('id',id),video);if(error)return toast(error.message,'error');toast('영상 이름을 변경했습니다.');await load();}
  async function mediaUpload(replace=false){
    const input=qs('#mediaWorkUploadFile'),files=Array.from(input?.files||[]);
    if(!files.length)return toast('MP4 파일을 선택하세요.','error');
    if(replace&&files.length!==1)return toast('파일 교체는 한 번에 하나만 가능합니다.','error');
    const maxSize=auth.role==='admin'?2*1024*1024*1024:350*1024*1024;
    const invalid=files.find(file=>!file.name.toLowerCase().endsWith('.mp4')||file.size>maxSize);
    if(invalid)return toast(`${invalid.name}: ${auth.role==='admin'?'2GB':'350MB'} 이하 MP4 파일만 업로드할 수 있습니다.`,'error');
    const target=replace?state.videos.find(v=>String(v.id)===qs('#mediaWorkEditVideo')?.value):null;
    if(replace&&!mediaCanEditVideo(target))return toast('이 영상을 교체할 권한이 없습니다.','error');
    if(replace&&!confirm(`'${target.title}'의 파일을 교체할까요? ${target.site_id==null?'공용 영상이므로 모든 병원에 영향을 줍니다. ':''}기존 재생목록은 그대로 유지됩니다.`))return;
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
          const next={source:'r2',storage_path:signed.key,url,size_bytes:file.size,file_modified_at:new Date().toISOString(),active:true,available:true};
          const result=replace?await mediaVideoUpdateQuery(db.from('videos').update(next).eq('id',target.id),target):await db.from('videos').insert({...next,title,site_id:targetSiteId});
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
    bindBulkPlaylistDelete();
    qsa('[data-media-floor-quick]').forEach(button=>button.addEventListener('click',()=>{
      const selector=qs('#mediaTargetFloor');if(!selector)return;
      const id=String(button.dataset.mediaFloorQuick||'');
      if(selector.value===id)return;
      selector.value=id;
      selector.dispatchEvent(new Event('change',{bubbles:true}));
    }));
    qs('#mediaTargetFloor')?.addEventListener('change',e=>{
      const next=String(e.target.value||'');if(mediaDirty&&!confirm('저장되지 않은 변경 사항을 버리고 층을 변경할까요?')){e.target.value=mediaTargetFloor;return;}
      mediaTargetFloor=next;mediaSelectTarget('');renderPreservingUi(false);
    });
    qs('#mediaTargetRoom')?.addEventListener('change',e=>{
      const previous=mediaTargetRoom;if(!mediaSelectTarget(e.target.value)){e.target.value=previous;return;}
      renderPreservingUi(false);
    });
    qs('#mediaApplyCurrent')?.addEventListener('click',mediaApplyCurrent);
    qs('#mediaCopyGlobal')?.addEventListener('click',()=>{
      const original=playlistById(mediaPlaylistId);if(!original||!mediaIsGlobalPlaylist(mediaPlaylistId))return;
      clearTimeout(mediaSaveTimer);mediaPlaylistId='';mediaDraft=mediaPlaylistItems(original.id);mediaDirty=true;
      qs('#staffPlaylistSelect').value='';
      const name=qs('#staffPlaylistName');if(name){name.value=`${original.name} (병원용)`;name.readOnly=false;}
      qs('#staffDeletePlaylist').disabled=true;
      refreshMediaWorkspace();toast('병원 전용 사본을 준비했습니다. 이름과 순서를 확인한 뒤 저장하세요.');
    });
    qs('#staffPlaylistSelect')?.addEventListener('change',()=>{if(mediaDirty&&!confirm('저장하지 않은 변경 사항을 버릴까요?')){qs('#staffPlaylistSelect').value=mediaPlaylistId;return;}fillHospitalPlaylistEditor();});
    qs('[data-new-playlist]')?.addEventListener('click',()=>{if(mediaDirty&&!confirm('저장하지 않은 변경 사항을 버릴까요?'))return;qs('#staffPlaylistSelect').value='';fillHospitalPlaylistEditor();qs('#staffPlaylistName')?.focus();});
    qs('#staffPlaylistName')?.addEventListener('input',()=>{mediaDirty=true;refreshMediaWorkspace();scheduleMediaSave();});
    qs('#videoUsageRefresh')?.addEventListener('click',()=>void refreshVideoUsage());
    qs('#videoUsageFilter')?.addEventListener('change',e=>{videoUsageFilter=e.target.value;refreshMediaWorkspace();});
    qs('#videoDeleteSelected')?.addEventListener('click',()=>void deleteHospitalVideos([...selectedVideoDeletes]));
    updateVideoDeleteControls();
    qs('#mediaWorkSearch')?.addEventListener('input',e=>{mediaFilter=e.target.value;refreshMediaWorkspace();});
    qs('#mediaGenerateMissingThumbs')?.addEventListener('click',()=>void generateHospitalThumbnails());
    qs('#mediaSelectedThumb')?.addEventListener('click',()=>{const id=qs('#mediaWorkEditVideo')?.value;if(!id)return toast('영상을 먼저 선택하세요.','error');void generateHospitalThumbnails(id);});
    qs('#staffSavePlaylist')?.addEventListener('click',saveHospitalPlaylist);
    qs('#mediaSaveTop')?.addEventListener('click',saveHospitalPlaylist);
    qs('#staffDeletePlaylist')?.addEventListener('click',deleteHospitalPlaylist);
    qs('#mediaWorkApplyTv')?.addEventListener('click',mediaApplyTv);
    qs('#mediaWorkFloor')?.addEventListener('change',()=>{qsa('[data-media-tv]').forEach(el=>{el.checked=false;});const search=qs('#mediaWorkTvSearch');if(search)search.value='';refreshMediaTvSelection();});
    qs('#mediaWorkTvSearch')?.addEventListener('input',refreshMediaTvSelection);
    qsa('[data-media-tv]').forEach(el=>el.addEventListener('change',refreshMediaTvSelection));
    refreshMediaTvSelection();
    qs('#mediaWorkEditVideo')?.addEventListener('change',e=>{const v=state.videos.find(v=>String(v.id)===e.target.value);const n=qs('#mediaWorkEditName');if(n)n.value=v?.title||'';});
    qs('#mediaWorkRename')?.addEventListener('click',mediaRename);
    qs('#mediaOpenUpload')?.addEventListener('click',()=>{const quick=qs('#mediaUploadQuickDetails');if(quick)quick.open=true;const details=qs('#mediaWorkManageDetails');if(details){details.open=true;details.scrollIntoView({behavior:'smooth',block:'center'});}qs('#mediaWorkUploadFile')?.focus();});
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
  const CATALOG_SECTIONS=[['treatments','진료 항목','맞춤 영상 선택에 사용합니다.'],['floor_types','층 유형','층의 운영 성격을 정합니다.'],['space_types','공간 유형','도면에서 공간을 등록할 때 사용합니다.']];
  const catalogAvailable=()=>dbFeature('site_catalog_v1')&&!!catalogConfig();
  function catalogEditorMarkup(){
    if(!catalogAvailable())return `<div class="hospital-admin-block hospital-settings-card"><div class="hospital-admin-block-head"><div><b>병원별 분류 및 로고</b><small>DB 업데이트 후 사용할 수 있습니다.</small></div></div></div>`;
    if(!catalogDirty&&!catalogSaving)catalogDraft=Catalog.profile(catalogConfig());
    const cfg=catalogDraft||Catalog.profile(catalogConfig());
    return `<div class="hospital-admin-block hospital-settings-card site-catalog-card" id="siteCatalogEditor"><div class="hospital-admin-block-head"><div><b>병원별 분류 및 로고</b><small>이 병원에만 적용됩니다. 다른 병원이나 기존 송출 영상에는 영향을 주지 않습니다.</small></div></div>
      <div class="site-logo-editor"><div class="site-logo-preview">${Catalog.validLogo(cfg.logo)?`<img src="${esc(cfg.logo)}" alt="병원 로고">`:'<span>로고 없음</span>'}</div><div><b>병원 로고</b><p class="muted">PNG · JPG · WebP, 최대 50KB. 관리자 화면에 표시합니다.</p><div class="inline"><label class="btn small site-logo-upload"><input type="file" id="siteLogoFile" accept="image/png,image/jpeg,image/webp"><span>이미지 선택</span></label><button type="button" class="btn small" id="siteLogoRemove" ${cfg.logo?'':'disabled'}>삭제</button></div></div></div>
      ${CATALOG_SECTIONS.map(([kind,title,note])=>`<details class="site-catalog-section"  data-catalog-section="${kind}"><summary><span><b>${title}</b><small>${note}</small></span><span>${cfg[kind].filter(e=>e.active).length}개 사용 중</span></summary><div class="site-catalog-rows">${cfg[kind].map((e,i)=>`<div class="site-catalog-row ${e.active?'':'is-archived'}"><label class="field"><span>표시 이름</span><input type="text" maxlength="80" value="${esc(e.label)}" data-catalog-label="${kind}:${i}" aria-label="${title} 이름"></label><span class="site-catalog-code" title="${esc(e.code)}">${esc(e.code)}</span><button type="button" class="btn small ${e.active?'':'primary'}" data-catalog-toggle="${kind}:${i}" ${kind!=='treatments'&&e.code==='other'?'disabled title="기타 유형은 유지해야 합니다"':''}>${e.active?'사용 중지':'다시 사용'}</button></div>`).join('')}<div class="site-catalog-add"><label class="field"><span>새 항목 이름</span><input maxlength="80" data-catalog-new-label="${kind}" placeholder="예: ${kind==='treatments'?'물리치료':kind==='floor_types'?'재활치료층':'검사실'}"></label><label class="field"><span>식별 코드 (선택)</span><input maxlength="48" data-catalog-new-code="${kind}" placeholder="자동 생성"></label><button type="button" class="btn small" data-catalog-add="${kind}">추가</button></div></div></details>`).join('')}
      <p class="muted site-catalog-note">사용 중지한 항목은 새 설정에서 숨겨집니다. 기존 영상·재생목록·진료 기록의 연결은 유지됩니다. 식별 코드는 저장 후 변경하지 않습니다.</p><div class="inline site-catalog-actions"><button type="button" class="btn primary" id="siteCatalogSave" ${catalogDirty&&!catalogSaving?'':'disabled'}>${catalogSaving?'저장 중…':'저장'}</button><button type="button" class="btn" id="siteCatalogCancel" ${catalogDirty&&!catalogSaving?'':'disabled'}>취소</button><span class="muted" id="siteCatalogStatus" role="status">${catalogDirty?'저장 전':'저장 완료'}</span></div></div>`;
  }
  function refreshCatalogEditor(){
    const el=qs('#siteCatalogEditor');if(!el)return;
    const opened=new Set(qsa('[data-catalog-section][open]',el).map(x=>x.dataset.catalogSection));
    el.outerHTML=catalogEditorMarkup();
    qsa('[data-catalog-section]').forEach(x=>x.open=opened.has(x.dataset.catalogSection));
    bindCatalogEditor();
  }
  function setCatalogDirty(){
    catalogDirty=true;
    const save=qs('#siteCatalogSave'),cancel=qs('#siteCatalogCancel'),status=qs('#siteCatalogStatus');
    if(save)save.disabled=false;if(cancel)cancel.disabled=false;if(status)status.textContent='저장 전';
  }
  function bindCatalogEditor(){
    const root=qs('#siteCatalogEditor');if(!root)return;
    const get=(value)=>{const [kind,i]=String(value).split(':');return catalogDraft?.[kind]?.[Number(i)];};
    qsa('[data-catalog-label]',root).forEach(el=>el.addEventListener('input',()=>{const item=get(el.dataset.catalogLabel);if(item){item.label=el.value;setCatalogDirty();}}));
    qsa('[data-catalog-toggle]',root).forEach(b=>b.addEventListener('click',()=>{const item=get(b.dataset.catalogToggle);if(!item)return;item.active=!item.active;setCatalogDirty();refreshCatalogEditor();}));
    qsa('[data-catalog-add]',root).forEach(b=>b.addEventListener('click',()=>{
      const k=b.dataset.catalogAdd,label=(qs(`[data-catalog-new-label="${k}"]`)?.value||'').trim(),typed=(qs(`[data-catalog-new-code="${k}"]`)?.value||'').trim();
      if(!label)return toast('항목 이름을 입력하세요.','error');
      const code=typed||'custom_'+crypto.randomUUID().replace(/-/g,'').slice(0,16);
      if(!Catalog.validCode(code)||catalogDraft[k].some(e=>e.code===code))return toast('식별 코드가 올바르지 않거나 이미 등록되어 있습니다.','error');
      if(catalogDraft[k].length>=150)return toast('항목은 최대 150개까지 등록할 수 있습니다.','error');
      catalogDraft[k].push({code,label,active:true});setCatalogDirty();refreshCatalogEditor();
    }));
    qs('#siteLogoFile')?.addEventListener('change',async e=>{
      const file=e.target.files?.[0];if(!file)return;
      if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>51200){e.target.value='';return toast('50KB 이하 PNG/JPG/WebP 이미지를 선택하세요.','error');}
      try{const url=await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(file);});if(!Catalog.validLogo(url))throw new Error('지원하지 않는 이미지입니다.');
        // Decode locally before storing to reject corrupt image data.
        const image=new Image();image.src=url;await image.decode();catalogDraft.logo=url;setCatalogDirty();refreshCatalogEditor();
      }catch(err){toast(err.message||'이미지를 읽지 못했습니다.','error');}
    });
    qs('#siteLogoRemove')?.addEventListener('click',()=>{catalogDraft.logo=null;setCatalogDirty();refreshCatalogEditor();});
    qs('#siteCatalogCancel')?.addEventListener('click',()=>{catalogDirty=false;catalogDraft=Catalog.profile(catalogConfig());refreshCatalogEditor();});
    qs('#siteCatalogSave')?.addEventListener('click',async()=>{
      if(catalogSaving||!catalogDirty||!catalogAvailable())return;
      const draft=Catalog.copy(catalogDraft),errorText=Catalog.validate(draft);if(errorText)return toast(errorText,'error');
      catalogSaving=true;root.querySelectorAll('button,input').forEach(el=>el.disabled=true);
      try{const {data,error}=await db.rpc('hospital_save_site_catalog',{p_site:targetSiteId,p_revision:draft.revision,p_catalog:draft});if(error)throw error;state.site.catalog_config=data;catalogDraft=Catalog.profile(data);catalogDirty=false;toast('병원별 설정을 저장했습니다.');await load();}
      catch(err){toast(err.message||'설정을 저장하지 못했습니다.','error');}
      finally{catalogSaving=false;if(qs('#siteCatalogEditor'))refreshCatalogEditor();}
    });
  }
  function hospitalSettingsPageMarkup(){const site=state.site||{};const custom=Object.values(state.floorplanAssets||{}).filter(x=>x?.key).length,placed=state.rooms.filter(roomMapPlaced).length,total=state.rooms.length;return `<section class="hospital-admin-settings-page"><div class="hospital-settings-primary"><div class="hospital-admin-block hospital-settings-card"><div class="hospital-admin-block-head"><div><b>병원 정보</b><small>관리 화면에 표시되는 병원명과 건물명입니다.</small></div></div><div class="grid-2"><label class="field"><span>병원명</span><input id="staffSiteName" maxlength="60" value="${esc(site.name||'')}"></label><label class="field"><span>건물명</span><input id="staffBuildingLabel" maxlength="60" value="${esc(site.building_label||'')}"></label></div><button id="staffSaveSiteIdentity" class="btn primary" type="button">병원 정보 저장</button></div><div class="hospital-settings-card">${operatingSettingsMarkup()}</div>${catalogEditorMarkup()}</div><div class="hospital-settings-layout-note"><b>도면 · 공간 · TV 위치 변경</b><button type="button" class="btn small" data-ops-go-layout>송출 관리에서 배치 편집</button></div></section>`;}
  function hospitalVideosPageMarkup(){
    return `<section class="hospital-content-page hospital-content-media unified-hospital-page" id="unifiedMediaEditor">
      <header class="unified-page-heading"><div class="site-heading-identity">${Catalog.validLogo(catalogConfig()?.logo)?`<img class="site-heading-logo" src="${esc(catalogConfig().logo)}" alt="병원 로고">`:''}<div><h1>${esc(state.site?.name||'병원')}</h1><p>TV 송출 현황과 재생목록, 공간 설정을 관리합니다.</p></div></div></header>${dbVersionBanner()}
      <details class="unified-secondary-panel unified-tv-overview-first" id="unifiedTvOperations" ${tvOperationsExpanded?'open':''}><summary><span><b>전체 TV 상태</b><small data-tv-summary-line>${esc(tvSummaryLine(tvCounts(state.rooms)))}</small></span><span aria-hidden="true" class="unified-panel-chevron">▾</span></summary><div class="unified-secondary-content"><div class="hospital-status-toolbar"><button type="button" id="staffStatusRefresh" class="btn small">상태 새로고침</button><button type="button" id="staffReloadAllPlayers" class="btn small danger-outline">전체 플레이어 새로고침</button></div>${hospitalOperationsSummary()}</div></details>
      <div class="unified-floorplan-primary" id="unifiedFloorplanPrimary" aria-label="층별 관리 및 도면">${staffBuildingOverview(groupedRooms())}</div>
      <section id="signagePlaylistManagement" class="signage-playlist-management" aria-label="재생목록 관리">
        
        ${hospitalPlaylistManagerMarkup()}
      </section>
      <details class="unified-secondary-panel" id="unifiedHospitalSettings"><summary><span><b>병원 설정</b><small>운영시간, 병원 정보, 기본 송출 설정</small></span></summary><div class="unified-secondary-content">${hospitalSettingsPageMarkup()}</div></details>
    </section>`;
  }
  async function saveHospitalIdentity(){const name=(qs('#staffSiteName')?.value||'').trim(),building=(qs('#staffBuildingLabel')?.value||'').trim();if(!name||!building)return toast('병원명과 건물명을 입력하세요.','error');const {error}=await db.rpc('hospital_update_site_identity',{p_site:targetSiteId,p_name:name,p_building_label:building});if(error)return toast(error.message,'error');toast('병원 정보를 저장했습니다.');await load();}
  const displaySetupRpcMissing=(error)=>String(error?.code||'')==='PGRST202'||/staff_set_display_setup|schema cache|function/i.test(String(error?.message||''))&&/could not find|not found/i.test(String(error?.message||''));
  async function saveDisplayPurpose(roomId){
    const r=roomById(roomId);if(!r)return;
    const input=qs(`[data-display-purpose="${roomId}"]`),note=String(input?.value||'').trim();
    const {error}=await db.rpc('staff_set_display_setup',{p_room:roomId,p_mode:displayControlMode(r),p_x:r.map_x_pct??null,p_y:r.map_y_pct??null,p_note:note||null,p_space:r.floor_space_id||null,p_group:canonicalFloorGroupIdForRoom(r)||r.group_id});
    if(error)return toast(error.message,'error');r.display_note=note||null;toast('송출 목적을 저장했습니다.');renderPreservingUi(true);
  }
  async function saveDisplaySetup(roomId,x,y,mode,spaceId){const r=state.rooms.find(x=>x.id===roomId);if(!r)return;const prev={x:r.map_x_pct,y:r.map_y_pct,mode:r.display_control_mode,space:r.floor_space_id,check:r.manual_check_status};const useMode=mode||displayControlMode(r),gid=canonicalFloorGroupIdForRoom(r)||r.group_id;let resolvedSpace=spaceId===undefined?r.floor_space_id||null:spaceId||null;if(spaceId===null||spaceId==='auto')resolvedSpace=(x===null||x===undefined||y===null||y===undefined)?null:spaceContainingPoint(gid,x,y)?.id||null;
    r.map_x_pct=x;r.map_y_pct=y;r.display_control_mode=useMode;r.floor_space_id=resolvedSpace;if(useMode==='manual'&&r.manual_check_status==='not_required')r.manual_check_status='needs_check';renderPreservingUi(true);
    let {error}=await db.rpc('staff_set_display_setup',{p_room:roomId,p_mode:useMode,p_x:x,p_y:y,p_note:r.display_note||null,p_space:resolvedSpace,p_group:gid}),legacy=false;if(error&&displaySetupRpcMissing(error)){const retry=await db.rpc('staff_set_display_setup',{p_room:roomId,p_mode:useMode,p_x:x,p_y:y,p_note:r.display_note||null});error=retry.error;legacy=!error;}
    if(error){r.map_x_pct=prev.x;r.map_y_pct=prev.y;r.display_control_mode=prev.mode;r.floor_space_id=prev.space;r.manual_check_status=prev.check;renderPreservingUi(true);toast(error.message,'error');return false;}
    if(legacy)r.floor_space_id=prev.space;if(legacy)toast('TV 위치를 저장했습니다. 공간 연결은 DB 업데이트 후 함께 저장됩니다.');renderPreservingUi(true);return true;}
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
  function queueLayoutDraft(save,cancel){
    if(layoutDraft||layoutDraftSaving){cancel();return;}
    layoutDraft={save,cancel};const bar=qs('#layoutDraftActions');if(bar){bar.hidden=false;bar.scrollIntoView({block:'nearest'});}
  }
  function bindDisplaySetup(){
    qs('#hospitalLayoutWorkspace')?.addEventListener('click',e=>{if((layoutDraft||layoutDraftSaving)&&!e.target.closest('#layoutDraftActions,[data-ops-layout-toggle]')){e.preventDefault();e.stopImmediatePropagation();toast('먼저 변경 내용을 저장하거나 취소하세요.');}},true);
    qs('#layoutDraftCancel')?.addEventListener('click',()=>{const d=layoutDraft;layoutDraft=null;d?.cancel();qs('#layoutDraftActions').hidden=true;});
    qs('#layoutDraftSave')?.addEventListener('click',async e=>{if(!layoutDraft||layoutDraftSaving)return;const d=layoutDraft;layoutDraftSaving=true;layoutDraft=null;e.currentTarget.disabled=true;try{await d.save();}catch(err){d.cancel();toast(err.message||'저장 실패','error');}finally{layoutDraftSaving=false;const bar=qs('#layoutDraftActions');if(bar)bar.hidden=true;if(e.target.isConnected)e.target.disabled=false;}});
    qs('#staffSaveSpaceName')?.addEventListener('click',async()=>{const sp=state.floorSpaces.find(x=>x.id===spaceRedrawId),name=(qs('#staffSpaceName')?.value||'').trim();if(!sp||!name)return toast('공간명을 입력하세요.','error');const {error}=await db.from('floor_spaces').update({name}).eq('id',sp.id).eq('site_id',targetSiteId);if(error)return toast(error.message,'error');sp.name=name;spaceRedrawId=null;layoutEditMode='display';renderPreservingUi(false);toast('저장했습니다.');});
    qs('#staffLayoutCopyToggle')?.addEventListener('click',()=>{layoutCopyOpen=!layoutCopyOpen;renderPreservingUi(true);});
    qs('#staffLayoutCopyClose')?.addEventListener('click',()=>{layoutCopyOpen=false;renderPreservingUi(true);});
    qs('#staffApplyLayoutCopy')?.addEventListener('click',async()=>{
      const targets=qsa('[data-layout-copy-target]:checked').map(x=>x.value),copySpaces=!!qs('#staffCopySpaces')?.checked,copyDisplays=!!qs('#staffCopyDisplays')?.checked;
      if(!targets.length)return toast('적용할 층을 선택하세요.','error');if(!copySpaces&&!copyDisplays)return toast('복사할 항목을 하나 이상 선택하세요.','error');
      if(!confirm(`선택한 ${targets.length}개 층의 ${copySpaces&&copyDisplays?'공간과 TV 위치':copySpaces?'공간':'TV 위치'}를 현재 층 기준으로 덮어쓸까요?`))return;
      const btn=qs('#staffApplyLayoutCopy');if(btn)btn.disabled=true;try{const result=await applyFloorLayoutCopy(spaceEditorGroupId,targets,{copySpaces,copyDisplays});const applied=result.applied.map(x=>{const parts=[];if(x.spaces_copied)parts.push('공간');if(x.displays_copied)parts.push(`TV 위치 ${Number(x.displays_updated||0)+Number(x.displays_created||0)}개`);return `${x.name||'대상층'} · ${parts.join(' + ')||'적용'} 완료`;});const skipped=result.skipped.map(x=>`${x.name||'대상층'} · ${x.reason==='DISPLAY_COUNT_MISMATCH'?(x.spaces_copied?'공간은 복사됨 · TV 위치만 제외':'TV 위치 제외 · 수 불일치'):x.reason||'조건 불일치'}`);toast([...applied,...skipped].join(' · ')||'변경 사항이 없습니다.');layoutCopyOpen=false;await load();}catch(e){toast(e.message||String(e),'error');if(btn)btn.disabled=false;}
    });
    qsa('[data-save-floor-meta]').forEach(b=>b.addEventListener('click',()=>saveHospitalFloorMeta(b.dataset.saveFloorMeta)));
    qs('#staffQuickCreateDisplay')?.addEventListener('click',()=>void createQuickDisplay());
    qs('#staffQuickDisplayName')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void createQuickDisplay();}});
    qs('#staffAddSpace')?.addEventListener('click',()=>{combinedCreateMode='both';layoutEditMode='space';layoutPlacementRoomId=null;spaceRedrawId=null;renderPreservingUi(true);requestAnimationFrame(()=>qs('#staffSpaceName')?.focus());});
    qs('#staffPlaceDisplayMode')?.addEventListener('click',()=>{layoutEditMode='display';layoutPlacementRoomId=null;spaceRedrawId=null;renderPreservingUi(true);requestAnimationFrame(()=>qs('#staffQuickDisplayName')?.focus());});
    qsa('[data-place-display]').forEach(b=>b.addEventListener('click',()=>{layoutEditMode='display';spaceRedrawId=null;layoutPlacementRoomId=b.dataset.placeDisplay||null;renderPreservingUi(true);}));
    qsa('[data-rename-display]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();renameHospitalDisplay(b.dataset.renameDisplay);}));
    qsa('[data-delete-display]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();deleteHospitalDisplay(b.dataset.deleteDisplay);}));
    qsa('[data-unplace-display]').forEach(b=>b.addEventListener('click',()=>{const r=roomById(b.dataset.unplaceDisplay);if(r)saveDisplaySetup(r.id,null,null,displayControlMode(r),null);}));
    qsa('[data-save-display-purpose]').forEach(b=>b.addEventListener('click',()=>saveDisplayPurpose(b.dataset.saveDisplayPurpose)));
    qsa('[data-staff-map-stage]').forEach(stage=>stage.addEventListener('click',async e=>{if(layoutDraft||layoutDraftSaving||layoutEditMode!=='display'||!layoutPlacementRoomId)return;if(e.target.closest('[data-display-marker]'))return;const roomId=layoutPlacementRoomId,r=roomById(roomId);if(!r)return;const rect=stage.getBoundingClientRect(),rawX=(e.clientX-rect.left)/rect.width*100,rawY=(e.clientY-rect.top)/rect.height*100,p=snapDisplayPoint(stage,roomId,rawX,rawY);const source=state.floorSpaces.find(sp=>sp.id===combinedSourceSpaceId);if(source&&(p.x<Number(source.x_pct)||p.x>Number(source.x_pct)+Number(source.width_pct)||p.y<Number(source.y_pct)||p.y>Number(source.y_pct)+Number(source.height_pct)))return toast('선택한 공간 안에 TV 위치를 지정하세요.','error');const draftPin=document.createElement('span');draftPin.className='layout-draft-pin';Object.assign(draftPin.style,{left:`${p.x}%`,top:`${p.y}%`});stage.appendChild(draftPin);queueLayoutDraft(async()=>{draftPin.remove();if(!await saveDisplaySetup(roomId,p.x,p.y,displayControlMode(r),combinedSourceSpaceId||'auto'))return;
      if(combinedPlacementQueue[0]===roomId&&roomMapPlaced(roomById(roomId))){
        combinedPlacementQueue.shift();layoutPlacementRoomId=combinedPlacementQueue[0]||null;
        if(combinedPlacementQueue.length)toast(`다음 TV 위치를 클릭하세요. 남은 TV ${combinedPlacementQueue.length}대`);
        else {combinedSourceSpaceId=null;toast('공간과 TV 배치를 완료했습니다.');}
      }else if(!combinedPlacementQueue.length){layoutPlacementRoomId=null;}
      renderPreservingUi(true);},()=>draftPin.remove());}));
    qsa('[data-display-marker]').forEach(marker=>marker.addEventListener('pointerdown',e=>{if(layoutDraft||layoutDraftSaving||layoutEditMode!=='display')return;e.preventDefault();e.stopPropagation();const stage=marker.closest('[data-staff-map-stage]');if(!stage)return;const roomId=marker.dataset.displayMarker;marker.setPointerCapture?.(e.pointerId);const move=ev=>{const rect=stage.getBoundingClientRect(),rawX=(ev.clientX-rect.left)/rect.width*100,rawY=(ev.clientY-rect.top)/rect.height*100,p=snapDisplayPoint(stage,roomId,rawX,rawY);marker.style.left=`${p.x}%`;marker.style.top=`${p.y}%`;showDisplaySnapGuides(stage,p);};const up=ev=>{marker.removeEventListener('pointermove',move);marker.removeEventListener('pointerup',up);marker.removeEventListener('pointercancel',cancel);const rect=stage.getBoundingClientRect(),rawX=(ev.clientX-rect.left)/rect.width*100,rawY=(ev.clientY-rect.top)/rect.height*100,p=snapDisplayPoint(stage,roomId,rawX,rawY);clearDisplaySnapGuides(stage);const r=roomById(roomId);queueLayoutDraft(()=>saveDisplaySetup(roomId,p.x,p.y,displayControlMode(r),null),()=>{marker.style.left=`${r.map_x_pct}%`;marker.style.top=`${r.map_y_pct}%`;});};const cancel=()=>{marker.removeEventListener('pointermove',move);marker.removeEventListener('pointerup',up);marker.removeEventListener('pointercancel',cancel);const r=roomById(roomId);marker.style.left=`${r.map_x_pct}%`;marker.style.top=`${r.map_y_pct}%`;clearDisplaySnapGuides(stage);};marker.addEventListener('pointermove',move);marker.addEventListener('pointerup',up);marker.addEventListener('pointercancel',cancel);}));
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
    qs('#staffSpaceFloor')?.addEventListener('change',e=>{spaceEditorGroupId=e.target.value;selectedFloorId=e.target.value;spaceRedrawId=null;layoutPlacementRoomId=null;combinedPlacementQueue=[];combinedSourceSpaceId=null;layoutEditMode='display';layoutCopyOpen=false;renderPreservingUi(false);});
    qsa('.floor-layout-stage [data-floor-space]').forEach(b=>{
      b.addEventListener('pointerdown',e=>{if(layoutDraft||layoutDraftSaving||layoutEditMode!=='space')return;const space=state.floorSpaces.find(x=>x.id===b.dataset.floorSpace);if(!space)return;e.preventDefault();e.stopPropagation();const stage=b.closest('[data-staff-space-stage]');if(!stage)return;const rect=stage.getBoundingClientRect(),sx=e.clientX,sy=e.clientY,oldX=Number(space.x_pct),oldY=Number(space.y_pct);let moved=false;
        b.setPointerCapture?.(e.pointerId);
        const move=ev=>{if(ev.pointerId!==e.pointerId)return;const dx=(ev.clientX-sx)/rect.width*100,dy=(ev.clientY-sy)/rect.height*100;if(Math.hypot(ev.clientX-sx,ev.clientY-sy)>5)moved=true;if(!moved)return;const x=Math.max(0,Math.min(100-Number(space.width_pct),Math.round(oldX+dx))),y=Math.max(0,Math.min(100-Number(space.height_pct),Math.round(oldY+dy)));b.style.left=`${x}%`;b.style.top=`${y}%`;};
        const cleanup=()=>{b.removeEventListener('pointermove',move);b.removeEventListener('pointerup',up);b.removeEventListener('pointercancel',cancel);};
        const cancel=()=>{cleanup();b.style.left=`${oldX}%`;b.style.top=`${oldY}%`;};
        const up=async ev=>{cleanup();if(!moved)return;const dx=(ev.clientX-sx)/rect.width*100,dy=(ev.clientY-sy)/rect.height*100,x=Math.max(0,Math.min(100-Number(space.width_pct),Math.round(oldX+dx))),y=Math.max(0,Math.min(100-Number(space.height_pct),Math.round(oldY+dy)));b.dataset.justMoved='1';queueLayoutDraft(async()=>{try{const {error}=await db.from('floor_spaces').update({x_pct:x,y_pct:y}).eq('id',space.id).eq('site_id',state.site.id);if(error)throw error;space.x_pct=x;space.y_pct=y;toast('공간 위치를 저장했습니다.');}catch(err){toast(err.message||'공간 위치 저장 실패','error');}renderPreservingUi(false);},cancel);};
        b.addEventListener('pointermove',move);b.addEventListener('pointerup',up);b.addEventListener('pointercancel',cancel);
      });
      b.addEventListener('click',e=>{if(layoutPlacementRoomId&&layoutEditMode==='display')return;e.preventDefault();e.stopPropagation();if(b.dataset.justMoved){delete b.dataset.justMoved;return;}if(layoutDraft||layoutDraftSaving)return;const space=state.floorSpaces.find(x=>x.id===b.dataset.floorSpace);if(!space)return;layoutEditMode='space';spaceEditorGroupId=space.group_id;spaceRedrawId=space.id;layoutPlacementRoomId=null;renderPreservingUi(false);requestAnimationFrame(()=>qs('#staffSpaceName')?.focus({preventScroll:true}));});
    });
    qsa('[data-staff-redraw-space]').forEach(b=>b.addEventListener('click',()=>{const space=state.floorSpaces.find(x=>x.id===b.dataset.staffRedrawSpace);if(!space)return;spaceEditorGroupId=space.group_id;spaceRedrawId=space.id;layoutPlacementRoomId=null;layoutEditMode='space';layoutPanelOpen=true;selectedFloorId=space.group_id;renderPreservingUi(false);requestAnimationFrame(()=>qs('[data-staff-space-stage]')?.scrollIntoView({behavior:'smooth',block:'center'}));}));
    qs('#staffCancelSpaceRedraw')?.addEventListener('click',()=>{spaceRedrawId=null;layoutEditMode='display';renderPreservingUi(false);});
    qsa('[data-save-space-content]').forEach(b=>b.addEventListener('click',()=>saveSpaceContent(b.dataset.saveSpaceContent)));
    qsa('[data-staff-delete-space]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('공간 구분을 삭제할까요?'))return;const {error}=await db.from('floor_spaces').delete().eq('id',b.dataset.staffDeleteSpace);if(error)return toast(error.message,'error');if(spaceRedrawId===b.dataset.staffDeleteSpace)spaceRedrawId=null;await load();}));
    const stage=qs('[data-staff-space-stage]');if(!stage)return;let start=null,preview=null;
    stage.addEventListener('pointerdown',e=>{if(layoutDraft||layoutDraftSaving||layoutEditMode!=='space')return;if(e.target.closest('[data-floor-space]'))return;const name=(qs('#staffSpaceName')?.value||'').trim();if(!name)return toast('공간명을 먼저 입력하세요.','error');e.preventDefault();const rect=stage.getBoundingClientRect(),rawX=(e.clientX-rect.left)/rect.width*100,rawY=(e.clientY-rect.top)/rect.height*100,p=snapSpacePoint(stage,rawX,rawY,spaceRedrawId);start={x:p.x,y:p.y,id:e.pointerId};preview=document.createElement('div');preview.className='floor-space-draft';stage.appendChild(preview);showDisplaySnapGuides(stage,p);stage.setPointerCapture?.(e.pointerId);});
    stage.addEventListener('pointermove',e=>{if(!start||e.pointerId!==start.id||!preview)return;const rect=stage.getBoundingClientRect(),rawX=(e.clientX-rect.left)/rect.width*100,rawY=(e.clientY-rect.top)/rect.height*100,p=snapSpacePoint(stage,rawX,rawY,spaceRedrawId),l=Math.min(start.x,p.x),t=Math.min(start.y,p.y),w=Math.abs(p.x-start.x),h=Math.abs(p.y-start.y);Object.assign(preview.style,{left:`${l}%`,top:`${t}%`,width:`${w}%`,height:`${h}%`});showDisplaySnapGuides(stage,p);});
    stage.addEventListener('pointerup',async e=>{if(!start||e.pointerId!==start.id)return;const rect=stage.getBoundingClientRect(),rawX=(e.clientX-rect.left)/rect.width*100,rawY=(e.clientY-rect.top)/rect.height*100,p=snapSpacePoint(stage,rawX,rawY,spaceRedrawId),l=Math.min(start.x,p.x),t=Math.min(start.y,p.y),w=Math.abs(p.x-start.x),h=Math.abs(p.y-start.y);preview?.remove();preview=null;start=null;clearDisplaySnapGuides(stage);if(w<2||h<2)return toast('공간 영역을 조금 더 크게 드래그하세요.','error');const name=(qs('#staffSpaceName')?.value||'').trim(),type=qs('#staffSpaceType')?.value||'other',groupId=stage.dataset.staffSpaceStage;
      const draftBox=document.createElement('div');draftBox.className='floor-space-draft';Object.assign(draftBox.style,{left:`${l}%`,top:`${t}%`,width:`${w}%`,height:`${h}%`});stage.appendChild(draftBox);queueLayoutDraft(async()=>{draftBox.remove();if(spaceRedrawId){const id=spaceRedrawId,{error}=await db.from('floor_spaces').update({name,space_type:type,x_pct:l,y_pct:t,width_pct:w,height_pct:h}).eq('id',id).eq('site_id',state.site.id);if(error)return toast(error.message,'error');const item=state.floorSpaces.find(x=>x.id===id);if(item)Object.assign(item,{name,space_type:type,x_pct:l,y_pct:t,width_pct:w,height_pct:h});spaceRedrawId=null;layoutEditMode='display';toast('공간을 다시 그렸습니다.');renderPreservingUi(true);return;}
      const count=Math.max(0,Math.min(6,Number(qs('#staffCombinedTvCount')?.value||0)));const nextOrder=Math.max(0,...state.floorSpaces.filter(x=>x.group_id===groupId).map(x=>Number(x.sort_order||0)))+10;const {data,error}=await db.from('floor_spaces').insert({site_id:state.site.id,group_id:groupId,name,space_type:type,x_pct:l,y_pct:t,width_pct:w,height_pct:h,sort_order:nextOrder}).select('*').single();if(error)return toast(error.message,'error');if(data)state.floorSpaces.push(data);layoutEditMode='display';if(data&&count){await createDisplaysForSpace(data,count);}else{toast('공간을 저장했습니다.');renderPreservingUi(true);}},()=>draftBox.remove());
    });
    stage.addEventListener('pointercancel',()=>{preview?.remove();preview=null;start=null;clearDisplaySnapGuides(stage);});
  }
  function bindHospitalAdminSettings(){
    const details=qs('.hospital-admin-settings');
    bindCatalogEditor();
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
  function hospitalBroadcastCard(){const active=!!state.broadcast?.active,selected=broadcastPlaylistId(),own=state.playlists.filter(p=>p.active!==false&&p.site_id===targetSiteId);return `<section class="hospital-broadcast-card ${active?'is-active':''}"><div><small>병원 병원 전체 영상</small><b>${active?'병원 전체 TV에서 영상 재생 중':'필요할 때 전체 TV에 영상 재생'}</b><p>선택한 영상 목록을 병원의 원격으로 관리하는 TV에 먼저 보여줍니다.</p></div><div class="hospital-broadcast-actions"><select id="hospitalBroadcastPlaylist" ${active?'disabled':''}><option value="">${active&&selected?'현재 재생 중인 목록':'재생목록 선택'}</option>${own.map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join('')}</select>${active?'<button class="btn danger" id="hospitalBroadcastStop">병원 전체 영상 종료</button>':'<button class="btn primary" id="hospitalBroadcastStart">병원 전체 영상 시작</button>'}</div></section>`;}
  async function setHospitalBroadcast(active){const playlist=qs('#hospitalBroadcastPlaylist')?.value||null;if(active&&!playlist)return toast('병원 전체 영상할 플레이리스트를 선택하세요.','error');if(!confirm(active?'이 병원의 모든 원격 디스플레이에 병원 전체 영상할까요?':'병원 병원 전체 영상을 종료할까요?'))return;const {error}=await db.rpc('hospital_set_broadcast',{p_site:targetSiteId,p_active:active,p_playlist:playlist,p_notice:null});if(error)return toast(error.message||'병원 전체 영상을 변경하지 못했습니다.','error');toast(active?'병원 병원 전체 영상을 시작했습니다.':'병원 병원 전체 영상을 종료했습니다.');await load();}

  function render(){
    const groups=groupedRooms();
    qsa('.nav-btn').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
    const siteLabel=qs('#hospitalSiteLabel');if(siteLabel)siteLabel.textContent=state.site?.name||'';
    tab='videos';
    const head=tab==='videos'?'':tab==='output'
      ? `<div class="hospital-output-hero"><div class="hospital-output-copy"><span class="eyebrow">${esc(state.site?.name||'병원')}</span><h1>TV 상태</h1><p>우리 병원의 TV가 잘 나오고 있는지 확인하세요.</p></div><div class="hospital-output-side hospital-output-side-simple"><span class="hospital-display-total">전체 TV <b>${state.rooms.length}</b>대</span><button id="staffStatusRefresh" class="btn hospital-refresh-btn">새로고침</button></div></div>`
      : `<div class="reception-head reception-head-board hospital-simple-head"><div><span class="eyebrow">${esc(state.site?.name||'병원')}</span><h1>${tab==='videos'?'영상관리':'병원 설정'}</h1><p>${tab==='videos'?'병원에서 보여줄 영상을 추가하고 재생 순서를 바꿀 수 있습니다.':'운영시간과 병원 정보, 도면과 TV 위치를 변경할 수 있습니다.'}</p></div></div>`;
    let content='';
    if(tab==='output')content=`${hospitalOperationsSummary()}${staffBuildingOverview(groups)}`;
    else if(tab==='videos')content=hospitalVideosPageMarkup();
    else content=hospitalSettingsPageMarkup();
    qs('#hospitalRoot').innerHTML=`${state.broadcast?.active&&tab==='output'?'<div class="broadcast-strip">병원 전체 영상 중입니다.</div>':''}${head}${content}`;
    bind();
    loadFloorplanSvgs(qs('#hospitalRoot')).catch(()=>{});
  }

  function groupCard(group){
    const summary=groupStatusSummary(group.rooms),nowText=groupNowText(summary);
    return `<details class="monitor-group staff-monitor-group group-state-${summary.key}" data-staff-group="${esc(group.id)}"><summary class="monitor-group-summary"><div class="monitor-group-overview"><div class="monitor-group-title-row"><h2>${esc(groupDisplayName(group.name))}</h2>${group.role_label?`<span class="floor-type-label">${esc(group.role_label)}</span>`:`<span class="floor-type-label">${esc(careTypeLabel(group.care_type))}</span>`}<span class="group-status-badge status-${summary.key}" data-staff-group-status>${esc(summary.label)}</span></div><p class="floor-purpose-summary">${esc(group.content_intro||group.signage_purpose||'송출 목적가 등록되지 않았습니다')}</p><div class="group-metric-row"><span>공간 <b data-staff-group-total>${summary.total}</b></span><span>재생 중 <b data-staff-group-live>${summary.live}</b></span><span>연결됨 <b data-staff-group-online>${summary.online}</b></span><span>수동 <b>${summary.manual+summary.manualNeedsCheck}</b></span><span>문제 <b data-staff-group-issues>${summary.issues}</b></span></div><p data-staff-group-summary>${esc(nowText)}${group.target_audience?` · 대상 ${esc(group.target_audience)}`:''}</p></div><span class="group-detail-link">상세보기</span></summary><div class="monitor-group-body">${groupContentTopicsMarkup(group)}${group.waiting_area_note?`<div class="floor-reason-note"><b>고객 대기공간</b><span>${esc(group.waiting_area_note)}</span></div>`:''}${group.signage_reason?`<div class="floor-reason-note"><b>왜 이 영상을 보여주나요?</b><span>${esc(group.signage_reason)}</span></div>`:''}<div class="monitor-room-grid staff-monitor-room-grid">${[...group.rooms].sort((a,b)=>roomProblemRank(a)-roomProblemRank(b)||(a.sort_order||0)-(b.sort_order||0)).map(roomCard).join('')}</div></div></details>`;
  }

  function roomCard(r){
    const p=patientForRoom(r.id),quick=isQuickSession(r),st=r.player_status||{},display=roomDisplayStatus(r),health=roomHealth(r),current=currentVideoTitle(r),next=nextVideoTitle(r)==='—'?'':nextVideoTitle(r),activeTreatment=p?.treatment||r.session_treatment||'';
    const audience=[p?.age_group||r.session_age_group,p?.gender||r.session_gender].filter(Boolean).map((v,i)=>i===0?ageLabel(v):genderLabel(v)).filter(x=>x!=='전체').join(' · '),manual=!!r.manual_active&&Array.isArray(r.manual_video_ids)&&r.manual_video_ids.length>0,defaultPlaylist=playlistById(r.default_playlist_id),currentVideo=currentVideoForRoom(r),on=staffIsOnline(r);
    const progress=st.duration?`${formatDuration(st.current_time||0)} / ${formatDuration(st.duration)}`:'';
    return `<details class="monitor-room staff-monitor-room health-${health}" data-room-card="${r.id}" data-health="${health}"><summary><div class="monitor-room-top"><div class="monitor-room-name"><span data-staff-live-dot class="dot ${on?'on':''}"></span><b>${esc(r.name)}</b></div><span class="room-status-badge status-${display.key} cat-${display.cat}" data-staff-room-status>${esc(display.label)}</span></div><div class="monitor-current-thumb" data-staff-live-thumb>${staffThumbLink(currentVideo,'monitor-current-thumb-link','현재 영상 열기')}</div><div class="monitor-now"><span>적용 중인 설정 · ${esc(priorityLabel(st.priority||st.mode))}</span><b data-staff-live-title>${esc(current)}</b><small data-staff-live-detail>${displayControlMode(r)==='manual'?esc(roomIssueReason(r)):(on?`${esc(playbackLabel(st.playback_state))}${progress?` · ${progress}`:''}${roomIssueReason(r)?` · ${esc(roomIssueReason(r))}`:''}`:'플레이어 응답 없음')}</small></div><div class="monitor-next"><span>다음</span><b data-staff-live-next>${esc(next||'—')}</b></div><div class="monitor-card-foot"><span>${esc(roomTypeLabel(r.room_mode))}${manual?' · 개별 영상':activeTreatment?` · ${esc(treatmentLabel(activeTreatment))}`:defaultPlaylist?` · ${esc(defaultPlaylist.name)}`:''}</span><b>관리</b></div></summary><div class="monitor-room-controls staff-room-control-body">
      ${playerDiagnosticsHtml(r)}
      <div class="staff-tv-overlay-settings"><div class="staff-tv-overlay-heading"><b>영상 위에 문구 표시</b><small>이 TV에서 나오는 영상 아래쪽에 문구를 보여줍니다. 비워서 저장하면 문구가 사라집니다.</small></div><div class="staff-tv-overlay-row"><input type="text" maxlength="160" data-tv-overlay-input="${esc(r.id)}" value="${esc(r.overlay_text||'')}" placeholder="예: 진료 대기 고객 안내" aria-label="${esc(r.name)} TV 화면 문구"><button type="button" class="btn small" data-tv-overlay-save="${esc(r.id)}">저장</button></div>${displayControlMode(r)==='manual'?'<small>현장 관리 TV는 원격 문구 표시를 확인할 수 없습니다.</small>':'<small>영상 자체는 수정되지 않습니다. 변경 후 플레이어에서 반영되는지 확인하세요.</small>'}</div>
      ${audience?`<div class="room-output-note">맞춤 대상 · ${esc(audience)}</div>`:''}
      ${displayControlMode(r)==='manual'?`<div class="manual-display-panel"><b>현장 관리 TV</b><p>${esc(r.display_note||'현장에서 직접 영상 재생 상태를 확인합니다.')}</p><div class="staff-output-row manual-config-row"><span>기본 재생목록</span><select data-staff-playlist="${r.id}">${playlistOptions(r.default_playlist_id||'')}</select><button class="btn primary" data-staff-playlist-apply="${r.id}">설정 저장</button><button type="button" class="btn" data-tv-edit-playlist="${esc(r.id)}">재생목록 편집</button></div><small>설정은 저장되지만, 현장 TV에는 바로 적용되지 않습니다.</small><button class="btn ${r.manual_check_status==='checked'?'':'primary'}" data-manual-check="${r.id}">${r.manual_check_status==='checked'?'확인 취소':'오늘 확인함'}</button></div>`:`<details class="staff-output-details"><summary>지금 보여주는 영상 · 변경하기</summary>${staffOutputList(r)}</details><div class="staff-output-controls"><div class="staff-output-row"><span>TV에서 보여줄 영상 목록</span><select data-staff-playlist="${r.id}">${playlistOptions(r.default_playlist_id||'')}</select><button class="btn" data-staff-playlist-apply="${r.id}">TV에 적용</button></div><div class="staff-output-edit-action"><button type="button" class="btn primary" data-tv-edit-playlist="${esc(r.id)}">영상 추가·제거</button><small>저장하면 이 목록을 사용하는 TV에도 변경됩니다.</small></div>${manual?`<button class="btn small" data-staff-manual-clear="${r.id}">기본 영상으로 돌아가기</button>`:''}</div><div class="room-player-actions hospital-room-player-actions"><span>환자 화면</span><div><button class="btn small" data-staff-player-open="${r.id}">플레이어 화면 열기</button><button class="btn small" data-staff-player-copy="${r.id}">TV 연결 주소 복사</button></div></div><div class="staff-tv-overlay-settings tv-pair-settings"><div class="staff-tv-overlay-heading"><b>설치형 플레이어 연결</b><small>TV 화면의 6자리 연결 코드를 입력하세요. 기존 연결이 있으면 교체 확인이 표시됩니다.</small></div><div class="staff-tv-overlay-row"><input type="text" inputmode="numeric" autocomplete="off" maxlength="7" pattern="[0-9 ]*" data-tv-pair-input="${esc(r.id)}" placeholder="예: 123456" aria-label="${esc(r.name)} TV 연결 코드" ${dbFeature('pairing_v2')?'':'disabled'}><button type="button" class="btn small primary" data-tv-pair="${esc(r.id)}" ${dbFeature('pairing_v2')?'':'disabled'}>연결</button></div><div class="tv-pair-reset"><button type="button" class="btn small danger-outline" data-tv-reset-key="${esc(r.id)}" ${dbFeature('display_key_reset')?'':'disabled'}>기존 기기 연결 해제</button></div>${dbFeature('pairing_v2')?'':'<p class="tv-pair-db-note">DB 업데이트(v2.35.87) 후 사용할 수 있습니다.</p>'}</div>`}
      ${p?`<div class="room-patient compact"><b>${esc(p.label||`대기 ${p.queue_no}`)}</b><span>${esc(waitText(p))}</span></div>`:''}
      ${displayControlMode(r)!=='manual'&&isPatientRoom(r)?`<div class="room-card-actions">${!p?`<button class="btn" data-open-quick="${r.id}">${quick?'맞춤 변경':'환자 맞춤'}</button>${quick?`<button class="btn" data-quick-clear="${r.id}">맞춤 해제</button>`:''}`:'<span class="room-managed-note">환자 관리에서 변경</span>'}</div>${!p?quickPanel(r):''}`:''}
    </div></details>`;
  }

  function quickPanel(r){
    return `<div class="quick-room-panel hidden" data-quick-panel="${r.id}">
      <div class="quick-room-head"><b>맞춤 영상</b><button class="text-btn dark" data-close-quick="${r.id}">닫기</button></div>
      <div class="quick-treatment-grid">${!dbFeature('site_catalog_v1')?'<small class="muted">진료 항목 선택은 병원별 설정 DB 업데이트 후 가능합니다.</small>':''}${(dbFeature('site_catalog_v1')?catalogEntries('treatments'):[]).map(([v,l])=>`<button class="quick-treatment ${r.session_treatment===v?'on':''}" data-quick-treatment="${esc(v)}" data-room="${esc(r.id)}">${esc(l)}</button>`).join('')}</div>
      <details class="quick-detail"><summary>연령·성별도 설정</summary><div class="quick-detail-grid"><label class="field"><span>연령</span><select data-quick-age="${r.id}">${AGE_OPTIONS.map(([v,l])=>`<option value="${v}" ${r.session_age_group===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="field"><span>성별</span><select data-quick-gender="${r.id}">${GENDER_OPTIONS.map(([v,l])=>`<option value="${v}" ${r.session_gender===v?'selected':''}>${l}</option>`).join('')}</select></label></div><p>연령·성별을 선택한 뒤 진료유형을 누르면 함께 적용됩니다.</p></details>
    </div>`;
  }


  async function markManualChecked(roomId){const r=roomById(roomId);if(!r)return;const checked=r.manual_check_status!=='checked';const {error}=await db.rpc('staff_mark_manual_display_checked',{p_room:roomId,p_checked:checked});if(error)return toast(error.message,'error');toast(checked?'현장 관리 TV 확인 완료':'미확인 상태로 변경했습니다.');await load();}

  function bindFloorTvTools(){
    const cards=qsa('.floor-ops-tv[data-tv-id]'),search=qs('#floorTvSearch'),filter=qs('#floorTvFilter');if(!search)return;
    const applyFilter=()=>{const q=search.value.trim().toLowerCase(),cat=filter.value;cards.forEach(el=>{const r=roomById(el.dataset.tvId);el.hidden=!(r&&String(r.name).toLowerCase().includes(q)&&(!cat||tvCat(r)===cat));});};
    search.addEventListener('input',applyFilter);filter.addEventListener('change',applyFilter);
    qs('#floorTvSelectAll')?.addEventListener('change',e=>cards.filter(el=>!el.hidden).forEach(el=>{qs('[data-floor-tv-select]',el).checked=e.target.checked;}));
    cards.forEach(el=>{qs('[data-floor-tv-select]',el)?.addEventListener('click',e=>e.stopPropagation());qs('summary',el)?.addEventListener('click',e=>{if(e.target.closest('input,button'))return;qs(`[data-staff-floor-room="${el.dataset.tvId}"]`)?.click();});});
    const selected=()=>cards.filter(el=>!el.hidden&&qs('[data-floor-tv-select]',el)?.checked).map(el=>roomById(el.dataset.tvId)).filter(Boolean);
    const run=async(reload)=>{if(floorBulkBusy)return;const rooms=selected().filter(r=>!reload||displayControlMode(r)!=='manual'),playlist=qs('#floorTvBulkPlaylist')?.value;if(!rooms.length||(!reload&&!playlist))return toast('TV와 필요한 재생목록을 선택하세요.','error');if(!confirm(`${rooms.length}대 TV에 ${reload?'새로고침 명령을 전송':'재생목록을 적용'}할까요?`))return;floorBulkBusy=true;let ok=0,failed=0;try{if(reload){const {data,error}=await db.rpc('hospital_reload_selected_players',{p_site:targetSiteId,p_rooms:rooms.map(r=>r.id)});if(error)throw error;ok=Number(data)||0;failed=rooms.length-ok;}else{for(const r of rooms){try{const {error}=await db.rpc('staff_set_room_playlist',{p_room:r.id,p_playlist:playlist});if(error)throw error;ok++;if(displayControlMode(r)!=='manual')await signalRoom(r.id);}catch(e){failed++;}}}toast(`${ok}대 처리 · ${failed}대 실패`,failed?'error':undefined);await load();}catch(e){toast(e.message||'처리 실패','error');}finally{floorBulkBusy=false;}};
    qs('#floorTvApply')?.addEventListener('click',()=>void run(false));qs('#floorTvReload')?.addEventListener('click',()=>void run(true));
  }
  function bind(){
    bindHospitalAdminSettings();
    bindFloorTvDragSort();
    bindFloorTvTools();
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

    qsa('[data-ops-quick-add]').forEach(button=>button.addEventListener('click',()=>{
      const kind=button.dataset.opsQuickAdd;
      layoutPanelOpen=true;spaceEditorGroupId=selectedFloorId||state.groups.find(g=>g.kind==='floor')?.id||null;
      layoutEditMode=kind==='space'?'space':'display';if(kind==='space')combinedCreateMode='both';spaceRedrawId=null;layoutPlacementRoomId=null;layoutCopyOpen=false;
      renderPreservingUi(false);
      requestAnimationFrame(()=>{
        const target=kind==='space'?'#staffSpaceName':'#staffQuickDisplayName';
        const field=qs(target);field?.scrollIntoView({behavior:'smooth',block:'center'});field?.focus({preventScroll:true});
      });
    }));
    qsa('[data-ops-layout-toggle],[data-ops-layout-open]').forEach(b=>b.addEventListener('click',()=>{
      if(layoutDraft&&!confirm('저장하지 않은 배치 변경을 취소할까요?'))return;layoutPanelOpen=b.hasAttribute('data-ops-layout-open')?true:!layoutPanelOpen;combinedPlacementQueue=[];combinedSourceSpaceId=null;
      if(layoutPanelOpen){spaceEditorGroupId=selectedFloorId||state.groups.find(g=>g.kind==='floor')?.id||null;layoutEditMode='display';spaceRedrawId=null;layoutPlacementRoomId=null;layoutCopyOpen=false;}
      renderPreservingUi(false);
      if(layoutPanelOpen)requestAnimationFrame(()=>qs('#hospitalLayoutWorkspace')?.scrollIntoView({behavior:'smooth',block:'start'}));
    }));
    qs('[data-ops-go-layout]')?.addEventListener('click',()=>{
      tab='videos';qs('#unifiedTvOperations')?.setAttribute('open','');layoutPanelOpen=true;spaceEditorGroupId=selectedFloorId||state.groups.find(g=>g.kind==='floor')?.id||null;layoutEditMode='display';spaceRedrawId=null;layoutPlacementRoomId=null;layoutCopyOpen=false;
      renderPreservingUi(false);requestAnimationFrame(()=>qs('#hospitalLayoutWorkspace')?.scrollIntoView({behavior:'smooth',block:'start'}));
    });
    qs('#unifiedTvOperations')?.addEventListener('toggle',event=>{tvOperationsExpanded=event.currentTarget.open;});
    qs('#staffStatusRefresh')?.addEventListener('click',event=>{void refreshVisibleStatuses(event.currentTarget);});qs('#staffReloadAllPlayers')?.addEventListener('click',event=>{void reloadAllSitePlayers(event.currentTarget);});qs('#hospitalBroadcastStart')?.addEventListener('click',()=>setHospitalBroadcast(true));qs('#hospitalBroadcastStop')?.addEventListener('click',()=>setHospitalBroadcast(false));qsa('[data-staff-open-settings]').forEach(b=>b.addEventListener('click',()=>{qs('#unifiedHospitalSettings')?.setAttribute('open','');qs('#unifiedHospitalSettings')?.scrollIntoView({behavior:'smooth',block:'start'});}));qsa('[data-staff-select-floor]').forEach(b=>{const open=()=>{
      const id=b.dataset.staffSelectFloor;
      const selectedGroup=state.groups.find(g=>String(g.id)===String(id));
      const physicalFloor=Number(selectedGroup?.floor_number||0);
      const matchingFloor=state.groups.find(g=>g.kind==='floor'&&Number(g.floor_number)===physicalFloor)||selectedGroup;
      const nextMediaFloor=String(matchingFloor?.id||'');
      if(mediaDirty&&nextMediaFloor!==mediaTargetFloor&&!confirm('저장되지 않은 영상 편성을 버리고 층을 변경할까요?'))return;
      if(nextMediaFloor&&mediaTargetFloor!==nextMediaFloor){mediaTargetFloor=nextMediaFloor;mediaSelectTarget('');}
      if(selectedFloorId!==id){if(layoutDraft&&!confirm('저장하지 않은 배치 변경을 취소할까요?'))return;combinedPlacementQueue=[];combinedSourceSpaceId=null;selectedFloorId=id;spaceEditorGroupId=id;spaceRedrawId=null;layoutPlacementRoomId=null;layoutEditMode='display';layoutCopyOpen=false;}
      renderPreservingUi(false);
    };b.addEventListener('click',open);b.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});});
    const floorStage=qs('.building-floor-plan-stage');
    const setFloorFocus=(kind,id,contextSpaceId=null)=>{if(!floorStage)return;floorStage.classList.add('has-map-focus');floorStage.dataset.focusKind=kind;floorStage.dataset.focusId=id;qsa('[data-staff-floor-room]',floorStage).forEach(x=>{const active=kind==='display'&&x.dataset.staffFloorRoom===id;const room=state.rooms.find(r=>r.id===x.dataset.staffFloorRoom);const linkedSpace=room?roomSpace(room)||spaceContainingPoint(room.group_id,room.map_x_pct,room.map_y_pct):null;const context=(kind==='space'&&linkedSpace?.id===id)||(kind==='display'&&contextSpaceId&&linkedSpace?.id===contextSpaceId);x.classList.toggle('is-selected',active);x.classList.toggle('is-focus-context',!!context);});qsa('[data-floor-space]',floorStage).forEach(x=>{const active=kind==='space'&&x.dataset.floorSpace===id;const context=kind==='display'&&contextSpaceId&&x.dataset.floorSpace===contextSpaceId;x.classList.toggle('is-selected-space',active);x.classList.toggle('is-focus-context',!!context);});};
    // Open exactly one editor from the TV card; retain unsaved-change guard.
    // TV card removal is an editor shortcut, not an immediate DB or R2 deletion.
    // The user must explicitly save the draft in the single playlist editor.
    qsa('[data-tv-remove-video]').forEach(button=>button.addEventListener('click',async event=>{
      event.preventDefault();event.stopPropagation();
      const roomId=button.dataset.room,videoId=String(button.dataset.tvRemoveVideo||'');
      const kind=button.dataset.removeKind||'other';
      const room=roomById(roomId),video=state.videos.find(v=>String(v.id)===videoId);
      if(!room||!video)return toast('영상 또는 TV 정보를 찾을 수 없습니다. 화면을 새로고침하세요.','error');
      if(kind==='override'){
        toast('이 영상은 병원 전체·층 전체·예약 영상에서 제공됩니다. 해당 송출 설정에서 변경해야 합니다.','error');
        return;
      }
      if(kind==='other'){
        if(!syncMediaTargetFromMap(roomId))return;
        qs('.media-workspace')?.scrollIntoView({behavior:'smooth',block:'start'});
        toast('현재 TV의 기본 재생목록에 없는 영상입니다. 환자 맞춤 또는 TV별 설정을 확인하세요.','error');
        return;
      }
      if(kind==='manual'){
        // Manual additions belong only to this TV, not the shared base playlist.
        if(!Array.isArray(room.manual_video_ids)||!room.manual_video_ids.map(String).includes(videoId))return toast('TV에 따로 지정한 영상 목록이 변경됐습니다. 다시 조회하세요.','error');
        if(!confirm(`「${video.title}」을(를) ${room.name} TV의 개별 송출 목록에서 제거할까요?\n\n다른 TV의 재생목록과 R2 원본은 유지됩니다. 마지막 영상이면 TV에서 보여줄 영상 목록으로 복귀합니다.`))return;
        button.disabled=true;
        try{
          const ok=await staffControl(roomId,()=>db.rpc('hospital_remove_room_manual_video',{p_site:targetSiteId,p_room:roomId,p_video:videoId}),'이 TV에 따로 지정한 영상 목록에서 영상을 제거했습니다. 다른 TV와 원본 영상은 유지됩니다.');
          if(!ok&&button.isConnected)button.disabled=false;
        }catch(error){if(button.isConnected)button.disabled=false;toast(error.message||String(error),'error');}
        return;
      }
      if(!syncMediaTargetFromMap(roomId))return;
      if(!mediaPlaylistId||!mediaDraft.includes(videoId)){
        toast('이 영상은 현재 기본 재생목록에 없습니다. 최신 송출 상태를 확인하세요.','error');
        return;
      }
      if(mediaGlobalReadonly(mediaPlaylistId)){
        toast('공용 재생목록은 슈퍼어드민만 수정할 수 있습니다. 병원별 수정은 공용 목록을 복사하세요.','error');
        qs('.media-workspace')?.scrollIntoView({behavior:'smooth',block:'start'});
        return;
      }
      if(mediaDraft.length===1){
        toast('마지막 영상은 제거 후 저장할 수 없습니다. 재생목록 자체를 삭제하거나 다른 영상을 먼저 추가하세요.','error');
        qs('.media-workspace')?.scrollIntoView({behavior:'smooth',block:'start'});
        return;
      }
      mediaDraft=mediaDraft.filter(id=>id!==videoId);
      mediaDirty=true;
      refreshMediaWorkspace();
      qs('.media-workspace')?.scrollIntoView({behavior:'smooth',block:'start'});
      toast('편집 목록에서 영상을 제거했습니다. 변경 저장을 눌러 적용하세요. 원본 파일은 유지됩니다.');
    }));
    qsa('[data-tv-edit-playlist]').forEach(button=>button.addEventListener('click',event=>{
      event.preventDefault();event.stopPropagation();
      const roomId=button.dataset.tvEditPlaylist;
      if(!syncMediaTargetFromMap(roomId))return;
      const section=qs('.media-workspace');
      if(!section)return toast('재생목록 편집 영역을 찾을 수 없습니다.','error');
      section.scrollIntoView({behavior:'smooth',block:'start'});
      if(!mediaPlaylistId)toast('이 TV에 연결된 재생목록이 없습니다. 새 목록을 만들고 저장한 뒤 TV에 적용하세요.');
    }));
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

    qsa('[data-staff-floor-room]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const id=b.dataset.staffFloorRoom,r=state.rooms.find(x=>x.id===id),inspector=qs('[data-staff-floor-zone-inspector]');if(r&&inspector){qsa('[data-tv-id]').forEach(el=>el.toggleAttribute('data-map-linked',el.dataset.tvId===id));const linkedSpace=roomSpace(r)||spaceContainingPoint(r.group_id,r.map_x_pct,r.map_y_pct);setFloorFocus('display',id,linkedSpace?.id||null);syncMediaTargetFromMap(id);inspector.innerHTML=staffFloorRoomPreviewHtml(r);}}));
    qs('[data-staff-floor-zone-inspector]')?.addEventListener('click',event=>{
      const edit=event.target.closest('[data-map-edit-space],[data-map-add-tv]');
      if(edit){const sp=state.floorSpaces.find(x=>x.id===(edit.dataset.mapEditSpace||edit.dataset.mapAddTv));if(!sp)return;layoutPanelOpen=true;selectedFloorId=spaceEditorGroupId=sp.group_id;layoutEditMode=edit.dataset.mapEditSpace?'space':'display';spaceRedrawId=edit.dataset.mapEditSpace?sp.id:null;layoutPlacementRoomId=null;renderPreservingUi(false);if(edit.dataset.mapAddTv){const name=prompt('추가할 TV 이름',sp.name+' TV');if(name?.trim())void addTvToSelectedSpace(sp,name.trim());}return;}
      const toggle=event.target.closest('[data-map-tv-toggle]');
      if(toggle){
        event.stopPropagation();
        const id=toggle.dataset.mapTvToggle;
        const panel=qs(`[data-map-tv-panel="${id}"]`,event.currentTarget);
        if(!panel)return;
        const opening=panel.hidden;
        qsa('[data-map-tv-panel]',event.currentTarget).forEach(p=>p.hidden=true);
        qsa('[data-map-tv-toggle]',event.currentTarget).forEach(b=>b.setAttribute('aria-expanded','false'));
        panel.hidden=!opening;
        toggle.setAttribute('aria-expanded',String(opening));
        return;
      }
      const action=event.target.closest('[data-staff-playlist-apply],[data-staff-open-room-detail],[data-tv-edit-playlist]');
      if(action){
        event.stopPropagation();
        const id=action.dataset.staffPlaylistApply||action.dataset.staffOpenRoomDetail||action.dataset.tvEditPlaylist;
        if(action.hasAttribute('data-staff-playlist-apply'))void setRoomPlaylist(id,action);
        else if(action.hasAttribute('data-tv-edit-playlist')){
          if(syncMediaTargetFromMap(id))qs('.media-workspace')?.scrollIntoView({behavior:'smooth',block:'start'});
        }else if(!openInlineTvDetail(id))toast('TV 설정을 찾을 수 없습니다. 아래 TV 목록을 확인하세요.','error');
        return;
      }
      // Controls inside the same panel do not activate the map underneath.
      if(event.target.closest('[data-map-tv-panel]'))event.stopPropagation();
    });
    qsa('.building-floor-plan-stage [data-floor-space]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const id=b.dataset.floorSpace,sp=state.floorSpaces.find(x=>x.id===id),inspector=qs('[data-staff-floor-zone-inspector]');if(!sp||!inspector)return;setFloorFocus('space',id);const ids=new Set(roomsForFloorSpace(sp).map(r=>r.id));qsa('[data-tv-id]').forEach(el=>el.toggleAttribute('data-map-linked',ids.has(el.dataset.tvId)));inspector.innerHTML=staffFloorSpacePreviewHtml(sp);}));
    floorStage?.addEventListener('click',e=>{if(e.target.closest('[data-staff-floor-room],[data-floor-space]'))return;qsa('[data-tv-id][data-map-linked]').forEach(el=>el.removeAttribute('data-map-linked'));floorStage.classList.remove('has-map-focus');delete floorStage.dataset.focusKind;delete floorStage.dataset.focusId;qsa('.is-selected,.is-selected-space,.is-focus-context',floorStage).forEach(x=>x.classList.remove('is-selected','is-selected-space','is-focus-context'));const inspector=qs('[data-staff-floor-zone-inspector]');if(inspector)inspector.innerHTML='<div class="floor-zone-inspector-empty"><div><b>도면에서 TV나 공간을 눌러주세요.</b></div><p>어떤 영상이 나오는지, 왜 나오는지 볼 수 있습니다.</p></div>';});

    qsa('#hospitalRoot select').forEach(el=>el.addEventListener('change',()=>{el.dataset.dirty='1';}));
    qsa('[data-tv-overlay-save]').forEach(b=>b.addEventListener('click',()=>saveTvOverlayText(b.dataset.tvOverlaySave)));
    qsa('[data-staff-playlist-apply]').forEach(b=>b.addEventListener('click',()=>setRoomPlaylist(b.dataset.staffPlaylistApply,b)));
    qsa('[data-staff-player-open]').forEach(b=>b.addEventListener('click',()=>openRoomPlayer(b.dataset.staffPlayerOpen)));
    qsa('[data-staff-player-copy]').forEach(b=>b.addEventListener('click',()=>copyRoomPlayer(b.dataset.staffPlayerCopy)));
    qsa('[data-tv-pair]').forEach(b=>b.addEventListener('click',()=>pairRoomPlayer(b.dataset.tvPair,b)));
    qsa('[data-tv-reset-key]').forEach(b=>b.addEventListener('click',()=>resetRoomPlayerKey(b.dataset.tvResetKey,b)));
    qsa('[data-tv-pair-input]').forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();const b=qsa('[data-tv-pair]').find(x=>x.dataset.tvPair===i.dataset.tvPairInput);if(b)pairRoomPlayer(i.dataset.tvPairInput,b);}}));
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
    const syncNote=signal&&signalled&&Signage.cfg?.enablePlayerRealtime !== true?` · TV 반영까지 최대 약 ${Math.ceil(Math.max(30000,Number(Signage.cfg.pollMs)||120000)*1.15/60000)}분`:'';
    if(okMessage)toast(signalled||!signal?`${okMessage}${syncNote}`:'설정은 저장됐지만 화면에 변경 신호를 전달하지 못했습니다. 플레이어가 다시 연결되어 변경을 받는지 확인하세요.',signalled||!signal?undefined:'error');
    await load().catch(e=>toast(e.message||String(e),'error'));
    if(room&&signal&&signalled)void confirmDelivery(room,issuedAt);
    return true;
  }
  async function saveTvOverlayText(roomId){
    const room=roomById(roomId);
    if(!room)return toast('TV를 찾을 수 없습니다.','error');
    const input=qs(`[data-tv-overlay-input="${roomId}"]`);
    if(!input)return;
    const text=String(input.value||'').trim();
    if(text.length>160)return toast('문구는 160자 이내로 입력해 주세요.','error');
    await staffControl(roomId,()=>db.rpc('hospital_set_room_overlay_text',{
      p_site:targetSiteId,p_room:roomId,p_text:text||null
    }),text?'영상 위에 표시할 문구를 저장했습니다.':'영상 위 문구를 삭제했습니다.',{signal:displayControlMode(room)==='remote'||displayControlMode(room)==='hybrid'});
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
    await staffControl(room,()=>db.rpc('staff_set_room_playlist',{p_room:room,p_playlist:playlist}),displayControlMode(roomById(room))==='manual'?'현장 관리 TV 설정을 저장했습니다.':'TV에서 사용할 영상 목록을 변경했습니다.',{signal:displayControlMode(roomById(room))!=='manual'});
  }
  async function addRoomVideo(room,source){
    const container=source?.closest('.floor-ops-tv,.staff-room-control-body');
    const video=(container?.querySelector(`[data-staff-video="${room}"]`)||qs(`[data-staff-video="${room}"]`))?.value; if(!video)return toast('추가할 영상을 선택하세요.','error');
    await staffControl(room,()=>db.rpc('staff_add_room_video',{p_room:room,p_video:video}),'이 공간에 영상 1개를 추가했습니다.');
  }
  async function clearRoomManual(room){
    await staffControl(room,()=>db.rpc('staff_clear_room_manual',{p_room:room}),'선택한 기본 재생목록로 돌아갑니다.');
  }
  async function staffToggleVideo(room,video,enabled){
    if(isOverridden(room))return toast('병원 또는 층 전체 영상이 재생 중이라 이 TV의 영상은 따로 바꿀 수 없습니다.','error');
    await staffControl(room,()=>db.rpc('staff_set_room_video_rule',{p_room:room,p_video:video,p_enabled:enabled}));
  }
  async function staffMoveVideo(room,video,dir){
    if(isOverridden(room))return toast('병원 또는 층 전체 영상이 재생 중이라 이 TV의 영상 순서를 바꿀 수 없습니다.','error');
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
    const status=qs('[data-staff-room-status]',card);if(status){status.className=`room-status-badge status-${display.key} cat-${display.cat}`;status.textContent=display.label;}
    const thumb=qs('[data-staff-live-thumb]',card),thumbKey=String(video?.id||'');if(thumb&&thumb.dataset.videoId!==thumbKey){thumb.innerHTML=staffThumbLink(video,'monitor-current-thumb-link','현재 영상 열기');thumb.dataset.videoId=thumbKey;}
    const title=qs('[data-staff-live-title]',card);if(title)title.textContent=displayControlMode(r)==='manual'?'현장 수동 운영':currentVideoTitle(r);
    const next=qs('[data-staff-live-next]',card);if(next)next.textContent=nextVideoTitle(r);
    repaintPlayerDiagnostics(r);
    const detail=qs('[data-staff-live-detail]',card);if(detail)detail.textContent=displayControlMode(r)==='manual'?roomIssueReason(r):(on?`${playbackLabel(st.playback_state)}${progress?` · ${progress}`:''} · ${roomIssueReason(r)}`:`${display.label} · ${roomIssueReason(r)}`);
  }
  function paintStaffSummary(){
    const c=tvCounts(state.rooms);
    TV_CAT_ORDER.forEach(cat=>qsa(`[data-tv-count="${cat}"]`).forEach(el=>{if(el.textContent!==String(c[cat]))el.textContent=String(c[cat]);el.closest('.ops-status-card')?.classList.toggle('has-count',c[cat]>0);}));
    const line=qs('[data-tv-summary-line]');if(line)line.textContent=tvSummaryLine(c);
    qsa('[data-ops-state]').forEach(el=>{const r=roomById(el.dataset.opsState);if(!r)return;const s=roomDisplayStatus(r);el.className=`floor-ops-state status-${s.key} cat-${s.cat}`;el.title=visibleTvStatus(s);el.innerHTML=tvBadgeHtml(s);el.closest('.floor-ops-tv')?.setAttribute('class',`floor-ops-tv status-${s.key} cat-${s.cat}`);});
    qsa('[data-ops-video]').forEach(el=>{const r=roomById(el.dataset.opsVideo);if(r)el.textContent=displayControlMode(r)==='manual'?'현장 수동 운영':(currentVideoTitle(r));});
    state.rooms.forEach(repaintPlayerDiagnostics);
    qsa('[data-ops-reason]').forEach(el=>{const r=roomById(el.dataset.opsReason);if(r)el.textContent=roomIssueReason(r)||' ';});
    qsa('[data-ops-floor-status]').forEach(el=>{const group=state.groups.find(g=>g.id===el.dataset.opsFloorStatus);if(!group)return;const rs=state.rooms.filter(r=>r.group_id===group.id);el.innerHTML=floorStatusDots(rs);el.closest('.hospital-floor-row')?.classList.toggle('has-issue',rs.some(r=>tvCat(r)==='issue'));});
    qsa('[data-floor-stats]').forEach(el=>{const g=state.groups.find(x=>x.id===el.dataset.floorStats);if(g)el.innerHTML=tvCountChips(tvCounts(state.rooms.filter(r=>r.group_id===g.id)));});
    groupedRooms().forEach(g=>paintStaffGroup(g));
    /* 도면 공간 색도 같은 5초 주기로 다시 칠한다 */
    qsa('.building-floor-plan-stage .floor-space-overlay[data-floor-space]:not(.is-editable)').forEach(el=>{const sp=state.floorSpaces.find(x=>x.id===el.dataset.floorSpace);if(!sp)return;const st=floorSpaceBroadcastStatus(sp);['live','standby','unpaired','issue','manual','empty'].forEach(k=>el.classList.toggle(`status-${k}`,st.key===k));const t=`${sp.name} · ${st.label}`;if(el.title!==t){el.title=t;el.setAttribute('aria-label',t);}});
  }
  function paintStaffGroup(group){
    const card=qs(`[data-staff-group="${group.id}"]`);if(!card)return;const x=groupStatusSummary(group.rooms),set=(sel,val)=>{const el=qs(sel,card);if(el)el.textContent=String(val);};
    card.className=`monitor-group staff-monitor-group group-state-${x.key}`;const badge=qs('[data-staff-group-status]',card);if(badge){badge.className=`group-status-badge status-${x.key}`;badge.textContent=x.label;}set('[data-staff-group-total]',x.total);set('[data-staff-group-live]',x.live);set('[data-staff-group-online]',x.online);set('[data-staff-group-issues]',x.issues);const p=qs('[data-staff-group-summary]',card);if(p)p.textContent=groupNowText(x);
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

  // Reboot only remote/hybrid players owned by the current site. The RPC validates
  // the PIN session and performs the site-scoped update; no cross-site table writes.
  let siteReloadInFlight=false;
  async function reloadAllSitePlayers(button){
    if(siteReloadInFlight)return;
    const targets=state.rooms.filter(r=>['remote','hybrid'].includes(displayControlMode(r)));
    if(!targets.length)return toast('원격으로 새로고침할 TV가 없습니다.','error');
    if(!window.confirm(`이 병원의 원격으로 관리하는 TV ${targets.length}대에 플레이어 새로고침 명령을 보낼까요?\n\n재생 중인 영상이 잠시 중단됩니다. 현장에서 관리하는 TV는 제외하며, 연결이 끊긴 TV는 즉시 반영되지 않을 수 있습니다.`))return;
    siteReloadInFlight=true;
    if(button){button.disabled=true;button.textContent='명령 전송 중…';}
    try{
      const {data,error}=await db.rpc('hospital_reload_site_players',{p_site:targetSiteId});
      if(error)throw error;
      const count=Number(data)||0;
      toast(`이 병원의 원격 TV ${count}대에 새로고침 명령을 보냈습니다. 실제 반영은 TV 연결 상태에 따라 달라집니다.`);
      await refreshVisibleStatuses(null);
    }catch(err){
      toast(`플레이어 새로고침 실패 · ${err?.message||String(err)}`,'error');
    }finally{
      siteReloadInFlight=false;
      if(button?.isConnected){button.disabled=false;button.textContent='전체 플레이어 새로고침';}
    }
  }
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
      if(button?.isConnected){button.disabled=false;button.textContent='상태 새로고침';}
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
