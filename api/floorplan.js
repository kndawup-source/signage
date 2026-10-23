'use strict';
const { requireMember, json } = require('./_lib/auth');
const { getFloorplan } = require('./_lib/floorplans');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    await requireMember(req);
    const floor = Math.trunc(Number(req.query?.floor));
    if (!Number.isInteger(floor) || floor < 1 || floor > 14) return json(res, 400, { error: 'INVALID_FLOOR' });
    const image = getFloorplan(floor);
    if (!image) return json(res, 404, { error: 'FLOORPLAN_NOT_FOUND' });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(image);
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'FLOORPLAN_FAILED' });
  }
};
