-- TEST DB ONLY. All changes, including temporary sessions, are rolled back.
BEGIN;
SET LOCAL search_path=public,extensions;
DO $$
DECLARE admin_id bigint; staff_id bigint; token text:=encode(gen_random_bytes(32),'hex'); staff_token text:=encode(gen_random_bytes(32),'hex'); suffix text:=encode(gen_random_bytes(8),'hex'); a uuid; b uuid; g uuid; r uuid; p uuid; v uuid:=gen_random_uuid(); w uuid:=gen_random_uuid(); common uuid:=gen_random_uuid(); x jsonb; y jsonb; j jsonb; pin text; denied boolean; rv uuid:=gen_random_uuid(); rk text; ru text;
BEGIN
 IF NOT (public.app_db_version()->'features' ? 'video_delete_scoped_v1') THEN RAISE EXCEPTION 'Apply v2.36.9 first'; END IF;
 SELECT id INTO admin_id FROM public.pin_accounts WHERE role='admin' AND enabled LIMIT 1;
 IF admin_id IS NULL THEN RAISE EXCEPTION 'Configure a test admin first'; END IF;
 INSERT INTO public.pin_sessions(account_id,token_hash,expires_at) VALUES(admin_id,digest(token,'sha256'),now()+interval '1 hour');
 PERFORM set_config('request.headers',jsonb_build_object('x-signage-session',token)::text,true);
 LOOP pin:=lpad((floor(random()*1000000)::int)::text,6,'0'); EXIT WHEN NOT EXISTS(SELECT 1 FROM public.pin_accounts WHERE enabled AND crypt(pin,pin_hash)=pin_hash); END LOOP;
 x:=public.admin_onboard_site('QA delete A','qa_del_a_'||suffix,pin,'QA',1); a:=(x#>>'{site,id}')::uuid;
 LOOP pin:=lpad((floor(random()*1000000)::int)::text,6,'0'); EXIT WHEN NOT EXISTS(SELECT 1 FROM public.pin_accounts WHERE enabled AND crypt(pin,pin_hash)=pin_hash); END LOOP;
 x:=public.admin_onboard_site('QA delete B','qa_del_b_'||suffix,pin,'QA',1); b:=(x#>>'{site,id}')::uuid;
 SELECT id INTO staff_id FROM public.pin_accounts WHERE role='staff' AND site_id=a;
 INSERT INTO public.pin_sessions(account_id,token_hash,expires_at) VALUES(staff_id,digest(staff_token,'sha256'),now()+interval '1 hour');
 SELECT id INTO g FROM public.signage_groups WHERE site_id=a AND kind='floor' LIMIT 1;
 INSERT INTO public.rooms(site_id,group_id,name) VALUES(a,g,'QA TV') RETURNING id INTO r;
 INSERT INTO public.videos(id,site_id,title,source,active) VALUES(v,a,'QA remove','legacy',true),(w,a,'QA keep','legacy',true),(common,NULL,'QA common','legacy',true);
 INSERT INTO public.playlists(site_id,name) VALUES(a,'QA list '||suffix) RETURNING id INTO p;
 INSERT INTO public.playlist_items(playlist_id,video_id,sort_order) VALUES(p,v,10),(p,w,20);
 UPDATE public.rooms SET default_playlist_id=p,manual_video_ids=ARRAY[v,w],manual_active=true WHERE id=r;
 INSERT INTO public.room_video_rules(room_id,video_id) VALUES(r,v);
 INSERT INTO public.site_broadcasts(site_id,video_ids,active) VALUES(a,ARRAY[v,w],true) ON CONFLICT(site_id) DO UPDATE SET video_ids=excluded.video_ids,active=true;
 INSERT INTO public.group_broadcasts(group_id,video_ids,active) VALUES(g,ARRAY[v],true) ON CONFLICT(group_id) DO UPDATE SET video_ids=excluded.video_ids,active=true;
 INSERT INTO public.broadcast_schedules(site_id,scope_type,group_id,video_ids,starts_at,ends_at,enabled) VALUES(a,'group',g,ARRAY[v,w],now()+interval '1 hour',now()+interval '2 hours',true);
 INSERT INTO public.site_settings(site_id,operating_config) VALUES(a,jsonb_build_object('emergency_video_id',v::text)) ON CONFLICT(site_id) DO UPDATE SET operating_config=excluded.operating_config;
 -- Staff can see and delete their own references, not global or another hospital's metadata.
 PERFORM set_config('request.headers',jsonb_build_object('x-signage-session',staff_token)::text,true);
 x:=public.video_delete_impact(v,a);
 IF (x->>'count')::int<>7 OR NOT (x->'tvs' @> jsonb_build_array(jsonb_build_object('id',r))) THEN RAISE EXCEPTION 'Unexpected references: %',x; END IF;
 y:=public.video_usage_counts(a,ARRAY[v,w,common]); IF (y->>v::text)::int<>7 OR y ? common::text THEN RAISE EXCEPTION 'Counts isolation failed: %',y; END IF;
 denied:=false; BEGIN PERFORM public.video_delete_impact(common,a); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END; IF NOT denied THEN RAISE EXCEPTION 'Common preview unexpectedly allowed'; END IF;
 denied:=false; BEGIN PERFORM public.video_usage_counts(b,ARRAY[v]); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END; IF NOT denied THEN RAISE EXCEPTION 'Other site counts unexpectedly allowed'; END IF;
 denied:=false; BEGIN PERFORM public.video_delete_confirmed(v,a,'bad'); EXCEPTION WHEN raise_exception THEN denied:=true; END; IF NOT denied OR NOT EXISTS(SELECT 1 FROM public.videos WHERE id=v) THEN RAISE EXCEPTION 'Invalid signature not rejected'; END IF;
 j:=public.video_delete_confirmed(v,a,x->>'signature');
 IF j->>'status'<>'pending' OR EXISTS(SELECT 1 FROM public.videos WHERE id=v) OR NOT EXISTS(SELECT 1 FROM public.playlist_items WHERE playlist_id=p AND video_id=w) OR NOT EXISTS(SELECT 1 FROM public.playlists WHERE id=p) THEN RAISE EXCEPTION 'Reference deletion failed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.rooms WHERE id=r AND manual_active AND manual_video_ids=ARRAY[w]) OR EXISTS(SELECT 1 FROM public.group_broadcasts WHERE group_id=g AND active) OR NOT EXISTS(SELECT 1 FROM public.broadcast_schedules WHERE site_id=a AND enabled AND video_ids=ARRAY[w]) THEN RAISE EXCEPTION 'Remaining video/empty broadcast behavior failed'; END IF;

 -- Verify that confirmed deletion did not acquire a write-blocking table lock.
 IF EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='relation' AND granted
  AND relation=ANY(ARRAY['public.app_settings'::regclass,'public.broadcast'::regclass,'public.broadcast_schedules'::regclass,'public.group_broadcasts'::regclass,'public.playlist_items'::regclass,'public.playlists'::regclass,'public.room_video_rules'::regclass,'public.rooms'::regclass,'public.signage_groups'::regclass,'public.site_broadcasts'::regclass,'public.site_settings'::regclass,'public.sites'::regclass,'public.videos'::regclass]::oid[])
  AND mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')) THEN RAISE EXCEPTION 'Unexpected write-blocking table lock'; END IF;
 denied:=false; BEGIN UPDATE public.site_broadcasts SET video_ids=array_append(video_ids,v) WHERE site_id=a; EXCEPTION WHEN foreign_key_violation THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Stale array reference accepted'; END IF;
 denied:=false; BEGIN UPDATE public.site_settings SET operating_config=jsonb_set(operating_config,'{emergency_video_id}',to_jsonb(v::text)) WHERE site_id=a; EXCEPTION WHEN foreign_key_violation THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Stale JSON reference accepted'; END IF;
 -- Scoped R2 deletion reserves the old object path and URL against stale retry races.
 rk:='sites/'||a::text||'/videos/'||rv::text||'.mp4'; ru:='https://example.invalid/'||rk;
 INSERT INTO public.videos(id,site_id,title,source,storage_path,url,active) VALUES(rv,a,'QA R2','r2',rk,ru,true);
 x:=public.video_delete_impact(rv,a); j:=public.video_delete_confirmed(rv,a,x->>'signature');
 IF j->>'object_key' IS DISTINCT FROM rk OR NOT EXISTS(SELECT 1 FROM public.video_r2_delete_jobs WHERE video_id=rv AND source_url_hash=md5(ru)) THEN RAISE EXCEPTION 'R2 identity not captured'; END IF;
 denied:=false; BEGIN INSERT INTO public.videos(site_id,title,source,storage_path,active) VALUES(a,'QA reused path','r2',rk,true); EXCEPTION WHEN unique_violation THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Queued path reused'; END IF;
 denied:=false; BEGIN INSERT INTO public.videos(site_id,title,source,url,active) VALUES(a,'QA reused URL','legacy',ru,true); EXCEPTION WHEN unique_violation THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Queued URL reused'; END IF;
 -- Admin global references, including legacy and global emergency, and a shared playlist batch.
 PERFORM set_config('request.headers',jsonb_build_object('x-signage-session',token)::text,true);
 UPDATE public.broadcast SET video_ids=array_append(video_ids,common) WHERE id=1;
 UPDATE public.app_settings SET emergency_video_id=common WHERE id=1;
 INSERT INTO public.playlist_items(playlist_id,video_id,sort_order) VALUES(p,common,30);
 x:=public.video_delete_impact(common,a); y:=public.video_delete_impact(w,a);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(x->'links') l WHERE l->>'kind'='legacy') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(x->'links') l WHERE l->>'kind'='emergency_global') THEN RAISE EXCEPTION 'Missing global links'; END IF;
 j:=public.video_delete_batch_confirmed(a,jsonb_build_array(jsonb_build_object('videoId',common,'signature',x->>'signature'),jsonb_build_object('videoId',w,'signature',y->>'signature')));
 IF jsonb_array_length(j)<>2 OR EXISTS(SELECT 1 FROM public.videos WHERE id IN (common,w)) OR NOT EXISTS(SELECT 1 FROM public.playlists WHERE id=p) OR EXISTS(SELECT 1 FROM public.playlist_items WHERE playlist_id=p) THEN RAISE EXCEPTION 'Batch failed'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: references, counts, tenant permissions, stale signature, single/batch deletion, scoped locks, stale references, R2 identity' AS result;
