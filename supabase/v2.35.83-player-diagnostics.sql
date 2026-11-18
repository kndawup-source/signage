-- Clinic Signage v2.35.83: non-destructive diagnostics telemetry extension.
-- Run in Supabase SQL Editor BEFORE deploying the v2.35.83 player.
-- This patch edits the installed RPC definitions, retaining existing permissions and logic.
-- A mismatch aborts without changing either RPC.
BEGIN;
DO $patch$
DECLARE
  report_sql text;
  heartbeat_sql text;
  report_anchor text := '''source'',          left(coalesce(p_status->>''source'', ''''), 64),';
  heartbeat_anchor text := '''source'',left(coalesce(p_status->>''source'',''''),64),';
  new_fields text := E'\n    ''visibility_state'', case when p_status->>''visibility_state'' in (''visible'',''hidden'') then p_status->>''visibility_state'' end,\n    ''window_focused'', case when jsonb_typeof(p_status->''window_focused'')=''boolean'' then (p_status->>''window_focused'')::boolean end,';
BEGIN
  SELECT pg_get_functiondef(to_regprocedure('public.player_report(uuid,jsonb)')) INTO report_sql;
  SELECT pg_get_functiondef(to_regprocedure('public.player_heartbeat(uuid,jsonb)')) INTO heartbeat_sql;
  IF report_sql IS NULL OR heartbeat_sql IS NULL THEN
    RAISE EXCEPTION 'Required report/heartbeat functions are missing';
  END IF;
  IF position('''visibility_state''' IN report_sql)=0 THEN
    IF position(report_anchor IN report_sql)=0 THEN
      RAISE EXCEPTION 'player_report definition differs from expected schema; no changes made';
    END IF;
    report_sql := replace(report_sql,report_anchor,report_anchor || new_fields);
    EXECUTE report_sql;
  END IF;
  IF position('''visibility_state''' IN heartbeat_sql)=0 THEN
    IF position(heartbeat_anchor IN heartbeat_sql)=0 THEN
      RAISE EXCEPTION 'player_heartbeat definition differs from expected schema; transaction rolled back';
    END IF;
    heartbeat_sql := replace(heartbeat_sql,heartbeat_anchor,heartbeat_anchor || new_fields);
    EXECUTE heartbeat_sql;
  END IF;
END $patch$;
SELECT pg_notify('pgrst', 'reload schema');
COMMIT;
SELECT
  position('''visibility_state''' in pg_get_functiondef(to_regprocedure('public.player_report(uuid,jsonb)')))>0 AS report_extended,
  position('''visibility_state''' in pg_get_functiondef(to_regprocedure('public.player_heartbeat(uuid,jsonb)')))>0 AS heartbeat_extended;
