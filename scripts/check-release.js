#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'player-release.json'),'utf8')).version;
const errors=[];
for(const file of ['player.html','hospital.html','admin.html','index.html','video-optimize.html']){
 const txt=fs.readFileSync(path.join(root,file),'utf8');
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
  for(const p of ['supabase/','sql/','server/','scripts/','floorplans_source/']){
    if(!rules.includes(p))errors.push(`not ignored: ${p}`);
  }
  // Critical: serverless functions still need their private assets at build time.
  if(rules.includes('api/')||rules.includes('api/_private/')) errors.push('api private server resources excluded');
}

if(errors.length){console.error('Deployment consistency FAILED:\n'+errors.join('\n'));process.exit(1);}
console.log(`Deployment consistency OK: ${version}`);
