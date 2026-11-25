BEGIN;
CREATE OR REPLACE FUNCTION public.hospital_reload_selected_players(p_site uuid, p_rooms uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_count integer;
BEGIN
  IF p_site IS NULL OR NOT public.can_manage_site(p_site) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501'; END IF;
  UPDATE public.rooms r SET reload_nonce=CASE WHEN r.reload_nonce>=2147483646 THEN 1 ELSE r.reload_nonce+1 END
  WHERE r.site_id=p_site AND r.id=ANY(p_rooms) AND coalesce(r.display_control_mode,'remote') IN ('remote','hybrid');
  GET DIAGNOSTICS v_count=ROW_COUNT;
  PERFORM public.signal_site_rooms_internal(p_site);
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.hospital_reload_selected_players(uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hospital_reload_selected_players(uuid,uuid[]) TO anon, authenticated;
COMMIT;
