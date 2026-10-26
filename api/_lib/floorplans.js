'use strict';

const escAttr = (v) => String(v ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function buildFloorplanSvgUrl(floor, imageUrl) {
  const n = Math.trunc(Number(floor));
  if (!Number.isInteger(n) || n < 1 || n > 99 || !imageUrl) return null;
  const safe = escAttr(imageUrl);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 632" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${n}층 평면도" data-floor="${n}"><rect fill="#fff" width="1440" height="632"/><image href="${safe}" x="0" y="0" width="1440" height="632" preserveAspectRatio="xMidYMid meet"/></svg>`,'utf8');
}

module.exports = { buildFloorplanSvgUrl };
