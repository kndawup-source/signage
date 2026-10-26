'use strict';
const { requireAdmin, json, parseBody } = require('./_lib/auth');
const { signedFetch } = require('./_lib/r2');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xtzchrpwgjvalvallfre.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0emNocnB3Z2p2YWx2YWxsZnJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzNzcwMTEsImV4cCI6MjEwNzk1MzAxMX0.FDD6cycD3kd0K1IBLp0P-4Jn7x3izEwGz6Q3trBsNqE';
function collectKeys(value,siteId,out=new Set()){
  if(!value)return out;
  if(Array.isArray(value)){for(const x of value)collectKeys(x,siteId,out);return out;}
  if(typeof value==='object'){for(const [k,v] of Object.entries(value)){if(k==='key'&&typeof v==='string'&&v.startsWith(`floorplans/${siteId}/`))out.add(v);else collectKeys(v,siteId,out);} }
  return out;
}
async function supabase(path,token,options={}){
  return fetch(`${SUPABASE_URL}${path}`,{...options,headers:{apikey:SUPABASE_ANON_KEY,Authorization:`Bearer ${SUPABASE_ANON_KEY}`,'Content-Type':'application/json','x-signage-session':token,...(options.headers||{})}});
}
module.exports=async(req,res)=>{
  if(req.method!=='POST')return json(res,405,{error:'METHOD_NOT_ALLOWED'});
  try{
    await requireAdmin(req);
    const token=String(req.headers['x-signage-session']||''),body=parseBody(req),siteId=String(body.siteId||''),confirmName=String(body.confirmName||'').trim();
    if(!siteId||!confirmName)return json(res,400,{error:'INVALID_REQUEST'});
    const settingsRes=await supabase(`/rest/v1/site_settings?site_id=eq.${encodeURIComponent(siteId)}&select=floorplan_assets&limit=1`,token);
    if(!settingsRes.ok)return json(res,502,{error:'SITE_SETTINGS_READ_FAILED'});
    const rows=await settingsRes.json(),keys=[...collectKeys(rows?.[0]?.floorplan_assets,siteId)];
    for(const key of keys){const r=await signedFetch('DELETE',key);if(!r.ok&&r.status!==404)return json(res,502,{error:`R2_DELETE_${r.status}`,key});}
    const rpc=await supabase('/rest/v1/rpc/admin_delete_site',token,{method:'POST',body:JSON.stringify({p_site:siteId,p_confirm_name:confirmName})});
    if(!rpc.ok){let detail={};try{detail=await rpc.json();}catch{}return json(res,rpc.status,{error:detail.message||detail.error||'SITE_DELETE_FAILED'});}
    return json(res,200,{ok:true,deleted_floorplans:keys.length});
  }catch(e){return json(res,e.statusCode||500,{error:e.message||'SITE_DELETE_FAILED'});}
};
