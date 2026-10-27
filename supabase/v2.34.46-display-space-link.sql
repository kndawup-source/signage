-- v2.34.46
-- Multiple displays may belong to the same floor space.

alter table public.rooms add column if not exists floor_space_id uuid;
alter table public.rooms drop constraint if exists rooms_floor_space_id_fkey;
alter table public.rooms add constraint rooms_floor_space_id_fkey foreign key (floor_space_id) references public.floor_spaces(id) on delete set null;
create index if not exists rooms_floor_space_id_idx on public.rooms(floor_space_id);

create or replace function public.enforce_room_floor_space()
returns trigger language plpgsql set search_path=public as $$
declare sp public.floor_spaces%rowtype;
begin
  if new.floor_space_id is null then return new; end if;
  select * into sp from public.floor_spaces where id=new.floor_space_id;
  if sp.id is null then raise exception '공간을 찾을 수 없습니다'; end if;
  if new.site_id is distinct from sp.site_id then raise exception '다른 병원의 공간은 연결할 수 없습니다'; end if;
  if new.group_id is distinct from sp.group_id then raise exception '다른 층의 공간은 연결할 수 없습니다'; end if;
  return new;
end $$;

drop trigger if exists rooms_floor_space_guard on public.rooms;
create trigger rooms_floor_space_guard before insert or update of site_id,group_id,floor_space_id on public.rooms for each row execute function public.enforce_room_floor_space();

create or replace function public.staff_set_display_setup(p_room uuid,p_mode text,p_x numeric,p_y numeric,p_note text,p_space uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id()); v_before jsonb; v_after jsonb; v_group uuid;
begin
  if public.pin_session_role() not in ('admin','staff') or p_mode not in ('remote','manual','hybrid') then raise exception 'not allowed'; end if;
  select to_jsonb(r),r.group_id into v_before,v_group from public.rooms r where r.id=p_room and r.site_id=v_site;
  if v_before is null and public.is_admin() then select to_jsonb(r),r.group_id into v_before,v_group from public.rooms r where r.id=p_room; end if;
  if v_before is null then raise exception '디스플레이를 찾을 수 없습니다'; end if;
  if p_space is not null and not exists(select 1 from public.floor_spaces fs where fs.id=p_space and fs.site_id=(v_before->>'site_id')::uuid and fs.group_id is not distinct from v_group) then raise exception '같은 층의 공간만 선택할 수 있습니다'; end if;
  update public.rooms set display_control_mode=p_mode,map_x_pct=case when p_x is null then null else greatest(0,least(100,p_x)) end,map_y_pct=case when p_y is null then null else greatest(0,least(100,p_y)) end,display_note=nullif(trim(coalesce(p_note,'')),''),floor_space_id=p_space where id=p_room;
  update public.rooms set manual_check_status=case when display_control_mode='manual' and manual_check_status='not_required' then 'needs_check' when display_control_mode<>'manual' then 'not_required' else manual_check_status end where id=p_room;
  select to_jsonb(r) into v_after from public.rooms r where r.id=p_room;
  perform public.audit_event((v_after->>'site_id')::uuid,'update','display',p_room::text,'디스플레이 설정 변경',v_before,v_after);
end $$;
revoke all on function public.staff_set_display_setup(uuid,text,numeric,numeric,text,uuid) from public;
grant execute on function public.staff_set_display_setup(uuid,text,numeric,numeric,text,uuid) to anon,authenticated;

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
  v_source_count integer;
  v_source record;
  v_target_room_id uuid;
  v_target_match_count integer;
  v_target_display_name text;
  v_duplicate_key text;
  v_source_key text;
  v_target_floor integer;
  v_target_space_id uuid;
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
      select public.hospital_display_slot_key(r.name) as slot_key, count(*) as cnt
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

    select g.name,g.floor_number into v_target_name,v_target_floor
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
      delete from public.floor_spaces where site_id=p_site and group_id=v_target;
      insert into public.floor_spaces(site_id,group_id,name,space_type,x_pct,y_pct,width_pct,height_pct,sort_order)
      select p_site,v_target,fs.name,fs.space_type,fs.x_pct,fs.y_pct,fs.width_pct,fs.height_pct,fs.sort_order
      from public.floor_spaces fs
      where fs.site_id=p_site and fs.group_id=p_source_group
      order by fs.sort_order,fs.created_at;
      v_spaces_copied:=true;
    end if;

    if p_copy_displays then
      if v_source_count=0 then
        v_skipped:=v_skipped||jsonb_build_array(
          jsonb_build_object('id',v_target,'name',v_target_name,'reason','SOURCE_HAS_NO_POSITIONED_DISPLAYS','spaces_copied',v_spaces_copied,'displays_copied',false)
        );
      else
        select x.slot_key into v_duplicate_key
        from (
          select public.hospital_display_slot_key(r.name) as slot_key, count(*) as cnt
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
          select r.id,r.name,r.sort_order,r.map_x_pct,r.map_y_pct,r.display_control_mode,r.floor_space_id,
                 public.hospital_display_slot_key(r.name) as slot_key
          from public.rooms r
          where r.site_id=p_site and r.group_id=p_source_group
            and r.map_x_pct is not null and r.map_y_pct is not null
          order by r.name,r.created_at,r.id
        loop
          v_source_key:=v_source.slot_key;
          v_target_space_id:=null;
          if v_source.floor_space_id is not null then
            select t.id into v_target_space_id
            from public.floor_spaces s
            join public.floor_spaces t
              on t.site_id=p_site and t.group_id=v_target
             and t.name=s.name and t.space_type=s.space_type and t.sort_order=s.sort_order
            where s.id=v_source.floor_space_id
            order by t.created_at,t.id
            limit 1;
          end if;
          select count(*),min(r.id) into v_target_match_count,v_target_room_id
          from public.rooms r
          where r.site_id=p_site and r.group_id=v_target
            and public.hospital_display_slot_key(r.name)=v_source_key;

          if v_target_match_count>1 then
            raise exception 'DUPLICATE_TARGET_DISPLAY_KEY:%:%',v_target_name,v_source_key;
          elsif v_target_match_count=0 then
            -- Preserve the source location code, but use the target floor as prefix when available.
            v_target_display_name:=case
              when v_target_floor is not null then
                v_target_floor::text||'F_'||regexp_replace(trim(v_source.name),'^[[:space:]]*[0-9]+[[:space:]]*(f|층)?[[:space:]_\-./]*','','i')
              else
                trim(v_target_name)||'_'||regexp_replace(trim(v_source.name),'^[[:space:]]*[0-9]+[[:space:]]*(f|층)?[[:space:]_\-./]*','','i')
            end;

            insert into public.rooms(site_id,group_id,name,sort_order,display_control_mode,manual_check_status,map_x_pct,map_y_pct,floor_space_id)
            values(
              p_site,v_target,v_target_display_name,v_source.sort_order,
              coalesce(v_source.display_control_mode,'remote'),
              case when coalesce(v_source.display_control_mode,'remote')='manual' then 'needs_check' else 'not_required' end,
              v_source.map_x_pct,v_source.map_y_pct,v_target_space_id
            ) returning id into v_target_room_id;
            v_displays_created:=v_displays_created+1;
          else
            update public.rooms r
            set map_x_pct=v_source.map_x_pct,map_y_pct=v_source.map_y_pct,floor_space_id=v_target_space_id
            where r.id=v_target_room_id;
            v_displays_updated:=v_displays_updated+1;
          end if;
        end loop;
        v_displays_copied:=true;
      end if;
    end if;

    if v_spaces_copied or v_displays_copied then
      perform public.audit_event(
        p_site,'update','floor_layout',v_target::text,'층 도면 배치 복사',null,
        jsonb_build_object('source_group',p_source_group,'target_group',v_target,'spaces_copied',v_spaces_copied,'displays_copied',v_displays_copied,'displays_created',v_displays_created,'displays_updated',v_displays_updated,'display_match','normalized_location_key')
      );
      v_applied:=v_applied||jsonb_build_array(
        jsonb_build_object('id',v_target,'name',v_target_name,'spaces_copied',v_spaces_copied,'displays_copied',v_displays_copied,'displays_created',v_displays_created,'displays_updated',v_displays_updated,'display_match','normalized_location_key')
      );
    end if;
  end loop;

  return jsonb_build_object('ok',true,'applied',v_applied,'skipped',v_skipped);
end
$$;


revoke all on function public.hospital_copy_floor_layout(uuid,uuid,uuid[],boolean,boolean) from public;
grant execute on function public.hospital_copy_floor_layout(uuid,uuid,uuid[],boolean,boolean) to anon,authenticated;

insert into public.schema_version(version,applied_at) values('2.34.46',clock_timestamp()) on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
