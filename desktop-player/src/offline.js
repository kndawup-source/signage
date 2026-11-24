'use strict';
(() => {
  const q = new URLSearchParams(location.search);
  let left = Math.max(1, Number(q.get('retry')) || 15);
  document.getElementById('reason').textContent = q.get('reason') || '';
  const sec = document.getElementById('sec');
  sec.textContent = String(left);
  setInterval(() => { left = Math.max(0, left - 1); sec.textContent = String(left); }, 1000);
})();
