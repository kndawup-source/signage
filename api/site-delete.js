'use strict';
const { requireAdmin, json, parseBody } = require('./_lib/auth');
const { signedFetch } = require('./_lib/r2');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xtzchrpwgjvalvallfre.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
function collectAssetKeys(value,siteId,out=new Set()){
  if(!value)return out;
  if(Array.isArray(value)){for(const x of value)collectAssetKeys(x,siteId,out);return out;}
  if(typeof value==='object')for(const [k,v] of Object.entries(value)){if(k==='key'&&typeof v==='string'&&v.startsWith(`floorplans/${siteId}/`))out.add(v);else collectAssetKeys(v,siteId,out);}
  return out;
}
function collectVideoKey(row,out){
  const key=String(row?.storage_path||row?.file_path||'').trim();
  if(key.startsWith('videos/'))out.add(key);
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

    // 1) DB 삭제 전에 R2 정리 대상을 모두 수집한다. 실제 R2 삭제는 DB 삭제 성공 후에만 수행한다.
    const [settingsRes,versionsRes,videosRes]=await Promise.all([
      supabase(`/rest/v1/site_settings?site_id=eq.${encodeURIComponent(siteId)}&select=floorplan_assets,building_asset&limit=1`,token),
      supabase(`/rest/v1/floorplan_versions?site_id=eq.${encodeURIComponent(siteId)}&select=object_key`,token),
      supabase(`/rest/v1/videos?site_id=eq.${encodeURIComponent(siteId)}&select=storage_path,file_path,source`,token)
    ]);
    if(!settingsRes.ok||!versionsRes.ok||!videosRes.ok)return json(res,502,{error:'SITE_ASSET_LIST_FAILED'});
    const rows=await settingsRes.json(),versions=await versionsRes.json(),videos=await videosRes.json();
    const keys=collectAssetKeys(rows?.[0]?.floorplan_assets,siteId);
    const buildingKey=String(rows?.[0]?.building_asset?.key||'');if(buildingKey.startsWith(`buildings/${siteId}/`))keys.add(buildingKey);
    for(const v of versions||[]){const k=String(v?.object_key||'');if(k.startsWith(`floorplans/${siteId}/`))keys.add(k);}
    for(const v of videos||[]){if(String(v?.source||'')==='r2')collectVideoKey(v,keys);}

    // 2) 병원명 확인/비활성 상태/DB FK 정리를 먼저 통과시킨다.
    const rpc=await supabase('/rest/v1/rpc/admin_delete_site',token,{method:'POST',body:JSON.stringify({p_site:siteId,p_confirm_name:confirmName})});
    if(!rpc.ok){let detail={};try{detail=await rpc.json();}catch{}return json(res,rpc.status,{error:detail.message||detail.error||'SITE_DELETE_FAILED'});}

    // 3) DB 삭제 성공 후에만 R2 물리 파일을 정리한다. 실패 파일은 보고하되 이미 성공한 DB 삭제를 되돌리지는 않는다.
    const failed=[];
    for(const key of keys){try{const r=await signedFetch('DELETE',key);if(!r.ok&&r.status!==404)failed.push({key,status:r.status});}catch(e){failed.push({key,error:e.message||String(e)});}}
    return json(res,200,{ok:true,deleted_assets:keys.size,r2_cleanup_failed:failed});
  }catch(e){return json(res,e.statusCode||500,{error:e.message||'SITE_DELETE_FAILED'});}
};
