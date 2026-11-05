const { requireAdmin, json, parseBody } = require('./_lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    await requireAdmin(req);
    const key = String(parseBody(req).key || '');
    if (!/^videos\/[0-9]{4}\/[0-9]{2}\/[A-Za-z0-9가-힣._\/-]+$/.test(key) || key.includes('..')) return json(res, 400, { error: 'INVALID_OBJECT_KEY' });
    // Global video keys do not establish exclusive hospital ownership.
    // Keep physical media until an ownership-aware garbage collector exists.
    return json(res, 200, { ok: true, physical_deleted: false, cleanup_deferred: true });
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'R2_DELETE_FAILED' });
  }
};
