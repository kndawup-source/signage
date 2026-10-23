-- Clinic Signage v2.33.2 — site compatibility / 400 recovery
-- Safe to rerun after partially applied v2.33.0/v2.33.1 migrations.

begin;

-- sites may already exist from a partial migration. CREATE TABLE IF NOT EXISTS
-- does not add missing columns, so explicitly repair the expected canonical shape.
create table if not exists public.sites (
  id uuid primary key default gen_random_uuid()
);

alter table public.sites add column if not exists code text;
alter table public.sites add column if not exists name text;
alter table public.sites add column if not exists building_label text;
alter table public.sites add column if not exists brand_color text;
alter table public.sites add column if not exists active boolean;
alter table public.sites add column if not exists created_at timestamptz;
alter table public.sites add column if not exists updated_at timestamptz;

alter table public.sites alter column id set default gen_random_uuid();
alter table public.sites alter column building_label set default 'MAIN BUILDING';
alter table public.sites alter column active set default true;
alter table public.sites alter column created_at set default clock_timestamp();
alter table public.sites alter column updated_at set default clock_timestamp();

update public.sites
set code = coalesce(nullif(code,''), 'site-' || substr(id::text,1,8)),
    name = coalesce(nullif(name,''), 'CLINIC SIGNAGE'),
    building_label = coalesce(nullif(building_label,''), 'MAIN BUILDING'),
    active = coalesce(active,true),
    created_at = coalesce(created_at,clock_timestamp()),
    updated_at = coalesce(updated_at,clock_timestamp());

alter table public.sites alter column code set not null;
alter table public.sites alter column name set not null;
alter table public.sites alter column building_label set not null;
alter table public.sites alter column active set not null;
alter table public.sites alter column created_at set not null;
alter table public.sites alter column updated_at set not null;

create unique index if not exists sites_code_uidx on public.sites(code);

-- Legacy app settings compatibility.
alter table public.app_settings add column if not exists site_name text not null default 'CLINIC SIGNAGE';
alter table public.app_settings add column if not exists building_label text not null default 'MAIN BUILDING';
alter table public.app_settings add column if not exists floorplan_assets jsonb not null default '{}'::jsonb;

-- Ensure default site exists.
insert into public.sites(code,name,building_label)
select
  'default',
  coalesce(nullif((select site_name from public.app_settings where id=1),''),'CLINIC SIGNAGE'),
  coalesce(nullif((select building_label from public.app_settings where id=1),''),'MAIN BUILDING')
where not exists(select 1 from public.sites where code='default');

create or replace function public.default_site_id()
returns uuid
language sql
stable
security definer
set search_path=public
as $$
  select id from public.sites where code='default' order by created_at limit 1;
$$;
revoke all on function public.default_site_id() from public,anon,authenticated;

-- site_settings can also be left half-created by an interrupted migration.
create table if not exists public.site_settings (
  site_id uuid primary key references public.sites(id) on delete cascade
);
alter table public.site_settings add column if not exists floorplan_assets jsonb;
alter table public.site_settings add column if not exists operating_config jsonb;
alter table public.site_settings add column if not exists updated_at timestamptz;

alter table public.site_settings alter column floorplan_assets set default '{}'::jsonb;
alter table public.site_settings alter column operating_config set default '{}'::jsonb;
alter table public.site_settings alter column updated_at set default clock_timestamp();

update public.site_settings
set floorplan_assets=coalesce(floorplan_assets,'{}'::jsonb),
    operating_config=coalesce(operating_config,'{}'::jsonb),
    updated_at=coalesce(updated_at,clock_timestamp());

alter table public.site_settings alter column floorplan_assets set not null;
alter table public.site_settings alter column operating_config set not null;
alter table public.site_settings alter column updated_at set not null;

insert into public.site_settings(site_id)
select s.id from public.sites s
on conflict(site_id) do nothing;

-- Recreate idempotent site creation only after the table shape is repaired.
create or replace function public.admin_create_site(
  p_name text,
  p_code text,
  p_building_label text default 'MAIN BUILDING'
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_name text:=btrim(coalesce(p_name,''));
  v_code text:=lower(btrim(coalesce(p_code,'')));
  v_building text:=coalesce(nullif(btrim(coalesce(p_building_label,'')),''),'MAIN BUILDING');
  v_site public.sites%rowtype;
begin
  if not public.is_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if v_name='' then
    return jsonb_build_object('ok',false,'code','SITE_NAME_REQUIRED','message','병원명을 입력하세요.');
  end if;
  if v_code='' or length(v_code)>32 or v_code !~ '^[a-z0-9][a-z0-9_-]*$' then
    return jsonb_build_object('ok',false,'code','SITE_CODE_INVALID','message','병원 코드는 영문 소문자, 숫자, - 또는 _만 사용할 수 있습니다.');
  end if;

  insert into public.sites(code,name,building_label,active,updated_at)
  values(v_code,v_name,v_building,true,clock_timestamp())
  on conflict(code) do nothing
  returning * into v_site;

  if v_site.id is null then
    select * into v_site from public.sites where code=v_code limit 1;
    if v_site.id is null then
      raise exception 'SITE_CREATE_FAILED';
    end if;
    insert into public.site_settings(site_id) values(v_site.id)
    on conflict(site_id) do nothing;
    return jsonb_build_object(
      'ok',true,'existing',true,'code','SITE_CODE_EXISTS',
      'message','이미 등록된 병원입니다.','site',to_jsonb(v_site)
    );
  end if;

  insert into public.site_settings(site_id) values(v_site.id)
  on conflict(site_id) do nothing;

  return jsonb_build_object('ok',true,'existing',false,'site',to_jsonb(v_site));
end
$$;

revoke all on function public.admin_create_site(text,text,text) from public;
grant execute on function public.admin_create_site(text,text,text) to anon,authenticated;

commit;
select pg_notify('pgrst','reload schema');
