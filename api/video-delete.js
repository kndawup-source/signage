 'use strict';
const { requireMember, json, parseBody, SUPABASE_URL, SUPABASE_ANON_KEY } = require('./_lib/auth');
const { signedFetch } = require('./_lib/r2');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches only keys created by the supported video-upload APIs (plus legacy global uploads).
const UUID_PART = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const FILE_PART = '[a-zA-Z0-9가-힣._-]+';
const SAFE_KEYS = [
  new RegExp(`^sites/(${UUID_PART})/videos/${UUID_PART}\\.mp4$`, 'i'),
  new RegExp(`^sites/(${UUID_PART})/videos/[0-9]{4}/[0-9]{2}/${FILE_PART}$`, 'i'),
  new RegExp(`^videos/sites/(${UUID_PART})/${UUID_PART}-${FILE_PART}$`, 'i'),
  new RegExp(`^videos/[0-9]{4}/[0-9]{2}/${FILE_PART}$`, 'i')
];
function isAllowedObjectKey(key, siteId) {
  if (typeof key !== 'string' || key.includes('..') || key.includes('//')) return false;
  for (const pattern of SAFE_KEYS) {
    const match = pattern.exec(key);
    if (!match) continue;
    if (match[1]) return !!siteId && match[1].toLowerCase() === String(siteId).toLowerCase();
    return true;
  }
  return false;
}
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
      for(const job of jobs)results.push(await removeOne(job,token));
      return json(res,200,{ok:true,retried:results.length,results});
    }
    const videoId=String(body.videoId||'');
    if(!UUID.test(videoId))return json(res,400,{error:'INVALID_VIDEO_ID'});
    const job=await rpc('video_delete_enqueue',token,{p_video:videoId,p_site:siteId||null});
    if(job.status==='complete')return json(res,200,{ok:true,physical_deleted:true,already_deleted:true});
    const result=await removeOne(job,token);
    return json(res,200,{ok:true,metadata_deleted:true,...result});
  }catch(e){return json(res,e.statusCode||500,{error:e.message||'VIDEO_DELETE_FAILED'});}
};
