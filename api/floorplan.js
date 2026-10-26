'use strict';
const { requireMember, resolveSite, json } = require('./_lib/auth');
const { presignGet } = require('./_lib/r2');
const { isRegisteredCurrentFloorplan } = require('./_lib/floorplan-auth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const session = await requireMember(req);
    const siteId = resolveSite(session, req.query?.siteId);
    const floor = Math.trunc(Number(req.query?.floor));
    if (!Number.isInteger(floor) || floor < 1 || floor > 99) return json(res, 400, { error: 'INVALID_FLOOR' });
    const key = String(req.query?.key || '').trim();
    if (!key) return json(res, 404, { error: 'FLOORPLAN_NOT_FOUND' });

    // Do not infer ownership from an R2 path convention. Older production uploads used
    // different key layouts. The authoritative check is the current floorplan pointer
    // stored for this exact site + floor in site_settings.floorplan_assets.
    if (!(await isRegisteredCurrentFloorplan(req, siteId, floor, key))) {
      return json(res, 403, { error: 'FLOORPLAN_NOT_REGISTERED' });
    }

    const url = presignGet(key, 300);
    const ext = key.toLowerCase().split('.').pop();
    const contentType = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/webp';
    return json(res, 200, { url, contentType, expiresIn: 300 });
  } catch (e) { return json(res, e.statusCode || 500, { error: e.message || 'FLOORPLAN_FAILED' }); }
};
