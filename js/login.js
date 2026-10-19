(async function () {
  'use strict';
  const { db, qs } = Signage;
  const safeNext=(value)=>{if(!value||!value.startsWith('/')||value.startsWith('//'))return null;try{const u=new URL(value,location.origin);return u.origin===location.origin?u.pathname+u.search+u.hash:null;}catch{return null;}};
  if(!db){const err=qs('#loginError');err.textContent='Supabase 설정 또는 로컬 라이브러리를 확인하세요.';err.classList.remove('hidden');qs('#loginForm button').disabled=true;return;}
  const existing = await Signage.getSession().catch(() => null);
  if (existing) {
    const { data } = await db.from('members').select('role').eq('user_id', existing.user.id).maybeSingle();
    if (data?.role) location.replace(data.role === 'admin' ? '/admin.html' : '/staff.html');
  }
  qs('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = qs('#loginError');
    err.classList.add('hidden');
    const btn = e.currentTarget.querySelector('button');
    btn.disabled = true;
    const { data, error } = await db.auth.signInWithPassword({ email: qs('#email').value.trim(), password: qs('#password').value });
    if (error) {
      err.textContent = '로그인 정보를 확인하세요.'; err.classList.remove('hidden'); btn.disabled = false; return;
    }
    const { data: member } = await db.from('members').select('role').eq('user_id', data.user.id).maybeSingle();
    if (!member) {
      await db.auth.signOut(); err.textContent = '등록되지 않은 계정입니다.'; err.classList.remove('hidden'); btn.disabled = false; return;
    }
    const next = safeNext(new URLSearchParams(location.search).get('next'));
    location.replace(next || (member.role === 'admin' ? '/admin.html' : '/staff.html'));
  });
})();
