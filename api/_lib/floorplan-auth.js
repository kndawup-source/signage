'use strict';
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./auth');

function basicFloorplanKeyOk(key){
  const value=String(key||'').trim();
  if(!value||value.length>512||value.includes('..')||value.startsWith('/')||value.includes('\\'))return false;
  if(!/^floorplans\/[A-Za-z0-9._\/-]+\.(?:png|jpe?g|webp)$/i.test(value))return false;
  return true;
}
function assetKey(meta){
  if(typeof meta==='string')return meta.trim();
  if(meta&&typeof meta==='object')return String(meta.key||meta.object_key||meta.path||'').trim();
  return '';
}
function headers(req){
  const token=String(req?.headers?.['x-signage-session']||'').trim();
  return {apikey:SUPABASE_ANON_KEY,Authorization:`Bearer ${SUPABASE_ANON_KEY}`,...(token?{'x-signage-session':token}:{})};
}
async function readCurrentAssets(req,siteId){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/site_settings?site_id=eq.${encodeURIComponent(siteId)}&select=floorplan_assets&limit=1`,{headers:headers(req)});
  if(!response.ok){const text=await response.text().catch(()=> '');throw Object.assign(new Error(`FLOORPLAN_METADATA_${response.status}${text?`:${text.slice(0,120)}`:''}`),{statusCode:502});}
  const rows=await response.json();
  return rows?.[0]?.floorplan_assets&&typeof rows[0].floorplan_assets==='object'?rows[0].floorplan_assets:{};
}
async function isRegisteredCurrentFloorplan(req,siteId,floor,key){
  if(!basicFloorplanKeyOk(key))return false;
  const assets=await readCurrentAssets(req,siteId),registered=assetKey(assets?.[String(Math.trunc(Number(floor)))]);
  return !!registered&&registered===String(key).trim();
}
async function isRegisteredFloorplanVersion(req,siteId,floor,key){
  if(!basicFloorplanKeyOk(key))return false;
  if(await isRegisteredCurrentFloorplan(req,siteId,floor,key))return true;
  const url=`${SUPABASE_URL}/rest/v1/floorplan_versions?site_id=eq.${encodeURIComponent(siteId)}&floor_number=eq.${encodeURIComponent(String(Math.trunc(Number(floor))))}&object_key=eq.${encodeURIComponent(String(key).trim())}&select=id&limit=1`;
  const response=await fetch(url,{headers:headers(req)});
  if(!response.ok){const text=await response.text().catch(()=> '');throw Object.assign(new Error(`FLOORPLAN_VERSION_METADATA_${response.status}${text?`:${text.slice(0,120)}`:''}`),{statusCode:502});}
  const rows=await response.json();return Array.isArray(rows)&&rows.length>0;
}
module.exports={basicFloorplanKeyOk,assetKey,isRegisteredCurrentFloorplan,isRegisteredFloorplanVersion};
