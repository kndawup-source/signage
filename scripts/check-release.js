#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'player-release.json'),'utf8')).version;
const errors=[];
// Admin uses a generated layered foundation so the shared TV/login CSS stays intact.
const crypto=require('node:crypto');
const sharedCss=fs.readFileSync(path.join(root,'css/app.css'));
const foundationPath=path.join(root,'css/admin-foundation.css');
const foundation=fs.existsSync(foundationPath)?fs.readFileSync(foundationPath,'utf8'):'';
const sourceHash=crypto.createHash('sha256').update(sharedCss).digest('hex');
if(!foundation.includes('Source SHA256: '+sourceHash+' */'))errors.push('Admin foundation missing or stale; run node scripts/build-admin-foundation.js');
if(!foundation.includes('@layer signage-base, signage-legacy, signage-admin;'))errors.push('Admin cascade layer order missing');
const adminCss=fs.readFileSync(path.join(root,'css/admin-console.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
if(/!\s*important\b/i.test(adminCss))errors.push('Admin design must use cascade layers instead of !important');
if(!adminCss.includes('@layer signage-admin'))errors.push('Admin design layer missing');
for(const file of ['admin.html','hospital.html']){
 const html=fs.readFileSync(path.join(root,file),'utf8');
 if(!html.includes('/css/admin-foundation.css?v=')||html.includes('/css/app.css?v='))errors.push(file+': admin must use layered foundation only');
 if(html.indexOf('/css/admin-console.css?v=')<html.indexOf('/css/admin-foundation.css?v='))errors.push(file+': admin layer load order incorrect');
}
for(const file of ['index.html','player.html']){
 const html=fs.readFileSync(path.join(root,file),'utf8');
 if(!html.includes('/css/app.css?v=')||html.includes('/css/admin-foundation.css?v='))errors.push(file+': legacy player/login CSS must remain isolated');
}

for(const file of ['player.html','hospital.html','admin.html','index.html']){
 const txt=fs.readFileSync(path.join(root,file),'utf8');
 // Check every local HTML script and stylesheet reference, including cache-busting URLs.
 for(const match of txt.matchAll(/<(script|link)\b[^>]*>/gi)){
   const tag=match[0], isScript=match[1].toLowerCase()==='script';
   if(!isScript&&!/\brel\s*=\s*["']stylesheet["']/i.test(tag))continue;
   const attr=tag.match(isScript?/\bsrc\s*=\s*["']([^"']+)["']/i:/\bhref\s*=\s*["']([^"']+)["']/i);
   if(!attr||/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(attr[1]))continue;
   const relative=attr[1].split(/[?#]/)[0].replace(/^\/+/, '');
   if(!relative||!fs.existsSync(path.join(root,relative))||!fs.statSync(path.join(root,relative)).isFile())errors.push(`${file}: missing local asset ${relative}`);
 }
 const versions=[...txt.matchAll(/v=(2\.35\.\d+(?:-layout\d+)?)/g)].map(m=>m[1]);
 if(!versions.length||versions.some(x=>x!==version))errors.push(`${file}: ${versions.join(', ')||'missing'}`);
 const dataset=[...txt.matchAll(/data-(?:player-)?version="([^"]+)"/g)].map(m=>m[1]);
 if(dataset.some(x=>x!==version))errors.push(`${file} dataset: ${dataset.join(', ')}`);
}
for(const file of ['js/version.js','player-sw.js']){
 const txt=fs.readFileSync(path.join(root,file),'utf8');
 if(!txt.includes(version))errors.push(`${file}: missing ${version}`);
}
const ignorePath=path.join(root,'.vercelignore');
if(!fs.existsSync(ignorePath)){
  errors.push('.vercelignore missing');
} else {
  const rules=fs.readFileSync(ignorePath,'utf8').split(/\r?\n/).map(x=>x.trim())
    .filter(x=>x && !x.startsWith('#'));
  for(const p of ['supabase/','sql/','server/','scripts/','floorplans_source/','desktop-player/','*.md','*.txt']){
    if(!rules.includes(p))errors.push(`not ignored: ${p}`);
  }
  // Critical: serverless functions still need their private assets at build time.
  if(rules.includes('api/')||rules.includes('api/_private/')) errors.push('api private server resources excluded');
}

if(errors.length){console.error('Deployment consistency FAILED:\n'+errors.join('\n'));process.exit(1);}
console.log(`Deployment consistency OK: ${version}`);
