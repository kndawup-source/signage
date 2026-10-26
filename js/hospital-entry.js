(async function(){
  'use strict';
  const session=await Signage.requireAuth();
  const version=String(document.currentScript?.dataset?.appVersion||'2.33.21');
  const header=document.querySelector('.topbar-inner');
  const root=document.querySelector('#hospitalRoot');
  if(session.role==='admin'){
    document.body.classList.add('hospital-superadmin-mode');
    if(root)root.id='adminRoot';
    if(header)header.innerHTML='<a class="brand" href="/admin.html">CLINIC SIGNAGE</a><nav><button class="nav-btn active" data-tab="dashboard">송출</button><button class="nav-btn" data-tab="videos">영상</button><button class="nav-btn" data-tab="settings">설정</button></nav><button id="signOut" class="text-btn">로그아웃</button>';
    const s=document.createElement('script');s.src=`/js/admin.js?v=${version}`;s.async=false;document.body.appendChild(s);
    return;
  }
  if(session.role!=='staff'){location.replace('/');return;}
  if(header)header.innerHTML='<a class="brand" href="/hospital.html">CLINIC SIGNAGE</a><nav><button class="nav-btn active" data-tab="output">송출</button><button class="nav-btn" data-tab="videos">영상</button><button class="nav-btn" data-tab="settings">설정</button></nav><button id="signOut" class="text-btn">로그아웃</button>';
  const s=document.createElement('script');s.src=`/js/hospital.js?v=${version}`;s.async=false;document.body.appendChild(s);
})();
