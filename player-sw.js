/* Clinic Signage Player offline runtime — v2.33.26 */
'use strict';
const VERSION='2.33.26';
const SHELL_CACHE=`clinic-signage-player-shell-${VERSION}`;
const MEDIA_CACHE='clinic-signage-playlist-media-v1';
const RUNTIME_CACHE='clinic-signage-player-runtime-v1';
const SUPABASE_CDN='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
const SHELL=[
  '/player.html',
  `/css/app.css?v=${VERSION}`,
  `/js/boot.js?v=${VERSION}`, 
  `/js/config.js?v=${VERSION}`,
  `/js/version.js?v=${VERSION}`,
  `/js/common.js?v=${VERSION}`,
  `/js/player.js?v=${VERSION}`
];
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(SHELL_CACHE);
    for(const url of [...SHELL,SUPABASE_CDN]){try{const target=url.startsWith('http')?url:new URL(url,self.location.origin).href;await cache.add(new Request(target,{mode:url.startsWith('http')?'cors':'same-origin',cache:'reload'}));}catch(_){}}
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const names=await caches.keys();
    await Promise.all(names.filter(n=>n.startsWith('clinic-signage-player-shell-')&&n!==SHELL_CACHE).map(n=>caches.delete(n)));
    await self.clients.claim();
  })());
});
function parseRange(value,size){
  const m=/bytes=(\d*)-(\d*)/.exec(value||'');if(!m)return null;
  let start=m[1]?Number(m[1]):0,end=m[2]?Number(m[2]):size-1;
  if(!m[1]&&m[2]){const suffix=Number(m[2]);start=Math.max(0,size-suffix);end=size-1;}
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||start>=size||end<start)return null;
  return {start,end:Math.min(end,size-1)};
}
async function cachedVideoResponse(request){
  const cache=await caches.open(MEDIA_CACHE);
  const full=await cache.match(request.url);if(!full)return null;
  const rangeHeader=request.headers.get('range');if(!rangeHeader)return full;
  const blob=await full.blob(),range=parseRange(rangeHeader,blob.size);if(!range)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${blob.size}`}});
  const body=blob.slice(range.start,range.end+1,blob.type||full.headers.get('content-type')||'video/mp4');
  const headers=new Headers(full.headers);headers.set('Accept-Ranges','bytes');headers.set('Content-Range',`bytes ${range.start}-${range.end}/${blob.size}`);headers.set('Content-Length',String(range.end-range.start+1));
  return new Response(body,{status:206,statusText:'Partial Content',headers});
}
async function networkFirst(request,fallback){
  try{
    const response=await fetch(request);
    if(response&&response.ok){const cache=await caches.open(RUNTIME_CACHE);try{await cache.put(request,response.clone());}catch(_){} }
    return response;
  }catch(_){return fallback?.()||Response.error();}
}
self.addEventListener('fetch',event=>{
  const request=event.request;if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(request.destination==='video'){
    event.respondWith((async()=>{try{const response=await fetch(request);if(response&&response.status<500)return response;}catch(_){}return (await cachedVideoResponse(request))||Response.error();})());return;
  }
  if(request.mode==='navigate'&&url.origin===self.location.origin){
    event.respondWith(networkFirst(request,async()=>{const cache=await caches.open(SHELL_CACHE);return (await cache.match('/player.html'))||Response.error();}));return;
  }
  if(url.origin===self.location.origin&&(/\/(?:js|css)\//.test(url.pathname)||url.pathname==='/player-release.json')){
    event.respondWith((async()=>{const shell=await caches.open(SHELL_CACHE),hit=await shell.match(request);if(hit)return hit;return networkFirst(request,async()=>{const runtime=await caches.open(RUNTIME_CACHE);return (await runtime.match(request))||Response.error();});})());return;
  }
  if(request.url===SUPABASE_CDN){
    event.respondWith(networkFirst(request,async()=>{const shell=await caches.open(SHELL_CACHE);return (await shell.match(SUPABASE_CDN))||Response.error();}));
  }
});
