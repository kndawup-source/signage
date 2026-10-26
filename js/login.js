(async function () {
  'use strict';
  const { db, qs, configError } = Signage;
  const safeNext=(value)=>{if(!value||!value.startsWith('/')||value.startsWith('//'))return null;try{const u=new URL(value,location.origin);return u.origin===location.origin?u.pathname+u.search+u.hash:null;}catch{return null;}};
  const err = qs('#loginError');
  const form = qs('#loginForm');
  const pinInput = qs('#pin');
  const btn = form.querySelector('button');

  if(!db){err.textContent=configError || 'Supabase 설정을 확인하세요.';err.classList.remove('hidden');btn.disabled=true;console.error('[Clinic Signage] config', {supabaseUrl: Signage.cfg?.supabaseUrl || '', hasAnonKey: !!Signage.cfg?.supabaseAnonKey, version: '2.5.8'});return;}

  const existing = await Signage.getSession().catch(() => null);
  if (existing?.role) {
    location.replace(existing.role === 'admin' ? '/admin.html' : '/hospital.html');
    return;
  }

  pinInput.addEventListener('input', () => {
    pinInput.value = pinInput.value.replace(/\D/g,'').slice(0,6);
    err.classList.add('hidden');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    const pin = pinInput.value.replace(/\D/g,'');
    if (pin.length < 4 || pin.length > 6) {
      err.textContent = 'PIN은 숫자 4~6자리로 입력하세요.';
      err.classList.remove('hidden');
      return;
    }
    btn.disabled = true;
    pinInput.disabled = true;
    try {
      const { data, error } = await db.rpc('pin_login', { p_pin: pin, p_client_id: Signage.getClientId() });
      if (error) throw error;
      if (!data?.ok) {
        if (data?.error === 'locked') {
          const sec = Math.max(1, Number(data.retry_after_sec || 0));
          err.textContent = `로그인이 잠겼습니다. 약 ${Math.ceil(sec/60)}분 후 다시 시도하세요.`;
        } else {
          err.textContent = 'PIN 번호를 확인하세요.';
        }
        err.classList.remove('hidden');
        pinInput.value = '';
        pinInput.focus();
        return;
      }
      Signage.storePinSession(data);
      const next = safeNext(new URLSearchParams(location.search).get('next'));
      const defaultPage = data.role === 'admin' ? '/admin.html' : '/hospital.html';
      location.replace(next || defaultPage);
    } catch (e2) {
      err.textContent = '로그인할 수 없습니다. 네트워크와 설정을 확인하세요.';
      err.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      pinInput.disabled = false;
    }
  });
})();
