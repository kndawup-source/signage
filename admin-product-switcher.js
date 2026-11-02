(() => {
  'use strict';

  const IMPLEMENTED_PRODUCTS = new Set(['profile', 'survey', 'camera']);

  function apply(products = {}) {
    const access = { profile: true, survey: false, camera: false, ...products };
    document.querySelectorAll('[data-oogo-product]').forEach((item) => {
      const key = String(item.dataset.oogoProduct || '').trim().toLowerCase();
      item.hidden = !IMPLEMENTED_PRODUCTS.has(key) || !access[key];
    });
  }

  function currentClinicSlug() {
    const parts = String(window.location.pathname || '')
      .split('/')
      .filter(Boolean);
    return String(parts[0] || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '');
  }

  function bindSignageLinks() {
    const slug = currentClinicSlug();
    const destination = slug
      ? `https://signage-lake.vercel.app/hospital.html?site=${encodeURIComponent(slug)}`
      : 'https://signage-lake.vercel.app/';

    document.querySelectorAll('[data-oogo-signage]').forEach((item) => {
      item.href = destination;
    });
  }

  bindSignageLinks();

  window.OogoProductSwitcher = Object.freeze({ apply, bindSignageLinks });
})();
