-- Clinic Signage v2.33.5 — current hospital identity + slug-safe default-site lookup
-- Safe to rerun. Only converts the legacy Clinic Signage/default identity.

begin;

update public.app_settings
set site_name='미니쉬치과병원',
    updated_at=clock_timestamp()
where id=1
  and (site_name is null or btrim(site_name)='' or lower(btrim(site_name))='clinic signage');

do $$
begin
  -- Rename only the legacy default Clinic Signage row. Never overwrite an existing minish slug.
  if exists (
    select 1 from public.sites
    where code='default'
      and (name is null or btrim(name)='' or lower(btrim(name))='clinic signage')
  ) and not exists (
    select 1 from public.sites where code='minish'
  ) then
    update public.sites
    set code='minish',
        name='미니쉬치과병원',
        updated_at=clock_timestamp()
    where code='default'
      and (name is null or btrim(name)='' or lower(btrim(name))='clinic signage');
  end if;

  -- If the slug was already changed separately, normalize only the old placeholder name.
  update public.sites
  set name='미니쉬치과병원',
      updated_at=clock_timestamp()
  where lower(btrim(name))='clinic signage';
end
$$;

-- Slug changes must never break fallback site resolution.
create or replace function public.default_site_id()
returns uuid
language sql
stable
security definer
set search_path=public
as $$
  select id
  from public.sites
  where active is not false
  order by created_at,id
  limit 1;
$$;

revoke all on function public.default_site_id() from public,anon,authenticated;
grant execute on function public.default_site_id() to service_role,postgres;

commit;

select pg_notify('pgrst','reload schema');
