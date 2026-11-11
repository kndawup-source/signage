'use strict';
// Read-only native playback contract. Existing website and DB RPC are untouched.
const { SUPABASE_URL, SUPABASE_ANON_KEY, json, parseBody } = require('./_lib/auth');
const { MAX_VIDEO_COUNT, mediaItem } = require('./_lib/native-media');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 2048;
const MAX_STATE_BYTES = 1024 * 1024;
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, {error:'METHOD_NOT_ALLOWED'}); }
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) return json(res, 413, {error:'REQUEST_TOO_LARGE'});
  let body;
  try { body = parseBody(req); } catch { return json(res, 400, {error:'INVALID_JSON'}); }
  const key = String(body?.key || '').trim();
  if (!UUID.test(key)) return json(res, 400, {error:'INVALID_TV_KEY'});
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json(res, 503, {error:'SERVICE_NOT_CONFIGURED'});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const upstream = await fetch(`${SUPABASE_URL}/rest/v1/rpc/player_get_state_lite`, {
      method:'POST', signal:controller.signal,
      headers:{apikey:SUPABASE_ANON_KEY,Authorization:`Bearer ${SUPABASE_ANON_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({p_key:key})
    });
    if (!upstream.ok) return json(res, 502, {error:'STATE_UNAVAILABLE'});
    const raw = await upstream.text();
    if (raw.length > MAX_STATE_BYTES) return json(res, 502, {error:'STATE_TOO_LARGE'});
    const state = JSON.parse(raw);
    if (!state?.room?.id) return json(res, 404, {error:'TV_NOT_FOUND'});
    const list = Array.isArray(state.playlist) ? state.playlist : [];
    if (list.length > MAX_VIDEO_COUNT) return json(res, 502, {error:'PLAYLIST_TOO_LARGE'});
    // Don't silently convert a malformed nonempty playlist into an empty one.
    const playlist = list.map(mediaItem);
    if (playlist.some(x => !x)) return json(res, 502, {error:'INVALID_PLAYLIST_MEDIA'});
    return json(res, 200, {
      contract:'clinic-signage-native/v1',
      server_time:state.server_time || new Date().toISOString(),
      poll_after_seconds:60,
      room:{
        id:String(state.room.id),name:String(state.room.name || '').slice(0,100),
        paused:Boolean(state.room.paused), force_mute:Boolean(state.room.force_mute),
        volume:Math.max(0,Math.min(100,Number(state.room.volume) || 0))
      },
      mode:String(state.mode || ''),
      revision:String(state.sync_revision || '').slice(0,250),
      playlist,
      download_policy:{atomic_playlist_switch:true,retain_previous_on_failure:true,prefer_quality:'original'}
    });
  } catch { return json(res,503,{error:'STATE_TEMPORARILY_UNAVAILABLE'}); }
  finally { clearTimeout(timer); }
};
