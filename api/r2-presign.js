const { requireAdmin, json, parseBody } = require('./_lib/auth');
const { config, presignPut, makeObjectKey } = require('./_lib/r2');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    await requireAdmin(req);
    const c = config();
    if (!c.ready) return json(res, 503, { error: 'R2_NOT_CONFIGURED' });
    const body = parseBody(req);
    const filename = String(body.filename || '').trim();
    const contentType = String(body.contentType || '');
    const size = Number(body.size || 0);
    if (!filename || !['video/mp4','video/webm'].includes(contentType)) return json(res, 400, { error: 'MP4_OR_WEBM_ONLY' });
    if (!Number.isFinite(size) || size <= 0 || size > 2 * 1024 * 1024 * 1024) return json(res, 400, { error: 'INVALID_FILE_SIZE' });
    const key = makeObjectKey(filename);
    const signed = presignPut(key, 900);
    return json(res, 200, { key, ...signed });
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'R2_PRESIGN_FAILED' });
  }
};
