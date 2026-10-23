'use strict';
const { requireAdmin, json, parseBody } = require('./_lib/auth');
const { config, presignPut, makeFloorplanObjectKey, floorplanExtension } = require('./_lib/r2');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    await requireAdmin(req);
    const c = config();
    if (!c.ready) return json(res, 503, { error: 'R2_NOT_CONFIGURED' });
    const body = parseBody(req);
    const floor = Math.trunc(Number(body.floor));
    const filename = String(body.filename || '').trim();
    const contentType = String(body.contentType || '').toLowerCase();
    const size = Number(body.size || 0);
    const ext = floorplanExtension(filename, contentType);
    if (!Number.isInteger(floor) || floor < 1 || floor > 14) return json(res, 400, { error: 'INVALID_FLOOR' });
    if (!ext || !['image/png','image/jpeg','image/webp'].includes(contentType)) return json(res, 400, { error: 'IMAGE_ONLY' });
    if (!Number.isFinite(size) || size <= 0 || size > 12 * 1024 * 1024) return json(res, 400, { error: 'INVALID_FILE_SIZE' });
    const key = makeFloorplanObjectKey(floor, filename, contentType);
    const signed = presignPut(key, 900);
    return json(res, 200, { key, uploadUrl: signed.uploadUrl, contentType, size });
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'FLOORPLAN_PRESIGN_FAILED' });
  }
};
