begin;

alter table public.site_settings add column if not exists building_asset jsonb;
update public.site_settings set building_asset=coalesce(building_asset,'{}'::jsonb);
alter table public.site_settings alter column building_asset set default '{}'::jsonb;
alter table public.site_settings alter column building_asset set not null;

create or replace function public.hospital_building_asset(p_site uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_site uuid; v_asset jsonb;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  v_site:=case when public.is_admin() then p_site else public.pin_session_site_id() end;
  if v_site is null or not public.can_manage_site(v_site) then raise exception 'not allowed'; end if;
  select coalesce(building_asset,'{}'::jsonb) into v_asset from public.site_settings where site_id=v_site;
  return coalesce(v_asset,'{}'::jsonb);
end $$;
revoke all on function public.hospital_building_asset(uuid) from public;
grant execute on function public.hospital_building_asset(uuid) to anon,authenticated;

create or replace function public.hospital_set_building_asset(p_site uuid,p_asset jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  insert into public.site_settings(site_id,building_asset,updated_at)
  values(p_site,coalesce(p_asset,'{}'::jsonb),clock_timestamp())
  on conflict(site_id) do update set building_asset=excluded.building_asset,updated_at=clock_timestamp();
end $$;
revoke all on function public.hospital_set_building_asset(uuid,jsonb) from public;
grant execute on function public.hospital_set_building_asset(uuid,jsonb) to anon,authenticated;

insert into public.schema_version(version,applied_at)
values('2.34.22',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;

notify pgrst,'reload schema';
commit;
