-- Apply ONLY after v2.34.96-release-consistency.sql.
-- Safe-copy fix. Does not change the historical migration file.
-- Existing room->space links must be safely remappable, otherwise RPC rolls back.
begin;
create or replace function public.hospital_copy_floor_layout(
  p_site uuid,
  p_source_group uuid,
  p_target_groups uuid[],
  p_copy_spaces boolean default true,
  p_copy_displays boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_target uuid; v_source_count integer; v_target_count integer; v_target_name text;
  v_spaces_copied boolean; v_displays_copied boolean;
  v_room record; v_new_space uuid; v_old_space record;
  v_applied jsonb:='[]'::jsonb; v_skipped jsonb:='[]'::jsonb;
begin
  if p_site is null or p_source_group is null or coalesce(array_length(p_target_groups,1),0)=0 then raise exception 'INVALID_ARGUMENT'; end if;
  if public.pin_session_role() not in ('admin','staff') or not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  if not exists(select 1 from public.signage_groups g where g.id=p_source_group and g.site_id=p_site) then raise exception 'SOURCE_FLOOR_NOT_FOUND'; end if;
  if not coalesce(p_copy_spaces,false) and not coalesce(p_copy_displays,false) then raise exception 'NOTHING_TO_COPY'; end if;
  select count(*) into v_source_count from public.rooms r where r.site_id=p_site and r.group_id=p_source_group;
  foreach v_target in array p_target_groups loop
    if v_target=p_source_group then continue; end if;
    select g.name into v_target_name from public.signage_groups g where g.id=v_target and g.site_id=p_site;
    if v_target_name is null then
      v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object('id',v_target,'name','알 수 없는 층','reason','TARGET_FLOOR_NOT_FOUND'));
      continue;
    end if;
    v_spaces_copied:=false; v_displays_copied:=false;
    if p_copy_spaces then
      -- Validate ALL existing room->space links before removing any target space.
      -- If the new layout cannot represent a linked room, abort the entire RPC
      -- transaction instead of silently setting floor_space_id to NULL.
      for v_room in
        select r.id,r.map_x_pct,r.map_y_pct,s.name as prior_name,s.space_type as prior_type
        from public.rooms r
        join public.floor_spaces s on s.id=r.floor_space_id and s.site_id=p_site and s.group_id=v_target
        where r.site_id=p_site and r.group_id=v_target
      loop
        if not exists (
          select 1 from public.floor_spaces s
          where s.site_id=p_site and s.group_id=p_source_group
            and ((s.name=v_room.prior_name and s.space_type=v_room.prior_type)
              or (v_room.map_x_pct is not null and v_room.map_y_pct is not null
                and v_room.map_x_pct>=s.x_pct and v_room.map_x_pct<=s.x_pct+s.width_pct
                and v_room.map_y_pct>=s.y_pct and v_room.map_y_pct<=s.y_pct+s.height_pct))
        ) then
          raise exception 'TARGET_ROOM_SPACE_UNMAPPABLE (room %): change the layout/positions before copying',v_room.id;
        end if;
      end loop;
      -- Keep room links in a transaction-local snapshot; no links are lost on success.
      create temporary table if not exists pg_temp.signage_copy_room_links (
        room_id uuid primary key, target_group uuid, prior_name text, prior_type text,
        x numeric, y numeric
      ) on commit drop;
      delete from pg_temp.signage_copy_room_links;
      insert into pg_temp.signage_copy_room_links(room_id,target_group,prior_name,prior_type,x,y)
      select r.id,v_target,s.name,s.space_type,r.map_x_pct,r.map_y_pct
      from public.rooms r join public.floor_spaces s on s.id=r.floor_space_id
      where r.site_id=p_site and r.group_id=v_target and s.site_id=p_site;
      delete from public.floor_spaces where site_id=p_site and group_id=v_target;
      insert into public.floor_spaces(site_id,group_id,name,space_type,x_pct,y_pct,width_pct,height_pct,sort_order,patient_context_note,content_reason)
      select p_site,v_target,fs.name,fs.space_type,fs.x_pct,fs.y_pct,fs.width_pct,fs.height_pct,fs.sort_order,fs.patient_context_note,fs.content_reason
      from public.floor_spaces fs where fs.site_id=p_site and fs.group_id=p_source_group
      order by fs.sort_order,fs.created_at;
      for v_room in select * from pg_temp.signage_copy_room_links loop
        select fs.id into v_new_space from public.floor_spaces fs
        where fs.site_id=p_site and fs.group_id=v_target and
          ((fs.name=v_room.prior_name and fs.space_type=v_room.prior_type)
           or (v_room.x is not null and v_room.y is not null
             and v_room.x>=fs.x_pct and v_room.x<=fs.x_pct+fs.width_pct
             and v_room.y>=fs.y_pct and v_room.y<=fs.y_pct+fs.height_pct))
        order by case when fs.name=v_room.prior_name and fs.space_type=v_room.prior_type then 0 else 1 end,
                 fs.sort_order,fs.id limit 1;
        if v_new_space is null then raise exception 'TARGET_ROOM_SPACE_RESTORE_FAILED (room %)',v_room.room_id; end if;
        update public.rooms set floor_space_id=v_new_space where id=v_room.room_id and site_id=p_site and group_id=v_target;
      end loop;
      v_spaces_copied:=true;
    end if;
    if p_copy_displays then
      select count(*) into v_target_count from public.rooms r where r.site_id=p_site and r.group_id=v_target;
      if v_target_count=v_source_count then
        with src as (
          select r.map_x_pct,r.map_y_pct,row_number() over(order by r.sort_order,r.name,r.created_at,r.id) rn
          from public.rooms r where r.site_id=p_site and r.group_id=p_source_group
        ), dst as (
          select r.id,row_number() over(order by r.sort_order,r.name,r.created_at,r.id) rn
          from public.rooms r where r.site_id=p_site and r.group_id=v_target
        )
        update public.rooms r set map_x_pct=src.map_x_pct,map_y_pct=src.map_y_pct
        from src join dst on dst.rn=src.rn where r.id=dst.id;
        v_displays_copied:=true;
      else
        v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object('id',v_target,'name',v_target_name,'reason','DISPLAY_COUNT_MISMATCH','source_count',v_source_count,'target_count',v_target_count,'spaces_copied',v_spaces_copied,'displays_copied',false));
      end if;
    end if;
    if v_spaces_copied or v_displays_copied then
      perform public.audit_event(p_site,'update','floor_layout',v_target::text,'층 도면 배치 복사',null,jsonb_build_object('source_group',p_source_group,'target_group',v_target,'spaces_copied',v_spaces_copied,'displays_copied',v_displays_copied));
      v_applied:=v_applied||jsonb_build_array(jsonb_build_object('id',v_target,'name',v_target_name,'spaces_copied',v_spaces_copied,'displays_copied',v_displays_copied));
    end if;
  end loop;
  return jsonb_build_object('ok',true,'applied',v_applied,'skipped',v_skipped);
end $$;
revoke all on function public.hospital_copy_floor_layout(uuid,uuid,uuid[],boolean,boolean) from public;
grant execute on function public.hospital_copy_floor_layout(uuid,uuid,uuid[],boolean,boolean) to anon,authenticated;
insert into public.schema_version(version,applied_at) values('2.35.01',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
commit;
