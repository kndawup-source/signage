(async function(){
  'use strict';
  const entryScript=document.currentScript;
  const entryUrl=new URL(entryScript?.src||location.href,location.href);
  const version=String(entryUrl.searchParams.get('v')||entryScript?.dataset?.version||'2.35.46').trim();
  const session=await Signage.requireAuth();
  if(!['admin','staff'].includes(session.role)){location.replace('/');return;}
  const header=document.querySelector('.topbar-inner');
  if(header){
    const back=session.role==='admin'?'/admin.html':'/hospital.html';
    header.innerHTML=`<a class="brand" href="${back}">CLINIC SIGNAGE</a><nav><button class="nav-btn active" data-tab="output">송출 관리</button><button class="nav-btn" data-tab="videos">영상 보관함</button><button class="nav-btn" data-tab="settings" title="병원 전체 설정">설정</button></nav><span id="hospitalSiteLabel" class="hospital-site-label"></span><button id="signOut" class="text-btn">로그아웃</button>`;
  }
  const s=document.createElement('script');s.src=`/js/hospital.js?v=${version}`;s.async=false;document.body.appendChild(s);
})();
