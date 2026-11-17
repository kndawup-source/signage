-- v2.35.79: durable deletion queue. Apply BEFORE deploying the web/API files.
-- Existing video references are checked before any metadata deletion; R2 failure leaves a retryable job.
BEGIN;
CREATE TABLE IF NOT EXISTS public.video_r2_delete_jobs (
  video_id uuid PRIMARY KEY,
  site_id uuid,
  object_key text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);
ALTER TABLE public.video_r2_delete_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.video_r2_delete_jobs FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.video_delete_enqueue(p_video uuid, p_site uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v public.videos%ROWTYPE; j public.video_r2_delete_jobs%ROWTYPE; v_key text;
BEGIN
  -- Serialize requests for this specific video, including duplicate clicks.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_video::text, 0));
  SELECT * INTO j FROM public.video_r2_delete_jobs WHERE video_id=p_video FOR UPDATE;
  IF FOUND THEN
    IF NOT (public.is_admin() OR (j.site_id IS NOT NULL AND public.can_manage_site(j.site_id) AND p_site=j.site_id)) THEN
      RAISE EXCEPTION '삭제 작업 접근 권한이 없습니다.' USING ERRCODE='42501';
    END IF;
    RETURN jsonb_build_object('video_id',j.video_id,'object_key',j.object_key,'status',j.status);
  END IF;
  SELECT * INTO v FROM public.videos WHERE id=p_video FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '영상을 찾을 수 없습니다.'; END IF;
  IF v.site_id IS NULL THEN
    IF NOT public.is_admin() THEN RAISE EXCEPTION '공용 영상은 슈퍼어드민만 삭제할 수 있습니다.' USING ERRCODE='42501'; END IF;
  ELSIF (p_site IS DISTINCT FROM v.site_id) OR NOT public.can_manage_site(v.site_id) THEN
    RAISE EXCEPTION '영상 삭제 권한이 없습니다.' USING ERRCODE='42501';
  END IF;

  -- Protect scheduled, inactive and active uses across ALL sites, not just the open hospital.
  IF EXISTS (SELECT 1 FROM public.playlist_items WHERE video_id=p_video)
    OR EXISTS (SELECT 1 FROM public.room_video_rules WHERE video_id=p_video)
    OR EXISTS (SELECT 1 FROM public.rooms WHERE p_video=ANY(manual_video_ids))
    OR EXISTS (SELECT 1 FROM public.site_broadcasts WHERE p_video=ANY(video_ids))
    OR EXISTS (SELECT 1 FROM public.group_broadcasts WHERE p_video=ANY(video_ids))
    OR EXISTS (SELECT 1 FROM public.broadcast_schedules WHERE p_video=ANY(video_ids))
    OR EXISTS (SELECT 1 FROM public.site_settings WHERE operating_config->>'emergency_video_id'=p_video::text)
    OR EXISTS (SELECT 1 FROM public.app_settings WHERE emergency_video_id=p_video)
    OR EXISTS (SELECT 1 FROM public.broadcast WHERE p_video=ANY(video_ids)) THEN
    RAISE EXCEPTION '사용 중인 영상입니다. 모든 재생목록 및 송출 연결을 해제하세요.' USING ERRCODE='P0001';
  END IF;

  v_key := CASE WHEN v.source='r2' THEN nullif(btrim(v.storage_path),'') END;
  -- Never delete an R2 key that looks unrelated to this system's managed video prefixes.
  IF v_key IS NOT NULL AND NOT (
      v_key ~ '^videos/[0-9]{4}/[0-9]{2}/[A-Za-z0-9가-힣._/-]+$'
      OR v_key ~ '^sites/[0-9a-fA-F-]{36}/videos/[0-9]{4}/[0-9]{2}/[A-Za-z0-9가-힣._/-]+$'
    ) THEN
    RAISE EXCEPTION 'R2 영상 경로를 확인할 수 없습니다. 수동 확인이 필요합니다.' USING ERRCODE='P0001';
  END IF;
  IF v_key LIKE '%..%' OR v_key LIKE '%//%' THEN
    RAISE EXCEPTION '안전하지 않은 R2 경로입니다.' USING ERRCODE='P0001';
  END IF;
  -- Legacy global keys may be shared by URL even where storage_path differs.
  IF v_key IS NOT NULL AND EXISTS(
    SELECT 1 FROM public.videos other
    WHERE other.id<>v.id AND (other.storage_path=v_key OR other.url=v.url AND v.url IS NOT NULL)
  ) THEN RAISE EXCEPTION '다른 영상에서도 동일한 파일을 사용합니다.' USING ERRCODE='P0001'; END IF;

  INSERT INTO public.video_r2_delete_jobs(video_id,site_id,object_key)
  VALUES(v.id,v.site_id,v_key);
  -- Metadata removal and retry job are committed in the SAME transaction.
  DELETE FROM public.videos WHERE id=v.id;
  RETURN jsonb_build_object('video_id',v.id,'object_key',v_key,'status','pending');
END $$;

CREATE OR REPLACE FUNCTION public.video_delete_pending(p_site uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT public.is_admin() AND (p_site IS NULL OR NOT public.can_manage_site(p_site)) THEN
    RAISE EXCEPTION '접근 권한이 없습니다.' USING ERRCODE='42501';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('video_id',video_id,'object_key',object_key))
    FROM (SELECT video_id,object_key FROM public.video_r2_delete_jobs
      WHERE status='pending' AND (site_id=p_site OR (public.is_admin() AND p_site IS NULL))
      ORDER BY created_at LIMIT 20) jobs), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.video_delete_finish(p_video uuid, p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j public.video_r2_delete_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM public.video_r2_delete_jobs WHERE video_id=p_video FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '삭제 작업을 찾지 못했습니다.'; END IF;
  IF NOT (public.is_admin() OR (j.site_id IS NOT NULL AND public.can_manage_site(j.site_id))) THEN
    RAISE EXCEPTION '삭제 작업 접근 권한이 없습니다.' USING ERRCODE='42501';
  END IF;
  UPDATE public.video_r2_delete_jobs
    SET status=CASE WHEN p_error IS NULL THEN 'complete' ELSE 'pending' END,
        last_error=left(p_error,500),
        completed_at=CASE WHEN p_error IS NULL THEN clock_timestamp() ELSE NULL END
    WHERE video_id=p_video;
END $$;
REVOKE ALL ON FUNCTION public.video_delete_enqueue(uuid,uuid),public.video_delete_pending(uuid),public.video_delete_finish(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.video_delete_enqueue(uuid,uuid),public.video_delete_pending(uuid),public.video_delete_finish(uuid,text) TO anon,authenticated;
COMMIT;
