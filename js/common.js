(function () {
  'use strict';

  const cfg = window.CLINIC_SIGNAGE_CONFIG || {};
  const PIN_SESSION_KEY = 'clinic_signage_pin_session_v1';
  const CLIENT_ID_KEY = 'clinic_signage_pin_client_v1';

  function readPinSession() {
    try {
      const raw = localStorage.getItem(PIN_SESSION_KEY);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!value?.token || !value?.role || !value?.expires_at) return null;
      if (Date.now() >= new Date(value.expires_at).getTime()) {
        localStorage.removeItem(PIN_SESSION_KEY);
        return null;
      }
      return value;
    } catch {
      localStorage.removeItem(PIN_SESSION_KEY);
      return null;
    }
  }

  const cachedPinSession = readPinSession();
  const normalizedSupabaseUrl = String(cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
  const isValidSupabaseUrl = (() => {
    try {
      const u = new URL(normalizedSupabaseUrl);
      return u.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/i.test(u.hostname) && (u.pathname === '/' || u.pathname === '');
    } catch {
      return false;
    }
  })();
  const hasSupabaseKey = !!String(cfg.supabaseAnonKey || '').trim()
    && !/YOUR_SUPABASE|PASTE_SUPABASE|YOUR_PROJECT/i.test(String(cfg.supabaseAnonKey || ''));
  const configReady = isValidSupabaseUrl && hasSupabaseKey;
  let db = null;
  let configError = '';

  if (!window.supabase?.createClient) {
    configError = 'Supabase 라이브러리를 불러오지 못했습니다.';
  } else if (!isValidSupabaseUrl) {
    configError = 'js/config.js의 Supabase URL을 확인하세요.';
  } else if (!hasSupabaseKey) {
    configError = 'js/config.js에 Supabase anon/public key를 입력하세요.';
  } else {
    try {
      db = window.supabase.createClient(normalizedSupabaseUrl, String(cfg.supabaseAnonKey || '').trim(), {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: cachedPinSession?.token ? { 'x-signage-session': cachedPinSession.token } : {} },
        realtime: { params: { eventsPerSecond: 10 } }
      });
    } catch (error) {
      console.error('[Clinic Signage] Supabase client init failed:', error);
      configError = 'Supabase 설정값이 올바르지 않습니다.';
    }
  }

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

  function getClientId() {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  }

  function storePinSession(session) {
    if (!session?.token || !session?.role || !session?.expires_at) throw new Error('INVALID_PIN_SESSION');
    localStorage.setItem(PIN_SESSION_KEY, JSON.stringify({ token: session.token, role: session.role, expires_at: session.expires_at }));
  }

  function clearPinSession() { localStorage.removeItem(PIN_SESSION_KEY); }

  async function getSession() {
    if (!db || !readPinSession()) return null;
    const { data, error } = await db.rpc('pin_session_info');
    if (error || !data?.valid) {
      clearPinSession();
      return null;
    }
    return { role: data.role, expires_at: data.expires_at };
  }

  async function requireAuth(requiredRole) {
    const session = await getSession();
    if (!session) {
      const next=encodeURIComponent(location.pathname+location.search);
      location.replace(`/?next=${next}`);
      throw new Error('AUTH_REQUIRED');
    }
    if (requiredRole && session.role !== requiredRole) {
      location.replace(session.role === 'admin' ? '/admin.html' : '/staff.html');
      throw new Error('ROLE_MISMATCH');
    }
    if (!window.__SIGNAGE_PIN_SESSION_WATCH__) {
      window.__SIGNAGE_PIN_SESSION_WATCH__ = setInterval(async () => {
        const live = await getSession().catch(() => null);
        if (!live) location.replace('/');
      }, 60000);
    }
    return { session, role: session.role };
  }

  async function signOut() {
    try { if (db && readPinSession()) await db.rpc('pin_logout'); } catch {}
    clearPinSession();
    location.replace('/');
  }

  window.Signage=Object.freeze({cfg,db,configReady,configError,qs,qsa,esc,sleep,formatBytes,formatDuration,basename,titleFromPath,joinMediaUrl,isOnline,toast,getClientId,storePinSession,clearPinSession,getSession,requireAuth,signOut});
})();
