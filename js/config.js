window.CLINIC_SIGNAGE_CONFIG = Object.freeze({
  // Shared Supabase project used by Clinic Signage.
  supabaseUrl: 'https://imumpyumchvctrpmfngr.supabase.co',

  // Paste the project's public anon / publishable key here once, then commit/push.
  // This is a browser-side public key; never put the service_role key here.
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0emNocnB3Z2p2YWx2YWxsZnJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzNzcwMTEsImV4cCI6MjEwNzk1MzAxMX0.FDD6cycD3kd0K1IBLp0P-4Jn7x3izEwGz6Q3trBsNqE',

  pollMs: 30000,
  heartbeatMs: 10000,
  onlineThresholdMs: 35000
});
