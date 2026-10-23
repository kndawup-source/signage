const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xtzchrpwgjvalvallfre.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0emNocnB3Z2p2YWx2YWxsZnJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzNzcwMTEsImV4cCI6MjEwNzk1MzAxMX0.FDD6cycD3kd0K1IBLp0P-4Jn7x3izEwGz6Q3trBsNqE';

async function requireAdmin(req) {
  const token = String(req.headers['x-signage-session'] || '');
  if (!token) throw Object.assign(new Error('AUTH_REQUIRED'), { statusCode: 401 });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/pin_session_info`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'x-signage-session': token
    },
    body: '{}'
  });
  if (!response.ok) throw Object.assign(new Error('AUTH_CHECK_FAILED'), { statusCode: 401 });
  const data = await response.json();
  if (!data?.valid || data?.role !== 'admin') throw Object.assign(new Error('ADMIN_REQUIRED'), { statusCode: 403 });
  return data;
}

async function requireMember(req) {
  const token = String(req.headers['x-signage-session'] || '');
  if (!token) throw Object.assign(new Error('AUTH_REQUIRED'), { statusCode: 401 });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/pin_session_info`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'x-signage-session': token
    },
    body: '{}'
  });
  if (!response.ok) throw Object.assign(new Error('AUTH_CHECK_FAILED'), { statusCode: 401 });
  const data = await response.json();
  if (!data?.valid) throw Object.assign(new Error('AUTH_REQUIRED'), { statusCode: 401 });
  return data;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch {}
  }
  return {};
}

module.exports = { requireAdmin, requireMember, json, parseBody };
