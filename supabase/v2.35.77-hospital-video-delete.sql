-- Clinic Signage v2.35.77
-- Safe site-only video removal. Do NOT remove referenced video and do NOT delete R2 object.
BEGIN;
CREATE OR REPLACE FUNCTION public.hospital_delete_site_video(p_site uuid,p_video uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $$
DECLARE v_video public.videos%ROWTYPE;
BEGIN
  IF NOT public.can_manage_site(p_site) THEN
    RAISE EXCEPTION '영상 삭제 권한이 없습니다.' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_video FROM public.videos WHERE id=p_video AND site_id=p_site FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '이 병원 소유 영상만 삭제할 수 있습니다.' USING ERRCODE='42501';
  END IF;
  -- Check all persistent references, including inactive/future schedules.
  IF EXISTS (SELECT 1 FROM public.playlist_items WHERE video_id=p_video)
     OR EXISTS (SELECT 1 FROM public.room_video_rules WHERE video_id=p_video)
     OR EXISTS (SELECT 1 FROM public.rooms WHERE p_video=ANY(manual_video_ids))
     OR EXISTS (SELECT 1 FROM public.site_broadcasts WHERE p_video=ANY(video_ids))
     OR EXISTS (SELECT 1 FROM public.group_broadcasts WHERE p_video=ANY(video_ids))
     OR EXISTS (SELECT 1 FROM public.broadcast_schedules WHERE p_video=ANY(video_ids))
     OR EXISTS (SELECT 1 FROM public.site_settings WHERE operating_config->>'emergency_video_id'=p_video::text)
     OR EXISTS (SELECT 1 FROM public.app_settings WHERE emergency_video_id=p_video)
     OR EXISTS (SELECT 1 FROM public.broadcast WHERE p_video=ANY(video_ids)) THEN
    RAISE EXCEPTION '재생목록 또는 송출 설정에서 사용 중인 영상입니다. 연결을 먼저 해제한 뒤 삭제하세요.' USING ERRCODE='P0001';
  END IF;
  DELETE FROM public.videos WHERE id=p_video AND site_id=p_site;
  IF NOT FOUND THEN RAISE EXCEPTION '삭제할 영상을 찾지 못했습니다.'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.hospital_delete_site_video(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hospital_delete_site_video(uuid,uuid) TO anon,authenticated;
COMMIT;
