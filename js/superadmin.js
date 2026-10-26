(async function () {
  'use strict';
  const { db, qs, esc, toast } = Signage;
  await Signage.requireAuth('admin');
  qs('#signOut')?.addEventListener('click', Signage.signOut);

  const monitor=Signage.createLiveMonitor({onUpdate:()=>load().catch(()=>{})});
  let state={sites:[],rooms:[],groups:[]};
  let selectedSiteId=null;
  let searchTerm='';

  const siteSlug=(s)=>String(s?.code||s?.slug||s?.id||'').trim();
  const sitePath=(s)=>`/hospital.html?site=${encodeURIComponent(siteSlug(s))}`;
  const isManual=(r)=>String(r?.display_control_mode||'remote')==='manual';
  const isRemoteDisplay=(r)=>!isManual(r);
  const healthOf=(r)=>isManual(r)?(r.manual_check_status==='checked'?'manual-ok':'manual-issue'):Signage.roomHealth(r,monitor.serverNow());
  const isOffline=(r)=>isRemoteDisplay(r)&&healthOf(r)==='offline';
  const roomIssueReason=(r)=>{
    if(isManual(r))return r.manual_check_status==='checked'?'':'현장 확인 필요';
    const h=healthOf(r),st=r.player_status||{};
    if(h==='offline')return '연결 안 됨';
    if(st.update_error||st.update_pending_version)return '업데이트 필요';
    if(st.offline_cache_error)return '캐시 오류';
    if(Number(st.failed_video_count||0)>0)return `재생 실패 ${Number(st.failed_video_count||0)}건`;
    if(st.error)return String(st.error).slice(0,50);
    return '';
  };
  const roomHasIssue=(r)=>Boolean(roomIssueReason(r));
  const isOnline=(r)=>isRemoteDisplay(r)&&!isOffline(r);

  function loadRisk(onlineRemote){
    const n=Number(onlineRemote||0);
    if(n>=80)return {label:'주의',cls:'risk-alert',note:'원격 디스플레이가 매우 많음'};
    if(n>=40)return {label:'높음',cls:'risk-high',note:'송출 부하가 높은 편'};
    if(n>=15)return {label:'보통',cls:'risk-normal',note:'일반적인 송출 규모'};
    return {label:'낮음',cls:'risk-low',note:'현재 송출 부하가 낮음'};
  }
  function siteRooms(siteId){return state.rooms.filter(r=>r.site_id===siteId);}
  function siteGroups(siteId){return state.groups.filter(g=>g.site_id===siteId);}
  function siteStats(site){
    const rooms=siteRooms(site.id);
    const issues=rooms.filter(roomHasIssue);
    const online=rooms.filter(isOnline).length;
    const offline=rooms.filter(isOffline).length;
    const manual=rooms.filter(isManual).length;
    const risk=loadRisk(online);
    return {total:rooms.length,issues:issues.length,issueRooms:issues,online,offline,manual,risk};
  }
  function floorRows(site){
    const groups=siteGroups(site.id).filter(g=>Number.isFinite(Number(g.floor_number)));
    const byId=new Map(groups.map(g=>[g.id,g]));
    const floors=new Map();
    for(const g of groups){
      const f=Number(g.floor_number);if(!floors.has(f))floors.set(f,{floor:f,total:0,issues:0,offline:0});
    }
    for(const r of siteRooms(site.id)){
      const g=byId.get(r.group_id);if(!g||!Number.isFinite(Number(g.floor_number)))continue;
      const f=Number(g.floor_number),row=floors.get(f)||{floor:f,total:0,issues:0,offline:0};
      row.total+=1;if(roomHasIssue(r))row.issues+=1;if(isOffline(r))row.offline+=1;floors.set(f,row);
    }
    return [...floors.values()].sort((a,b)=>b.floor-a.floor);
  }
  function issueHeadline(stats){
    if(!stats.issues)return '현재 확인할 문제가 없습니다.';
    const first=stats.issueRooms[0],reason=first?roomIssueReason(first):'';
    if(stats.issues===1)return `${first?.name||'디스플레이'} · ${reason||'확인 필요'}`;
    return `${first?.name||'디스플레이'} · ${reason||'확인 필요'} 외 ${stats.issues-1}건`;
  }

  async function load(){
    const [sitesRes,roomsRes,groupsRes,liveRes]=await Promise.all([
      db.from('sites').select('*').order('created_at'),
      db.from('rooms').select('id,site_id,group_id,name,display_control_mode,manual_check_status,last_seen_at,player_status'),
      db.from('signage_groups').select('id,site_id,name,floor_number,sort_order'),
      monitor.loadAll().then(data=>({data,error:null}),error=>({data:null,error}))
    ]);
    if(sitesRes.error)throw sitesRes.error;if(roomsRes.error)throw roomsRes.error;if(groupsRes.error)throw groupsRes.error;
    const live=new Map((liveRes.data?.rows||[]).map(x=>[x.room_id,x]));
    const rooms=(roomsRes.data||[]).map(r=>{const x=live.get(r.id);return x?{...r,last_seen_at:x.last_seen_at||r.last_seen_at,player_status:x.player_status||r.player_status}:r;});
    state={sites:(sitesRes.data||[]).filter(s=>s.active!==false),rooms,groups:groupsRes.data||[]};
    if(selectedSiteId&&!state.sites.some(s=>s.id===selectedSiteId))selectedSiteId=null;
    render();
  }

  function render(){
    const allRows=state.sites.map(site=>({site,stats:siteStats(site)})).sort((a,b)=>b.stats.issues-a.stats.issues||String(a.site.name||'').localeCompare(String(b.site.name||''),'ko'));
    const filtered=allRows.filter(({site})=>!searchTerm||`${site.name||''} ${siteSlug(site)}`.toLowerCase().includes(searchTerm));
    const totalDisplays=allRows.reduce((n,x)=>n+x.stats.total,0),issues=allRows.reduce((n,x)=>n+x.stats.issues,0),online=allRows.reduce((n,x)=>n+x.stats.online,0);
    const overallRisk=loadRisk(online);
    const selected=state.sites.find(s=>s.id===selectedSiteId)||null;

    qs('#adminRoot').innerHTML=`
      <section class="superadmin-home">
        <div class="hospital-overview-head"><div><span class="eyebrow">SUPER ADMIN</span><h1>전체 현황</h1><p>문제가 있는 병원을 먼저 확인하고, 필요한 경우에만 관리자 페이지로 들어갑니다.</p></div><button type="button" class="btn" id="openAddHospital">병원 추가</button></div>
        <div class="hospital-overview-summary superadmin-summary"><span><b>${allRows.length}</b><small>병원</small></span><span><b>${totalDisplays}</b><small>디스플레이</small></span><span class="${issues?'has-issue':''}"><b>${issues}</b><small>확인 필요</small></span><span class="${overallRisk.cls}"><b>${overallRisk.label}</b><small>송출 부하</small></span></div>
        <div class="superadmin-layout ${selected?'has-selection':''}">
          <div class="superadmin-hospital-list-wrap">
            <div class="superadmin-list-head"><h2>병원 현황</h2><label class="superadmin-search"><span class="sr-only">병원 검색</span><input id="hospitalSearch" type="search" placeholder="병원 검색" value="${esc(searchTerm)}"></label></div>
            <div class="hospital-overview-list">${filtered.map(({site,stats})=>`<button type="button" class="hospital-overview-row ${stats.issues?'has-issue':''} ${selectedSiteId===site.id?'is-selected':''}" data-site-summary="${site.id}"><span class="hospital-overview-identity"><b>${esc(site.name||'병원')}</b><small>${stats.issues?`확인 필요 ${stats.issues}`:'정상'}</small></span><span class="hospital-overview-stat"><b>${stats.total}</b><small>디스플레이</small></span><span class="hospital-overview-stat"><b>${stats.offline}</b><small>오프라인</small></span><span class="hospital-overview-risk ${stats.risk.cls}">${stats.risk.label}</span><span class="hospital-overview-arrow" aria-hidden="true">›</span></button>`).join('')||'<div class="empty-state">조건에 맞는 병원이 없습니다.</div>'}</div>
          </div>
          ${selected?renderSiteSummary(selected):'<aside class="superadmin-site-summary is-empty"><b>병원을 선택하세요</b><p>병원의 현재 상태를 먼저 확인한 뒤 관리자 페이지로 이동할 수 있습니다.</p></aside>'}
        </div>
      </section>
      <dialog id="addHospitalDialog" class="simple-dialog"><form method="dialog" class="simple-dialog-card"><div class="simple-dialog-head"><div><span class="eyebrow">NEW HOSPITAL</span><h2>병원 추가</h2></div><button class="text-btn dark" value="cancel">닫기</button></div><label class="field"><span>병원명</span><input id="newHospitalName" maxlength="60" placeholder="예: 강남 본원"></label><label class="field"><span>고유 주소</span><div class="slug-input"><i>/</i><input id="newHospitalSlug" maxlength="32" autocomplete="off" spellcheck="false" placeholder="gangnam"></div></label><label class="field"><span>병원 관리자 PIN</span><input id="newHospitalPin" type="password" inputmode="numeric" maxlength="6" placeholder="4~6자리"></label><div class="inline top-gap"><button type="button" class="btn primary" id="createHospital">추가</button></div></form></dialog>`;

    qs('#openAddHospital')?.addEventListener('click',()=>qs('#addHospitalDialog')?.showModal());
    qs('#createHospital')?.addEventListener('click',createHospital);
    qs('#hospitalSearch')?.addEventListener('input',e=>{searchTerm=String(e.target.value||'').trim().toLowerCase();render();requestAnimationFrame(()=>{const el=qs('#hospitalSearch');if(el){el.focus();el.setSelectionRange(el.value.length,el.value.length);}});});
    document.querySelectorAll('[data-site-summary]').forEach(el=>el.addEventListener('click',()=>{selectedSiteId=el.dataset.siteSummary||null;render();}));
    qs('[data-save-site-pin]')?.addEventListener('click',saveSelectedSitePin);
    qs('[data-export-site]')?.addEventListener('click',exportSelectedSite);
    qs('[data-import-site]')?.addEventListener('change',importSelectedSite);
    qs('[data-prune-logs]')?.addEventListener('click',pruneLogs);
  }

  function renderSiteSummary(site){
    const stats=siteStats(site),floors=floorRows(site),problemFloors=floors.filter(f=>f.issues),normalFloors=floors.filter(f=>!f.issues);
    const floorHtml=(problemFloors.length?problemFloors:floors.slice(0,6)).map(f=>`<div class="superadmin-floor-row ${f.issues?'has-issue':''}"><b>${f.floor}층</b><span>${f.issues?`확인 필요 ${f.issues}`:'정상'}</span><small>${f.total}대${f.offline?` · 오프라인 ${f.offline}`:''}</small></div>`).join('');
    return `<aside class="superadmin-site-summary">
      <div class="superadmin-site-summary-head"><div><span class="eyebrow">HOSPITAL</span><h2>${esc(site.name||'병원')}</h2><p>${stats.issues?'확인이 필요한 항목이 있습니다.':'현재 정상 운영 중입니다.'}</p></div><span class="superadmin-status-pill ${stats.issues?'has-issue':''}">${stats.issues?'확인 필요':'정상'}</span></div>
      <div class="superadmin-site-metrics"><div><small>디스플레이</small><b>${stats.total}</b></div><div><small>현재 연결</small><b>${stats.online}</b></div><div class="${stats.offline?'has-issue':''}"><small>오프라인</small><b>${stats.offline}</b></div><div class="${stats.issues?'has-issue':''}"><small>확인 필요</small><b>${stats.issues}</b></div></div>
      <div class="superadmin-risk-card ${stats.risk.cls}"><div><small>송출 부하</small><b>${stats.risk.label}</b></div><p>${esc(stats.risk.note)} · 현재 연결된 원격 디스플레이 수 기준</p></div>
      <div class="superadmin-attention ${stats.issues?'has-issue':''}"><small>지금 확인할 내용</small><b>${esc(issueHeadline(stats))}</b></div>
      <div class="superadmin-floor-summary"><div class="superadmin-subhead"><b>층별 현황</b>${problemFloors.length&&normalFloors.length?`<small>정상 ${normalFloors.length}개 층은 접어 표시</small>`:''}</div>${floorHtml||'<p class="muted">층 정보가 없습니다.</p>'}</div>
      <details class="superadmin-maintenance"><summary><span><b>관리 도구</b><small>자주 쓰지 않는 설정과 백업</small></span></summary><div class="superadmin-maintenance-body"><label class="field"><span>병원 관리자 PIN</span><div class="inline"><input id="selectedHospitalPin" type="password" inputmode="numeric" maxlength="6" placeholder="4~6자리"><button type="button" class="btn" data-save-site-pin="${site.id}">PIN 변경</button></div></label><div class="inline"><button type="button" class="btn" data-export-site="${site.id}">설정 백업</button><label class="btn"><input type="file" accept="application/json" data-import-site="${site.id}" hidden>설정 복원</label><button type="button" class="btn" data-prune-logs>오래된 로그 정리</button></div></div></details>
      <a class="btn primary superadmin-open-hospital" href="${esc(sitePath(site))}">병원 관리자 페이지 열기</a>
    </aside>`;
  }

  async function saveSelectedSitePin(){const siteId=qs('[data-save-site-pin]')?.dataset.saveSitePin,pin=(qs('#selectedHospitalPin')?.value||'').replace(/\D/g,'');if(!siteId||pin.length<4||pin.length>6)return toast('PIN은 4~6자리 숫자로 입력하세요.','error');const {error}=await db.rpc('admin_set_site_staff_pin',{p_site:siteId,p_pin:pin});if(error)return toast(error.message,'error');qs('#selectedHospitalPin').value='';toast('병원 관리자 PIN을 변경했습니다.');}
  async function exportSelectedSite(){const siteId=qs('[data-export-site]')?.dataset.exportSite;if(!siteId)return;const {data,error}=await db.rpc('admin_export_site_config',{p_site:siteId});if(error)return toast(error.message,'error');const site=state.sites.find(x=>x.id===siteId),blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`signage-${siteSlug(site)||siteId}-backup.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
  async function importSelectedSite(e){const file=e.target.files?.[0];e.target.value='';if(!file)return;if(!confirm('이 병원의 설정을 백업 파일 기준으로 복원할까요?'))return;try{const config=JSON.parse(await file.text());const {error}=await db.rpc('admin_import_site_config',{p_config:config});if(error)throw error;toast('병원 설정을 복원했습니다.');await load();}catch(err){toast(err.message||'복원 파일을 확인하세요.','error');}}
  async function pruneLogs(){if(!confirm('30일이 지난 플레이어 이벤트를 정리할까요?'))return;const {data,error}=await db.rpc('admin_prune_player_events',{p_days:30});if(error)return toast(error.message,'error');toast(`오래된 로그 ${Number(data||0)}건을 정리했습니다.`);}
  async function createHospital(){
    const name=(qs('#newHospitalName')?.value||'').trim(),code=(qs('#newHospitalSlug')?.value||'').trim().toLowerCase(),pin=(qs('#newHospitalPin')?.value||'').replace(/\D/g,'');
    if(!name||!code)return toast('병원명과 고유 주소를 입력하세요.','error');
    if(pin.length<4||pin.length>6)return toast('병원 관리자 PIN은 4~6자리 숫자로 입력하세요.','error');
    const {data,error}=await db.rpc('admin_create_site',{p_name:name,p_code:code,p_building_label:'MAIN BUILDING'});
    if(error)return toast(error.message||'병원을 추가하지 못했습니다.','error');
    if(data?.ok===false)return toast(data.message||'병원을 추가하지 못했습니다.','error');
    if(data?.existing)return toast('이미 사용 중인 고유 주소입니다. 다른 주소를 입력하세요.','error');
    const siteId=data?.site?.id;if(!siteId)return toast('병원은 생성됐지만 식별자를 받지 못했습니다.','error');
    const pinRes=await db.rpc('admin_set_site_staff_pin',{p_site:siteId,p_pin:pin});if(pinRes.error)return toast(`병원은 생성됐지만 PIN 설정에 실패했습니다: ${pinRes.error.message}`,'error');
    selectedSiteId=siteId;await load();
  }
  await load().catch(e=>{console.error(e);qs('#adminRoot').innerHTML='<div class="loading error">병원 현황을 불러오지 못했습니다.</div>';});
})();
