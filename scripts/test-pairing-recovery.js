'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const fast=read('js/player-fastboot.js');
async function fastboot(response, initialRevoked=false){
 const key='abc',saved=`clinic-signage:last-state:${key}`,revoked=`clinic-signage:revoked:${key}`;
 const storage=new Map([[saved,'{}'],[`clinic-signage:offline-ready:${key}`,'{}']]);if(initialRevoked)storage.set(revoked,'1');
 let requests=0,paused=0;
 const root={innerHTML:'',querySelectorAll:()=>[{pause(){paused++},removeAttribute(){},load(){}}]};
 const ctx={URLSearchParams,Date,JSON,location:{search:'?key=abc'},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{getElementById:()=>root},fetch:async()=>{requests++;if(response==='network')throw Error('network');return {ok:true,json:async()=>response}},CLINIC_SIGNAGE_CONFIG:{supabaseUrl:'https://example.test',supabaseAnonKey:'anon'}};ctx.window=ctx;
 vm.runInNewContext(fast,ctx);await new Promise(setImmediate);
 return {storage,requests,paused,root,saved,revoked};
}
async function run(){
 let a=await fastboot(null);assert.equal(a.storage.get(a.revoked),'1');assert(!a.storage.has(a.saved));assert.equal(a.paused,1);
 a=await fastboot('network');assert(a.storage.has(a.saved));assert(!a.storage.has(a.revoked));assert.equal(a.paused,0);
 a=await fastboot(null,true);assert.equal(a.requests,0);
 const src=read('desktop-player/src/main.js');const body=src.slice(src.indexOf('async function confirmPairing()'),src.indexOf("ipcMain.handle('pair:poll'"));
 let cfg={baseUrl:'https://example.test',playerUrl:'https://example.test/player.html?key=abc',pendingPairing:{id:'p',code:'123456',playerKey:'abc',baseUrl:'https://example.test',playerUrl:'https://example.test/player.html?key=abc'}};let fail=true,timer;
 const ctx={readConfig:()=>structuredClone(cfg),writeConfig:x=>{cfg=structuredClone(x)},deviceId:()=> 'device',rpc:async()=>{if(fail)throw Error('network');return {ok:true}},log(){},clearTimeout(){},setTimeout:f=>{timer=f}};vm.createContext(ctx);vm.runInContext('let confirmBusy=false,confirmTimer=null;'+body,ctx);
 await vm.runInContext('confirmPairing()',ctx);assert(cfg.pendingPairing);assert.equal(typeof timer,'function');
 fail=false;await vm.runInContext('confirmPairing()',ctx);assert(!cfg.pendingPairing);
 console.log('Pairing recovery tests: 5 scenarios passed (mocked runtime)');
}
run().catch(e=>{console.error(e);process.exit(1)});
