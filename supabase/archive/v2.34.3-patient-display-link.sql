-- Clinic Signage v2.34.3
-- 병원 어드민에서 선택한 디스플레이의 환자 화면 링크를 안전하게 조회한다.

create or replace function public.hospital_room_player_path(p_room uuid)
returns text
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  v_site uuid;
  v_key uuid;
begin
  select r.site_id, r.player_key
    into v_site, v_key
  from public.rooms r
  where r.id = p_room;

  if v_site is null or v_key is null then
    raise exception 'display not found';
  end if;

  if not public.can_manage_site(v_site) then
    raise exception 'not allowed';
  end if;

  return '/player.html?key=' || v_key::text;
end $$;

revoke all on function public.hospital_room_player_path(uuid) from public;
grant execute on function public.hospital_room_player_path(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
