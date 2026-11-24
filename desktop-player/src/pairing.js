'use strict';
(async () => {
  const $ = (id) => document.getElementById(id);
  const api = window.signageApp;
  const info = await api.pairInfo();
  $('hint').textContent = info.hint;
  $('ver').textContent = `v${info.version}`;
  $('manual').addEventListener('click', () => api.openSetup());

  let code = null, expiresAt = 0, pollTimer = null, tickTimer = null, failures = 0;
  const fmt = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;
  const setStatus = (t, warn = false) => { $('status').textContent = t; $('status').classList.toggle('warn', warn); };

  async function requestCode() {
    clearTimeout(pollTimer);
    const r = await api.pairRequest();
    if (!r?.ok) {
      code = null;
      $('code').textContent = '--- ---'; $('code').classList.add('dim');
      const msg = r?.error === 'server_not_ready' ? '서버 업데이트가 필요합니다 (관리자에게 문의)'
        : r?.error === 'rate_limited' ? '요청이 많습니다. 잠시 후 다시 시도합니다'
        : '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요';
      setStatus(`${msg} · 15초 후 다시 시도`, true);
      pollTimer = setTimeout(requestCode, 15000);
      return;
    }
    code = String(r.code);
    expiresAt = Date.now() + Math.max(30, Number(r.ttl_sec) || 600) * 1000;
    $('code').textContent = fmt(code); $('code').classList.remove('dim');
    failures = 0;
    tick();
    pollTimer = setTimeout(poll, 3000);
  }

  async function poll() {
    if (!code) return;
    const r = await api.pairPoll(code);
    if (r?.status === 'paired') {
      clearInterval(tickTimer);
      $('waiting').hidden = true;
      $('done').hidden = false;
      $('doneName').textContent = [r.site_name, r.room_name].filter(Boolean).join(' · ');
      return;
    }
    if (r?.status === 'expired') { setStatus('새 코드를 받는 중…'); return requestCode(); }
    if (r?.status === 'network') {
      failures += 1;
      if (failures >= 3) setStatus('서버 연결이 불안정합니다. 계속 확인 중…', true);
    } else { failures = 0; }
    pollTimer = setTimeout(poll, 3000);
  }

  function tick() {
    clearInterval(tickTimer);
    const render = () => {
      if (!code) return;
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      if (left <= 0) { setStatus('새 코드를 받는 중…'); requestCode(); return; }
      if (failures < 3) setStatus(`이 코드는 ${Math.floor(left / 60)}분 ${String(left % 60).padStart(2, '0')}초 동안 유효합니다 · 만료되면 새 코드가 자동으로 나옵니다`);
    };
    render();
    tickTimer = setInterval(render, 1000);
  }

  requestCode();
})();
