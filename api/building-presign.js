'use strict';
const { requireMember, resolveSite, json, parseBody } = require('./_lib/auth');
const { config, presignPut, makeBuildingObjectKey, floorplanExtension } = require('./_lib/r2');
module.exports = async (req,res)=>{
  if(req.method!=='POST') return json(res,405,{error:'METHOD_NOT_ALLOWED'});
  try{
    const session=await requireMember(req),body=parseBody(req),siteId=resolveSite(session,body.siteId);
    const c=config(); if(!c.ready) return json(res,503,{error:'R2_NOT_CONFIGURED'});
    const filename=String(body.filename||'').trim(),contentType=String(body.contentType||'').toLowerCase(),size=Number(body.size||0),ext=floorplanExtension(filename,contentType);
    if(!ext||!['image/png','image/jpeg','image/webp'].includes(contentType)) return json(res,400,{error:'IMAGE_ONLY'});
    if(!Number.isFinite(size)||size<=0||size>4*1024*1024) return json(res,400,{error:'INVALID_FILE_SIZE'});
    const key=makeBuildingObjectKey(filename,contentType,siteId),signed=presignPut(key,900,contentType);
    return json(res,200,{key,uploadUrl:signed.uploadUrl,contentType,size,siteId});
  }catch(e){return json(res,e.statusCode||500,{error:e.message||'BUILDING_PRESIGN_FAILED'});}
};
