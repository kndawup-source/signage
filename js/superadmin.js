(async function () {
  'use strict';
  const { db, qs, esc, toast } = Signage;
  await Signage.requireAuth('admin');
  qs('#signOut')?.addEventListener('click', Signage.signOut);

  const monitor=Signage.createLiveMonitor({onUpdate:()=>load().catch(()=>{})});
  let state={sites:[],rooms:[]};

  const siteSlug=(s)=>String(s?.code||s?.slug||s?.id||'').trim();
  const sitePath=(s)=>`/hospital.html?site=${encodeURIComponent(siteSlug(s))}`;
  const roomStatus=(r)=>{
    if(String(r.display_control_mode||'remote')==='manual')return r.manual_check_status==='checked'?'ok':'issue';
    const h=Signage.roomHealth(r,monitor.serverNow());
    const st=r.player_status||{};
    if(h==='offline')return 'issue';
    if(st.update_error||st.update_pending_version||st.error||st.offline_cache_error||Number(st.failed_video_count||0)>0)return 'issue';
    return 'ok';
  };
  function siteStats(site){
    const rooms=state.rooms.filter(r=>r.site_id===site.id),issues=rooms.filter(r=>roomStatus(r)==='issue').length;
    return {total:rooms.length,issues};
  }
  async function load(){
    const [sitesRes,roomsRes,liveRes]=await Promise.all([
      db.from('sites').select('*').order('created_at'),
      db.from('rooms').select('id,site_id,name,display_control_mode,manual_check_status,last_seen_at,player_status'),
      monitor.loadAll().then(data=>({data,error:null}),error=>({data:null,error}))
    ]);
    if(sitesRes.error)throw sitesRes.error;if(roomsRes.error)throw roomsRes.error;
    const live=new Map((liveRes.data?.rows||[]).map(x=>[x.room_id,x]));
    const rooms=(roomsRes.data||[]).map(r=>{const x=live.get(r.id);return x?{...r,last_seen_at:x.last_seen_at||r.last_seen_at,player_status:x.player_status||r.player_status}:r;});
    state={sites:(sitesRes.data||[]).filter(s=>s.active!==false),rooms};render();
  }
  function render(){
    const rows=state.sites.map(site=>({site,stats:siteStats(site)})).sort((a,b)=>b.stats.issues-a.stats.issues||String(a.site.name||'').localeCompare(String(b.site.name||''),'ko'));
    const totalDisplays=rows.reduce((n,x)=>n+x.stats.total,0),issues=rows.reduce((n,x)=>n+x.stats.issues,0);
    qs('#adminRoot').innerHTML=`
      <section class="superadmin-home">
        <div class="hospital-overview-head"><div><span class="eyebrow">SUPER ADMIN</span><h1>병원 현황</h1><p>전체 상태만 확인하고, 관리가 필요할 때 해당 병원으로 들어갑니다.</p></div><button type="button" class="btn" id="openAddHospital">병원 추가</button></div>
        <div class="hospital-overview-summary"><span><b>${rows.length}</b><small>병원</small></span><span><b>${totalDisplays}</b><small>디스플레이</small></span><span class="${issues?'has-issue':''}"><b>${issues}</b><small>확인 필요</small></span></div>
        <div class="hospital-overview-list">${rows.map(({site,stats})=>`<a class="hospital-overview-row ${stats.issues?'has-issue':''}" href="${esc(sitePath(site))}"><span class="hospital-overview-identity"><b>${esc(site.name||'병원')}</b><small>${stats.issues?`확인 필요 ${stats.issues}`:'정상'}</small></span><span class="hospital-overview-stat"><b>${stats.total}</b><small>디스플레이</small></span><span class="hospital-overview-arrow" aria-hidden="true">›</span></a>`).join('')||'<div class="empty-state">등록된 병원이 없습니다.</div>'}</div>
      </section>
      <dialog id="addHospitalDialog" class="simple-dialog"><form method="dialog" class="simple-dialog-card"><div class="simple-dialog-head"><div><span class="eyebrow">NEW HOSPITAL</span><h2>병원 추가</h2></div><button class="text-btn dark" value="cancel">닫기</button></div><label class="field"><span>병원명</span><input id="newHospitalName" maxlength="60" placeholder="예: 강남 본원"></label><label class="field"><span>고유 주소</span><div class="slug-input"><i>/</i><input id="newHospitalSlug" maxlength="32" autocomplete="off" spellcheck="false" placeholder="gangnam"></div></label><div class="inline top-gap"><button type="button" class="btn primary" id="createHospital">추가</button></div></form></dialog>`;
    qs('#openAddHospital')?.addEventListener('click',()=>qs('#addHospitalDialog')?.showModal());
    qs('#createHospital')?.addEventListener('click',createHospital);
  }
  async function createHospital(){
    const name=(qs('#newHospitalName')?.value||'').trim(),code=(qs('#newHospitalSlug')?.value||'').trim().toLowerCase();
    if(!name||!code)return toast('병원명과 고유 주소를 입력하세요.','error');
    const {data,error}=await db.rpc('admin_create_site',{p_name:name,p_code:code,p_building_label:'MAIN BUILDING'});
    if(error)return toast(error.message||'병원을 추가하지 못했습니다.','error');
    if(data?.ok===false)return toast(data.message||'병원을 추가하지 못했습니다.','error');
    location.href=sitePath(data?.site||{code});
  }
  await load().catch(e=>{console.error(e);qs('#adminRoot').innerHTML='<div class="loading error">병원 현황을 불러오지 못했습니다.</div>';});
})();
