(function () {
  'use strict';

  // Values live in js/config.js. Only non-secret tuning defaults are kept here.
  const DEFAULT_CONFIG = Object.freeze({
    supabaseUrl: '',
    supabaseAnonKey: '',
    pollMs: 60000,
    heartbeatMs: 60000,
    livePresenceMs: 60000,
    livePollMs: 30000,
    onlineThresholdMs: 180000
  });
  const suppliedConfig = window.CLINIC_SIGNAGE_CONFIG && typeof window.CLINIC_SIGNAGE_CONFIG === 'object'
    ? window.CLINIC_SIGNAGE_CONFIG
    : {};
  const cfg = Object.freeze({
    ...DEFAULT_CONFIG,
    ...suppliedConfig,
    supabaseUrl: String(suppliedConfig.supabaseUrl || '').trim(),
    supabaseAnonKey: String(suppliedConfig.supabaseAnonKey || '').trim()
  });
  window.CLINIC_SIGNAGE_CONFIG = cfg;
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
  const isOnline = (room) => room?.last_seen_at && Date.now() - new Date(room.last_seen_at).getTime() < (cfg.onlineThresholdMs || 180000);

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
  function getPinSession() { return readPinSession(); }

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

  // ---------------------------------------------------------------------------
  // Live status monitor (admin / staff)
  //  - No Realtime subscription for player status: PIN-session RLS cannot be evaluated
  //    by Realtime (no request headers there) and every status write would otherwise be
  //    billed once per listening tab.
  //  - Background: one small 30s delta query while the page is visible (changed rows only).
  //  - Realtime status wake-ups fetch only the changed room; delta polling is loss recovery.
  //  - After a control action: poll only the affected rooms until each player reports
  //    `synced_at >= issuedAt` (the server time of the state it is actually playing).
  // ---------------------------------------------------------------------------
  const isMissingFunction = (error) => {
    const code = String(error?.code || '');
    return code === 'PGRST202' || code === '42883' || /could not find the function/i.test(String(error?.message || ''));
  };
  const ACK_STEPS_MS = [800, 800, 1000, 1500, 2000, 3000, 5000, 6000]; // checks at ~0.8,1.6,2.6,4.1,6.1,9.1,14,20s

  function createLiveMonitor(options = {}) {
    const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
    let offsetMs = 0;
    let rpcSupported = true;
    let lastSince = null;
    let timer = null;
    let busy = false;
    let intervalMs = 0;

    const serverNow = () => Date.now() + offsetMs;
    const normalizeRow = (x) => ({
      room_id: x.room_id,
      last_seen_at: x.last_seen_at || null,
      player_status: x.player_status || null,
      changed_at: x.changed_at || x.updated_at || null
    });

    async function fetchStatus({ roomIds = null, since = null } = {}) {
      if (!db) return { rows: [], seen: [], serverTime: null };
      const ids = Array.isArray(roomIds) && roomIds.length ? [...new Set(roomIds.filter(Boolean))] : null;
      if (rpcSupported) {
        const t0 = Date.now();
        const { data, error } = await db.rpc('signage_live_status', { p_room_ids: ids, p_since: since });
        const t1 = Date.now();
        if (!error && data) {
          const st = new Date(data.server_time).getTime();
          if (Number.isFinite(st)) offsetMs = st - (t0 + t1) / 2;
          return { rows: (data.rows || []).map(normalizeRow), seen: data.seen || [], serverTime: data.server_time || null };
        }
        if (error && !isMissingFunction(error)) throw error;
        rpcSupported = false; // migration v2.24 not applied yet -> legacy table read
      }
      let q = db.from('player_live_status').select('room_id,last_seen_at,player_status,updated_at');
      if (ids) q = q.in('room_id', ids);
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data || []).map(normalizeRow);
      return { rows, seen: rows.map((r) => ({ room_id: r.room_id, last_seen_at: r.last_seen_at })), serverTime: null };
    }

    function emit(result, reason) {
      try { onUpdate(result, reason); } catch (e) { console.error('[Clinic Signage] live update handler failed:', e); }
    }
    function advanceSince(result) {
      if (!result?.serverTime) return;
      const t = new Date(result.serverTime).getTime() - 2000; // overlap guards in-flight commits
      if (Number.isFinite(t)) lastSince = new Date(t).toISOString();
    }

    async function loadAll() {
      const result = await fetchStatus();
      advanceSince(result);
      return result;
    }

    async function poll(reason = 'poll') {
      if (busy || document.hidden || !db) return;
      busy = true;
      try {
        const result = await fetchStatus({ since: rpcSupported ? lastSince : null });
        advanceSince(result);
        emit(result, reason);
      } catch (e) {
        console.warn('[Clinic Signage] live status poll failed:', e?.message || e);
      } finally {
        busy = false;
      }
    }

    const onVisible = () => { if (!document.hidden) void poll('visible'); };
    function start(ms = cfg.livePollMs) {
      stop();
      intervalMs = Number(ms) || 0;
      if (intervalMs <= 0) return;
      timer = setInterval(() => void poll('poll'), Math.max(30000, intervalMs));
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', onVisible);
    }
    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    }

    // Call immediately BEFORE sending the control RPC.
    const markIssue = () => serverNow() - 50;

    function verdict(row, issuedAtMs) {
      const st = row?.player_status || {};
      const synced = st.synced_at ? new Date(st.synced_at).getTime() : 0;
      if (!synced || synced < issuedAtMs) return 'pending';
      const play = String(st.playback_state || '').toLowerCase();
      if (play === 'loading') return 'pending';
      if (play === 'error') return 'error';
      return 'ok';
    }

    async function awaitAck(roomIds, issuedAtMs, { onProgress } = {}) {
      const ids = [...new Set((roomIds || []).filter(Boolean))];
      const result = new Map(ids.map((id) => [id, 'pending']));
      if (!ids.length) return { supported: rpcSupported, result };
      if (!rpcSupported) {
        for (const delay of [400, 1500, 3500]) {
          await sleep(delay);
          try { emit(await fetchStatus({ roomIds: ids }), 'ack'); } catch (_) {}
        }
        return { supported: false, result };
      }
      for (const delay of ACK_STEPS_MS) {
        await sleep(delay);
        const pending = ids.filter((id) => result.get(id) !== 'ok');
        if (!pending.length) break;
        try {
          const res = await fetchStatus({ roomIds: pending });
          emit(res, 'ack');
          res.rows.forEach((row) => result.set(row.room_id, verdict(row, issuedAtMs)));
          onProgress?.(result);
        } catch (_) {}
      }
      return { supported: true, result };
    }

    return Object.freeze({
      serverNow, fetchStatus, loadAll, poll, start, stop, markIssue, awaitAck, verdict,
      get rpcSupported() { return rpcSupported; }
    });
  }

  // Shared health rules for admin + staff room cards (server-clock based).
  const LIVE_DELAY_MS = 150000;
  const LIVE_OFFLINE_MS = Math.max(180000, Number(cfg.onlineThresholdMs) || 0);
  function roomAgeMs(room, now = Date.now()) {
    const ts = room?.last_seen_at ? new Date(room.last_seen_at).getTime() : 0;
    return ts > 0 ? Math.max(0, now - ts) : Infinity;
  }
  function roomHealth(room, now = Date.now()) {
    const st = room?.player_status || {}, age = roomAgeMs(room, now);
    const closed = st.operating_active === false || String(st.mode || '').toLowerCase() === 'closed';
    const offlineMs = closed ? Math.max(LIVE_OFFLINE_MS, 7 * 60 * 1000) : LIVE_OFFLINE_MS;
    if (age > offlineMs) return 'offline';
    if (st.error || String(st.playback_state || '').toLowerCase() === 'error') return 'error';
    if (st.recovery_stage) return 'recovering';
    if (age > LIVE_DELAY_MS) return 'delayed';
    return 'normal';
  }
  // Progress estimate from the server-stamped report time.
  function estimatedCurrentTime(room, now = Date.now()) {
    const st = room?.player_status || {};
    let current = Math.max(0, Number(st.current_time) || 0);
    const duration = Math.max(0, Number(st.duration) || 0);
    const playing = String(st.playback_state || '').toLowerCase() === 'playing' && !room?.paused;
    const base = st.reported_at ? new Date(st.reported_at).getTime() : 0;
    if (playing && base > 0) current += Math.max(0, now - base) / 1000;
    if (duration > 0) current = Math.min(duration, current);
    return current;
  }
  async function fetchPlayerRelease() {
    try {
      const r = await fetch(`/player-release.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return null;
      const data = await r.json();
      return String(data?.version || '').trim() || null;
    } catch (_) { return null; }
  }

  window.Signage=Object.freeze({cfg,db,configReady,configError,qs,qsa,esc,sleep,formatBytes,formatDuration,basename,titleFromPath,joinMediaUrl,isOnline,toast,getClientId,isMissingFunction,createLiveMonitor,roomAgeMs,roomHealth,estimatedCurrentTime,fetchPlayerRelease,LIVE_DELAY_MS,LIVE_OFFLINE_MS,storePinSession,clearPinSession,getPinSession,getSession,requireAuth,signOut});
})();
