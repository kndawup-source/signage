-- Clinic Signage · 재생목록 일괄/강제 삭제 (미리보기 + 단일 확인 + 원자적 해제)
-- 기존 데이터는 이 SQL을 설치하는 것만으로 변경되지 않습니다.
BEGIN;
CREATE OR REPLACE FUNCTION public.hospital_bulk_delete_playlists(
  p_site uuid,
  p_ids uuid[],
  p_dry_run boolean DEFAULT true,
  p_expected_signature text DEFAULT null
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_ids uuid[];
  v_total integer;
  v_count integer;
  v_tv_count integer;
  v_group_count integer;
  v_site_count integer;
  v_signature text;
  v_global_count integer;
BEGIN
  IF NOT public.can_manage_site(p_site) THEN
    RAISE EXCEPTION '이 병원의 관리 권한이 없습니다.' USING ERRCODE='42501';
  END IF;
  SELECT array_agg(x ORDER BY x) INTO v_ids
  FROM (SELECT DISTINCT id AS x FROM unnest(coalesce(p_ids, '{}'::uuid[])) id WHERE id IS NOT NULL) u;
  v_total := coalesce(cardinality(v_ids), 0);
  IF v_total < 1 OR v_total > 100 THEN
    RAISE EXCEPTION '재생목록은 1~100개씩 삭제할 수 있습니다.' USING ERRCODE='22023';
  END IF;
  -- 삭제 대상 자체를 잠그고 존재 여부와 범위를 서버에서 재검증한다.
  PERFORM id FROM public.playlists WHERE id=ANY(v_ids) ORDER BY id FOR UPDATE;
  SELECT count(*), count(*) FILTER (WHERE site_id IS NULL)
    INTO v_count, v_global_count
  FROM public.playlists WHERE id=ANY(v_ids)
    AND (site_id=p_site OR (site_id IS NULL AND public.is_admin()));
  IF v_count <> v_total THEN
    RAISE EXCEPTION '재생목록이 없거나 삭제 권한이 없습니다.' USING ERRCODE='42501';
  END IF;
  -- 같은 TV의 직접 연결과 층 상속 연결을 중복 집계하지 않는다.
  SELECT count(*) INTO v_tv_count
  FROM public.rooms r
  LEFT JOIN public.signage_groups g ON g.id=r.group_id
  WHERE r.default_playlist_id=ANY(v_ids)
     OR (r.default_playlist_id IS NULL AND g.default_playlist_id=ANY(v_ids));
  SELECT count(*) INTO v_group_count
  FROM public.signage_groups WHERE default_playlist_id=ANY(v_ids);
  SELECT count(*) INTO v_site_count
  FROM (
    SELECT r.site_id FROM public.rooms r
    LEFT JOIN public.signage_groups g ON g.id=r.group_id
    WHERE r.default_playlist_id=ANY(v_ids)
       OR (r.default_playlist_id IS NULL AND g.default_playlist_id=ANY(v_ids))
    UNION
    SELECT site_id FROM public.signage_groups WHERE default_playlist_id=ANY(v_ids)
  ) s;
  -- 변경 감지 지문: 선택 목록/TV 직접 연결/층 연결. 미리보기 이후 연결이 달라지면 삭제 중단.
  SELECT md5(
    coalesce((SELECT string_agg(id::text,',' ORDER BY id) FROM unnest(v_ids) id),'') || '|' ||
    coalesce((SELECT string_agg(r.id::text||':'||r.default_playlist_id::text,',' ORDER BY r.id)
      FROM public.rooms r WHERE r.default_playlist_id=ANY(v_ids)),'') || '|' ||
    coalesce((SELECT string_agg(g.id::text||':'||g.default_playlist_id::text,',' ORDER BY g.id)
      FROM public.signage_groups g WHERE g.default_playlist_id=ANY(v_ids)),'')
  ) INTO v_signature;
  IF coalesce(p_dry_run,true) THEN
    RETURN jsonb_build_object('playlist_count',v_total,'tv_count',v_tv_count,
      'group_count',v_group_count,'site_count',v_site_count,
      'global_count',v_global_count,'signature',v_signature);
  END IF;
  IF p_expected_signature IS NULL OR p_expected_signature<>v_signature THEN
    RAISE EXCEPTION '목록 연결 상태가 변경되었습니다. 다시 확인해 주세요.' USING ERRCODE='P0001';
  END IF;
  -- 모든 작업은 한 RPC/트랜잭션 안에서 실행되며 실패 시 전체 롤백된다.
  UPDATE public.rooms SET default_playlist_id=NULL WHERE default_playlist_id=ANY(v_ids);
  UPDATE public.signage_groups SET default_playlist_id=NULL WHERE default_playlist_id=ANY(v_ids);
  DELETE FROM public.playlists WHERE id=ANY(v_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count<>v_total THEN
    RAISE EXCEPTION '삭제 건수가 달라져 작업을 취소했습니다.' USING ERRCODE='P0001';
  END IF;
  RETURN jsonb_build_object('deleted_count',v_count,'playlist_count',v_total,
    'tv_count',v_tv_count,'group_count',v_group_count,'site_count',v_site_count,
    'global_count',v_global_count);
END
$function$;
REVOKE ALL ON FUNCTION public.hospital_bulk_delete_playlists(uuid,uuid[],boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hospital_bulk_delete_playlists(uuid,uuid[],boolean,text) TO anon,authenticated;
COMMIT;
-- 설치 확인(데이터 변경 없음)
SELECT to_regprocedure('public.hospital_bulk_delete_playlists(uuid,uuid[],boolean,text)') IS NOT NULL AS rpc_installed;
