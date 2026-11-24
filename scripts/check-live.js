#!/usr/bin/env node
'use strict';
/*
 * 배포 후 운영 서버의 버전 파일들이 모두 같은 버전인지 확인한다.
 * 일부 파일만 올라간 배포(예: player-release.json만 새 버전)를 바로 잡아낸다.
 *
 *   node scripts/check-live.js                       # https://signage-lake.vercel.app
 *   node scripts/check-live.js https://도메인          # 다른 배포 주소
 */
const fs=require('node:fs');
const path=require('node:path');
const base=String(process.argv[2]||'https://signage-lake.vercel.app').replace(/\/+$/,'');
const expected=JSON.parse(fs.readFileSync(path.resolve(__dirname,'..','player-release.json'),'utf8')).version;

async function get(p){
  const r=await fetch(`${base}${p}${p.includes('?')?'&':'?'}t=${Date.now()}`,{cache:'no-store',headers:{'cache-control':'no-cache'}});
  if(!r.ok)throw new Error(`${p} HTTP ${r.status}`);
  return r.text();
}
const pick=(re,txt)=>[...String(txt).matchAll(re)].map(m=>m[1]);

(async()=>{
  const rows=[];
  const add=(file,versions)=>rows.push({file,versions:[...new Set(versions)]});
  try{
    add('js/version.js',pick(/CLINIC_SIGNAGE_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/g,await get('/js/version.js')));
    add('player-release.json',[String(JSON.parse(await get('/player-release.json')).version||'')]);
    add('player-sw.js',pick(/const VERSION='(\d+\.\d+\.\d+)'/g,await get('/player-sw.js')));
    for(const f of ['player.html','hospital.html','admin.html','index.html'])add(f,pick(/v=(\d+\.\d+\.\d+)/g,await get(`/${f}`)));
  }catch(e){console.error(`운영 서버 확인 실패: ${e.message}`);process.exit(2);}
  let bad=0;
  for(const r of rows){
    const ok=r.versions.length===1&&r.versions[0]===expected;
    if(!ok)bad++;
    console.log(`${ok?'OK  ':'FAIL'}  ${r.file.padEnd(20)} ${r.versions.join(', ')||'(버전 없음)'}`);
  }
  if(bad){console.error(`\n배포 버전 불일치: ${bad}개 파일이 ${expected}가 아님. 전체 파일을 다시 배포하세요.`);process.exit(1);}
  console.log(`\n운영 배포 일치: ${expected} (${base})`);
})();
