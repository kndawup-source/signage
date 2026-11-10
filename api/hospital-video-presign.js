 'use strict';
const { requireMember, resolveSite, json, parseBody } = require('./_lib/auth');
const { config, presignPut, makeObjectKey } = require('./_lib/r2');
module.exports=async(req,res)=>{
  if(req.method!=='POST')return json(res,405,{error:'METHOD_NOT_ALLOWED'});
  try{
    const session=await requireMember(req),body=parseBody(req);
    const siteId=resolveSite(session,body.siteId);
    if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(siteId))return json(res,400,{error:'INVALID_SITE'});
    const filename=String(body.filename||'').trim(),type=String(body.contentType||'').toLowerCase(),size=Number(body.size);
    if(!filename.toLowerCase().endsWith('.mp4')||type!=='video/mp4')return json(res,400,{error:'MP4_ONLY'});
    if(!Number.isFinite(size)||size<=0||size>2*1024*1024*1024)return json(res,400,{error:'INVALID_FILE_SIZE'});
    if(!config().ready)return json(res,503,{error:'R2_NOT_CONFIGURED'});
    // Scoped key makes multi-tenant media ownership explicit. Site authorization uses the PIN session.
    const key=`videos/sites/${siteId}/${makeObjectKey(filename).split('/').pop()}`;
    const signed=presignPut(key,900,'video/mp4');
    return json(res,200,{key,uploadUrl:signed.uploadUrl,publicUrl:signed.publicUrl,siteId});
  }catch(e){return json(res,e.statusCode||500,{error:e.message||'VIDEO_UPLOAD_SIGN_FAILED'});}
};
