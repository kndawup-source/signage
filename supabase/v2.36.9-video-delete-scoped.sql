-- v2.36.9: scoped video deletion; serialize only same hospital/target video and actual reference rows.
-- Reference writers must participate: arrays and JSON do not have foreign-key locking.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version='2.36.8') THEN
  RAISE EXCEPTION 'Apply v2.36.8-auth-stability.sql first';
 END IF;
END $$;

-- Capture a hash of the original URL for R2 jobs. Never re-use a queued object identity:
-- a previously issued or retried R2 DELETE may still be in flight, even after job completion.
ALTER TABLE public.video_r2_delete_jobs ADD COLUMN IF NOT EXISTS source_url_hash text;
CREATE INDEX IF NOT EXISTS video_delete_jobs_object_key_idx ON public.video_r2_delete_jobs(object_key);
CREATE INDEX IF NOT EXISTS video_delete_jobs_url_hash_idx ON public.video_r2_delete_jobs(source_url_hash);

CREATE OR REPLACE FUNCTION public.video_delete_asset_lock(p_key text,p_url_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k bigint;
BEGIN
 IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
  RAISE EXCEPTION '영상 변경은 READ COMMITTED 트랜잭션에서 실행하세요.' USING ERRCODE='25001';
 END IF;
 FOR k IN SELECT DISTINCT hashtextextended(x,0) FROM unnest(ARRAY[
  CASE WHEN p_key IS NOT NULL THEN 'video-asset:key:'||p_key END,
  CASE WHEN p_url_hash IS NOT NULL THEN 'video-asset:url:'||p_url_hash END
 ]) x WHERE x IS NOT NULL ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(k);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.video_delete_guard_asset_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS NOT DISTINCT FROM OLD.id AND NEW.storage_path IS NOT DISTINCT FROM OLD.storage_path AND NEW.url IS NOT DISTINCT FROM OLD.url THEN RETURN NEW; END IF;
 END IF;
 -- ID reuse must wait for a concurrent deletion even when there is no R2 object.
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text,0));
 ELSIF NEW.id IS DISTINCT FROM OLD.id THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text,0));
 END IF;
 PERFORM public.video_delete_asset_lock(NEW.storage_path,CASE WHEN nullif(btrim(NEW.url),'') IS NOT NULL THEN md5(NEW.url) END);
 IF EXISTS(SELECT 1 FROM public.video_r2_delete_jobs j WHERE j.video_id=NEW.id
  OR (j.object_key IS NOT NULL AND (j.object_key=NEW.storage_path OR j.source_url_hash=CASE WHEN nullif(btrim(NEW.url),'') IS NOT NULL THEN md5(NEW.url) END))) THEN
  RAISE EXCEPTION '삭제 이력이 있는 영상 ID 또는 파일 경로입니다. 새 파일로 등록하세요.' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.video_delete_guard_job_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v public.videos%ROWTYPE;
BEGIN
 IF NEW.object_key IS NULL THEN NEW.source_url_hash:=NULL; RETURN NEW; END IF;
 SELECT * INTO v FROM public.videos WHERE id=NEW.video_id FOR UPDATE;
 IF NOT FOUND OR NEW.object_key IS DISTINCT FROM v.storage_path THEN
  RAISE EXCEPTION '삭제할 파일 정보를 확인할 수 없습니다.';
 END IF;
 NEW.source_url_hash:=CASE WHEN nullif(btrim(v.url),'') IS NOT NULL THEN md5(v.url) END;
 PERFORM public.video_delete_asset_lock(NEW.object_key,NEW.source_url_hash);
 -- Recheck AFTER acquiring the same identity locks used by metadata writers.
 IF EXISTS(SELECT 1 FROM public.videos other WHERE other.id<>v.id
  AND (other.storage_path=NEW.object_key OR (nullif(btrim(v.url),'') IS NOT NULL AND other.url=v.url))) THEN
  RAISE EXCEPTION '다른 영상에서도 동일한 파일을 사용합니다.';
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS video_delete_asset_guard ON public.videos;
CREATE TRIGGER video_delete_asset_guard BEFORE INSERT OR UPDATE OF id,storage_path,url ON public.videos
 FOR EACH ROW EXECUTE FUNCTION public.video_delete_guard_asset_write();
DROP TRIGGER IF EXISTS video_delete_job_guard ON public.video_r2_delete_jobs;
CREATE TRIGGER video_delete_job_guard BEFORE INSERT ON public.video_r2_delete_jobs
 FOR EACH ROW EXECUTE FUNCTION public.video_delete_guard_job_insert();

-- On a newly added reference, lock its video with FOR KEY SHARE (conflicts with
-- the delete's FOR UPDATE). After a committed delete, stale edits fail instead
-- of putting missing IDs into arrays/JSON. Removal-only edits remain permitted.
CREATE OR REPLACE FUNCTION public.video_delete_guard_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n jsonb; o jsonb; vid uuid; field text:=TG_ARGV[0];
BEGIN
 IF field='operating_config' THEN
  n:=jsonb_build_array(NEW.operating_config->>'emergency_video_id');
  IF TG_OP='UPDATE' THEN o:=jsonb_build_array(OLD.operating_config->>'emergency_video_id'); END IF;
 ELSE
  n:=to_jsonb(NEW)->field;
  IF TG_OP='UPDATE' THEN o:=to_jsonb(OLD)->field; END IF;
  IF jsonb_typeof(n) IS DISTINCT FROM 'array' THEN n:=jsonb_build_array(n); END IF;
  IF jsonb_typeof(o) IS DISTINCT FROM 'array' THEN o:=jsonb_build_array(o); END IF;
 END IF;
 IF n IS NOT DISTINCT FROM o THEN RETURN NEW; END IF;
 IF field='operating_config' THEN
  IF nullif(n->>0,'') IS NOT NULL THEN
   NEW.operating_config:=jsonb_set(NEW.operating_config,'{emergency_video_id}',to_jsonb((n->>0)::uuid::text),true);
   n:=jsonb_build_array(NEW.operating_config->>'emergency_video_id');
  END IF;
 END IF;
 FOR vid IN SELECT DISTINCT x.id::uuid FROM jsonb_array_elements_text(n) x(id)
  WHERE nullif(x.id,'') IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements_text(coalesce(o,'[]'::jsonb)) prev(id) WHERE lower(prev.id)=lower(x.id)
  ) ORDER BY 1 LOOP
  PERFORM 1 FROM public.videos v WHERE v.id=vid FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION '영상이 삭제되었거나 존재하지 않습니다. 다시 불러오세요.' USING ERRCODE='23503'; END IF;
 END LOOP;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS video_ref_guard_playlist_items ON public.playlist_items;
CREATE TRIGGER video_ref_guard_playlist_items BEFORE INSERT OR UPDATE OF video_id ON public.playlist_items
 FOR EACH ROW EXECUTE FUNCTION public.video_delete_guard_reference('video_id');
DROP TRIGGER IF EXISTS video_ref_guard_room_video_rules ON public.room_video_rules;
CREATE TRIGGER video_ref_guard_room_video_rules BEFORE INSERT OR UPDATE OF video_id ON public.room_video_rules
 FOR EACH ROW EXECUTE FUNCTION public.video_delete_guard_reference('video_id');
DROP TRIGGER IF EXISTS video_ref_guard_rooms ON public.rooms;
CREATE TRIGGER video_ref_guard_rooms BEFORE INSERT OR UPDATE OF manual_video_ids ON public.rooms
 FOR EACH ROW EXECUTE FUNCTION public.video_delete_guard_reference('manual_video_ids');
DROP TRIGGER IF EXISTS video_ref_guard_site_broadcasts ON public.site_broadcasts;
CREATE TRIGGER video_ref_guard_site_broadcasts BEFORE INSERT OR UPDATE OF video_ids ON public.site_broadcasts
 FOR EACH ROW EXECUTE FUNCTION public.video_delete_guard_reference('video_ids');
DROP TRIGGER IF EXISTS video_ref_guard_group_broadcasts ON public.group_broadcasts;
CREATE TRIGGER video_ref_guard_group_broadcasts BEFORE INSERT OR UPDATE OF video_ids ON public.group_broadcasts
 FOR EACH ROW EXECUTE FUNCTION public.video_delete_guard_reference('video_ids');
DROP TRIGGER IF EXISTS video_ref_guard_broadcast_schedules ON public.broadcast_schedules;
CREATE TRIGGER video_ref_guard_broadcast_schedules BEFORE INSERT OR UPDATE OF video_ids ON public.broadcast_schedules
 FOR EACH ROW EXECUTE FUNCTION public.video_delete_guard_reference('video_ids');
DROP TRIGGER IF EXISTS video_ref_guard_site_settings ON public.site_settings;
CREATE TRIGGER video_ref_guard_site_settings BEFORE INSERT OR UPDATE OF operating_config ON public.site_settings
 FOR EACH ROW EXECUTE FUNCTION public.video_delete_guard_reference('operating_config');
DROP TRIGGER IF EXISTS video_ref_guard_app_settings ON public.app_settings;
CREATE TRIGGER video_ref_guard_app_settings BEFORE INSERT OR UPDATE OF emergency_video_id ON public.app_settings
 FOR EACH ROW EXECUTE FUNCTION public.video_delete_guard_reference('emergency_video_id');
DROP TRIGGER IF EXISTS video_ref_guard_broadcast ON public.broadcast;
CREATE TRIGGER video_ref_guard_broadcast BEFORE INSERT OR UPDATE OF video_ids ON public.broadcast
 FOR EACH ROW EXECUTE FUNCTION public.video_delete_guard_reference('video_ids');

-- All delete targets are authorized before locks are acquired. All video locks are
-- acquired in UUID order (same advisory key as the existing enqueue RPC).
-- A hospital advisory lock serializes deletes within that hospital, not other sites.
CREATE OR REPLACE FUNCTION public.video_delete_lock_targets(p_site uuid,p_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE vid uuid; owner_id uuid; admin_ok boolean:=coalesce(public.is_admin(),false); has_private boolean:=false;
BEGIN
 IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
  RAISE EXCEPTION '영상 삭제는 READ COMMITTED 트랜잭션에서 실행하세요.' USING ERRCODE='25001';
 END IF;
 PERFORM set_config('lock_timeout','3000',true);
 IF p_ids IS NULL OR cardinality(p_ids)=0 OR array_position(p_ids,NULL::uuid) IS NOT NULL THEN RAISE EXCEPTION '삭제 대상을 선택하세요.'; END IF;
 FOR vid IN SELECT DISTINCT unnest(p_ids) ORDER BY 1 LOOP
  SELECT v.site_id INTO owner_id FROM public.videos v WHERE v.id=vid;
  IF NOT FOUND THEN RAISE EXCEPTION '영상을 찾을 수 없습니다.'; END IF;
  IF (owner_id IS NOT NULL AND owner_id IS DISTINCT FROM p_site)
    OR (NOT admin_ok AND (owner_id IS NULL OR NOT coalesce(public.can_manage_site(owner_id),false))) THEN
   RAISE EXCEPTION '영상 삭제 권한이 없습니다.' USING ERRCODE='42501';
  END IF;
  has_private:=has_private OR owner_id IS NOT NULL;
 END LOOP;
 IF has_private THEN PERFORM pg_advisory_xact_lock(hashtextextended('video-delete-site:'||p_site::text,0)); END IF;
 FOR vid IN SELECT DISTINCT unnest(p_ids) ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(vid::text,0));
  SELECT v.site_id INTO owner_id FROM public.videos v WHERE v.id=vid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '영상이 이미 삭제되었습니다. 다시 불러오세요.'; END IF;
  IF (owner_id IS NOT NULL AND owner_id IS DISTINCT FROM p_site)
    OR (NOT admin_ok AND (owner_id IS NULL OR NOT coalesce(public.can_manage_site(owner_id),false))) THEN
   RAISE EXCEPTION '영상 삭제 권한이 없습니다.' USING ERRCODE='42501';
  END IF;
 END LOOP;
 -- Only rows containing the target videos, and their immediate playlist/room parents.
 -- Reference insertions are fenced by the video row locks above; unrelated writes continue.
 PERFORM a.id FROM public.app_settings a WHERE a.emergency_video_id=ANY(p_ids) ORDER BY a.id FOR UPDATE;
 PERFORM b.id FROM public.broadcast b WHERE b.video_ids && p_ids ORDER BY b.id FOR UPDATE;
 PERFORM b.id FROM public.broadcast_schedules b WHERE b.video_ids && p_ids ORDER BY b.id FOR UPDATE;
 PERFORM b.group_id FROM public.group_broadcasts b WHERE b.video_ids && p_ids ORDER BY b.group_id FOR UPDATE;
 PERFORM p.id FROM public.playlists p WHERE EXISTS(SELECT 1 FROM public.playlist_items i WHERE i.playlist_id=p.id AND i.video_id=ANY(p_ids)) ORDER BY p.id FOR UPDATE;
 PERFORM i.playlist_id FROM public.playlist_items i WHERE i.video_id=ANY(p_ids) ORDER BY i.playlist_id,i.video_id FOR UPDATE;
 PERFORM r.id FROM public.rooms r WHERE r.manual_video_ids && p_ids OR EXISTS(SELECT 1 FROM public.room_video_rules rr WHERE rr.room_id=r.id AND rr.video_id=ANY(p_ids)) ORDER BY r.id FOR UPDATE;
 PERFORM rr.room_id FROM public.room_video_rules rr WHERE rr.video_id=ANY(p_ids) ORDER BY rr.room_id,rr.video_id FOR UPDATE;
 PERFORM b.site_id FROM public.site_broadcasts b WHERE b.video_ids && p_ids ORDER BY b.site_id FOR UPDATE;
 PERFORM s.site_id FROM public.site_settings s WHERE lower(s.operating_config->>'emergency_video_id') IN (SELECT id::text FROM unnest(p_ids) id) ORDER BY s.site_id FOR UPDATE;
END $$;

CREATE OR REPLACE FUNCTION public.video_delete_remove_references(p_video uuid,p_site uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 DELETE FROM public.playlist_items WHERE video_id=p_video;
 DELETE FROM public.room_video_rules WHERE video_id=p_video;
 UPDATE public.rooms SET manual_video_ids=array_remove(manual_video_ids,p_video),manual_active=manual_active AND cardinality(array_remove(manual_video_ids,p_video))>0,manual_updated_at=clock_timestamp() WHERE p_video=ANY(manual_video_ids);
 UPDATE public.site_broadcasts SET video_ids=array_remove(video_ids,p_video),active=active AND cardinality(array_remove(video_ids,p_video))>0,revision=revision+1,updated_at=clock_timestamp() WHERE p_video=ANY(video_ids);
 UPDATE public.group_broadcasts SET video_ids=array_remove(video_ids,p_video),active=active AND cardinality(array_remove(video_ids,p_video))>0,revision=revision+1,updated_at=clock_timestamp() WHERE p_video=ANY(video_ids);
 UPDATE public.broadcast_schedules SET video_ids=array_remove(video_ids,p_video),enabled=enabled AND cardinality(array_remove(video_ids,p_video))>0 WHERE p_video=ANY(video_ids);
 UPDATE public.site_settings SET operating_config=operating_config-'emergency_video_id',updated_at=clock_timestamp() WHERE lower(operating_config->>'emergency_video_id')=p_video::text;
 UPDATE public.app_settings SET emergency_video_id=NULL,updated_at=clock_timestamp() WHERE emergency_video_id=p_video;
 UPDATE public.broadcast SET video_ids=array_remove(video_ids,p_video),active=active AND cardinality(array_remove(video_ids,p_video))>0,revision=revision+1,updated_at=clock_timestamp() WHERE p_video=ANY(video_ids);
 -- Existing authorization, key safety and shared-file checks still run; any failure rolls back all changes.
 RETURN public.video_delete_enqueue(p_video,p_site);
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
  UNION ALL SELECT 'emergency_site',s.site_id::text,s.site_id,'병원 긴급 영상',0,'{}'::jsonb FROM public.site_settings s WHERE lower(s.operating_config->>'emergency_video_id')=p_video::text
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
  UNION ALL SELECT a.id,s.site_id FROM public.site_settings s JOIN allowed a ON lower(s.operating_config->>'emergency_video_id')=a.id::text
  UNION ALL SELECT emergency_video_id,NULL::uuid FROM public.app_settings WHERE emergency_video_id=ANY(p_ids)
  UNION ALL SELECT x.id,NULL::uuid FROM public.broadcast r CROSS JOIN LATERAL (SELECT DISTINCT unnest(r.video_ids) id) x WHERE x.id=ANY(p_ids)
 ), counts AS (SELECT a.id,count(r.video_id) AS n FROM allowed a LEFT JOIN refs r ON r.video_id=a.id GROUP BY a.id HAVING coalesce(public.is_admin(),false) OR count(*) FILTER (WHERE r.video_id IS NOT NULL AND r.site_id IS DISTINCT FROM p_site)=0)
 SELECT coalesce(jsonb_object_agg(id::text,n),'{}'::jsonb) INTO result FROM counts;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.video_delete_confirmed(p_video uuid,p_site uuid,p_signature text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE impact jsonb;
BEGIN
 -- The enqueue RPC authorizes retries against the existing job's hospital.
 IF EXISTS(SELECT 1 FROM public.video_r2_delete_jobs WHERE video_id=p_video) THEN RETURN public.video_delete_enqueue(p_video,p_site); END IF;
 PERFORM public.video_delete_lock_targets(p_site,ARRAY[p_video]);
 impact:=public.video_delete_impact(p_video,p_site);
 IF p_signature IS NULL OR p_signature IS DISTINCT FROM impact->>'signature' THEN RAISE EXCEPTION '사용 위치가 변경되었습니다. 다시 확인 후 삭제하세요.'; END IF;
 RETURN public.video_delete_remove_references(p_video,p_site);
END $$;

CREATE OR REPLACE FUNCTION public.video_delete_batch_confirmed(p_site uuid,p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE item jsonb; vid uuid; impact jsonb; jobs jsonb:='[]'::jsonb; ids uuid[];
BEGIN
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '삭제 대상을 선택하세요.'; END IF;
 IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION '영상은 1~10개씩 삭제하세요.'; END IF;
 SELECT array_agg(DISTINCT (e->>'videoId')::uuid ORDER BY (e->>'videoId')::uuid) INTO ids FROM jsonb_array_elements(p_items) e;
 IF cardinality(ids)<>jsonb_array_length(p_items) OR array_position(ids,NULL::uuid) IS NOT NULL THEN RAISE EXCEPTION '중복되거나 잘못된 영상입니다.'; END IF;
 PERFORM public.video_delete_lock_targets(p_site,ids);
 -- Validate every original preview before modifying anything. No third impact scan is needed.
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  impact:=public.video_delete_impact((item->>'videoId')::uuid,p_site);
  IF item->>'signature' IS NULL OR (item->>'signature') IS DISTINCT FROM (impact->>'signature') THEN RAISE EXCEPTION '사용 위치가 변경되었습니다. 다시 확인 후 삭제하세요.'; END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  vid:=(item->>'videoId')::uuid;
  jobs:=jobs||jsonb_build_array(public.video_delete_remove_references(vid,p_site));
 END LOOP;
 RETURN jobs;
END $$;

REVOKE ALL ON FUNCTION public.video_delete_asset_lock(text,text),public.video_delete_guard_asset_write(),public.video_delete_guard_job_insert(),public.video_delete_guard_reference(),public.video_delete_lock_targets(uuid,uuid[]),public.video_delete_remove_references(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.video_delete_confirmed(uuid,uuid,text),public.video_delete_batch_confirmed(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.video_delete_confirmed(uuid,uuid,text),public.video_delete_batch_confirmed(uuid,jsonb) TO anon,authenticated;
CREATE OR REPLACE FUNCTION public.app_db_version()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('version','2.36.9','features',jsonb_build_array('pairing_v2','display_key_reset','pairing_v3','site_catalog_v1','video_delete_impact_v1','layout_atomic_v1','selected_reload_v1','security_v1','trusted_revoke_v1','video_delete_scoped_v1'))
$$;
INSERT INTO public.schema_version(version,applied_at) VALUES('2.36.9',clock_timestamp()) ON CONFLICT(version) DO UPDATE SET applied_at=excluded.applied_at;
NOTIFY pgrst,'reload schema';
COMMIT;
