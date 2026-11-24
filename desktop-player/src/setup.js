'use strict';
(async () => {
  const $ = (id) => document.getElementById(id);
  const api = window.signageApp;
  const cfg = await api.getConfig();
  $('current').textContent = `v${cfg.version} · ${cfg.playerUrl ? '현재 연결된 디스플레이가 있습니다' : '아직 연결된 디스플레이가 없습니다'}`;
  $('playerUrl').value = cfg.playerUrl || '';
  $('baseUrl').value = cfg.baseUrl || cfg.defaultBaseUrl;
  $('autoStart').checked = cfg.autoStart !== false;
  $('hint').textContent = `송출 중 단축키 — ${cfg.hint} (작업표시줄 아이콘 메뉴에서도 가능)`;
  $('logPath').textContent = `로그: ${cfg.logPath}`;

  for (const d of cfg.displays) $('displayIndex').add(new Option(d.label, String(d.index), false, d.index === Number(cfg.displayIndex || 0)));
  $('dailyReloadHour').add(new Option('사용 안 함', ''));
  for (let h = 0; h < 24; h++) $('dailyReloadHour').add(new Option(`${String(h).padStart(2, '0')}:00 ~ ${String(h).padStart(2, '0')}:30 사이`, String(h)));
  $('dailyReloadHour').value = cfg.dailyReloadHour === null || cfg.dailyReloadHour === undefined ? '' : String(cfg.dailyReloadHour);

  const common = () => ({
    baseUrl: $('baseUrl').value,
    autoStart: $('autoStart').checked,
    dailyReloadHour: $('dailyReloadHour').value,
    displayIndex: $('displayIndex').value
  });
  const showError = (err) => { $('error').textContent = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); };

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('error').textContent = '';
    if (!$('playerUrl').value.trim()) { showError('주소를 입력하거나, 위의 "연결 코드 화면으로"를 누르세요.'); return; }
    $('save').disabled = true;
    try { await api.save({ ...common(), playerUrl: $('playerUrl').value }); }
    catch (err) { showError(err); $('save').disabled = false; }
  });
  $('pair').addEventListener('click', async () => {
    $('error').textContent = '';
    try { await api.pairWithCode(common()); } catch (err) { showError(err); }
  });
  $('cancel').addEventListener('click', () => api.cancel());
  $('quit').addEventListener('click', () => api.quit());
})();
