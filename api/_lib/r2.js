const crypto = require('crypto');

const enc = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (path) => String(path).split('/').map(enc).join('/');
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hmac = (key, v, encoding) => crypto.createHmac('sha256', key).update(v).digest(encoding);
const amzDate = (d = new Date()) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');
const dateStamp = (amz) => amz.slice(0, 8);

function config() {
  const c = {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET_NAME || '',
    publicBaseUrl: (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  };
  c.ready = Object.values(c).every(Boolean);
  return c;
}

function endpoint(c) { return `${c.accountId}.r2.cloudflarestorage.com`; }
function scope(amz) { return `${dateStamp(amz)}/auto/s3/aws4_request`; }
function signingKey(secret, amz) {
  const kDate = hmac(Buffer.from(`AWS4${secret}`, 'utf8'), dateStamp(amz));
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}
function canonicalQuery(params) {
  return Object.entries(params).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${enc(k)}=${enc(v)}`).join('&');
}

function presignPut(key, expires = 900) {
  const c = config();
  if (!c.ready) throw new Error('R2_NOT_CONFIGURED');
  const amz = amzDate();
  const host = endpoint(c);
  const uri = `/${enc(c.bucket)}/${encodePath(key)}`;
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${c.accessKeyId}/${scope(amz)}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host'
  };
  const query = canonicalQuery(params);
  const canonicalRequest = ['PUT', uri, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope(amz), sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(c.secretAccessKey, amz), stringToSign, 'hex');
  return {
    uploadUrl: `https://${host}${uri}?${query}&X-Amz-Signature=${signature}`,
    publicUrl: `${c.publicBaseUrl}/${encodePath(key)}`
  };
}

async function signedFetch(method, objectKey = '', query = {}) {
  const c = config();
  if (!c.ready) throw new Error('R2_NOT_CONFIGURED');
  const amz = amzDate();
  const host = endpoint(c);
  const uri = objectKey ? `/${enc(c.bucket)}/${encodePath(objectKey)}` : `/${enc(c.bucket)}`;
  const qs = canonicalQuery(query);
  const payloadHash = sha256('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amz}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, uri, qs, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope(amz), sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(c.secretAccessKey, amz), stringToSign, 'hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope(amz)}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return fetch(`https://${host}${uri}${qs ? `?${qs}` : ''}`, {
    method,
    headers: {
      Authorization: authorization,
      'x-amz-date': amz,
      'x-amz-content-sha256': payloadHash
    }
  });
}

function sanitizeFilename(name) {
  const ext = String(name).toLowerCase().endsWith('.webm') ? '.webm' : '.mp4';
  const base = String(name).replace(/\.[^.]+$/, '').normalize('NFKC').replace(/[^a-zA-Z0-9가-힣._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'video';
  return `${base}${ext}`;
}
function makeObjectKey(filename) {
  const d = new Date();
  return `videos/${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${crypto.randomUUID()}-${sanitizeFilename(filename)}`;
}

module.exports = { config, presignPut, signedFetch, makeObjectKey };
