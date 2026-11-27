BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version='2.36.1') THEN RAISE EXCEPTION 'Apply v2.36.1-video-delete-impact.sql first'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.hospital_reload_selected_players(p_site uuid,p_rooms uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_count integer;
BEGIN
 IF NOT public.can_manage_site(p_site) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501'; END IF;
 WITH changed AS (
 UPDATE public.rooms r SET reload_nonce=CASE WHEN r.reload_nonce>=2147483646 THEN 1 ELSE r.reload_nonce+1 END
 WHERE r.site_id=p_site AND r.id=ANY(p_rooms) AND coalesce(r.display_control_mode,'remote') IN ('remote','hybrid') RETURNING r.id,r.site_id
 ) INSERT INTO public.player_control_signals(room_id,site_id,revision,updated_at)
 SELECT id,site_id,1,clock_timestamp() FROM changed
 ON CONFLICT(room_id) DO UPDATE SET site_id=excluded.site_id,revision=public.player_control_signals.revision+1,updated_at=excluded.updated_at;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 RETURN v_count;
END $$;
CREATE OR REPLACE FUNCTION public.hospital_save_space_geometry(p_site uuid,p_space uuid,p_before jsonb,p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE old_space public.floor_spaces%ROWTYPE; new_space public.floor_spaces%ROWTYPE; dx numeric; dy numeric; moved jsonb;
BEGIN
 IF NOT public.can_manage_site(p_site) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT old_space FROM public.floor_spaces WHERE id=p_space AND site_id=p_site FOR UPDATE;
 IF ROW(old_space.x_pct,old_space.y_pct,old_space.width_pct,old_space.height_pct) IS DISTINCT FROM ROW((p_before->>'x_pct')::numeric,(p_before->>'y_pct')::numeric,(p_before->>'width_pct')::numeric,(p_before->>'height_pct')::numeric) THEN RAISE EXCEPTION '공간이 다른 관리자에 의해 변경되었습니다. 취소 후 새로고침하세요.'; END IF;
 UPDATE public.floor_spaces SET x_pct=coalesce((p_patch->>'x_pct')::numeric,x_pct),y_pct=coalesce((p_patch->>'y_pct')::numeric,y_pct),width_pct=coalesce((p_patch->>'width_pct')::numeric,width_pct),height_pct=coalesce((p_patch->>'height_pct')::numeric,height_pct),name=coalesce(nullif(trim(p_patch->>'name'),''),name),space_type=coalesce(p_patch->>'space_type',space_type) WHERE id=p_space AND site_id=p_site RETURNING * INTO new_space;
 dx:=new_space.x_pct-old_space.x_pct; dy:=new_space.y_pct-old_space.y_pct;
 PERFORM 1 FROM public.rooms WHERE site_id=p_site AND floor_space_id=p_space FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.rooms WHERE site_id=p_site AND floor_space_id=p_space AND map_x_pct IS NOT NULL AND map_y_pct IS NOT NULL AND (map_x_pct+dx NOT BETWEEN new_space.x_pct AND new_space.x_pct+new_space.width_pct OR map_y_pct+dy NOT BETWEEN new_space.y_pct AND new_space.y_pct+new_space.height_pct)) THEN RAISE EXCEPTION '연결된 TV가 새 공간 영역을 벗어납니다. TV 위치 또는 공간 크기를 조정하세요.'; END IF;
 WITH changed AS (UPDATE public.rooms SET map_x_pct=map_x_pct+dx,map_y_pct=map_y_pct+dy WHERE site_id=p_site AND floor_space_id=p_space AND map_x_pct IS NOT NULL AND map_y_pct IS NOT NULL RETURNING id,map_x_pct,map_y_pct)
 SELECT coalesce(jsonb_agg(to_jsonb(changed)),'[]'::jsonb) INTO moved FROM changed;
 RETURN jsonb_build_object('space',to_jsonb(new_space),'rooms',moved);
END $$;
CREATE OR REPLACE FUNCTION public.hospital_create_placed_displays(p_site uuid,p_space uuid,p_names text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE sp public.floor_spaces%ROWTYPE; nm text; rid uuid; created public.rooms%ROWTYPE; result jsonb:='[]'::jsonb; n integer; i integer:=0;
BEGIN
 IF NOT public.can_manage_site(p_site) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501'; END IF;
 n:=coalesce(cardinality(p_names),0); IF n<1 OR n>6 THEN RAISE EXCEPTION 'TV count must be 1–6'; END IF;
 SELECT * INTO STRICT sp FROM public.floor_spaces WHERE id=p_space AND site_id=p_site FOR UPDATE;
 PERFORM 1 FROM public.signage_groups WHERE id=sp.group_id AND site_id=p_site AND kind='floor' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid floor'; END IF;
 FOREACH nm IN ARRAY p_names LOOP
  IF nullif(trim(nm),'') IS NULL OR length(trim(nm))>40 THEN RAISE EXCEPTION 'TV 이름은 1~40자여야 합니다.'; END IF;
  IF EXISTS(SELECT 1 FROM public.rooms WHERE site_id=p_site AND group_id=sp.group_id AND lower(trim(name))=lower(trim(nm))) THEN RAISE EXCEPTION '같은 층에 같은 이름의 TV가 있습니다.'; END IF;
  i:=i+1;
  rid:=public.hospital_create_display(p_site,sp.group_id,trim(nm),'remote');
  UPDATE public.rooms SET floor_space_id=sp.id,map_x_pct=round(sp.x_pct+sp.width_pct*i/(n+1),2),map_y_pct=round(sp.y_pct+sp.height_pct/2,2) WHERE id=rid AND site_id=p_site RETURNING * INTO STRICT created;
  result:=result||jsonb_build_array(jsonb_build_object('id',created.id,'site_id',created.site_id,'group_id',created.group_id,'name',created.name,'sort_order',created.sort_order,'floor_space_id',created.floor_space_id,'map_x_pct',created.map_x_pct,'map_y_pct',created.map_y_pct,'display_control_mode',created.display_control_mode,'manual_check_status',created.manual_check_status));
 END LOOP;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.hospital_create_space_with_displays(p_site uuid,p_group uuid,p_name text,p_type text,p_x numeric,p_y numeric,p_width numeric,p_height numeric,p_count integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE sp public.floor_spaces%ROWTYPE; names text[]; result jsonb:='[]'::jsonb;
BEGIN
 IF NOT public.can_manage_site(p_site) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501'; END IF;
 IF p_count IS NULL OR p_count NOT BETWEEN 0 AND 6 OR nullif(trim(p_name),'') IS NULL OR length(trim(p_name))>40 THEN RAISE EXCEPTION 'invalid space or TV count'; END IF;
 PERFORM 1 FROM public.signage_groups WHERE id=p_group AND site_id=p_site AND kind='floor' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid floor'; END IF;
 INSERT INTO public.floor_spaces(site_id,group_id,name,space_type,x_pct,y_pct,width_pct,height_pct,sort_order) VALUES(p_site,p_group,trim(p_name),p_type,p_x,p_y,p_width,p_height,(SELECT coalesce(max(sort_order),0)+10 FROM public.floor_spaces WHERE site_id=p_site AND group_id=p_group)) RETURNING * INTO sp;
 IF p_count>0 THEN
  SELECT array_agg(left(trim(p_name),34)||' TV'||CASE WHEN p_count>1 THEN ' '||i::text ELSE '' END ORDER BY i) INTO names FROM generate_series(1,p_count) i;
  result:=public.hospital_create_placed_displays(p_site,sp.id,names);
 END IF;
 RETURN jsonb_build_object('space',to_jsonb(sp),'rooms',result);
END $$;
REVOKE ALL ON FUNCTION public.hospital_reload_selected_players(uuid,uuid[]),public.hospital_save_space_geometry(uuid,uuid,jsonb,jsonb),public.hospital_create_placed_displays(uuid,uuid,text[]),public.hospital_create_space_with_displays(uuid,uuid,text,text,numeric,numeric,numeric,numeric,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hospital_reload_selected_players(uuid,uuid[]),public.hospital_save_space_geometry(uuid,uuid,jsonb,jsonb),public.hospital_create_placed_displays(uuid,uuid,text[]),public.hospital_create_space_with_displays(uuid,uuid,text,text,numeric,numeric,numeric,numeric,integer) TO anon,authenticated;
CREATE OR REPLACE FUNCTION public.app_db_version()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('version','2.36.6','features',jsonb_build_array('pairing_v2','display_key_reset','pairing_v3','site_catalog_v1','video_delete_impact_v1','layout_atomic_v1','selected_reload_v1'))
$$;
INSERT INTO public.schema_version(version,applied_at) VALUES('2.36.6',clock_timestamp()) ON CONFLICT(version) DO UPDATE SET applied_at=excluded.applied_at;
NOTIFY pgrst,'reload schema';
COMMIT;
