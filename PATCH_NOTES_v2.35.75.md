# Clinic Signage 2.35.75 — player recovery patch

## Modified

- `js/player.js`: emergency/error recovery of prepared playlist, end-of-clip transition of healthy default/group playback, partial 404/410 omission, resume after just-finished media, failure diagnostics, UTF-8-sized heartbeat, downloaded-cache coordination, cached URL normalization, and previous manifest retention until one full successful lap.
- `js/hospital.js`: pending-state and failed-media diagnostics, Korean cache error messages.
- `js/superadmin.js`: per-TV diagnostic details under the selected site's summary.
- `hospital.html`: fixed inconsistent CSS/boot version references.
- `supabase/schema.sql`: current player_report and player_heartbeat accept diagnostic fields.
- `supabase/v2.35.75-player-recovery-diagnostics.sql`: **must be manually applied to Supabase**; copying the web files alone does not update SQL functions.
- Release metadata and HTML asset versions set to 2.35.75.

## Deployment order

1. Backup DB and apply `supabase/v2.35.75-player-recovery-diagnostics.sql` on staging; confirm both functions compile and player_report/player_heartbeat work under intended permissions.
2. Upload the web build. Confirm `node scripts/check-release.js` PASS and stale service workers are updated.
3. Test the TV in Edge. Specifically test all-broken playlist -> emergency loop -> ready new list: the replacement must start without an `ended` event. Confirm paused/muted states and patient transitions.
4. Test one missing 404 file with one valid file, one 5xx failure, a group order change, a 15-minute clip, multi-TV tabs, restart while pending download, quota exhaustion and offline fallback.

## Limitations and unverified items

- Browser, real TV, actual remote DB and 300MB Range-performance tests were **not** performed here; do not interpret static passes as a field test.
- Downloads interrupted by starvation still restart from zero (HTTP Range resume not implemented).
- Streaming fallback for repeated download yielding is **not automatically enabled**: it is only reported; an unverified live stream is not used to replace stable playback.
- `player-sw.js` still uses whole-blob processing on cached Range requests; performance tuning and real-device validation remain open.
- Cross-tab Navigator Locks requires browser support. Without Web Locks, the existing per-tab fallback applies.
- The new playlist currently must have at least one valid downloadable media file for partial 404/410 omission. 5xx errors remain pending for retry.
