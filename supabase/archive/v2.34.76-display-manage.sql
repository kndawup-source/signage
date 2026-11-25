-- Clinic Signage v2.34.76 · hospital display rename/delete
-- Safe to re-run. Apply only this migration, not the full schema.

begin;
create or replace function public.hospital_rename_display(p_site uuid,p_room uuid,p_name text)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_group uuid;
  v_name text:=trim(coalesce(p_name,''));
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  if v_name='' then raise exception 'display name required'; end if;
  select group_id into v_group from public.rooms where id=p_room and site_id=p_site;
  if not found then raise exception 'display not found'; end if;
  if exists(select 1 from public.rooms where site_id=p_site and group_id is not distinct from v_group and id<>p_room and lower(trim(name))=lower(v_name)) then
    raise exception 'same display name already exists on this floor';
  end if;
  update public.rooms set name=v_name where id=p_room and site_id=p_site;
end $$;

create or replace function public.hospital_delete_display(p_site uuid,p_room uuid)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_x numeric;
  v_y numeric;
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  select map_x_pct,map_y_pct into v_x,v_y from public.rooms where id=p_room and site_id=p_site;
  if not found then raise exception 'display not found'; end if;
  if v_x is not null or v_y is not null then raise exception 'unplace display before deleting'; end if;
  delete from public.rooms where id=p_room and site_id=p_site;
end $$;

revoke all on function public.hospital_rename_display(uuid,uuid,text), public.hospital_delete_display(uuid,uuid) from public;
grant execute on function public.hospital_rename_display(uuid,uuid,text), public.hospital_delete_display(uuid,uuid) to anon,authenticated;

insert into public.schema_version(version) values('2.34.76') on conflict(version) do update set applied_at=excluded.applied_at;
commit;
notify pgrst,'reload schema';
