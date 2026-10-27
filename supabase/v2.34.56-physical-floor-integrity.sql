-- Clinic Signage v2.34.56 — physical floor integrity + canonical display position save
begin;

-- A hospital floor must exist independently from whether a content strategy was configured.
-- MINISH is a 14-floor building: guarantee exactly one canonical floor row for 1F..14F.
with target as (
  select id from public.sites where code='minish' limit 1
), floors as (
  select generate_series(1,14)::smallint as floor_number
)
insert into public.signage_groups(site_id,name,kind,floor_number,care_type,sort_order)
select t.id, f.floor_number::text||'층', 'floor', f.floor_number, 'other', 100-f.floor_number
from target t cross join floors f
where not exists (
  select 1 from public.signage_groups g
  where g.site_id=t.id and g.kind='floor' and g.floor_number=f.floor_number
);

-- Keep requested editable names/content only where strategy was explicitly defined.
-- Missing floors (3F/11F/12F) deliberately keep neutral DB names until edited by admin.

-- Position saving must canonicalize the display to the selected physical floor in the same statement.
drop function if exists public.staff_set_display_setup(uuid,text,numeric,numeric,text,uuid,uuid);
create or replace function public.staff_set_display_setup(
  p_room uuid,
  p_mode text,
  p_x numeric,
  p_y numeric,
  p_note text default null,
  p_space uuid default null,
  p_group uuid default null
)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
  v_before jsonb;
  v_after jsonb;
  v_current_group uuid;
  v_target_group uuid;
  v_room_site uuid;
begin
  if public.pin_session_role() not in ('admin','staff') or p_mode not in ('remote','manual','hybrid') then
    raise exception 'not allowed';
  end if;

  select to_jsonb(r),r.group_id,r.site_id
    into v_before,v_current_group,v_room_site
  from public.rooms r
  where r.id=p_room and r.site_id=v_site;

  if v_before is null and public.is_admin() then
    select to_jsonb(r),r.group_id,r.site_id
      into v_before,v_current_group,v_room_site
    from public.rooms r where r.id=p_room;
  end if;
  if v_before is null then raise exception '디스플레이를 찾을 수 없습니다'; end if;

  v_target_group:=coalesce(p_group,v_current_group);
  if not exists(
    select 1 from public.signage_groups g
    where g.id=v_target_group and g.site_id=v_room_site and g.kind='floor'
  ) then
    raise exception '올바른 층을 선택하세요';
  end if;

  if p_space is not null and not exists(
    select 1 from public.floor_spaces fs
    where fs.id=p_space and fs.site_id=v_room_site and fs.group_id=v_target_group
  ) then
    raise exception '같은 층의 공간만 선택할 수 있습니다';
  end if;

  update public.rooms
  set group_id=v_target_group,
      display_control_mode=p_mode,
      map_x_pct=case when p_x is null then null else greatest(0,least(100,p_x)) end,
      map_y_pct=case when p_y is null then null else greatest(0,least(100,p_y)) end,
      display_note=nullif(trim(coalesce(p_note,'')),''),
      floor_space_id=p_space
  where id=p_room;

  update public.rooms
  set manual_check_status=case
    when display_control_mode='manual' and manual_check_status='not_required' then 'needs_check'
    when display_control_mode<>'manual' then 'not_required'
    else manual_check_status end
  where id=p_room;

  select to_jsonb(r) into v_after from public.rooms r where r.id=p_room;
  perform public.audit_event(v_room_site,'update','display',p_room::text,'디스플레이 설정 변경',v_before,v_after);
end $$;
revoke all on function public.staff_set_display_setup(uuid,text,numeric,numeric,text,uuid,uuid) from public;
grant execute on function public.staff_set_display_setup(uuid,text,numeric,numeric,text,uuid,uuid) to anon,authenticated;

insert into public.schema_version(version,applied_at) values('2.34.56',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst, 'reload schema';
commit;
