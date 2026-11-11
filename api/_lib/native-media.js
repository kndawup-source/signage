'use strict';

// Native player representation selector. Never invent converted variants: use
// only explicit, previously published media metadata from the database RPC.
const MAX_VIDEO_BYTES = 650 * 1024 * 1024;
const MAX_VIDEO_COUNT = 200;

function validUrl(input) {
  if (typeof input !== 'string' || input.length > 4096) return null;
  try {
    const u = new URL(input);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith('127.') || host === '[::1]') return null;
    if (u.port && u.port !== '443') return null;
    return u.href;
  } catch { return null; }
}
function byteSize(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_VIDEO_BYTES ? n : null;
}
function sourceVariant(item, q) {
  const variants = item.variants && typeof item.variants === 'object' && !Array.isArray(item.variants) ? item.variants : {};
  // Only recognize fields supplied explicitly by the server. Do not rewrite
  // filenames or infer that an optimized rendition exists on R2.
  let candidate = variants[q] ?? item[`url_${q}`] ?? item[`${q}_url`];
  if (typeof candidate === 'string') candidate = { url: candidate };
  if (!candidate || typeof candidate !== 'object') return null;
  const url = validUrl(candidate.url);
  if (!url) return null;
  const size = byteSize(candidate.bytes ?? candidate.size_bytes ?? candidate.size);
  const sha = candidate.sha256;
  const sha256 = typeof sha === 'string' && /^[a-f0-9]{64}$/i.test(sha) ? sha.toLowerCase() : null;
  return { url, bytes: size, sha256, quality: q };
}
function mediaItem(item) {
  if (!item || typeof item !== 'object') return null;
  const original = validUrl(item.url);
  if (!original) return null;
  const fallback = { url: original, bytes: byteSize(item.size_bytes ?? item.size), quality: 'original' };
  const optimized = [sourceVariant(item, '480p'), sourceVariant(item, '720p')].filter(Boolean);
  const preferred = optimized[0] || fallback;
  const id = String(item.id || '').slice(0, 80);
  return {
    id, title: String(item.title || '').slice(0, 150),
    url: preferred.url, bytes: preferred.bytes,
    quality: preferred.quality, sha256: preferred.sha256 || null,
    // Native clients can download 480p first, but have a verified URL fallback.
    sources: [...optimized, fallback],
    revision: String(item.file_modified_at || item.revision || '').slice(0, 100),
    format: 'mp4'
  };
}
module.exports = { MAX_VIDEO_COUNT, mediaItem, validUrl, sourceVariant };
