'use strict';
const { requireMember, resolveSite, json } = require('./_lib/auth');
const { getFloorplan, buildFloorplanSvg } = require('./_lib/floorplans');
const { signedFetch } = require('./_lib/r2');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const session = await requireMember(req);
    const siteId = resolveSite(session, req.query?.siteId);
    const floor = Math.trunc(Number(req.query?.floor));
    if (!Number.isInteger(floor) || floor < 1 || floor > 14) return json(res, 400, { error: 'INVALID_FLOOR' });
    const key = String(req.query?.key || '').trim();
    let image = null;
    if (key) {
      const modern = new RegExp(`^floorplans/${siteId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/[0-9]{2}/[A-Za-z0-9._-]+\\.(?:png|jpg|webp)$`,'i');
      const legacy = /^floorplans\/[0-9]{2}\/[A-Za-z0-9._-]+\.(?:png|jpg|webp)$/i;
      if (key.includes('..') || (!modern.test(key) && !(session.role==='admin' && legacy.test(key)))) return json(res, 400, { error: 'INVALID_OBJECT_KEY' });
      const response = await signedFetch('GET', key);
      if (!response.ok) return json(res, response.status === 404 ? 404 : 502, { error: response.status === 404 ? 'FLOORPLAN_NOT_FOUND' : `R2_FLOORPLAN_${response.status}` });
      const mime = String(response.headers.get('content-type') || 'image/png').split(';')[0].trim();
      if (!['image/png','image/jpeg','image/webp'].includes(mime)) return json(res, 415, { error: 'INVALID_FLOORPLAN_TYPE' });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 12 * 1024 * 1024) return json(res, 413, { error: 'FLOORPLAN_TOO_LARGE' });
      image = buildFloorplanSvg(floor, bytes, mime, floor);
    } else {
      image = getFloorplan(floor);
    }
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
