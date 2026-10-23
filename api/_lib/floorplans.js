'use strict';
// v2.31.8 canonical interactive vector floorplans. Each floor is a real SVG line drawing, not a raster image.
const fs = require('fs');
const path = require('path');
const cache = new Map();

function getFloorplan(floor) {
  const n = Math.trunc(Number(floor));
  if (!Number.isInteger(n) || n < 1 || n > 14) return null;
  if (cache.has(n)) return cache.get(n);
  const file = path.join(__dirname, '..', '..', 'floorplans_svg', `${String(n).padStart(2, '0')}.svg`);
  try {
    const data = fs.readFileSync(file);
    cache.set(n, data);
    return data;
  } catch (_) {
    return null;
  }
}

module.exports = { getFloorplan };
