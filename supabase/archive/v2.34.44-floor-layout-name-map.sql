-- Clinic Signage v2.34.44 — map display coordinates by display name/location key, never row order

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
  v_target_name text;
  v_spaces_copied boolean;
  v_displays_copied boolean;
  v_displays_created integer;
  v_displays_updated integer;
  v_applied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_prefix text;
  v_source_count integer;
  v_source record;
  v_target_room_id uuid;
  v_target_match_count integer;
  v_target_display_name text;
  v_duplicate_key text;
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

  if p_copy_displays then
    select count(*) into v_source_count
    from public.rooms r
    where r.site_id=p_site and r.group_id=p_source_group
      and r.map_x_pct is not null and r.map_y_pct is not null;

    select x.slot_key into v_duplicate_key
    from (
      select regexp_replace(lower(trim(r.name)), '^[^_]+_', '') as slot_key, count(*) as cnt
      from public.rooms r
      where r.site_id=p_site and r.group_id=p_source_group
        and r.map_x_pct is not null and r.map_y_pct is not null
      group by 1
      having count(*)>1
      limit 1
    ) x;
    if v_duplicate_key is not null then
      raise exception 'DUPLICATE_SOURCE_DISPLAY_KEY:%',v_duplicate_key;
    end if;
  else
    v_source_count:=0;
  end if;

  foreach v_target in array p_target_groups loop
    if v_target=p_source_group then continue; end if;

    select g.name into v_target_name
    from public.signage_groups g
    where g.id=v_target and g.site_id=p_site;

    if v_target_name is null then
      v_skipped:=v_skipped||jsonb_build_array(
        jsonb_build_object('id',v_target,'name','알 수 없는 층','reason','TARGET_FLOOR_NOT_FOUND')
      );
      continue;
    end if;

    v_spaces_copied:=false;
    v_displays_copied:=false;
    v_displays_created:=0;
    v_displays_updated:=0;

    if p_copy_spaces then
      delete from public.floor_spaces
      where site_id=p_site and group_id=v_target;

      insert into public.floor_spaces(
        site_id,group_id,name,space_type,x_pct,y_pct,width_pct,height_pct,sort_order
      )
      select p_site,v_target,fs.name,fs.space_type,fs.x_pct,fs.y_pct,fs.width_pct,fs.height_pct,fs.sort_order
      from public.floor_spaces fs
      where fs.site_id=p_site and fs.group_id=p_source_group
      order by fs.sort_order,fs.created_at;

      v_spaces_copied:=true;
    end if;

    if p_copy_displays then
      if v_source_count=0 then
        v_skipped:=v_skipped||jsonb_build_array(
          jsonb_build_object(
            'id',v_target,'name',v_target_name,'reason','SOURCE_HAS_NO_POSITIONED_DISPLAYS',
            'spaces_copied',v_spaces_copied,'displays_copied',false
          )
        );
      else
        v_prefix:=regexp_replace(v_target_name,'[[:space:]]+','','g');

        select x.slot_key into v_duplicate_key
        from (
          select regexp_replace(lower(trim(r.name)), '^[^_]+_', '') as slot_key, count(*) as cnt
          from public.rooms r
          where r.site_id=p_site and r.group_id=v_target
          group by 1
          having count(*)>1
          limit 1
        ) x;
        if v_duplicate_key is not null then
          raise exception 'DUPLICATE_TARGET_DISPLAY_KEY:%:%',v_target_name,v_duplicate_key;
        end if;

        for v_source in
          select r.id,r.name,r.sort_order,r.map_x_pct,r.map_y_pct,r.display_control_mode,
                 regexp_replace(lower(trim(r.name)), '^[^_]+_', '') as slot_key,
                 regexp_replace(trim(r.name), '^[^_]+_', '') as slot_label
          from public.rooms r
          where r.site_id=p_site and r.group_id=p_source_group
            and r.map_x_pct is not null and r.map_y_pct is not null
          order by r.name,r.created_at,r.id
        loop
          select count(*),(array_agg(r.id order by r.id))[1] into v_target_match_count,v_target_room_id
          from public.rooms r
          where r.site_id=p_site and r.group_id=v_target
            and regexp_replace(lower(trim(r.name)), '^[^_]+_', '')=v_source.slot_key;

          if v_target_match_count>1 then
            raise exception 'DUPLICATE_TARGET_DISPLAY_KEY:%:%',v_target_name,v_source.slot_key;
          elsif v_target_match_count=0 then
            v_target_display_name:=case
              when position('_' in trim(v_source.name))>0 then v_prefix||'_'||v_source.slot_label
              else v_prefix||'_'||trim(v_source.name)
            end;

            insert into public.rooms(
              site_id,group_id,name,sort_order,display_control_mode,manual_check_status,map_x_pct,map_y_pct
            ) values(
              p_site,v_target,v_target_display_name,v_source.sort_order,
              coalesce(v_source.display_control_mode,'remote'),
              case when coalesce(v_source.display_control_mode,'remote')='manual' then 'needs_check' else 'not_required' end,
              v_source.map_x_pct,v_source.map_y_pct
            ) returning id into v_target_room_id;
            v_displays_created:=v_displays_created+1;
          else
            update public.rooms r
            set map_x_pct=v_source.map_x_pct,map_y_pct=v_source.map_y_pct
            where r.id=v_target_room_id;
            v_displays_updated:=v_displays_updated+1;
          end if;
        end loop;

        v_displays_copied:=true;
      end if;
    end if;

    if v_spaces_copied or v_displays_copied then
      perform public.audit_event(
        p_site,'update','floor_layout',v_target::text,'층 도면 배치 복사',
        null,jsonb_build_object(
          'source_group',p_source_group,'target_group',v_target,
          'spaces_copied',v_spaces_copied,'displays_copied',v_displays_copied,
          'displays_created',v_displays_created,'displays_updated',v_displays_updated,
          'display_match','name_slot_key'
        )
      );
      v_applied:=v_applied||jsonb_build_array(
        jsonb_build_object(
          'id',v_target,'name',v_target_name,
          'spaces_copied',v_spaces_copied,'displays_copied',v_displays_copied,
          'displays_created',v_displays_created,'displays_updated',v_displays_updated,
          'display_match','name_slot_key'
        )
      );
    end if;
  end loop;

  return jsonb_build_object('ok',true,'applied',v_applied,'skipped',v_skipped);
end
$$;

revoke all on function public.hospital_copy_floor_layout(uuid,uuid,uuid[],boolean,boolean) from public;
grant execute on function public.hospital_copy_floor_layout(uuid,uuid,uuid[],boolean,boolean) to anon,authenticated;

insert into public.schema_version(version,applied_at)
values('2.34.44',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
