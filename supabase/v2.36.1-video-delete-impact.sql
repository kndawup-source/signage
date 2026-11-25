-- Preview and confirmed deletion. Existing R2 queue remains authoritative.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version='2.36.0') THEN
  RAISE EXCEPTION '먼저 v2.36.0-site-catalog.sql을 실행하세요.';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.video_delete_impact(p_video uuid,p_site uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v public.videos%ROWTYPE; links jsonb; tvs jsonb;
BEGIN
 SELECT * INTO v FROM public.videos WHERE id=p_video;
 IF NOT FOUND THEN RAISE EXCEPTION '영상을 찾을 수 없습니다.'; END IF;
 IF NOT coalesce(public.is_admin(),false) AND (v.site_id IS NULL OR p_site IS DISTINCT FROM v.site_id OR NOT coalesce(public.can_manage_site(v.site_id),false)) THEN
  RAISE EXCEPTION '영상 삭제 권한이 없습니다.' USING ERRCODE='42501';
 END IF;
 IF v.site_id IS NOT NULL AND p_site IS DISTINCT FROM v.site_id THEN RAISE EXCEPTION '영상 소유 병원이 일치하지 않습니다.' USING ERRCODE='42501'; END IF;
 WITH refs(kind,id,site_id,label,remaining,detail) AS (
  SELECT 'playlist',p.id::text,p.site_id,p.name,(SELECT count(*) FROM public.playlist_items i WHERE i.playlist_id=p.id AND i.video_id<>p_video),jsonb_build_object('active',p.active,'kind',p.kind) FROM public.playlists p JOIN public.playlist_items i ON i.playlist_id=p.id WHERE i.video_id=p_video
  UNION ALL SELECT 'rule',r.id::text,r.site_id,concat_ws(' / ',g.name,r.name),NULL::bigint,jsonb_build_object('enabled',rr.enabled,'starts_at',rr.starts_at,'ends_at',rr.ends_at) FROM public.room_video_rules rr JOIN public.rooms r ON r.id=rr.room_id LEFT JOIN public.signage_groups g ON g.id=r.group_id WHERE rr.video_id=p_video
  UNION ALL SELECT 'manual',r.id::text,r.site_id,concat_ws(' / ',g.name,r.name),cardinality(array_remove(r.manual_video_ids,p_video)),jsonb_build_object('active',r.manual_active,'ids',r.manual_video_ids) FROM public.rooms r LEFT JOIN public.signage_groups g ON g.id=r.group_id WHERE p_video=ANY(r.manual_video_ids)
  UNION ALL SELECT 'site',b.site_id::text,b.site_id,'병원 전체 송출',cardinality(array_remove(b.video_ids,p_video)),jsonb_build_object('active',b.active,'ids',b.video_ids) FROM public.site_broadcasts b WHERE p_video=ANY(b.video_ids)
  UNION ALL SELECT 'group',g.id::text,g.site_id,g.name,cardinality(array_remove(b.video_ids,p_video)),jsonb_build_object('active',b.active,'ids',b.video_ids) FROM public.group_broadcasts b JOIN public.signage_groups g ON g.id=b.group_id WHERE p_video=ANY(b.video_ids)
  UNION ALL SELECT 'schedule',b.id::text,b.site_id,concat_ws(' / ',coalesce(g.name,'병원 전체'),to_char(b.starts_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI')),cardinality(array_remove(b.video_ids,p_video)),jsonb_build_object('enabled',b.enabled,'starts_at',b.starts_at,'ends_at',b.ends_at,'ids',b.video_ids,'group_id',b.group_id) FROM public.broadcast_schedules b LEFT JOIN public.signage_groups g ON g.id=b.group_id WHERE p_video=ANY(b.video_ids)
  UNION ALL SELECT 'emergency_site',s.site_id::text,s.site_id,'병원 긴급 영상',0,'{}'::jsonb FROM public.site_settings s WHERE s.operating_config->>'emergency_video_id'=p_video::text
  UNION ALL SELECT 'emergency_global',a.id::text,NULL::uuid,'전체 긴급 영상',0,'{}'::jsonb FROM public.app_settings a WHERE a.emergency_video_id=p_video
  UNION ALL SELECT 'legacy',b.id::text,NULL::uuid,'기존 공통 송출',cardinality(array_remove(b.video_ids,p_video)),jsonb_build_object('active',b.active,'ids',b.video_ids) FROM public.broadcast b WHERE p_video=ANY(b.video_ids)
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('kind',q.kind,'id',q.id,'site_id',q.site_id,'site',coalesce(s.name,'전체/공용'),'label',q.label,'remaining',q.remaining,'detail',q.detail) ORDER BY q.kind,q.id),'[]'::jsonb) INTO links FROM refs q LEFT JOIN public.sites s ON s.id=q.site_id;
 -- Never disclose another hospital's references to a hospital account.
 IF NOT coalesce(public.is_admin(),false) AND EXISTS(SELECT 1 FROM jsonb_array_elements(links) l WHERE l->>'site_id' IS DISTINCT FROM p_site::text) THEN
  RAISE EXCEPTION '병원 범위 밖의 연결이 있습니다. 슈퍼어드민에게 삭제를 요청하세요.' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'site',s.name,'label',concat_ws(' / ',g.name,r.name)) ORDER BY r.id),'[]'::jsonb) INTO tvs
 FROM public.rooms r JOIN public.sites s ON s.id=r.site_id LEFT JOIN public.signage_groups g ON g.id=r.group_id
 WHERE (coalesce(public.is_admin(),false) OR r.site_id=p_site) AND EXISTS(SELECT 1 FROM jsonb_array_elements(links) l WHERE
  (l->>'kind'='playlist' AND coalesce(r.default_playlist_id,g.default_playlist_id)::text=l->>'id') OR
  (l->>'kind' IN ('rule','manual') AND r.id::text=l->>'id') OR
  (l->>'kind' IN ('site','emergency_site') AND r.site_id::text=l->>'site_id') OR
  (l->>'kind'='group' AND r.group_id::text=l->>'id') OR
  (l->>'kind'='schedule' AND r.site_id::text=l->>'site_id' AND ((l->'detail'->>'group_id') IS NULL OR r.group_id::text=l->'detail'->>'group_id')) OR
  l->>'kind' IN ('emergency_global','legacy'));
 RETURN jsonb_build_object('title',v.title,'links',links,'tvs',tvs,'count',jsonb_array_length(links),'signature',md5(jsonb_build_array(p_video,v.site_id,v.title,links,tvs)::text));
END $$;
CREATE OR REPLACE FUNCTION public.video_delete_confirmed(p_video uuid,p_site uuid,p_signature text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE impact jsonb;
BEGIN
 -- Authorize before taking locks. Keep existing queue semantics on retries.
 IF EXISTS(SELECT 1 FROM public.video_r2_delete_jobs WHERE video_id=p_video) THEN RETURN public.video_delete_enqueue(p_video,p_site); END IF;
 PERFORM public.video_delete_impact(p_video,p_site);
 -- Lock references against concurrent writes while rechecking the preview and deleting.
 PERFORM set_config('lock_timeout','3000',true);
 LOCK TABLE public.app_settings,public.broadcast,public.broadcast_schedules,public.group_broadcasts,public.playlist_items,public.playlists,public.room_video_rules,public.rooms,public.signage_groups,public.site_broadcasts,public.site_settings,public.sites,public.videos IN SHARE ROW EXCLUSIVE MODE;
 impact:=public.video_delete_impact(p_video,p_site);
 IF p_signature IS NULL OR p_signature IS DISTINCT FROM impact->>'signature' THEN RAISE EXCEPTION '사용 위치가 변경되었습니다. 다시 확인 후 삭제하세요.'; END IF;
 DELETE FROM public.playlist_items WHERE video_id=p_video;
 DELETE FROM public.room_video_rules WHERE video_id=p_video;
 UPDATE public.rooms SET manual_video_ids=array_remove(manual_video_ids,p_video),manual_active=manual_active AND cardinality(array_remove(manual_video_ids,p_video))>0,manual_updated_at=clock_timestamp() WHERE p_video=ANY(manual_video_ids);
 UPDATE public.site_broadcasts SET video_ids=array_remove(video_ids,p_video),active=active AND cardinality(array_remove(video_ids,p_video))>0,revision=revision+1,updated_at=clock_timestamp() WHERE p_video=ANY(video_ids);
 UPDATE public.group_broadcasts SET video_ids=array_remove(video_ids,p_video),active=active AND cardinality(array_remove(video_ids,p_video))>0,revision=revision+1,updated_at=clock_timestamp() WHERE p_video=ANY(video_ids);
 UPDATE public.broadcast_schedules SET video_ids=array_remove(video_ids,p_video),enabled=enabled AND cardinality(array_remove(video_ids,p_video))>0 WHERE p_video=ANY(video_ids);
 UPDATE public.site_settings SET operating_config=operating_config-'emergency_video_id',updated_at=clock_timestamp() WHERE operating_config->>'emergency_video_id'=p_video::text;
 UPDATE public.app_settings SET emergency_video_id=NULL,updated_at=clock_timestamp() WHERE emergency_video_id=p_video;
 UPDATE public.broadcast SET video_ids=array_remove(video_ids,p_video),active=active AND cardinality(array_remove(video_ids,p_video))>0,revision=revision+1,updated_at=clock_timestamp() WHERE p_video=ANY(video_ids);
 -- Existing authorization, key safety and shared-file checks still run; any failure rolls back all changes.
 RETURN public.video_delete_enqueue(p_video,p_site);
END $$;
REVOKE ALL ON FUNCTION public.video_delete_impact(uuid,uuid),public.video_delete_confirmed(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.video_delete_impact(uuid,uuid),public.video_delete_confirmed(uuid,uuid,text) TO anon,authenticated;
CREATE OR REPLACE FUNCTION public.video_usage_counts(p_site uuid,p_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result jsonb;
BEGIN
 IF p_site IS NULL OR NOT coalesce(public.can_manage_site(p_site),false) THEN RAISE EXCEPTION '병원 관리 권한이 없습니다.' USING ERRCODE='42501'; END IF;
 IF coalesce(cardinality(p_ids),0)>1000 THEN RAISE EXCEPTION '조회는 최대 1000개씩 가능합니다.'; END IF;
 WITH allowed AS (
  SELECT id FROM public.videos WHERE id=ANY(p_ids) AND (site_id=p_site OR (site_id IS NULL AND public.is_admin()))
 ), refs AS (
  SELECT i.video_id,p.site_id FROM public.playlist_items i JOIN public.playlists p ON p.id=i.playlist_id WHERE i.video_id=ANY(p_ids)
  UNION ALL SELECT i.video_id,r.site_id FROM public.room_video_rules i JOIN public.rooms r ON r.id=i.room_id WHERE i.video_id=ANY(p_ids)
  UNION ALL SELECT x.id,r.site_id FROM public.rooms r CROSS JOIN LATERAL (SELECT DISTINCT unnest(r.manual_video_ids) id) x WHERE x.id=ANY(p_ids)
  UNION ALL SELECT x.id,r.site_id FROM public.site_broadcasts r CROSS JOIN LATERAL (SELECT DISTINCT unnest(r.video_ids) id) x WHERE x.id=ANY(p_ids)
  UNION ALL SELECT x.id,g.site_id FROM public.group_broadcasts r JOIN public.signage_groups g ON g.id=r.group_id CROSS JOIN LATERAL (SELECT DISTINCT unnest(r.video_ids) id) x WHERE x.id=ANY(p_ids)
  UNION ALL SELECT x.id,r.site_id FROM public.broadcast_schedules r CROSS JOIN LATERAL (SELECT DISTINCT unnest(r.video_ids) id) x WHERE x.id=ANY(p_ids)
  UNION ALL SELECT a.id,s.site_id FROM public.site_settings s JOIN allowed a ON s.operating_config->>'emergency_video_id'=a.id::text
  UNION ALL SELECT emergency_video_id,NULL::uuid FROM public.app_settings WHERE emergency_video_id=ANY(p_ids)
  UNION ALL SELECT x.id,NULL::uuid FROM public.broadcast r CROSS JOIN LATERAL (SELECT DISTINCT unnest(r.video_ids) id) x WHERE x.id=ANY(p_ids)
 ), counts AS (SELECT a.id,count(r.video_id) AS n FROM allowed a LEFT JOIN refs r ON r.video_id=a.id GROUP BY a.id HAVING coalesce(public.is_admin(),false) OR count(*) FILTER (WHERE r.video_id IS NOT NULL AND r.site_id IS DISTINCT FROM p_site)=0)
 SELECT coalesce(jsonb_object_agg(id::text,n),'{}'::jsonb) INTO result FROM counts;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.video_delete_batch_confirmed(p_site uuid,p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE item jsonb; vid uuid; impact jsonb; jobs jsonb:='[]'::jsonb;
BEGIN
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '삭제 대상을 선택하세요.'; END IF;
 IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION '영상은 1~10개씩 삭제하세요.'; END IF;
 IF (SELECT count(DISTINCT (e->>'videoId')::uuid) FROM jsonb_array_elements(p_items) e)<>jsonb_array_length(p_items) THEN RAISE EXCEPTION '중복되거나 잘못된 영상입니다.'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  PERFORM public.video_delete_impact((item->>'videoId')::uuid,p_site);
 END LOOP;
 PERFORM set_config('lock_timeout','3000',true);
 LOCK TABLE public.app_settings,public.broadcast,public.broadcast_schedules,public.group_broadcasts,public.playlist_items,public.playlists,public.room_video_rules,public.rooms,public.signage_groups,public.site_broadcasts,public.site_settings,public.sites,public.videos IN SHARE ROW EXCLUSIVE MODE;
 -- Check every original preview BEFORE modifying any reference. Shared playlists change during a batch.
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  impact:=public.video_delete_impact((item->>'videoId')::uuid,p_site);
  IF item->>'signature' IS NULL OR (item->>'signature') IS DISTINCT FROM (impact->>'signature') THEN RAISE EXCEPTION '사용 위치가 변경되었습니다. 다시 확인 후 삭제하세요.'; END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  vid:=(item->>'videoId')::uuid;
  impact:=public.video_delete_impact(vid,p_site);
  jobs:=jobs||jsonb_build_array(public.video_delete_confirmed(vid,p_site,impact->>'signature'));
 END LOOP;
 RETURN jobs;
END $$;
REVOKE ALL ON FUNCTION public.video_usage_counts(uuid,uuid[]),public.video_delete_batch_confirmed(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.video_usage_counts(uuid,uuid[]),public.video_delete_batch_confirmed(uuid,jsonb) TO anon,authenticated;
CREATE OR REPLACE FUNCTION public.video_delete_pending(p_site uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT public.is_admin() AND (p_site IS NULL OR NOT public.can_manage_site(p_site)) THEN
  RAISE EXCEPTION '접근 권한이 없습니다.' USING ERRCODE='42501';
 END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('video_id',video_id,'object_key',object_key,'site_id',site_id))
  FROM (SELECT video_id,object_key,site_id FROM public.video_r2_delete_jobs
   WHERE status='pending' AND (site_id=p_site OR (public.is_admin() AND (p_site IS NULL OR site_id IS NULL)))
   ORDER BY created_at LIMIT 20) jobs),'[]'::jsonb);
END $$;
CREATE OR REPLACE FUNCTION public.app_db_version()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('version','2.36.1','features',jsonb_build_array('pairing_v2','display_key_reset','pairing_v3','site_catalog_v1','video_delete_impact_v1'))
$$;
INSERT INTO public.schema_version(version,applied_at) VALUES('2.36.1',clock_timestamp()) ON CONFLICT(version) DO UPDATE SET applied_at=excluded.applied_at;
NOTIFY pgrst,'reload schema';
COMMIT;
