'use strict';
// 연결 코드 화면.
// - 요청은 한 번에 하나만 (busy), 오래된 응답은 무시 (gen), 타이머는 항상 하나만.
// - 서버가 알려준 재시도 시간을 따른다.
(async () => {
  const $ = (id) => document.getElementById(id);
  const api = window.signageApp;
  const info = await api.pairInfo();
  $('hint').textContent = info.hint;
  $('ver').textContent = `v${info.version}`;
  $('manual').addEventListener('click', () => api.openSetup());

  const POLL_MS = 3000;
  let code = null, expiresAt = 0, gen = 0, busy = false, failures = 0, done = false;
  let nextTimer = null, tickTimer = null;

  const fmt = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;
  const setStatus = (t, warn = false) => { $('status').textContent = t; $('status').classList.toggle('warn', warn); };
  const showCode = (c) => { $('code').textContent = c ? fmt(c) : '--- ---'; $('code').classList.toggle('dim', !c); };
  function stopTimers() { clearTimeout(nextTimer); nextTimer = null; clearInterval(tickTimer); tickTimer = null; }
  function schedule(fn, ms) { clearTimeout(nextTimer); nextTimer = setTimeout(fn, ms); }

  async function requestCode() {
    if (done) return;
    if (busy) { schedule(requestCode, 500); return; } // 진행 중인 요청이 끝난 뒤 한 번만
    busy = true;
    stopTimers();
    const my = ++gen;
    let r;
    try { r = await api.pairRequest(); } catch (_) { r = { ok: false, error: 'network' }; }
    busy = false;
    if (my !== gen || done) return; // 늦게 도착한 이전 응답은 버린다
    if (!r?.ok) {
      code = null; showCode(null);
      const wait = Math.max(5, Math.min(600, Number(r?.retry_after_sec) || 15));
      const msg = r?.error === 'server_not_ready' ? '서버 업데이트가 필요합니다 (관리자에게 문의)'
        : r?.error === 'rate_limited' ? '요청이 많습니다. 잠시 후 다시 시도합니다'
        : '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요';
      setStatus(`${msg} · ${wait}초 후 다시 시도`, true);
      schedule(requestCode, wait * 1000);
      return;
    }
    code = String(r.code);
    expiresAt = Date.now() + Math.max(30, Number(r.ttl_sec) || 600) * 1000;
    failures = 0;
    showCode(code);
    startTick();
    // 이미 승인된 코드(재시작 등)면 바로 확인
    schedule(poll, r.status === 'approved' || r.status === 'delivered' ? 200 : POLL_MS);
  }

  async function poll() {
    if (busy || done || !code) return;
    busy = true;
    const my = gen, myCode = code;
    let r;
    try { r = await api.pairPoll(myCode); } catch (_) { r = { ok: false, status: 'network' }; }
    busy = false;
    if (my !== gen || done) return;
    if (r?.status === 'paired') {
      done = true; stopTimers();
      $('waiting').hidden = true; $('done').hidden = false;
      $('doneName').textContent = [r.site_name, r.room_name].filter(Boolean).join(' · ');
      return;
    }
    if (r?.status === 'expired' || r?.status === 'confirmed') { setStatus('새 코드를 받는 중…'); requestCode(); return; }
    if (r?.status === 'network') {
      failures += 1;
      if (failures >= 3) setStatus('서버 연결이 불안정합니다. 계속 확인 중…', true);
    } else {
      failures = 0;
      if (Number.isFinite(Number(r?.ttl_sec))) expiresAt = Date.now() + Number(r.ttl_sec) * 1000; // 서버 시간 기준으로 보정
    }
    schedule(poll, POLL_MS);
  }

  function startTick() {
    clearInterval(tickTimer);
    const render = () => {
      if (!code || done) return;
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      if (left <= 0) {
        // 만료: 타이머를 먼저 멈추고 한 번만 새 코드를 요청한다
        clearInterval(tickTimer); tickTimer = null;
        setStatus('새 코드를 받는 중…');
        requestCode();
        return;
      }
      if (failures < 3) setStatus(`이 코드는 ${Math.floor(left / 60)}분 ${String(left % 60).padStart(2, '0')}초 동안 유효합니다 · 만료되면 새 코드가 자동으로 나옵니다`);
    };
    render();
    tickTimer = setInterval(render, 1000);
  }

  requestCode();
})();
