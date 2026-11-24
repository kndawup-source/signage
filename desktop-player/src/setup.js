'use strict';
(async () => {
  const $ = (id) => document.getElementById(id);
  const api = window.signageApp;
  const cfg = await api.getConfig();
  $('ver').textContent = `v${cfg.version}`;
  $('playerUrl').value = cfg.playerUrl || '';
  $('baseUrl').value = cfg.defaultBaseUrl;
  $('autoStart').checked = cfg.autoStart !== false;
  $('logPath').textContent = `로그: ${cfg.logPath}`;
  if (cfg.platform === 'darwin') ['k1', 'k2', 'k3'].forEach((id) => { $(id).textContent = $(id).textContent.replace('Ctrl', 'Cmd'); });

  for (const d of cfg.displays) $('displayIndex').add(new Option(d.label, String(d.index), false, d.index === Number(cfg.displayIndex || 0)));
  $('dailyReloadHour').add(new Option('사용 안 함', ''));
  for (let h = 0; h < 24; h++) $('dailyReloadHour').add(new Option(`${String(h).padStart(2, '0')}:00 ~ ${String(h).padStart(2, '0')}:30 사이`, String(h)));
  $('dailyReloadHour').value = cfg.dailyReloadHour === null || cfg.dailyReloadHour === undefined ? '' : String(cfg.dailyReloadHour);
  $('cancel').hidden = !cfg.playerUrl;
  $('playerUrl').focus();

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('error').textContent = '';
    $('save').disabled = true;
    try {
      await api.save({
        playerUrl: $('playerUrl').value,
        baseUrl: $('baseUrl').value,
        autoStart: $('autoStart').checked,
        dailyReloadHour: $('dailyReloadHour').value,
        displayIndex: $('displayIndex').value
      });
    } catch (err) {
      $('error').textContent = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      $('save').disabled = false;
    }
  });
  $('cancel').addEventListener('click', () => api.cancel());
  $('quit').addEventListener('click', () => api.quit());
})();
