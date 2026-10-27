-- Clinic Signage v2.34.48 — display position save / RPC signature normalization
-- Re-runnable. Restores rooms.floor_space_id and leaves exactly one staff_set_display_setup signature.

alter table public.rooms add column if not exists floor_space_id uuid;
alter table public.rooms drop constraint if exists rooms_floor_space_id_fkey;
alter table public.rooms add constraint rooms_floor_space_id_fkey
  foreign key (floor_space_id) references public.floor_spaces(id) on delete set null;
create index if not exists rooms_floor_space_id_idx on public.rooms(floor_space_id);

create or replace function public.enforce_room_floor_space() returns trigger
language plpgsql set search_path=public as $$
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
create trigger rooms_floor_space_guard
before insert or update of site_id,group_id,floor_space_id on public.rooms
for each row execute function public.enforce_room_floor_space();

-- Remove the legacy overload so PostgREST has one canonical RPC only.
drop function if exists public.staff_set_display_setup(uuid,text,numeric,numeric,text);
drop function if exists public.staff_set_display_setup(uuid,text,numeric,numeric,text,uuid);

create function public.staff_set_display_setup(
  p_room uuid,
  p_mode text,
  p_x numeric,
  p_y numeric,
  p_note text default null,
  p_space uuid default null
)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
  v_before jsonb;
  v_after jsonb;
  v_group uuid;
begin
  if public.pin_session_role() not in ('admin','staff') or p_mode not in ('remote','manual','hybrid') then
    raise exception 'not allowed';
  end if;

  select to_jsonb(r),r.group_id into v_before,v_group
  from public.rooms r where r.id=p_room and r.site_id=v_site;
  if v_before is null and public.is_admin() then
    select to_jsonb(r),r.group_id into v_before,v_group from public.rooms r where r.id=p_room;
  end if;
  if v_before is null then raise exception '디스플레이를 찾을 수 없습니다'; end if;

  if p_space is not null and not exists(
    select 1 from public.floor_spaces fs
    where fs.id=p_space
      and fs.site_id=(v_before->>'site_id')::uuid
      and fs.group_id is not distinct from v_group
  ) then
    raise exception '같은 층의 공간만 선택할 수 있습니다';
  end if;

  update public.rooms
  set display_control_mode=p_mode,
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
  perform public.audit_event((v_after->>'site_id')::uuid,'update','display',p_room::text,'디스플레이 설정 변경',v_before,v_after);
end $$;

revoke all on function public.staff_set_display_setup(uuid,text,numeric,numeric,text,uuid) from public;
grant execute on function public.staff_set_display_setup(uuid,text,numeric,numeric,text,uuid) to anon,authenticated;

insert into public.schema_version(version,applied_at)
values('2.34.48',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;

notify pgrst, 'reload schema';
