-- v2.35.23: Restrict player_control_signals metadata reads.
-- This is compatible with the v2.35.22 default (Realtime disabled).
-- If realtime delivery to browser clients is enabled, implement a tenant-scoped
-- access method before switching it back on. Review any other SELECT policies.
BEGIN;
ALTER TABLE public.player_control_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS player_control_signals_read ON public.player_control_signals;
DROP POLICY IF EXISTS player_control_signals_read_disabled ON public.player_control_signals;
CREATE POLICY player_control_signals_read_disabled
 ON public.player_control_signals FOR SELECT TO anon, authenticated USING (false);
INSERT INTO public.schema_version(version,applied_at)
 VALUES ('2.35.23',clock_timestamp())
 ON CONFLICT (version) DO UPDATE SET applied_at=excluded.applied_at;
COMMIT;
NOTIFY pgrst, 'reload schema';
