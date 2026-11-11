const { requireMember, getSite, json, parseBody } = require('./_lib/auth');
const { config, presignPut, makeObjectKey } = require('./_lib/r2');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const member = await requireMember(req);
    const siteId = String(parseBody(req).siteId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(siteId)) return json(res, 400, { error: 'SITE_REQUIRED' });
    if (member.role !== 'admin' && (!member.site_id || String(member.site_id) !== siteId)) return json(res, 403, { error: 'SITE_FORBIDDEN' });
    if (!await getSite(req, siteId)) return json(res, 403, { error: 'SITE_NOT_ACCESSIBLE' });
    const c = config();
    if (!c.ready) return json(res, 503, { error: 'R2_NOT_CONFIGURED' });
    const body = parseBody(req);
    const filename = String(body.filename || '').trim();
    const contentType = String(body.contentType || '');
    const size = Number(body.size || 0);
    if (!filename || contentType !== 'video/mp4' || !filename.toLowerCase().endsWith('.mp4')) return json(res, 400, { error: 'MP4_ONLY' });
    const maxSize = member.role === 'admin' ? 2 * 1024 * 1024 * 1024 : 350 * 1024 * 1024;
    if (!Number.isFinite(size) || size <= 0 || size > maxSize) return json(res, 400, { error: 'INVALID_FILE_SIZE' });
    const key = `sites/${siteId}/${makeObjectKey(filename)}`;
    const signed = presignPut(key, 900, contentType);
    return json(res, 200, { key, ...signed });
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'R2_PRESIGN_FAILED' });
  }
};
