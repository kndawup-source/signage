'use strict';
const { requireMember, resolveSite, json } = require('./_lib/auth');
const { signedFetch } = require('./_lib/r2');

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
    const upstream = await signedFetch('GET', key);
    if (!upstream.ok) return json(res, upstream.status, { error: 'FLOORPLAN_FETCH_FAILED' });
    const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
    if (!/^image\/(png|jpeg|webp)$/i.test(contentType)) return json(res, 502, { error: 'INVALID_FLOORPLAN_IMAGE_TYPE' });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'private, max-age=120, stale-while-revalidate=120');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
  } catch (e) { return json(res, e.statusCode || 500, { error: e.message || 'FLOORPLAN_FAILED' }); }
};
