'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const VENDOR_DIR = path.join(__dirname, 'cache');
const SUPABASE_VENDOR = path.join(VENDOR_DIR, 'supabase.js');
const SUPABASE_VERSION = '2.118.0';
const APP_VERSION = '2.5.2';
const SCAN_CACHE_MS = 10 * 60 * 1000;
const SUPABASE_CDN = `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SUPABASE_VERSION}/dist/umd/supabase.js`;
let activeStreams = 0;
let scanCache = { files: null, at: 0, inFlight: null };

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('server/config.json 이 없습니다. config.example.json을 복사해 config.json으로 만든 뒤 mediaRoot를 확인하세요.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const HOST = config.host || '0.0.0.0';
const PORT = Number(config.port || 8080);
const MEDIA_ROOT = path.resolve(config.mediaRoot || '');
const WEB_ROOT = path.resolve(__dirname, '..');
const ORIGIN = config.allowedOrigin || '*';
const VIDEO_EXT = new Set(['.mp4', '.webm', '.m4v']);

if (!config.mediaRoot || !fs.existsSync(MEDIA_ROOT)) {
  console.error(`영상 폴더를 찾을 수 없습니다: ${config.mediaRoot || '(비어 있음)'}`);
  process.exit(1);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type,If-None-Match,If-Modified-Since');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges,ETag,Last-Modified');
}
function json(res, code, body) {
  cors(res);
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(body));
}
function safeMediaPath(relative) {
  const decoded = decodeURIComponent(relative || '').replace(/^\/+/, '');
  if (!decoded || decoded.split(/[\\/]+/).includes('..')) return null;
  const target = path.resolve(MEDIA_ROOT, ...decoded.split('/'));
  const root = MEDIA_ROOT.toLowerCase();
  const t = target.toLowerCase();
  if (t !== root && !t.startsWith(root + path.sep.toLowerCase())) return null;
  return target;
}
function mime(file) {
  const e=path.extname(file).toLowerCase();
  return e==='.webm'?'video/webm':e==='.m4v'?'video/x-m4v':'video/mp4';
}
async function scanDirectory(dir=MEDIA_ROOT, prefix='') {
  const out=[];
  const entries=await fsp.readdir(dir,{withFileTypes:true});
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full=path.join(dir,ent.name), rel=prefix?`${prefix}/${ent.name}`:ent.name;
    if (ent.isDirectory()) out.push(...await scanDirectory(full,rel));
    else if (ent.isFile() && VIDEO_EXT.has(path.extname(ent.name).toLowerCase())) {
      const st=await fsp.stat(full);
      out.push({path:rel.replace(/\\/g,'/'),size:st.size,modified_at:st.mtime.toISOString()});
    }
  }
  return out;
}
async function getFiles(force=false) {
  const now=Date.now();
  if(!force && scanCache.files && now-scanCache.at<SCAN_CACHE_MS)return scanCache.files;
  if(scanCache.inFlight)return scanCache.inFlight;
  scanCache.inFlight=(async()=>{
    const files=(await scanDirectory()).sort((a,b)=>a.path.localeCompare(b.path,'ko'));
    scanCache={files,at:Date.now(),inFlight:null};
    return files;
  })();
  try{return await scanCache.inFlight;}
  catch(e){scanCache.inFlight=null;throw e;}
}
async function serveVideo(req,res,file,urlObj) {
  let st;
  try { st=await fsp.stat(file); } catch { return json(res,404,{error:'not_found'}); }
  if (!st.isFile() || !VIDEO_EXT.has(path.extname(file).toLowerCase())) return json(res,404,{error:'not_found'});
  cors(res);
  const etag=`W/\"${st.size}-${Math.floor(st.mtimeMs)}\"`;
  res.setHeader('Accept-Ranges','bytes');
  res.setHeader('Content-Type',mime(file));
  res.setHeader('ETag',etag);
  res.setHeader('Last-Modified',st.mtime.toUTCString());
  res.setHeader('Cache-Control',urlObj.searchParams.has('v')?'public, max-age=31536000, immutable':'no-cache');
  if (!req.headers.range && (req.headers['if-none-match']===etag || (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']).getTime()>=Math.floor(st.mtimeMs/1000)*1000))) {
    res.writeHead(304); return res.end();
  }
  const range=req.headers.range;
  if (!range) {
    res.writeHead(200,{'Content-Length':st.size});
    if(req.method==='HEAD')return res.end();
    const stream=fs.createReadStream(file);
    activeStreams++;
    let closed=false;
    const done=()=>{if(!closed){closed=true;activeStreams=Math.max(0,activeStreams-1);}};
    res.on('close',done); stream.on('close',done); stream.on('error',done);
    return stream.pipe(res);
  }
  const m=/bytes=(\d*)-(\d*)/.exec(range);
  if(!m){res.writeHead(416,{'Content-Range':`bytes */${st.size}`});return res.end();}
  let start=m[1]?Number(m[1]):0, end=m[2]?Number(m[2]):st.size-1;
  if(start>=st.size||end>=st.size||start>end){res.writeHead(416,{'Content-Range':`bytes */${st.size}`});return res.end();}
  res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${st.size}`,'Content-Length':end-start+1});
  if(req.method==='HEAD')return res.end();
  const stream=fs.createReadStream(file,{start,end});
  activeStreams++;
  let closed=false;
  const done=()=>{if(!closed){closed=true;activeStreams=Math.max(0,activeStreams-1);}};
  res.on('close',done); stream.on('close',done); stream.on('error',done);
  return stream.pipe(res);
}
async function serveWeb(req,res,urlPath) {
  if (!config.serveWebApp) return false;
  let rel=urlPath==='/'?'index.html':urlPath.replace(/^\//,'');
  const allowedRoot=new Set(['index.html','admin.html','staff.html','player.html']);
  const allowed=allowedRoot.has(rel)||rel.startsWith('css/')||rel.startsWith('js/');
  if(!allowed)return false;
  const target=path.resolve(WEB_ROOT,rel);
  if(!target.startsWith(WEB_ROOT+path.sep) && target!==WEB_ROOT)return false;
  let st; try{st=await fsp.stat(target);}catch{return false;}
  if(!st.isFile())return false;
  const ext=path.extname(target).toLowerCase();
  const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
  const cache = ext==='.html'?'no-cache':'public, max-age=300';
  res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':cache,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'SAMEORIGIN'});
  if(req.method==='HEAD')return res.end();
  fs.createReadStream(target).pipe(res); return true;
}
function download(url,dest,redirects=0) {
  return new Promise((resolve,reject)=>{
    if(redirects>5)return reject(new Error('too_many_redirects'));
    const client=url.startsWith('https:')?https:http;
    const request=client.get(url,{headers:{'User-Agent':`Clinic-Signage/${APP_VERSION}`}},(r)=>{
      if(r.statusCode>=300&&r.statusCode<400&&r.headers.location){r.resume();return resolve(download(new URL(r.headers.location,url).toString(),dest,redirects+1));}
      if(r.statusCode!==200){r.resume();return reject(new Error(`HTTP ${r.statusCode}`));}
      const tmp=`${dest}.tmp`;
      const out=fs.createWriteStream(tmp);
      r.pipe(out);
      out.on('finish',()=>out.close(()=>fs.rename(tmp,dest,(e)=>e?reject(e):resolve())));
      out.on('error',reject);
    });
    request.setTimeout(15000,()=>request.destroy(new Error('download_timeout')));
    request.on('error',reject);
  });
}
async function ensureVendor() {
  await fsp.mkdir(VENDOR_DIR,{recursive:true});
  if(fs.existsSync(SUPABASE_VENDOR))return true;
  try { await download(SUPABASE_CDN,SUPABASE_VENDOR); console.log('Supabase JS 로컬 캐시 완료'); return true; }
  catch(e){ console.warn(`Supabase JS 최초 캐시 실패: ${e.message}`); return false; }
}
async function serveVendor(req,res) {
  if(!fs.existsSync(SUPABASE_VENDOR)) await ensureVendor();
  if(!fs.existsSync(SUPABASE_VENDOR)) return json(res,503,{error:'vendor_unavailable',message:'서버 PC를 인터넷에 연결한 뒤 다시 실행하세요.'});
  const st=await fsp.stat(SUPABASE_VENDOR);
  res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Content-Length':st.size,'Cache-Control':'public, max-age=86400'});
  if(req.method==='HEAD')return res.end();
  fs.createReadStream(SUPABASE_VENDOR).pipe(res);
}
async function diskStats(){
  try {
    if (typeof fsp.statfs !== 'function') return {};
    const st = await fsp.statfs(MEDIA_ROOT);
    const block = Number(st.bsize || 0);
    return { total_bytes: Number(st.blocks || 0) * block, free_bytes: Number(st.bavail || st.bfree || 0) * block };
  } catch { return {}; }
}
function hostName(){return os.hostname();}

const server=http.createServer(async(req,res)=>{
  try {
    const u=new URL(req.url,'http://local');
    if(req.method==='OPTIONS'){cors(res);res.writeHead(204);return res.end();}
    if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'method_not_allowed'});
    if(u.pathname==='/vendor/supabase.js')return serveVendor(req,res);
    if(u.pathname==='/health'){
      let files=0, scan_ok=true; try{files=(await getFiles(false)).length;}catch{scan_ok=false;}
      const disk=await diskStats();
      return json(res,scan_ok?200:503,{ok:scan_ok,app_version:APP_VERSION,host:hostName(),files,media_root:path.basename(MEDIA_ROOT),vendor_cached:fs.existsSync(SUPABASE_VENDOR),supabase_version:SUPABASE_VERSION,active_streams:activeStreams,scan_age_ms:scanCache.at?Date.now()-scanCache.at:null,...disk});
    }
    if(u.pathname==='/api/files'){
      try{return json(res,200,{files:await getFiles(u.searchParams.get('refresh')==='1')});}catch(e){return json(res,500,{error:'scan_failed',message:e.message});}
    }
    if(u.pathname.startsWith('/videos/')){
      const file=safeMediaPath(u.pathname.slice('/videos/'.length)); if(!file)return json(res,400,{error:'invalid_path'}); return serveVideo(req,res,file,u);
    }
    if(await serveWeb(req,res,u.pathname))return;
    return json(res,404,{error:'not_found'});
  } catch(e) { return json(res,500,{error:'internal_error',message:e.message}); }
});

server.maxConnections=200;
server.keepAliveTimeout=65000;
server.headersTimeout=66000;
server.requestTimeout=0;

server.listen(PORT,HOST,()=>{
  console.log('');
  console.log(`Clinic Signage Media Server v${APP_VERSION}`);
  console.log(`영상 폴더: ${MEDIA_ROOT}`);
  console.log(`포트: ${PORT}`);
  console.log(`이 PC: http://localhost:${PORT}`);
  console.log(`다른 PC: http://${hostName()}:${PORT}`);
  console.log('종료: Ctrl+C');
  ensureVendor();
  getFiles(true).catch((e)=>console.warn(`초기 영상 스캔 실패: ${e.message}`));
});
