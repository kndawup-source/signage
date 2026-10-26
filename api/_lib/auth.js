const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xtzchrpwgjvalvallfre.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0emNocnB3Z2p2YWx2YWxsZnJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzNzcwMTEsImV4cCI6MjEwNzk1MzAxMX0.FDD6cycD3kd0K1IBLp0P-4Jn7x3izEwGz6Q3trBsNqE';

async function sessionInfo(req) {
  const token = String(req.headers['x-signage-session'] || '');
  if (!token) throw Object.assign(new Error('AUTH_REQUIRED'), { statusCode: 401 });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/pin_session_info`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'x-signage-session': token },
    body: '{}'
  });
  if (!response.ok) throw Object.assign(new Error('AUTH_CHECK_FAILED'), { statusCode: 401 });
  const data = await response.json();
  if (!data?.valid) throw Object.assign(new Error('AUTH_REQUIRED'), { statusCode: 401 });
  return data;
}
async function requireAdmin(req) {
  const data = await sessionInfo(req);
  if (data.role !== 'admin') throw Object.assign(new Error('ADMIN_REQUIRED'), { statusCode: 403 });
  return data;
}
async function requireMember(req) { return sessionInfo(req); }
function resolveSite(data, requested) {
  const reqSite = String(requested || '').trim();
  if (data?.role === 'admin') return reqSite || String(data.site_id || 'default');
  if (reqSite && data?.site_id && reqSite !== String(data.site_id)) throw Object.assign(new Error('SITE_FORBIDDEN'), { statusCode: 403 });
  return String(data?.site_id || reqSite || 'default');
}
async function getSite(req, siteId) {
  const token = String(req.headers['x-signage-session'] || '');
  const id = String(siteId || '').trim();
  if (!token || !id) return null;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/sites?id=eq.${encodeURIComponent(id)}&select=id,code,name&limit=1`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'x-signage-session': token }
  });
  if (!response.ok) return null;
  const rows = await response.json();
  return Array.isArray(rows) ? (rows[0] || null) : null;
}

function json(res, status, body) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body));
}
function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) { try { return JSON.parse(req.body); } catch {} }
  return {};
}
module.exports = { requireAdmin, requireMember, resolveSite, getSite, json, parseBody };
