'use strict';
const { requireAdmin, json, parseBody } = require('./_lib/auth');
const { signedFetch } = require('./_lib/r2');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    await requireAdmin(req);
    const key = String(parseBody(req).key || '');
    if (!/^floorplans\/[0-9]{2}\/[A-Za-z0-9._-]+\.(?:png|jpg|webp)$/i.test(key) || key.includes('..')) return json(res, 400, { error: 'INVALID_OBJECT_KEY' });
    const response = await signedFetch('DELETE', key);
    if (!response.ok && response.status !== 404) return json(res, 502, { error: `R2_DELETE_${response.status}` });
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'FLOORPLAN_DELETE_FAILED' });
  }
};
