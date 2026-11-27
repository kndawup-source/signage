'use strict';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches only keys created by the supported video-upload APIs (plus legacy global uploads).
const UUID_PART = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const FILE_PART = '[a-zA-Z0-9가-힣._-]+';
const SAFE_KEYS = [
  new RegExp(`^sites/(${UUID_PART})/videos/${UUID_PART}\\.mp4$`, 'i'),
  new RegExp(`^sites/(${UUID_PART})/videos/[0-9]{4}/[0-9]{2}/${FILE_PART}$`, 'i'),
  new RegExp(`^videos/sites/(${UUID_PART})/${UUID_PART}-${FILE_PART}$`, 'i'),
  new RegExp(`^videos/[0-9]{4}/[0-9]{2}/${FILE_PART}$`, 'i')
];
function isAllowedObjectKey(key, siteId) {
  if (typeof key !== 'string' || key.includes('..') || key.includes('//')) return false;
  for (const pattern of SAFE_KEYS) {
    const match = pattern.exec(key);
    if (!match) continue;
    if (match[1]) return !!siteId && match[1].toLowerCase() === String(siteId).toLowerCase();
    return true;
  }
  return false;
}
module.exports={UUID,isAllowedObjectKey};
