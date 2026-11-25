-- Clinic Signage 2.35.78: superadmin global content controls from hospital view.
-- Never infer admin from client-supplied p_site. Verify PIN session on server.
-- Requires existing v2.35.77 hospital_delete_site_video migration.
BEGIN;

CREATE OR REPLACE FUNCTION public.superadmin_save_global_playlist(
  p_id uuid, p_name text, p_video_ids uuid[]
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_video uuid; v_pos int:=0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '슈퍼어드민만 공용 재생목록을 수정할 수 있습니다.' USING ERRCODE='42501';
  END IF;
  IF p_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.playlists WHERE id=p_id AND site_id IS NULL) THEN
    RAISE EXCEPTION '공용 재생목록을 찾을 수 없습니다.' USING ERRCODE='P0001';
  END IF;
  IF nullif(btrim(coalesce(p_name,'')),'') IS NULL THEN
    RAISE EXCEPTION '재생목록 이름을 입력하세요.' USING ERRCODE='P0001';
  END IF;
  IF coalesce(array_length(p_video_ids,1),0)=0 THEN
    RAISE EXCEPTION '영상은 1개 이상 선택하세요.' USING ERRCODE='P0001';
  END IF;
  IF EXISTS(
    SELECT 1 FROM unnest(p_video_ids) AS x(id)
    WHERE NOT EXISTS(SELECT 1 FROM public.videos v WHERE v.id=x.id AND v.site_id IS NULL AND v.active)
  ) THEN
    RAISE EXCEPTION '공용 재생목록에는 공용 영상만 넣을 수 있습니다.' USING ERRCODE='P0001';
  END IF;
  IF (SELECT count(*) FROM unnest(p_video_ids)) <> (SELECT count(DISTINCT x.id) FROM unnest(p_video_ids) AS x(id)) THEN
    RAISE EXCEPTION '중복된 영상이 포함되어 있습니다.' USING ERRCODE='P0001';
  END IF;
  PERFORM 1 FROM public.playlists WHERE id=p_id AND site_id IS NULL FOR UPDATE;
  UPDATE public.playlists SET name=btrim(p_name),updated_at=clock_timestamp() WHERE id=p_id AND site_id IS NULL;
  DELETE FROM public.playlist_items WHERE playlist_id=p_id;
  FOREACH v_video IN ARRAY p_video_ids LOOP
    v_pos:=v_pos+10;
    INSERT INTO public.playlist_items(playlist_id,video_id,sort_order)
    VALUES (p_id,v_video,v_pos);
  END LOOP;
  RETURN p_id;
END $$;

CREATE OR REPLACE FUNCTION public.superadmin_delete_global_playlist(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION '슈퍼어드민 권한이 필요합니다.' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.playlists WHERE id=p_id AND site_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '공용 재생목록을 찾을 수 없습니다.' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM public.rooms WHERE default_playlist_id=p_id)
     OR EXISTS(SELECT 1 FROM public.signage_groups WHERE default_playlist_id=p_id) THEN
    RAISE EXCEPTION 'TV 또는 층에서 사용 중인 공용 재생목록은 삭제할 수 없습니다.' USING ERRCODE='P0001';
  END IF;
  DELETE FROM public.playlists WHERE id=p_id AND site_id IS NULL;
END $$;

CREATE OR REPLACE FUNCTION public.superadmin_delete_global_video(p_video uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION '슈퍼어드민 권한이 필요합니다.' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.videos WHERE id=p_video AND site_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '공용 영상을 찾을 수 없습니다.' USING ERRCODE='P0001'; END IF;
  -- Protect all hospitals and all scheduled/persistent references.
  IF EXISTS(SELECT 1 FROM public.playlist_items WHERE video_id=p_video)
    OR EXISTS(SELECT 1 FROM public.room_video_rules WHERE video_id=p_video)
    OR EXISTS(SELECT 1 FROM public.rooms WHERE p_video=ANY(manual_video_ids))
    OR EXISTS(SELECT 1 FROM public.site_broadcasts WHERE p_video=ANY(video_ids))
    OR EXISTS(SELECT 1 FROM public.group_broadcasts WHERE p_video=ANY(video_ids))
    OR EXISTS(SELECT 1 FROM public.broadcast_schedules WHERE p_video=ANY(video_ids))
    OR EXISTS(SELECT 1 FROM public.site_settings WHERE operating_config->>'emergency_video_id'=p_video::text)
    OR EXISTS(SELECT 1 FROM public.app_settings WHERE emergency_video_id=p_video)
    OR EXISTS(SELECT 1 FROM public.broadcast WHERE p_video=ANY(video_ids)) THEN
    RAISE EXCEPTION '다른 병원 또는 송출 설정에서 사용 중입니다. 연결을 모두 해제한 뒤 삭제하세요.' USING ERRCODE='P0001';
  END IF;
  DELETE FROM public.videos WHERE id=p_video AND site_id IS NULL;
END $$;

REVOKE ALL ON FUNCTION public.superadmin_save_global_playlist(uuid,text,uuid[]),
  public.superadmin_delete_global_playlist(uuid),
  public.superadmin_delete_global_video(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.superadmin_save_global_playlist(uuid,text,uuid[]),
  public.superadmin_delete_global_playlist(uuid),
  public.superadmin_delete_global_video(uuid) TO anon,authenticated;
COMMIT;
