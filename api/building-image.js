'use strict';
const { requireMember, resolveSite, json, SUPABASE_URL, SUPABASE_ANON_KEY } = require('./_lib/auth');
const { signedFetch } = require('./_lib/r2');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const session = await requireMember(req);
    const siteId = resolveSite(session, req.query?.siteId);
    const token = String(req.headers['x-signage-session'] || '');

    const lookup = await fetch(`${SUPABASE_URL}/rest/v1/rpc/hospital_building_asset`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'x-signage-session': token
      },
      body: JSON.stringify({ p_site: siteId })
    });
    if (!lookup.ok) return json(res, lookup.status, { error: 'BUILDING_ASSET_LOOKUP_FAILED' });

    const asset = await lookup.json();
    const key = String(asset?.key || '').trim();
    if (!key) return json(res, 404, { error: 'BUILDING_IMAGE_NOT_SET' });

    const safeSite = String(siteId).replace(/[^A-Za-z0-9_-]/g, '');
    const expectedPrefix = `buildings/${safeSite}/`;
    if (!safeSite || !key.startsWith(expectedPrefix) || key.includes('..')) {
      return json(res, 400, { error: 'INVALID_BUILDING_OBJECT_KEY' });
    }

    const upstream = await signedFetch('GET', key);
    if (!upstream.ok) return json(res, upstream.status, { error: 'BUILDING_IMAGE_FETCH_FAILED' });

    const contentType = String(upstream.headers.get('content-type') || asset?.mime || 'image/webp');
    if (!/^image\/(png|jpeg|webp)$/i.test(contentType)) {
      return json(res, 502, { error: 'INVALID_BUILDING_IMAGE_TYPE' });
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'private, max-age=120, stale-while-revalidate=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'BUILDING_IMAGE_FAILED' });
  }
};
