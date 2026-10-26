begin;

-- Clinic Signage v2.34.32 · hospital runtime / canonical install repairs

-- 1) Building asset support must exist on both upgraded and fresh installs.
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

-- 2) Normalize legacy TIME::text values (HH:MM:SS) to the UI/API contract (HH:MM).
update public.site_settings
set operating_config = jsonb_strip_nulls(operating_config || jsonb_build_object(
  'weekday_start', case when coalesce(operating_config->>'weekday_start','') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:[.][0-9]+)?)?$' then left(operating_config->>'weekday_start',5) else operating_config->>'weekday_start' end,
  'weekday_end', case when coalesce(operating_config->>'weekday_end','') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:[.][0-9]+)?)?$' then left(operating_config->>'weekday_end',5) else operating_config->>'weekday_end' end,
  'saturday_start', case when coalesce(operating_config->>'saturday_start','') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:[.][0-9]+)?)?$' then left(operating_config->>'saturday_start',5) else operating_config->>'saturday_start' end,
  'saturday_end', case when coalesce(operating_config->>'saturday_end','') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:[.][0-9]+)?)?$' then left(operating_config->>'saturday_end',5) else operating_config->>'saturday_end' end,
  'sunday_start', case when coalesce(operating_config->>'sunday_start','') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:[.][0-9]+)?)?$' then left(operating_config->>'sunday_start',5) else operating_config->>'sunday_start' end,
  'sunday_end', case when coalesce(operating_config->>'sunday_end','') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:[.][0-9]+)?)?$' then left(operating_config->>'sunday_end',5) else operating_config->>'sunday_end' end
)), updated_at=clock_timestamp()
where operating_config is not null;

create or replace function public.hospital_save_operating_config(p_site uuid,p_config jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare c jsonb; oldc jsonb; k text; v text;
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  foreach k in array array['weekday_start','weekday_end','saturday_start','saturday_end','sunday_start','sunday_end'] loop
    v:=coalesce(p_config->>k,'');
    if v !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:[.][0-9]+)?)?$' then raise exception '% must be HH:MM',k; end if;
    p_config:=jsonb_set(p_config,array[k],to_jsonb(left(v,5)),true);
  end loop;
  foreach k in array array['weekday_enabled','saturday_enabled','sunday_enabled'] loop
    v:=lower(coalesce(p_config->>k,'')); if v not in ('true','false') then raise exception '% must be boolean',k; end if;
  end loop;
  select coalesce(operating_config,'{}'::jsonb) into oldc from public.site_settings where site_id=p_site;
  c:=jsonb_strip_nulls(jsonb_build_object(
    'weekday_enabled',(p_config->>'weekday_enabled')::boolean,'weekday_start',p_config->>'weekday_start','weekday_end',p_config->>'weekday_end',
    'saturday_enabled',(p_config->>'saturday_enabled')::boolean,'saturday_start',p_config->>'saturday_start','saturday_end',p_config->>'saturday_end',
    'sunday_enabled',(p_config->>'sunday_enabled')::boolean,'sunday_start',p_config->>'sunday_start','sunday_end',p_config->>'sunday_end',
    'early_closed_date',coalesce(nullif(p_config->>'early_closed_date',''),nullif(oldc->>'early_closed_date','')),
    'emergency_video_id',nullif(p_config->>'emergency_video_id','')
  ));
  insert into public.site_settings(site_id,operating_config,updated_at) values(p_site,c,clock_timestamp())
  on conflict(site_id) do update set operating_config=excluded.operating_config,updated_at=clock_timestamp();
  perform public.signal_site_rooms(p_site);
end $$;
revoke all on function public.hospital_save_operating_config(uuid,jsonb) from public;
grant execute on function public.hospital_save_operating_config(uuid,jsonb) to anon,authenticated;

insert into public.schema_version(version,applied_at)
values('2.34.32',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;

notify pgrst,'reload schema';
commit;
