(() => {
  'use strict';
  const current = document.currentScript;
  const entry = String(current?.dataset?.entry || '').trim();
  const appVersion = String(current?.dataset?.version || '2.34.5').trim();
  const playerVersion = String(current?.dataset?.playerVersion || appVersion).trim();
  const supabaseVersion = '2.118.0';
  const supabaseSrc = location.protocol === 'http:'
    ? '/vendor/supabase.js'
    : `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${supabaseVersion}/dist/umd/supabase.js`;

  const loadScript = (src, attrs = {}) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    Object.entries(attrs).forEach(([k, v]) => script.setAttribute(k, v));
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`SCRIPT_LOAD_FAILED:${src}`));
    document.head.appendChild(script);
  });

  window.__CLINIC_SIGNAGE_BOOT__ = (async () => {
    try {
      if (!window.supabase?.createClient) {
        await loadScript(supabaseSrc, location.protocol === 'http:' ? {} : { crossorigin: 'anonymous' });
      }
      const version = entry === 'player' ? playerVersion : appVersion;
      if (!window.CLINIC_SIGNAGE_CONFIG) await loadScript(`/js/config.js?v=${version}`);
      await loadScript(`/js/version.js?v=${playerVersion}`);
      await loadScript(`/js/common.js?v=${version}`);
      if (entry) await loadScript(`/js/${entry}.js?v=${version}`);
    } catch (error) {
      console.error('[Clinic Signage] boot failed', error);
      const root = document.querySelector('#adminRoot,#hospitalRoot,#playerRoot,.auth-panel');
      if (root) root.innerHTML = '<div class="loading error">필수 모듈을 불러오지 못했습니다. 네트워크를 확인한 뒤 새로고침하세요.</div>';
    }
  })();
})();
