-- Clinic Signage v2.34.41
-- Copy floor-space geometry and display map positions from one floor to selected floors.

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
  v_target uuid;
  v_source_count integer;
  v_target_count integer;
  v_target_name text;
  v_applied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  if p_site is null or p_source_group is null or coalesce(array_length(p_target_groups,1),0)=0 then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if public.pin_session_role() not in ('admin','staff') or not public.can_manage_site(p_site) then
    raise exception 'not allowed';
  end if;
  if not exists(select 1 from public.signage_groups g where g.id=p_source_group and g.site_id=p_site) then
    raise exception 'SOURCE_FLOOR_NOT_FOUND';
  end if;
  if coalesce(p_copy_spaces,false)=false and coalesce(p_copy_displays,false)=false then
    raise exception 'NOTHING_TO_COPY';
  end if;

  select count(*) into v_source_count from public.rooms r where r.site_id=p_site and r.group_id=p_source_group;

  foreach v_target in array p_target_groups loop
    if v_target=p_source_group then
      continue;
    end if;
    select g.name into v_target_name from public.signage_groups g where g.id=v_target and g.site_id=p_site;
    if v_target_name is null then
      v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object('id',v_target,'name','알 수 없는 층','reason','TARGET_FLOOR_NOT_FOUND'));
      continue;
    end if;

    if p_copy_displays then
      select count(*) into v_target_count from public.rooms r where r.site_id=p_site and r.group_id=v_target;
      if v_target_count<>v_source_count then
        v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object('id',v_target,'name',v_target_name,'reason','DISPLAY_COUNT_MISMATCH','source_count',v_source_count,'target_count',v_target_count));
        continue;
      end if;
    end if;

    if p_copy_spaces then
      delete from public.floor_spaces where site_id=p_site and group_id=v_target;
      insert into public.floor_spaces(site_id,group_id,name,space_type,x_pct,y_pct,width_pct,height_pct,sort_order)
      select p_site,v_target,fs.name,fs.space_type,fs.x_pct,fs.y_pct,fs.width_pct,fs.height_pct,fs.sort_order
      from public.floor_spaces fs
      where fs.site_id=p_site and fs.group_id=p_source_group
      order by fs.sort_order,fs.created_at;
    end if;

    if p_copy_displays then
      with src as (
        select r.map_x_pct,r.map_y_pct,row_number() over(order by r.sort_order,r.name,r.created_at,r.id) rn
        from public.rooms r where r.site_id=p_site and r.group_id=p_source_group
      ), dst as (
        select r.id,row_number() over(order by r.sort_order,r.name,r.created_at,r.id) rn
        from public.rooms r where r.site_id=p_site and r.group_id=v_target
      )
      update public.rooms r
      set map_x_pct=src.map_x_pct,map_y_pct=src.map_y_pct
      from src join dst on dst.rn=src.rn
      where r.id=dst.id;
    end if;

    perform public.audit_event(
      p_site,'update','floor_layout',v_target::text,'층 도면 배치 복사',
      null,jsonb_build_object('source_group',p_source_group,'target_group',v_target,'copy_spaces',p_copy_spaces,'copy_displays',p_copy_displays)
    );
    v_applied:=v_applied||jsonb_build_array(jsonb_build_object('id',v_target,'name',v_target_name));
  end loop;

  return jsonb_build_object('ok',true,'applied',v_applied,'skipped',v_skipped);
end
$$;

revoke all on function public.hospital_copy_floor_layout(uuid,uuid,uuid[],boolean,boolean) from public;
grant execute on function public.hospital_copy_floor_layout(uuid,uuid,uuid[],boolean,boolean) to anon,authenticated;

insert into public.schema_version(version,applied_at)
values('2.34.41',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;

notify pgrst,'reload schema';
commit;
