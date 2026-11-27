 'use strict';
const { requireMember, json, parseBody, SUPABASE_URL, SUPABASE_ANON_KEY } = require('./_lib/auth');
const { signedFetch } = require('./_lib/r2');
const {UUID,isAllowedObjectKey}=require('./_lib/video-keys');
async function rpc(name,token,body){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',headers:{apikey:SUPABASE_ANON_KEY,Authorization:`Bearer ${SUPABASE_ANON_KEY}`,'x-signage-session':token,'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(data.message||data.error||name+' failed'),{statusCode:response.status});
  return data;
}
async function removeOne(job,token){
  const id=String(job.video_id||''),key=job.object_key;
  if(!UUID.test(id))throw new Error('INVALID_JOB_ID');
  let error=null;
  if(key!==null && key!==undefined){
    if(!isAllowedObjectKey(key,job.site_id)){
      error='INVALID_R2_OBJECT_KEY';
    } else {
      try{
        const response=await signedFetch('DELETE',key);
        if(!response.ok&&response.status!==404)error='R2_DELETE_HTTP_'+response.status;
      }catch(e){error='R2_DELETE_CONNECTION_FAILED: '+String(e.message||e).slice(0,150);}
    }
  }
  await rpc('video_delete_finish',token,{p_video:id,p_error:error});
  return {video_id:id,physical_deleted:!error,cleanup_pending:!!error,error};
}
module.exports=async(req,res)=>{
  if(req.method!=='POST')return json(res,405,{error:'METHOD_NOT_ALLOWED'});
  try{
    const user=await requireMember(req),token=String(req.headers['x-signage-session']||'');
    const body=parseBody(req),siteId=String(body.siteId||'').trim();
    if(siteId&&!UUID.test(siteId))return json(res,400,{error:'INVALID_SITE'});
    if(user.role!=='admin'&&(!siteId||String(user.site_id)!==siteId))return json(res,403,{error:'SITE_FORBIDDEN'});
    if(body.action==='retry'){
      const pending=await rpc('video_delete_pending',token,{p_site:siteId||null});
      const jobs=Array.isArray(pending)?pending:[];
      const results=[];
      for(const job of jobs){
        try{results.push(await removeOne(job,token));}
        catch(e){results.push({video_id:job.video_id,physical_deleted:false,cleanup_pending:true,error:String(e.message||e)});}
      }
      return json(res,200,{ok:true,retried:results.length,results});
    }
    if(body.action==='batch-confirm'){
      const items=body.items;
      if(!Array.isArray(items)||items.length<1||items.length>10||items.some(i=>!i||!UUID.test(String(i.videoId||''))||!(/^[0-9a-f]{32}$/.test(String(i.signature||''))))||new Set(items.map(i=>i.videoId.toLowerCase())).size!==items.length)return json(res,400,{error:'삭제 대상을 다시 선택하세요. (최대 10개)'});
      const jobs=await rpc('video_delete_batch_confirmed',token,{p_site:siteId||null,p_items:items.map(i=>({videoId:i.videoId,signature:i.signature}))});
      const results=[];
      for(const job of jobs){
        try{results.push(job.status==='complete'?{video_id:job.video_id,physical_deleted:true,cleanup_pending:false}:await removeOne(job,token));}
        catch(e){results.push({video_id:job.video_id,physical_deleted:false,cleanup_pending:true,error:String(e.message||e)});}
      }
      return json(res,200,{ok:true,metadata_deleted:true,deleted_count:jobs.length,results});
    }
    const videoId=String(body.videoId||'');
    if(!UUID.test(videoId))return json(res,400,{error:'INVALID_VIDEO_ID'});
    if(body.action==='preview'){
      const impact=await rpc('video_delete_impact',token,{p_video:videoId,p_site:siteId||null});
      return json(res,200,{ok:true,...impact});
    }
    if(body.action!=='confirm'||!(/^[0-9a-f]{32}$/.test(String(body.signature||''))))return json(res,400,{error:'사용 위치를 먼저 확인하세요.'});
    const job=await rpc('video_delete_confirmed',token,{p_video:videoId,p_site:siteId||null,p_signature:body.signature});
    if(job.status==='complete')return json(res,200,{ok:true,physical_deleted:true,already_deleted:true});
    try{const result=await removeOne(job,token);return json(res,200,{ok:true,metadata_deleted:true,...result});}
    catch(e){return json(res,200,{ok:true,metadata_deleted:true,video_id:videoId,physical_deleted:false,cleanup_pending:true,error:String(e.message||e)});}
  }catch(e){return json(res,e.statusCode||500,{error:e.message||'VIDEO_DELETE_FAILED'});}
};
