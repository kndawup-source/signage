(async function(){
  'use strict';
  const session=await Signage.requireAuth();
  if(!['admin','staff'].includes(session.role)){location.replace('/');return;}
  const version=String(document.currentScript?.dataset?.appVersion||'2.34.0');
  const header=document.querySelector('.topbar-inner');
  if(header){
    const back=session.role==='admin'?'/admin.html':'/hospital.html';
    header.innerHTML=`<a class="brand" href="${back}">CLINIC SIGNAGE</a><nav><button class="nav-btn active" data-tab="output">송출</button><button class="nav-btn" data-tab="videos">영상</button><button class="nav-btn" data-tab="settings">설정</button></nav><button id="signOut" class="text-btn">로그아웃</button>`;
  }
  const s=document.createElement('script');s.src=`/js/hospital.js?v=${version}`;s.async=false;document.body.appendChild(s);
})();
