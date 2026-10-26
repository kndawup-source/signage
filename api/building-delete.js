'use strict';
const { requireMember, resolveSite, json, parseBody, SUPABASE_URL, SUPABASE_ANON_KEY } = require('./_lib/auth');
const { signedFetch } = require('./_lib/r2');
module.exports=async(req,res)=>{
  if(req.method!=='POST')return json(res,405,{error:'METHOD_NOT_ALLOWED'});
  try{
    const session=await requireMember(req),body=parseBody(req),siteId=resolveSite(session,body.siteId),key=String(body.key||'').trim();
    const safeSite=siteId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const allowed=new RegExp(`^buildings/${safeSite}/[A-Za-z0-9._-]+\\.(?:png|jpg|webp)$`,'i');
    if(key.includes('..')||!allowed.test(key))return json(res,400,{error:'INVALID_OBJECT_KEY'});

    // Never delete the object that is still registered as the hospital's active building image.
    const token=String(req.headers['x-signage-session']||'');
    const lookup=await fetch(`${SUPABASE_URL}/rest/v1/rpc/hospital_building_asset`,{
      method:'POST',
      headers:{apikey:SUPABASE_ANON_KEY,Authorization:`Bearer ${SUPABASE_ANON_KEY}`,'Content-Type':'application/json','x-signage-session':token},
      body:JSON.stringify({p_site:siteId})
    });
    if(!lookup.ok)return json(res,lookup.status,{error:'BUILDING_ASSET_LOOKUP_FAILED'});
    const active=await lookup.json();
    if(String(active?.key||'')===key)return json(res,409,{error:'BUILDING_IMAGE_STILL_IN_USE'});

    const response=await signedFetch('DELETE',key);
    if(!response.ok&&response.status!==404)return json(res,502,{error:`R2_DELETE_${response.status}`});
    return json(res,200,{ok:true});
  }catch(e){return json(res,e.statusCode||500,{error:e.message||'BUILDING_DELETE_FAILED'});}
};
