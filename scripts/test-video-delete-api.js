'use strict';
const assert=require('node:assert/strict');
const a=require.resolve('../api/_lib/auth'),r=require.resolve('../api/_lib/r2');
const site='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',id2='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',sig='a'.repeat(32);
let user={role:'staff',site_id:site},calls=[],r2fail=false,finishfail=false;
require.cache[a]={exports:{requireMember:async()=>user,json:(res,status,body)=>Object.assign(res,{status,body}),parseBody:req=>req.body,SUPABASE_URL:'https://test.invalid',SUPABASE_ANON_KEY:'fixture'}};
require.cache[r]={exports:{signedFetch:async(method,key)=>{calls.push({method,key});return {ok:!r2fail,status:r2fail?503:204};}}};
const job=(video_id)=>({video_id,object_key:`sites/${site}/videos/${video_id}.mp4`,site_id:site,status:'pending'});
global.fetch=async(url,options)=>{const rpc=url.split('/').pop(),body=JSON.parse(options.body);calls.push({rpc,body});let data={};if(rpc==='video_delete_impact')data={title:'fixture',links:[],tvs:[],signature:sig};if(rpc==='video_delete_confirmed')data=job(body.p_video);if(rpc==='video_delete_batch_confirmed')data=body.p_items.map(i=>job(i.videoId));if(rpc==='video_delete_finish'&&finishfail)return {ok:false,status:500,json:async()=>({message:'finish failed'})};return {ok:true,json:async()=>data};};
const handler=require('../api/video-delete');
async function post(body){calls=[];const res={};await handler({method:'POST',headers:{'x-signage-session':'fixture'},body:{siteId:site,...body}},res);return res;}
(async()=>{
 let x=await post({action:'preview',videoId:id});assert.equal(x.status,200);assert.equal(x.body.signature,sig);assert.equal(calls.length,1);assert.equal(calls[0].rpc,'video_delete_impact');
 x=await post({videoId:id});assert.equal(x.status,400);assert.equal(calls.length,0);
 x=await post({action:'confirm',videoId:id,signature:sig,siteId:other});assert.equal(x.status,403);assert.equal(calls.length,0);
 x=await post({action:'confirm',videoId:id,signature:sig});assert.equal(x.status,200);assert.equal(x.body.physical_deleted,true);assert.equal(calls[0].rpc,'video_delete_confirmed');assert.equal(calls[0].body.p_signature,sig);assert.equal(calls[1].method,'DELETE');
 r2fail=true;x=await post({action:'confirm',videoId:id,signature:sig});assert(x.body.cleanup_pending);assert.match(calls.at(-1).body.p_error,/503/);r2fail=false;
 x=await post({action:'batch-confirm',items:[{videoId:id,signature:sig},{videoId:id,signature:sig}]});assert.equal(x.status,400);assert.equal(calls.length,0);
 x=await post({action:'batch-confirm',items:[{videoId:id,signature:sig},{videoId:id2,signature:sig}]});assert.equal(x.body.deleted_count,2);assert.equal(calls[0].rpc,'video_delete_batch_confirmed');assert.equal(calls.filter(c=>c.method==='DELETE').length,2);
 finishfail=true;x=await post({action:'batch-confirm',items:[{videoId:id,signature:sig},{videoId:id2,signature:sig}]});assert.equal(x.body.results.filter(j=>j.cleanup_pending).length,2);assert.equal(calls.filter(c=>c.method==='DELETE').length,2);
 x=await post({action:'confirm',videoId:id,signature:sig});assert.equal(x.body.metadata_deleted,true);assert.equal(x.body.cleanup_pending,true);
 console.log('Video deletion API mock: 9 scenarios passed');
})().catch(e=>{console.error(e);process.exit(1);});
