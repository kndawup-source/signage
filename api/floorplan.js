'use strict';
const { requireMember, resolveSite, json } = require('./_lib/auth');
const { presignGet } = require('./_lib/r2');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const session = await requireMember(req);
    const siteId = resolveSite(session, req.query?.siteId);
    const floor = Math.trunc(Number(req.query?.floor));
    if (!Number.isInteger(floor) || floor < 1 || floor > 99) return json(res, 400, { error: 'INVALID_FLOOR' });
    const key = String(req.query?.key || '').trim();
    let image = null;
    if (!key) return json(res, 404, { error: 'FLOORPLAN_NOT_FOUND' });
    const safeSite=siteId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const modern = new RegExp(`^floorplans/${safeSite}/[0-9]{2}/[A-Za-z0-9._-]+\\.(?:png|jpg|webp)$`,'i');
    const legacy = /^floorplans\/[0-9]{2}\/[A-Za-z0-9._-]+\.(?:png|jpg|webp)$/i;
    if (key.includes('..') || (!modern.test(key) && !(session.role==='admin' && legacy.test(key)))) return json(res, 400, { error: 'INVALID_OBJECT_KEY' });
    const url = presignGet(key, 300);
    const ext = key.toLowerCase().split('.').pop();
    const contentType = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/webp';
    return json(res, 200, { url, contentType, expiresIn: 300 });
  } catch (e) { return json(res, e.statusCode || 500, { error: e.message || 'FLOORPLAN_FAILED' }); }
};
