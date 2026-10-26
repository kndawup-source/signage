'use strict';
const { requireMember, resolveSite, json, parseBody } = require('./_lib/auth');
const { signedFetch } = require('./_lib/r2');
const { isRegisteredFloorplanVersion } = require('./_lib/floorplan-auth');
module.exports=async(req,res)=>{
  if(req.method!=='POST') return json(res,405,{error:'METHOD_NOT_ALLOWED'});
  try{
    const session=await requireMember(req),body=parseBody(req),siteId=resolveSite(session,body.siteId),key=String(body.key||'').trim(),floor=Math.trunc(Number(body.floor));
    if(!Number.isInteger(floor)||floor<1||floor>99)return json(res,400,{error:'INVALID_FLOOR'});
    if(!(await isRegisteredFloorplanVersion(req,siteId,floor,key)))return json(res,403,{error:'FLOORPLAN_NOT_REGISTERED'});
    const response=await signedFetch('DELETE',key);
    if(!response.ok&&response.status!==404) return json(res,502,{error:`R2_DELETE_${response.status}`});
    return json(res,200,{ok:true});
  }catch(e){return json(res,e.statusCode||500,{error:e.message||'FLOORPLAN_DELETE_FAILED'});}
};
