const { requireAdmin, json } = require('./_lib/auth');
const { config, signedFetch } = require('./_lib/r2');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    await requireAdmin(req);
    const c = config();
    if (!c.ready) return json(res, 503, { error: 'R2_NOT_CONFIGURED' });
    const response = await signedFetch('GET', '', { 'list-type': '2', 'max-keys': '1' });
    if (!response.ok) return json(res, 502, { error: `R2_CONNECTION_${response.status}` });
    return json(res, 200, { ok: true, bucket: c.bucket, publicBaseUrl: c.publicBaseUrl });
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'R2_STATUS_FAILED' });
  }
};
