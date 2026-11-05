window.CLINIC_SIGNAGE_CONFIG = Object.freeze({
  // Shared Supabase project used by Clinic Signage.
  supabaseUrl: 'https://xtzchrpwgjvalvallfre.supabase.co',

  // Public anon / publishable key only. Never put the service_role key here.
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0emNocnB3Z2p2YWx2YWxsZnJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzNzcwMTEsImV4cCI6MjEwNzk1MzAxMX0.FDD6cycD3kd0K1IBLp0P-4Jn7x3izEwGz6Q3trBsNqE',

  // Player: fallback full-state poll (Realtime wake-up is the primary path).
  pollMs: 120000,
  // Player: fallback poll while the Realtime control channel is subscribed.
  pollMsRealtime: 300000,
  // Large deployments: each TV subscribed to two channels adds long-lived sockets.
  // Opt in only after capacity testing; 120s fallback polling still receives commands.
  enablePlayerRealtime: false,
  // Player: analytics heartbeat (재생률 통계).
  heartbeatMs: 300000,
  // Player: presence report when nothing changed. State changes are reported immediately.
  livePresenceMs: 300000,
  // Admin / staff: changed-rows-only status poll while the tab is visible. 0 = off.
  livePollMs: 60000,
  // Admin / staff: no presence for this long -> offline.
  onlineThresholdMs: 600000
});
