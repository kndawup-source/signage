'use strict';
const { requireMember, resolveSite, json } = require('./_lib/auth');
const { presignGet } = require('./_lib/r2');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xtzchrpwgjvalvallfre.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
module.exports=async(req,res)=>{
  if(req.method!=='GET')return json(res,405,{error:'METHOD_NOT_ALLOWED'});
  try{
    const session=await requireMember(req),siteId=resolveSite(session,req.query?.siteId);
    const token=String(req.headers['x-signage-session']||'');
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/hospital_building_asset`,{method:'POST',headers:{apikey:SUPABASE_ANON_KEY,Authorization:`Bearer ${SUPABASE_ANON_KEY}`,'Content-Type':'application/json','x-signage-session':token},body:JSON.stringify({p_site:siteId})});
    if(!response.ok)return json(res,response.status,{error:'BUILDING_ASSET_LOOKUP_FAILED'});
    const asset=await response.json(),key=String(asset?.key||'');
    if(!key)return json(res,404,{error:'BUILDING_IMAGE_NOT_SET'});
    res.statusCode=302;res.setHeader('Location',presignGet(key,300));res.setHeader('Cache-Control','private, max-age=120');res.end();
  }catch(e){return json(res,e.statusCode||500,{error:e.message||'BUILDING_IMAGE_FAILED'});}
};
