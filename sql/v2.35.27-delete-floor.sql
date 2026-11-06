-- Clinic Signage v2.35.27: protected physical-floor deletion.
-- Apply once to Supabase SQL Editor before deploying the hospital UI.
-- Only an unused floor may be deleted. No cascading removal of TV/space/broadcast data.
begin;
create or replace function public.hospital_delete_floor(p_site uuid, p_group uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_floor int;
begin
  if public.pin_session_role() not in ('admin','staff') or not public.can_manage_site(p_site) then
    raise exception 'not allowed';
  end if;
  select g.floor_number into v_floor from public.signage_groups g
    where g.id=p_group and g.site_id=p_site and g.floor_number is not null for update;
  if not found then raise exception '이 병원의 층을 찾을 수 없습니다'; end if;
  if exists(select 1 from public.rooms where site_id=p_site and group_id=p_group) then
    raise exception 'TV가 연결된 층은 삭제할 수 없습니다';
  end if;
  if exists(select 1 from public.floor_spaces where site_id=p_site and group_id=p_group) then
    raise exception '공간이 연결된 층은 삭제할 수 없습니다';
  end if;
  if exists(select 1 from public.broadcast_schedules where group_id=p_group) then
    raise exception '방송 예약이 연결된 층은 삭제할 수 없습니다';
  end if;
  if exists(select 1 from public.group_broadcasts where group_id=p_group) then
    raise exception '층 방송 설정이 연결되어 있어 삭제할 수 없습니다';
  end if;
  delete from public.signage_groups where id=p_group and site_id=p_site and floor_number is not null;
  if not found then raise exception '층 삭제에 실패했습니다'; end if;
end $$;
revoke all on function public.hospital_delete_floor(uuid,uuid) from public;
grant execute on function public.hospital_delete_floor(uuid,uuid) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
