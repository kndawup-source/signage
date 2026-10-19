(function () {
  'use strict';

  const cfg = window.CLINIC_SIGNAGE_CONFIG || {};
  const db = window.supabase?.createClient ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    realtime: { params: { eventsPerSecond: 10 } }
  }) : null;

  const qs = (s, root = document) => root.querySelector(s);
  const qsa = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>'\"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const formatBytes = (n) => { const v=Number(n||0); if(!v)return '0 B'; const u=['B','KB','MB','GB','TB']; const i=Math.min(u.length-1,Math.floor(Math.log(v)/Math.log(1024))); return `${(v/Math.pow(1024,i)).toFixed(i>1?1:0)} ${u[i]}`; };
  const formatDuration = (sec) => { const n=Math.max(0,Math.round(Number(sec||0))); const h=Math.floor(n/3600),m=Math.floor((n%3600)/60),s=n%60; return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`; };
  const basename = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
  const titleFromPath = (p) => basename(p).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const joinMediaUrl = (base, filePath, version) => {
    const b = String(base || '').trim().replace(/\/+$/, '');
    const parts = String(filePath || '').replace(/^\/+/, '').split('/').filter(Boolean).map(encodeURIComponent);
    const url = `${b}/videos/${parts.join('/')}`;
    return version ? `${url}?v=${encodeURIComponent(String(version))}` : url;
  };
  const isOnline = (room) => room?.last_seen_at && Date.now() - new Date(room.last_seen_at).getTime() < (cfg.onlineThresholdMs || 90000);

  function toast(message, type = 'info') { let box=qs('#toast'); if(!box){box=document.createElement('div');box.id='toast';box.className='toast';document.body.appendChild(box);} box.className=`toast show ${type}`;box.textContent=message;clearTimeout(box._timer);box._timer=setTimeout(()=>{box.className='toast';},2600); }
  async function getSession(){ if(!db)return null; const {data,error}=await db.auth.getSession(); if(error)throw error; return data.session; }
  async function requireAuth(requiredRole){ const session=await getSession(); if(!session){const next=encodeURIComponent(location.pathname+location.search);location.replace(`/?next=${next}`);throw new Error('AUTH_REQUIRED');} const {data,error}=await db.from('members').select('role').eq('user_id',session.user.id).maybeSingle(); if(error||!data){await db.auth.signOut();location.replace('/');throw error||new Error('등록되지 않은 계정입니다.');} if(requiredRole&&data.role!==requiredRole){location.replace(data.role==='admin'?'/admin.html':'/staff.html');throw new Error('ROLE_MISMATCH');} return {session,role:data.role}; }
  async function signOut(){ if(db)await db.auth.signOut(); location.replace('/'); }

  window.Signage=Object.freeze({cfg,db,qs,qsa,esc,sleep,formatBytes,formatDuration,basename,titleFromPath,joinMediaUrl,isOnline,toast,getSession,requireAuth,signOut});
})();
