'use strict';
const fs = require('fs');
const path = require('path');
const cache = new Map();

// Built-in fallback plans. Custom admin uploads override these per floor.
const FLOORPLAN_SOURCE = Object.freeze({
  1:1, 2:2, 3:3, 4:4, 6:6, 7:3, 8:3, 9:3, 10:3, 11:11, 12:12, 13:13, 14:14
});
const escAttr = (v) => String(v ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function zonesForFloor(floor) {
  const zoneKey = String(Math.trunc(Number(floor))).padStart(2, '0');
  const zoneFile = path.join(__dirname, '..', '..', 'floorzones', `${zoneKey}.json`);
  try { return fs.existsSync(zoneFile) ? JSON.parse(fs.readFileSync(zoneFile,'utf8')) : []; }
  catch (_) { return []; }
}
function buildFloorplanSvg(floor, imageBuffer, mime='image/png', sourceFloor=floor) {
  const n = Math.trunc(Number(floor));
  if (!imageBuffer?.length) return null;
  const zones = zonesForFloor(n);
  const hitAreas = zones.map(z => `<g class="floor-zone zone-${escAttr(z.type||'common')}" tabindex="0" role="button" data-zone-key="${escAttr(z.key)}" data-zone-label="${escAttr(z.label)}" data-zone-type="${escAttr(z.type)}" data-zone-bounds="${escAttr(z.bounds)}" aria-label="${escAttr(z.label)}"><path class="floor-zone-hit" vector-effect="non-scaling-stroke" d="${escAttr(z.path)}"/></g>`).join('');
  const base64 = imageBuffer.toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 632" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${n}층 평면도" data-floor="${n}" data-source-floor="${sourceFloor}"><style>.bg{fill:#fff}.source-plan{opacity:.94}.floor-zone{cursor:pointer;outline:none}.floor-zone-hit{fill:#232176;fill-opacity:0;stroke:transparent;stroke-width:1.5;transition:fill-opacity .14s ease,stroke .14s ease}.floor-zone:hover .floor-zone-hit,.floor-zone:focus .floor-zone-hit{fill-opacity:.045;stroke:#232176}.floor-zone.is-selected .floor-zone-hit{fill-opacity:.11;stroke:#232176;stroke-width:2}</style><rect class="bg" width="1440" height="632"/><image class="source-plan" href="data:${escAttr(mime)};base64,${base64}" x="0" y="0" width="1440" height="632" preserveAspectRatio="xMidYMid meet"/>${hitAreas}</svg>`;
  return Buffer.from(svg,'utf8');
}
function getFloorplan(floor) {
  const n = Math.trunc(Number(floor));
  if (!Number.isInteger(n) || n < 1 || n > 14) return null;
  if (cache.has(n)) return cache.get(n);
  const sourceFloor = FLOORPLAN_SOURCE[n];
  if (!sourceFloor) return null;
  const sourceKey = String(sourceFloor).padStart(2, '0');
  const imageFile = path.join(__dirname, '..', '..', 'floorplans_source', `${sourceKey}.png`);
  if (!fs.existsSync(imageFile)) return null;
  try {
    const data = buildFloorplanSvg(n, fs.readFileSync(imageFile), 'image/png', sourceFloor);
    cache.set(n, data);
    return data;
  } catch (_) { return null; }
}
module.exports = { getFloorplan, buildFloorplanSvg, FLOORPLAN_SOURCE };
