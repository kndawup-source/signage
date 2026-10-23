-- Clinic Signage v2.33.0 — product foundation / site-ready operation
-- Safe to rerun. Keeps current single-site behavior while making the data model extensible.

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  building_label text not null default 'MAIN BUILDING',
  brand_color text,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.sites(code,name,building_label)
select 'default',coalesce(nullif((select site_name from public.app_settings where id=1),''),'CLINIC SIGNAGE'),coalesce(nullif((select building_label from public.app_settings where id=1),''),'MAIN BUILDING')
where not exists(select 1 from public.sites where code='default');

create or replace function public.default_site_id()
returns uuid language sql stable security definer set search_path=public as $$
  select id from public.sites where code='default' order by created_at limit 1;
$$;
revoke all on function public.default_site_id() from public,anon,authenticated;

alter table public.pin_accounts add column if not exists site_id uuid references public.sites(id) on delete set null;
update public.pin_accounts set site_id=public.default_site_id() where role='staff' and site_id is null;

alter table public.rooms add column if not exists site_id uuid references public.sites(id) on delete restrict;
alter table public.rooms add column if not exists display_control_mode text not null default 'remote';
alter table public.rooms add column if not exists manual_check_status text not null default 'not_required';
alter table public.rooms add column if not exists manual_checked_at timestamptz;
alter table public.rooms add column if not exists manual_checked_by text;
alter table public.rooms add column if not exists display_note text;
alter table public.rooms drop constraint if exists rooms_display_control_mode_check;
alter table public.rooms add constraint rooms_display_control_mode_check check(display_control_mode in ('remote','manual','hybrid'));
alter table public.rooms drop constraint if exists rooms_manual_check_status_check;
alter table public.rooms add constraint rooms_manual_check_status_check check(manual_check_status in ('not_required','needs_check','checked'));
update public.rooms set site_id=public.default_site_id() where site_id is null;
alter table public.rooms alter column site_id set not null;
update public.rooms set manual_check_status='needs_check' where display_control_mode='manual' and manual_check_status='not_required';
create index if not exists rooms_site_sort_idx on public.rooms(site_id,sort_order,created_at);

alter table public.signage_groups add column if not exists site_id uuid references public.sites(id) on delete cascade;
update public.signage_groups set site_id=public.default_site_id() where site_id is null;
alter table public.signage_groups alter column site_id set not null;
alter table public.signage_groups drop constraint if exists signage_groups_name_key;
drop index if exists signage_groups_name_uidx;
create unique index if not exists signage_groups_site_name_uidx on public.signage_groups(site_id,lower(name));
create index if not exists signage_groups_site_sort_idx on public.signage_groups(site_id,sort_order,created_at);

alter table if exists public.patient_sessions add column if not exists site_id uuid references public.sites(id) on delete cascade;
update public.patient_sessions p set site_id=coalesce((select r.site_id from public.rooms r where r.id=p.room_id),public.default_site_id()) where site_id is null;
alter table public.patient_sessions alter column site_id set not null;
create index if not exists patient_sessions_site_status_idx on public.patient_sessions(site_id,status,waiting_started_at);

alter table if exists public.videos add column if not exists site_id uuid references public.sites(id) on delete cascade;
alter table if exists public.playlists add column if not exists site_id uuid references public.sites(id) on delete cascade;
-- NULL content is global/shared. Current content stays global so the existing installation does not change.

create table if not exists public.site_settings (
  site_id uuid primary key references public.sites(id) on delete cascade,
  floorplan_assets jsonb not null default '{}'::jsonb,
  operating_config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.site_settings(site_id,floorplan_assets)
select public.default_site_id(),coalesce((select floorplan_assets from public.app_settings where id=1),'{}'::jsonb)
where public.default_site_id() is not null
on conflict(site_id) do nothing;

create table if not exists public.floor_spaces (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  group_id uuid references public.signage_groups(id) on delete cascade,
  name text not null,
  space_type text not null default 'other',
  x_pct numeric(5,2) not null,
  y_pct numeric(5,2) not null,
  width_pct numeric(5,2) not null,
  height_pct numeric(5,2) not null,
  sort_order int not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(space_type in ('treatment','consultation','waiting','lounge','reception','lobby','staff','support','public','other')),
  check(x_pct between 0 and 100 and y_pct between 0 and 100),
  check(width_pct > 0 and width_pct <= 100 and height_pct > 0 and height_pct <= 100),
  check(x_pct+width_pct <= 100.01 and y_pct+height_pct <= 100.01)
);
create index if not exists floor_spaces_site_group_idx on public.floor_spaces(site_id,group_id,sort_order,created_at);

create table if not exists public.audit_log (
  id bigint generated by default as identity primary key,
  site_id uuid references public.sites(id) on delete set null,
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id text,
  summary text,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists audit_log_site_created_idx on public.audit_log(site_id,created_at desc);

create or replace function public.pin_session_site_id()
returns uuid language sql stable security definer set search_path=public,extensions as $$
  select a.site_id from public.pin_sessions s join public.pin_accounts a on a.id=s.account_id and a.enabled
  where s.token_hash=digest(coalesce(public.pin_request_token(),''),'sha256') and s.expires_at>clock_timestamp() limit 1;
$$;
revoke all on function public.pin_session_site_id() from public,anon,authenticated;

create or replace function public.can_manage_site(p_site uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select case public.pin_session_role() when 'admin' then true when 'staff' then public.pin_session_site_id()=p_site else false end;
$$;
revoke all on function public.can_manage_site(uuid) from public,anon,authenticated;

-- Session payload now exposes site scope. Internal role values stay admin/staff for compatibility.
create or replace function public.pin_session_info()
returns jsonb language plpgsql stable security definer set search_path=public,extensions as $$
declare v_role text; v_exp timestamptz; v_site uuid;
begin
  select a.role,s.expires_at,a.site_id into v_role,v_exp,v_site
  from public.pin_sessions s join public.pin_accounts a on a.id=s.account_id and a.enabled
  where s.token_hash=digest(coalesce(public.pin_request_token(),''),'sha256') and s.expires_at>clock_timestamp() limit 1;
  if v_role is null then return jsonb_build_object('valid',false); end if;
  return jsonb_build_object('valid',true,'role',v_role,'site_id',v_site,'expires_at',v_exp);
end $$;
revoke all on function public.pin_session_info() from public;
grant execute on function public.pin_session_info() to anon,authenticated;

-- Current staff PIN belongs to the default site.
update public.pin_accounts set site_id=public.default_site_id() where role='staff' and site_id is null;

alter table public.sites enable row level security;
alter table public.site_settings enable row level security;
alter table public.floor_spaces enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists sites_admin_all on public.sites;
create policy sites_admin_all on public.sites for all to anon,authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists sites_staff_read on public.sites;
create policy sites_staff_read on public.sites for select to anon,authenticated using(public.can_manage_site(id));
drop policy if exists site_settings_manage on public.site_settings;
create policy site_settings_manage on public.site_settings for all to anon,authenticated using(public.can_manage_site(site_id)) with check(public.can_manage_site(site_id));
drop policy if exists floor_spaces_manage on public.floor_spaces;
create policy floor_spaces_manage on public.floor_spaces for all to anon,authenticated using(public.can_manage_site(site_id)) with check(public.can_manage_site(site_id));
drop policy if exists audit_log_admin_read on public.audit_log;
create policy audit_log_admin_read on public.audit_log for select to anon,authenticated using(public.is_admin() or public.can_manage_site(site_id));

grant select,insert,update,delete on public.sites,public.site_settings,public.floor_spaces to anon,authenticated;
grant select on public.audit_log to anon,authenticated;

create or replace function public.audit_event(p_site uuid,p_action text,p_entity_type text,p_entity_id text,p_summary text,p_before jsonb default null,p_after jsonb default null)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  insert into public.audit_log(site_id,actor_role,action,entity_type,entity_id,summary,before_state,after_state)
  values(p_site,public.pin_session_role(),p_action,p_entity_type,p_entity_id,p_summary,p_before,p_after);
end $$;
revoke all on function public.audit_event(uuid,text,text,text,text,jsonb,jsonb) from public;
grant execute on function public.audit_event(uuid,text,text,text,text,jsonb,jsonb) to anon,authenticated;

create or replace function public.staff_site_context()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_site uuid; v_result jsonb;
begin
  if public.pin_session_role() not in ('admin','staff') then raise exception 'not allowed'; end if;
  v_site:=coalesce(public.pin_session_site_id(),public.default_site_id());
  select jsonb_build_object(
    'site',jsonb_build_object('id',s.id,'code',s.code,'name',s.name,'building_label',s.building_label,'brand_color',s.brand_color),
    'floorplan_assets',coalesce(ss.floorplan_assets,'{}'::jsonb),
    'spaces',coalesce((select jsonb_agg(to_jsonb(fs) order by fs.sort_order,fs.created_at) from public.floor_spaces fs where fs.site_id=s.id),'[]'::jsonb),
    'server_time',clock_timestamp()
  ) into v_result
  from public.sites s left join public.site_settings ss on ss.site_id=s.id where s.id=v_site;
  return coalesce(v_result,'{}'::jsonb);
end $$;
revoke all on function public.staff_site_context() from public;
grant execute on function public.staff_site_context() to anon,authenticated;

create or replace function public.staff_update_site_identity(p_name text,p_building_label text)
returns void language plpgsql security definer set search_path=public as $$
declare v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id()); v_before jsonb; v_after jsonb;
begin
  if public.pin_session_role() not in ('admin','staff') or not public.can_manage_site(v_site) then raise exception 'not allowed'; end if;
  select to_jsonb(s) into v_before from public.sites s where id=v_site;
  update public.sites set name=coalesce(nullif(trim(p_name),''),name),building_label=coalesce(nullif(trim(p_building_label),''),building_label),updated_at=clock_timestamp() where id=v_site;
  select to_jsonb(s) into v_after from public.sites s where id=v_site;
  perform public.audit_event(v_site,'update','site',v_site::text,'병원 기본 정보 변경',v_before,v_after);
end $$;
revoke all on function public.staff_update_site_identity(text,text) from public;
grant execute on function public.staff_update_site_identity(text,text) to anon,authenticated;

create or replace function public.staff_set_floorplan_assets(p_assets jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
begin
  if public.pin_session_role() not in ('admin','staff') or not public.can_manage_site(v_site) then raise exception 'not allowed'; end if;
  insert into public.site_settings(site_id,floorplan_assets,updated_at) values(v_site,coalesce(p_assets,'{}'::jsonb),clock_timestamp())
  on conflict(site_id) do update set floorplan_assets=excluded.floorplan_assets,updated_at=clock_timestamp();
  perform public.audit_event(v_site,'update','floorplan','all','층별 도면 설정 변경',null,jsonb_build_object('floors',jsonb_object_length(coalesce(p_assets,'{}'::jsonb))));
end $$;
revoke all on function public.staff_set_floorplan_assets(jsonb) from public;
grant execute on function public.staff_set_floorplan_assets(jsonb) to anon,authenticated;

create or replace function public.staff_set_display_setup(p_room uuid,p_mode text,p_x numeric,p_y numeric,p_note text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id()); v_before jsonb; v_after jsonb;
begin
  if public.pin_session_role() not in ('admin','staff') or p_mode not in ('remote','manual','hybrid') then raise exception 'not allowed'; end if;
  select to_jsonb(r) into v_before from public.rooms r where r.id=p_room and r.site_id=v_site;
  if v_before is null and public.is_admin() then select to_jsonb(r) into v_before from public.rooms r where r.id=p_room; end if;
  if v_before is null then raise exception '공간을 찾을 수 없습니다'; end if;
  update public.rooms set display_control_mode=p_mode,map_x_pct=case when p_x is null then null else greatest(0,least(100,p_x)) end,map_y_pct=case when p_y is null then null else greatest(0,least(100,p_y)) end,display_note=nullif(trim(coalesce(p_note,'')),'') where id=p_room;
  update public.rooms set manual_check_status=case when display_control_mode='manual' and manual_check_status='not_required' then 'needs_check' when display_control_mode<>'manual' then 'not_required' else manual_check_status end where id=p_room;
  select to_jsonb(r) into v_after from public.rooms r where r.id=p_room;
  perform public.audit_event((v_after->>'site_id')::uuid,'update','display',p_room::text,'디스플레이 설정 변경',v_before,v_after);
end $$;
revoke all on function public.staff_set_display_setup(uuid,text,numeric,numeric,text) from public;
grant execute on function public.staff_set_display_setup(uuid,text,numeric,numeric,text) to anon,authenticated;

create or replace function public.staff_mark_manual_display_checked(p_room uuid,p_checked boolean default true)
returns void language plpgsql security definer set search_path=public as $$
declare v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
begin
  if public.pin_session_role() not in ('admin','staff') then raise exception 'not allowed'; end if;
  update public.rooms set manual_check_status=case when p_checked then 'checked' else 'needs_check' end,manual_checked_at=case when p_checked then clock_timestamp() else null end,manual_checked_by=case when p_checked then coalesce(public.pin_session_role(),'staff') else null end where id=p_room and (site_id=v_site or public.is_admin()) and display_control_mode in ('manual','hybrid');
  if not found then raise exception '수동 디스플레이를 찾을 수 없습니다'; end if;
  perform public.audit_event((select site_id from public.rooms where id=p_room),'check','display',p_room::text,case when p_checked then '수동 디스플레이 확인 완료' else '수동 디스플레이 확인 필요로 변경' end,null,null);
end $$;
revoke all on function public.staff_mark_manual_display_checked(uuid,boolean) from public;
grant execute on function public.staff_mark_manual_display_checked(uuid,boolean) to anon,authenticated;

create or replace function public.admin_export_site_config(p_site uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_site uuid:=coalesce(p_site,public.default_site_id());
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'version','2.33.0','site',(select to_jsonb(s) from public.sites s where s.id=v_site),
    'settings',(select to_jsonb(ss) from public.site_settings ss where ss.site_id=v_site),
    'groups',coalesce((select jsonb_agg(to_jsonb(g) order by g.sort_order,g.created_at) from public.signage_groups g where g.site_id=v_site),'[]'::jsonb),
    'rooms',coalesce((select jsonb_agg(to_jsonb(r) order by r.sort_order,r.created_at) from public.rooms r where r.site_id=v_site),'[]'::jsonb),
    'spaces',coalesce((select jsonb_agg(to_jsonb(fs) order by fs.sort_order,fs.created_at) from public.floor_spaces fs where fs.site_id=v_site),'[]'::jsonb),
    'exported_at',clock_timestamp());
end $$;
revoke all on function public.admin_export_site_config(uuid) from public;
grant execute on function public.admin_export_site_config(uuid) to anon,authenticated;

-- RLS adjustments: superadmin sees all; hospital admin only its site where direct table access is allowed.
drop policy if exists rooms_admin_select on public.rooms;
create policy rooms_admin_select on public.rooms for select to anon,authenticated using(public.is_admin());
drop policy if exists rooms_admin on public.rooms;
create policy rooms_admin on public.rooms for all to anon,authenticated using(public.is_admin()) with check(public.is_admin());

-- Keep current app_settings synchronized with the default site for legacy player/admin code.
update public.app_settings a set site_name=s.name,building_label=s.building_label from public.sites s where a.id=1 and s.id=public.default_site_id();

notify pgrst,'reload schema';

create or replace function public.admin_import_site_config(p_config jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_site uuid; g jsonb; r jsonb; sp jsonb; v_groups int:=0; v_rooms int:=0; v_spaces int:=0;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  v_site:=coalesce(nullif(p_config#>>'{site,id}','')::uuid,public.default_site_id());
  if not exists(select 1 from public.sites where id=v_site) then raise exception 'site not found'; end if;
  update public.sites set name=coalesce(nullif(p_config#>>'{site,name}',''),name),building_label=coalesce(nullif(p_config#>>'{site,building_label}',''),building_label),updated_at=clock_timestamp() where id=v_site;
  if jsonb_typeof(p_config->'settings')='object' then
    insert into public.site_settings(site_id,floorplan_assets,operating_config,updated_at)
    values(v_site,coalesce(p_config#>'{settings,floorplan_assets}','{}'::jsonb),coalesce(p_config#>'{settings,operating_config}','{}'::jsonb),clock_timestamp())
    on conflict(site_id) do update set floorplan_assets=excluded.floorplan_assets,operating_config=excluded.operating_config,updated_at=clock_timestamp();
  end if;
  if jsonb_typeof(p_config->'groups')='array' then
    for g in select * from jsonb_array_elements(p_config->'groups') loop
      update public.signage_groups set name=coalesce(nullif(g->>'name',''),name),kind=coalesce(nullif(g->>'kind',''),kind),floor_number=coalesce((g->>'floor_number')::smallint,floor_number),care_type=coalesce(nullif(g->>'care_type',''),care_type),signage_purpose=g->>'signage_purpose',target_audience=g->>'target_audience',waiting_area_note=g->>'waiting_area_note',signage_reason=g->>'signage_reason',default_playlist_id=nullif(g->>'default_playlist_id','')::uuid,sort_order=coalesce((g->>'sort_order')::int,sort_order) where id=(g->>'id')::uuid and site_id=v_site;
      if found then v_groups:=v_groups+1; end if;
    end loop;
  end if;
  if jsonb_typeof(p_config->'rooms')='array' then
    for r in select * from jsonb_array_elements(p_config->'rooms') loop
      update public.rooms set name=coalesce(nullif(r->>'name',''),name),group_id=nullif(r->>'group_id','')::uuid,room_mode=coalesce(nullif(r->>'room_mode',''),room_mode),map_x_pct=nullif(r->>'map_x_pct','')::numeric,map_y_pct=nullif(r->>'map_y_pct','')::numeric,display_control_mode=coalesce(nullif(r->>'display_control_mode',''),display_control_mode),display_note=r->>'display_note' where id=(r->>'id')::uuid and site_id=v_site;
      if found then v_rooms:=v_rooms+1; end if;
    end loop;
  end if;
  if jsonb_typeof(p_config->'spaces')='array' then
    delete from public.floor_spaces where site_id=v_site;
    for sp in select * from jsonb_array_elements(p_config->'spaces') loop
      insert into public.floor_spaces(id,site_id,group_id,name,space_type,x_pct,y_pct,width_pct,height_pct,sort_order)
      values(coalesce(nullif(sp->>'id','')::uuid,gen_random_uuid()),v_site,nullif(sp->>'group_id','')::uuid,coalesce(nullif(sp->>'name',''),'공간'),coalesce(nullif(sp->>'space_type',''),'other'),coalesce((sp->>'x_pct')::numeric,0),coalesce((sp->>'y_pct')::numeric,0),coalesce((sp->>'width_pct')::numeric,10),coalesce((sp->>'height_pct')::numeric,10),coalesce((sp->>'sort_order')::int,0));
      v_spaces:=v_spaces+1;
    end loop;
  end if;
  perform public.audit_event(v_site,'restore','site_config',v_site::text,'사이트 설정 백업 복원',null,jsonb_build_object('groups',v_groups,'rooms',v_rooms,'spaces',v_spaces));
  return jsonb_build_object('ok',true,'groups',v_groups,'rooms',v_rooms,'spaces',v_spaces);
end $$;
revoke all on function public.admin_import_site_config(jsonb) from public;
grant execute on function public.admin_import_site_config(jsonb) to anon,authenticated;
notify pgrst,'reload schema';

-- Multiple hospital-admin PINs: one staff account per site, one superadmin account globally.
alter table public.pin_accounts drop constraint if exists pin_accounts_role_key;
create unique index if not exists pin_accounts_admin_singleton_uidx on public.pin_accounts(role) where role='admin';
create unique index if not exists pin_accounts_staff_site_uidx on public.pin_accounts(site_id) where role='staff' and site_id is not null;



create or replace function public.admin_change_pin(p_role text,p_pin text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_account bigint;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_role='staff' then perform public.admin_set_site_staff_pin(public.default_site_id(),p_pin); return; end if;
  if p_role<>'admin' then raise exception 'invalid role'; end if;
  if p_pin !~ '^[0-9]{6}$' then raise exception '관리자 PIN은 숫자 6자리여야 합니다'; end if;
  if exists(select 1 from public.pin_accounts a where a.role='staff' and a.enabled and crypt(p_pin,a.pin_hash)=a.pin_hash) then raise exception '관리자와 병원 관리자 PIN은 서로 달라야 합니다'; end if;
  select id into v_account from public.pin_accounts where role='admin' order by id limit 1;
  if v_account is null then insert into public.pin_accounts(role,pin_hash,enabled,updated_at) values('admin',crypt(p_pin,gen_salt('bf',10)),true,clock_timestamp()) returning id into v_account;
  else update public.pin_accounts set pin_hash=crypt(p_pin,gen_salt('bf',10)),enabled=true,updated_at=clock_timestamp() where id=v_account; end if;
  delete from public.pin_sessions where account_id=v_account;
end $$;
revoke all on function public.admin_change_pin(text,text) from public;
grant execute on function public.admin_change_pin(text,text) to anon,authenticated;
notify pgrst,'reload schema';

-- v2.33.0 final site-scope hardening for hospital administrators.
create or replace function public.staff_can_access_room(p_room uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select public.is_admin() or exists(
    select 1 from public.rooms r where r.id=p_room and r.site_id=public.pin_session_site_id()
  );
$$;
revoke all on function public.staff_can_access_room(uuid) from public,anon,authenticated;

create or replace function public.staff_can_remote_control_room(p_room uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select public.staff_can_access_room(p_room) and exists(
    select 1 from public.rooms r where r.id=p_room and coalesce(r.display_control_mode,'remote') in ('remote','hybrid')
  );
$$;
revoke all on function public.staff_can_remote_control_room(uuid) from public,anon,authenticated;

create or replace function public.staff_can_access_patient(p_patient uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select public.is_admin() or exists(
    select 1 from public.patient_sessions p where p.id=p_patient and p.site_id=public.pin_session_site_id()
  );
$$;
revoke all on function public.staff_can_access_patient(uuid) from public,anon,authenticated;

create or replace function public.staff_reception_state()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_site uuid; v_rooms jsonb; v_groups jsonb; v_patients jsonb; v_broadcast jsonb;
  v_playlists jsonb; v_videos jsonb; v_items jsonb; v_rules jsonb; v_site_row jsonb;
  v_floorplans jsonb; v_spaces jsonb; v_versions jsonb;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  v_site:=coalesce(public.pin_session_site_id(),public.default_site_id());
  if public.is_admin() and v_site is null then v_site:=public.default_site_id(); end if;
  if v_site is null then raise exception 'site not configured'; end if;

  select to_jsonb(s) into v_site_row from public.sites s where s.id=v_site;
  select coalesce(ss.floorplan_assets,'{}'::jsonb) into v_floorplans from public.site_settings ss where ss.site_id=v_site;
  v_floorplans:=coalesce(v_floorplans,'{}'::jsonb);
  select coalesce(jsonb_agg(to_jsonb(fs) order by fs.sort_order,fs.created_at),'[]'::jsonb) into v_spaces
    from public.floor_spaces fs where fs.site_id=v_site;
  select coalesce(jsonb_agg(to_jsonb(fv) order by fv.created_at desc),'[]'::jsonb) into v_versions
    from public.floorplan_versions fv where fv.site_id=v_site;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,'site_id',r.site_id,'name',r.name,'sort_order',r.sort_order,'group_id',r.group_id,'group_name',g.name,'room_mode',r.room_mode,
    'last_seen_at',r.last_seen_at,'player_status',coalesce(r.player_status,'{}'::jsonb),'session_timeout_min',r.session_timeout_min,
    'session_started_at',r.session_started_at,'session_age_group',r.session_age_group,'session_gender',r.session_gender,'session_treatment',r.session_treatment,
    'default_playlist_id',r.default_playlist_id,'manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids,
    'map_x_pct',r.map_x_pct,'map_y_pct',r.map_y_pct,'display_control_mode',r.display_control_mode,'manual_check_status',r.manual_check_status,
    'manual_checked_at',r.manual_checked_at,'manual_checked_by',r.manual_checked_by,'display_note',r.display_note
  ) order by coalesce(g.sort_order,2147483647),r.sort_order,r.created_at),'[]'::jsonb) into v_rooms
  from public.rooms r left join public.signage_groups g on g.id=r.group_id
  where r.site_id=v_site;

  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'site_id',g.site_id,'name',g.name,'kind',g.kind,'floor_number',g.floor_number,
    'care_type',g.care_type,'signage_purpose',g.signage_purpose,'target_audience',g.target_audience,'waiting_area_note',g.waiting_area_note,
    'signage_reason',g.signage_reason,'default_playlist_id',g.default_playlist_id,'sort_order',g.sort_order) order by g.sort_order,g.floor_number,g.created_at),'[]'::jsonb)
    into v_groups from public.signage_groups g where g.site_id=v_site;

  select coalesce(jsonb_agg(to_jsonb(x) order by case x.status when 'in_progress' then 0 when 'assigned' then 1 when 'waiting' then 2 else 3 end,x.waiting_started_at),'[]'::jsonb)
    into v_patients from (select * from public.patient_sessions where site_id=v_site and ((status in ('waiting','assigned','in_progress')) or (status='completed' and completed_at>=date_trunc('day',clock_timestamp())))) x;

  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'site_id',p.site_id,'name',p.name,'kind',p.kind,'active',p.active,'sort_order',p.sort_order,
    'target_treatment',p.target_treatment,'target_age',p.target_age,'target_gender',p.target_gender) order by p.sort_order,p.created_at),'[]'::jsonb)
    into v_playlists from public.playlists p where p.active and (p.site_id is null or p.site_id=v_site);
  select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'site_id',v.site_id,'title',v.title,'active',v.active,'duration_sec',v.duration_sec,
    'thumbnail_data_url',v.thumbnail_data_url,'target_treatment',v.target_treatment,'target_age',v.target_age,'target_gender',v.target_gender) order by v.sort_order,v.created_at),'[]'::jsonb)
    into v_videos from public.videos v where v.active and (v.site_id is null or v.site_id=v_site) and (v.source<>'local' or v.available);
  select coalesce(jsonb_agg(jsonb_build_object('playlist_id',pi.playlist_id,'video_id',pi.video_id,'sort_order',pi.sort_order) order by pi.playlist_id,pi.sort_order,pi.created_at),'[]'::jsonb)
    into v_items from public.playlist_items pi join public.playlists p on p.id=pi.playlist_id where p.site_id is null or p.site_id=v_site;
  select coalesce(jsonb_agg(jsonb_build_object('room_id',rr.room_id,'video_id',rr.video_id,'enabled',rr.enabled,'sort_order',rr.sort_order,'starts_at',rr.starts_at,'ends_at',rr.ends_at,'updated_at',rr.updated_at)),'[]'::jsonb)
    into v_rules from public.room_video_rules rr join public.rooms r on r.id=rr.room_id where r.site_id=v_site;
  select jsonb_build_object('active',active,'notice_text',notice_text) into v_broadcast from public.broadcast where id=1;

  return jsonb_build_object('site',coalesce(v_site_row,'{}'::jsonb),'floorplan_assets',v_floorplans,'floorplan_versions',coalesce(v_versions,'[]'::jsonb),'spaces',coalesce(v_spaces,'[]'::jsonb),
    'rooms',v_rooms,'groups',v_groups,'patients',v_patients,'playlists',v_playlists,'videos',v_videos,'playlist_items',v_items,
    'room_video_rules',v_rules,'broadcast',coalesce(v_broadcast,'{}'::jsonb),'server_time',clock_timestamp());
end $$;

create or replace function public.staff_create_patient(p_label text,p_age_group text,p_gender text,p_treatment text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_queue bigint; v_site uuid;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  v_site:=coalesce(public.pin_session_site_id(),public.default_site_id());
  if v_site is null then raise exception 'site not configured'; end if;
  if nullif(trim(coalesce(p_treatment,'')),'') is null then raise exception '진료유형을 선택하세요'; end if;
  insert into public.patient_sessions(site_id,label,age_group,gender,treatment)
  values(v_site,nullif(trim(coalesce(p_label,'')),''),nullif(trim(coalesce(p_age_group,'')),''),nullif(trim(coalesce(p_gender,'')),''),case when p_treatment='veneer' then 'minish' else p_treatment end)
  returning id,queue_no into v_id,v_queue;
  update public.patient_sessions set label=coalesce(label,'대기 '||lpad(v_queue::text,3,'0')) where id=v_id;
  return v_id;
end $$;

create or replace function public.staff_assign_patient(p_patient uuid,p_room uuid)
returns void language plpgsql security definer set search_path=public as $$
declare p public.patient_sessions; old_room uuid; v_mode text; v_site uuid;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  v_site:=coalesce(public.pin_session_site_id(),public.default_site_id());
  if not public.staff_can_access_patient(p_patient) or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  select * into p from public.patient_sessions where id=p_patient and site_id=v_site and status in ('waiting','assigned','in_progress') for update;
  if not found then raise exception '환자를 찾을 수 없습니다'; end if;
  select room_mode into v_mode from public.rooms where id=p_room and site_id=v_site;
  if v_mode not in ('treatment','consultation') then raise exception '환자 배정이 가능한 공간이 아닙니다'; end if;
  if exists(select 1 from public.patient_sessions x where x.site_id=v_site and x.room_id=p_room and x.status in ('assigned','in_progress') and x.id<>p_patient) then raise exception '이미 다른 환자가 배정된 공간입니다'; end if;
  old_room:=p.room_id;
  if old_room is not null and old_room<>p_room then update public.rooms set session_tags='{}',session_started_at=null,session_age_group=null,session_gender=null,session_treatment=null where id=old_room and site_id=v_site; end if;
  update public.patient_sessions set room_id=p_room,status='assigned',assigned_at=clock_timestamp(),started_at=null,updated_at=clock_timestamp() where id=p_patient and site_id=v_site;
  update public.rooms set session_age_group=p.age_group,session_gender=p.gender,session_treatment=p.treatment,session_tags=array_remove(array[p.age_group,p.gender,p.treatment]::text[],null),session_started_at=clock_timestamp() where id=p_room and site_id=v_site;
end $$;

create or replace function public.staff_start_patient(p_patient uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_member() or not public.staff_can_access_patient(p_patient) then raise exception 'not allowed'; end if;
  update public.patient_sessions set status='in_progress',started_at=coalesce(started_at,clock_timestamp()),updated_at=clock_timestamp() where id=p_patient and status='assigned';
  if not found then raise exception '배정된 환자가 아닙니다'; end if;
end $$;

create or replace function public.staff_unassign_patient(p_patient uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_room uuid; v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
begin
  if not public.is_member() or not public.staff_can_access_patient(p_patient) then raise exception 'not allowed'; end if;
  select room_id into v_room from public.patient_sessions where id=p_patient and site_id=v_site and status in ('assigned','in_progress') for update;
  if not found then raise exception '배정된 환자가 아닙니다'; end if;
  if v_room is not null then update public.rooms set session_tags='{}',session_started_at=null,session_age_group=null,session_gender=null,session_treatment=null where id=v_room and site_id=v_site; end if;
  update public.patient_sessions set room_id=null,status='waiting',assigned_at=null,started_at=null,updated_at=clock_timestamp() where id=p_patient and site_id=v_site;
end $$;

create or replace function public.staff_complete_patient(p_patient uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_room uuid; v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
begin
  if not public.is_member() or not public.staff_can_access_patient(p_patient) then raise exception 'not allowed'; end if;
  select room_id into v_room from public.patient_sessions where id=p_patient and site_id=v_site and status in ('assigned','in_progress') for update;
  if not found then raise exception '진행 중인 환자가 아닙니다'; end if;
  if v_room is not null then update public.rooms set session_tags='{}',session_started_at=null,session_age_group=null,session_gender=null,session_treatment=null where id=v_room and site_id=v_site; end if;
  update public.patient_sessions set status='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_patient and site_id=v_site;
end $$;

create or replace function public.staff_cancel_patient(p_patient uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_room uuid; v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
begin
  if not public.is_member() or not public.staff_can_access_patient(p_patient) then raise exception 'not allowed'; end if;
  select room_id into v_room from public.patient_sessions where id=p_patient and site_id=v_site and status in ('waiting','assigned','in_progress') for update;
  if not found then raise exception '환자를 찾을 수 없습니다'; end if;
  if v_room is not null then update public.rooms set session_tags='{}',session_started_at=null,session_age_group=null,session_gender=null,session_treatment=null where id=v_room and site_id=v_site; end if;
  update public.patient_sessions set status='cancelled',completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_patient and site_id=v_site;
end $$;

create or replace function public.staff_quick_set_room(p_room uuid,p_treatment text,p_age_group text default null,p_gender text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_mode text; v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
begin
  if not public.is_member() or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  if nullif(trim(coalesce(p_treatment,'')),'') is null then raise exception '진료유형을 선택하세요'; end if;
  select room_mode into v_mode from public.rooms where id=p_room and site_id=v_site for update;
  if not found then raise exception '진료실을 찾을 수 없습니다'; end if;
  if v_mode not in ('treatment','consultation') then raise exception '맞춤 송출이 가능한 공간이 아닙니다'; end if;
  if exists(select 1 from public.patient_sessions where site_id=v_site and room_id=p_room and status in ('assigned','in_progress')) then raise exception '등록 환자가 배정된 진료실입니다. 환자 관리에서 변경하세요'; end if;
  update public.rooms set session_age_group=nullif(trim(coalesce(p_age_group,'')),''),session_gender=nullif(trim(coalesce(p_gender,'')),''),session_treatment=case when p_treatment='veneer' then 'minish' else p_treatment end,
    session_tags=array_remove(array[nullif(trim(coalesce(p_age_group,'')),''),nullif(trim(coalesce(p_gender,'')),''),case when p_treatment='veneer' then 'minish' else p_treatment end]::text[],null),session_started_at=clock_timestamp()
  where id=p_room and site_id=v_site;
end $$;

create or replace function public.staff_quick_clear_room(p_room uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
begin
  if not public.is_member() or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  if exists(select 1 from public.patient_sessions where site_id=v_site and room_id=p_room and status in ('assigned','in_progress')) then raise exception '등록 환자가 배정된 진료실입니다. 환자 관리에서 종료하세요'; end if;
  update public.rooms set session_tags='{}',session_started_at=null,session_age_group=null,session_gender=null,session_treatment=null where id=p_room and site_id=v_site;
  if not found then raise exception '진료실을 찾을 수 없습니다'; end if;
end $$;

create or replace function public.staff_set_room_playlist(p_room uuid,p_playlist uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_name text; v_count int; v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
begin
  if not public.is_member() or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  select name into v_name from public.playlists where id=p_playlist and active and (site_id is null or site_id=v_site);
  if v_name is null then raise exception '사용 가능한 플레이리스트가 아닙니다'; end if;
  select count(*) into v_count from public.playlist_items pi join public.videos v on v.id=pi.video_id where pi.playlist_id=p_playlist and v.active and (v.site_id is null or v.site_id=v_site) and (v.source<>'local' or v.available);
  if v_count=0 then raise exception '플레이리스트에 재생 가능한 영상이 없습니다'; end if;
  update public.rooms set default_playlist_id=p_playlist,manual_active=false,manual_video_ids='{}'::uuid[],manual_updated_at=clock_timestamp(),
    session_started_at=case when exists(select 1 from public.patient_sessions where site_id=v_site and room_id=p_room and status in ('assigned','in_progress')) then session_started_at else null end,
    session_age_group=case when exists(select 1 from public.patient_sessions where site_id=v_site and room_id=p_room and status in ('assigned','in_progress')) then session_age_group else null end,
    session_gender=case when exists(select 1 from public.patient_sessions where site_id=v_site and room_id=p_room and status in ('assigned','in_progress')) then session_gender else null end,
    session_treatment=case when exists(select 1 from public.patient_sessions where site_id=v_site and room_id=p_room and status in ('assigned','in_progress')) then session_treatment else null end,
    session_tags=case when exists(select 1 from public.patient_sessions where site_id=v_site and room_id=p_room and status in ('assigned','in_progress')) then session_tags else '{}'::text[] end
  where id=p_room and site_id=v_site;
  if not found then raise exception '공간을 찾을 수 없습니다'; end if;
end $$;

create or replace function public.staff_add_room_video(p_room uuid,p_video uuid)
returns void language plpgsql security definer set search_path=public as $$
declare r public.rooms; v_ids uuid[]; v_playlist uuid; v_title text; v_keep_window boolean; v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
begin
  if not public.is_member() or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  select * into r from public.rooms where id=p_room and site_id=v_site for update;
  if not found then raise exception '공간을 찾을 수 없습니다'; end if;
  select title into v_title from public.videos where id=p_video and active and (site_id is null or site_id=v_site) and (source<>'local' or available);
  if v_title is null then raise exception '사용 가능한 영상이 아닙니다'; end if;
  v_keep_window:=r.manual_active and (r.manual_ends_at is null or r.manual_ends_at>clock_timestamp());
  if v_keep_window and coalesce(array_length(r.manual_video_ids,1),0)>0 then v_ids:=r.manual_video_ids;
  else
    v_playlist:=r.default_playlist_id;
    if v_playlist is null then select id into v_playlist from public.playlists where active and kind='default' and (site_id is null or site_id=v_site) order by (site_id is not null) desc,sort_order,created_at limit 1; end if;
    select coalesce(array_agg(v.id order by pi.sort_order,pi.created_at),'{}'::uuid[]) into v_ids from public.playlist_items pi join public.videos v on v.id=pi.video_id where pi.playlist_id=v_playlist and v.active and (v.site_id is null or v.site_id=v_site) and (v.source<>'local' or v.available);
  end if;
  if not (p_video=any(coalesce(v_ids,'{}'::uuid[]))) then v_ids:=array_append(coalesce(v_ids,'{}'::uuid[]),p_video); end if;
  update public.rooms set manual_video_ids=v_ids,manual_active=true,manual_starts_at=case when v_keep_window then r.manual_starts_at else null end,manual_ends_at=case when v_keep_window then r.manual_ends_at else null end,manual_updated_at=clock_timestamp() where id=p_room and site_id=v_site;
end $$;

create or replace function public.staff_clear_room_manual(p_room uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_member() or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  update public.rooms set manual_active=false,manual_video_ids='{}'::uuid[],manual_starts_at=null,manual_ends_at=null,manual_updated_at=clock_timestamp() where id=p_room;
end $$;

create or replace function public.staff_set_room_video_rule(p_room uuid,p_video uuid,p_enabled boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_member() or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  if not exists(select 1 from public.videos v where v.id=p_video and (v.site_id is null or v.site_id=coalesce(public.pin_session_site_id(),public.default_site_id()))) then raise exception '영상을 찾을 수 없습니다'; end if;
  insert into public.room_video_rules(room_id,video_id,enabled,updated_at) values(p_room,p_video,coalesce(p_enabled,true),clock_timestamp())
  on conflict(room_id,video_id) do update set enabled=excluded.enabled,updated_at=clock_timestamp();
end $$;

create or replace function public.staff_set_room_video_order(p_room uuid,p_video_ids uuid[])
returns void language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_pos int:=0;
begin
  if not public.is_member() or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  foreach v_id in array coalesce(p_video_ids,'{}'::uuid[]) loop
    v_pos:=v_pos+10;
    insert into public.room_video_rules(room_id,video_id,sort_order,updated_at) values(p_room,v_id,v_pos,clock_timestamp())
    on conflict(room_id,video_id) do update set sort_order=excluded.sort_order,updated_at=clock_timestamp();
  end loop;
end $$;

create or replace function public.staff_clear_room_video_rules(p_room uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_member() or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  delete from public.room_video_rules where room_id=p_room;
end $$;

create or replace function public.signal_signage_rooms(p_room_ids uuid[] default null,p_group uuid default null,p_all boolean default false)
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer:=0; v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  if (coalesce(p_all,false) or p_group is not null) and not public.is_admin() then raise exception 'not allowed'; end if;
  if not public.is_admin() and exists(select 1 from unnest(coalesce(p_room_ids,'{}'::uuid[])) x where not public.staff_can_remote_control_room(x)) then raise exception 'not allowed'; end if;
  if not coalesce(p_all,false) and p_group is null and coalesce(array_length(p_room_ids,1),0)=0 then return 0; end if;
  insert into public.player_control_signals(room_id,revision,updated_at)
  select r.id,1,clock_timestamp() from public.rooms r
  where coalesce(r.display_control_mode,'remote') in ('remote','hybrid') and (
        (public.is_admin() and (coalesce(p_all,false) or (p_group is not null and r.group_id=p_group)))
     or (coalesce(array_length(p_room_ids,1),0)>0 and r.id=any(p_room_ids) and (public.is_admin() or r.site_id=v_site)))
  on conflict(room_id) do update set revision=public.player_control_signals.revision+1,updated_at=excluded.updated_at;
  get diagnostics v_count=row_count; return v_count;
end $$;

revoke all on function public.staff_reception_state() from public;
revoke all on function public.staff_create_patient(text,text,text,text) from public;
revoke all on function public.staff_assign_patient(uuid,uuid) from public;
revoke all on function public.staff_start_patient(uuid) from public;
revoke all on function public.staff_unassign_patient(uuid) from public;
revoke all on function public.staff_complete_patient(uuid) from public;
revoke all on function public.staff_cancel_patient(uuid) from public;
revoke all on function public.staff_quick_set_room(uuid,text,text,text) from public;
revoke all on function public.staff_quick_clear_room(uuid) from public;
revoke all on function public.staff_set_room_playlist(uuid,uuid) from public;
revoke all on function public.staff_add_room_video(uuid,uuid) from public;
revoke all on function public.staff_clear_room_manual(uuid) from public;
revoke all on function public.staff_set_room_video_rule(uuid,uuid,boolean) from public;
revoke all on function public.staff_set_room_video_order(uuid,uuid[]) from public;
revoke all on function public.staff_clear_room_video_rules(uuid) from public;
revoke all on function public.signal_signage_rooms(uuid[],uuid,boolean) from public;
grant execute on function public.staff_reception_state() to anon,authenticated;
grant execute on function public.staff_create_patient(text,text,text,text) to anon,authenticated;
grant execute on function public.staff_assign_patient(uuid,uuid) to anon,authenticated;
grant execute on function public.staff_start_patient(uuid) to anon,authenticated;
grant execute on function public.staff_unassign_patient(uuid) to anon,authenticated;
grant execute on function public.staff_complete_patient(uuid) to anon,authenticated;
grant execute on function public.staff_cancel_patient(uuid) to anon,authenticated;
grant execute on function public.staff_quick_set_room(uuid,text,text,text) to anon,authenticated;
grant execute on function public.staff_quick_clear_room(uuid) to anon,authenticated;
grant execute on function public.staff_set_room_playlist(uuid,uuid) to anon,authenticated;
grant execute on function public.staff_add_room_video(uuid,uuid) to anon,authenticated;
grant execute on function public.staff_clear_room_manual(uuid) to anon,authenticated;
grant execute on function public.staff_set_room_video_rule(uuid,uuid,boolean) to anon,authenticated;
grant execute on function public.staff_set_room_video_order(uuid,uuid[]) to anon,authenticated;
grant execute on function public.staff_clear_room_video_rules(uuid) to anon,authenticated;
grant execute on function public.signal_signage_rooms(uuid[],uuid,boolean) to anon,authenticated;

notify pgrst,'reload schema';

-- Audit only human-managed spatial/site settings; player heartbeat/report tables are intentionally excluded.
create or replace function public.audit_floor_space_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_site uuid; v_id text;
begin
  if tg_op='DELETE' then v_site:=old.site_id; v_id:=old.id::text; else v_site:=new.site_id; v_id:=new.id::text; end if;
  if public.pin_session_role() in ('admin','staff') then
    insert into public.audit_log(site_id,actor_role,action,entity_type,entity_id,summary,before_state,after_state)
    values(v_site,public.pin_session_role(),lower(tg_op),'floor_space',v_id,'도면 공간 구분 변경',case when tg_op='INSERT' then null else to_jsonb(old) end,case when tg_op='DELETE' then null else to_jsonb(new) end);
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
drop trigger if exists floor_spaces_audit on public.floor_spaces;
create trigger floor_spaces_audit after insert or update or delete on public.floor_spaces for each row execute function public.audit_floor_space_change();

create or replace function public.audit_site_settings_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_site uuid;
begin
  if tg_op='DELETE' then v_site:=old.site_id; else v_site:=new.site_id; end if;
  if public.pin_session_role() in ('admin','staff') then
    insert into public.audit_log(site_id,actor_role,action,entity_type,entity_id,summary,before_state,after_state)
    values(v_site,public.pin_session_role(),lower(tg_op),'site_settings',v_site::text,'병원 도면/운영 설정 변경',case when tg_op='INSERT' then null else to_jsonb(old) end,case when tg_op='DELETE' then null else to_jsonb(new) end);
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
drop trigger if exists site_settings_audit on public.site_settings;
create trigger site_settings_audit after insert or update or delete on public.site_settings for each row execute function public.audit_site_settings_change();
notify pgrst,'reload schema';

-- Hospital-admin live status is site scoped. Superadmin keeps cross-site access.
drop policy if exists player_live_status_member_select on public.player_live_status;
create policy player_live_status_member_select on public.player_live_status
  for select to anon,authenticated using(
    public.is_admin() or exists(
      select 1 from public.rooms r where r.id=player_live_status.room_id and r.site_id=public.pin_session_site_id()
    )
  );

create or replace function public.signage_live_status(p_room_ids uuid[] default null,p_since timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_site uuid:=public.pin_session_site_id();
begin
  if not coalesce(public.is_member(),false) then raise exception 'not allowed' using errcode='42501'; end if;
  return jsonb_build_object(
    'server_time',clock_timestamp(),
    'seen',coalesce((select jsonb_agg(jsonb_build_object('room_id',s.room_id,'last_seen_at',s.last_seen_at))
      from public.player_live_status s join public.rooms r on r.id=s.room_id
      where coalesce(r.display_control_mode,'remote')<>'manual' and (public.is_admin() or r.site_id=v_site) and (p_room_ids is null or s.room_id=any(p_room_ids))),'[]'::jsonb),
    'rows',coalesce((select jsonb_agg(jsonb_build_object('room_id',s.room_id,'last_seen_at',s.last_seen_at,'player_status',coalesce(s.player_status,'{}'::jsonb)-'thumbnail','changed_at',coalesce(s.changed_at,s.updated_at,s.last_seen_at)))
      from public.player_live_status s join public.rooms r on r.id=s.room_id
      where coalesce(r.display_control_mode,'remote')<>'manual' and (public.is_admin() or r.site_id=v_site) and (p_room_ids is null or s.room_id=any(p_room_ids)) and (p_since is null or coalesce(s.changed_at,s.updated_at,s.last_seen_at)>p_since)),'[]'::jsonb)
  );
end $$;
revoke all on function public.signage_live_status(uuid[],timestamptz) from public;
grant execute on function public.signage_live_status(uuid[],timestamptz) to anon,authenticated;
notify pgrst,'reload schema';

-- Floorplan version history. Old R2 objects stay available for rollback; current pointer remains in site_settings.floorplan_assets.
create table if not exists public.floorplan_versions (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  floor_number smallint not null check(floor_number between 1 and 99),
  object_key text not null,
  filename text,
  mime text,
  size_bytes bigint,
  active boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  unique(site_id,object_key)
);
create index if not exists floorplan_versions_site_floor_idx on public.floorplan_versions(site_id,floor_number,created_at desc);
alter table public.floorplan_versions enable row level security;
drop policy if exists floorplan_versions_manage on public.floorplan_versions;
create policy floorplan_versions_manage on public.floorplan_versions for all to anon,authenticated using(public.can_manage_site(site_id)) with check(public.can_manage_site(site_id));
grant select,insert,update,delete on public.floorplan_versions to anon,authenticated;
notify pgrst,'reload schema';

-- Final PIN behavior for multi-site hospital admins. Staff PINs must be unique across sites because login is PIN-only.
create or replace function public.configure_signage_pins(p_admin_pin text,p_staff_pin text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_admin bigint; v_staff bigint; v_site uuid:=public.default_site_id();
begin
  if p_admin_pin !~ '^[0-9]{6}$' then raise exception 'admin PIN must be exactly 6 digits'; end if;
  if p_staff_pin !~ '^[0-9]{4,6}$' then raise exception 'staff PIN must be 4 to 6 digits'; end if;
  if p_admin_pin=p_staff_pin then raise exception 'admin and staff PIN must differ'; end if;
  select id into v_admin from public.pin_accounts where role='admin' order by id limit 1;
  if v_admin is null then insert into public.pin_accounts(role,pin_hash,enabled,updated_at) values('admin',crypt(p_admin_pin,gen_salt('bf',10)),true,clock_timestamp()) returning id into v_admin;
  else update public.pin_accounts set pin_hash=crypt(p_admin_pin,gen_salt('bf',10)),enabled=true,updated_at=clock_timestamp() where id=v_admin; end if;
  select id into v_staff from public.pin_accounts where role='staff' and site_id=v_site order by id limit 1;
  if v_staff is null then insert into public.pin_accounts(role,site_id,pin_hash,enabled,updated_at) values('staff',v_site,crypt(p_staff_pin,gen_salt('bf',10)),true,clock_timestamp()) returning id into v_staff;
  else update public.pin_accounts set pin_hash=crypt(p_staff_pin,gen_salt('bf',10)),enabled=true,updated_at=clock_timestamp() where id=v_staff; end if;
  delete from public.pin_sessions; delete from public.pin_login_throttle;
end $$;
revoke all on function public.configure_signage_pins(text,text) from public,anon,authenticated;

create or replace function public.admin_set_site_staff_pin(p_site uuid,p_pin text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_account bigint;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if not exists(select 1 from public.sites where id=p_site) then raise exception 'site not found'; end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception '병원 관리자 PIN은 숫자 4~6자리여야 합니다'; end if;
  if exists(select 1 from public.pin_accounts a where a.enabled and a.role='admin' and crypt(p_pin,a.pin_hash)=a.pin_hash) then raise exception '슈퍼어드민 PIN과 병원 관리자 PIN은 달라야 합니다'; end if;
  if exists(select 1 from public.pin_accounts a where a.enabled and a.role='staff' and a.site_id is distinct from p_site and crypt(p_pin,a.pin_hash)=a.pin_hash) then raise exception '다른 병원에서 사용 중인 PIN입니다'; end if;
  select id into v_account from public.pin_accounts where role='staff' and site_id=p_site order by id limit 1;
  if v_account is null then insert into public.pin_accounts(role,site_id,pin_hash,enabled,updated_at) values('staff',p_site,crypt(p_pin,gen_salt('bf',10)),true,clock_timestamp()) returning id into v_account;
  else update public.pin_accounts set pin_hash=crypt(p_pin,gen_salt('bf',10)),enabled=true,updated_at=clock_timestamp() where id=v_account; end if;
  delete from public.pin_sessions where account_id=v_account;
  perform public.audit_event(p_site,'update','access',v_account::text,'병원 관리자 PIN 변경',null,null);
end $$;
revoke all on function public.admin_set_site_staff_pin(uuid,text) from public;
grant execute on function public.admin_set_site_staff_pin(uuid,text) to anon,authenticated;
create or replace function public.pin_login(p_pin text, p_client_id text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_client text := left(trim(coalesce(p_client_id, '')), 100);
  v_ip_key text := 'ip:' || coalesce(public.pin_request_ip(), 'unknown');
  v_fail int := 0; v_locked timestamptz;
  v_ip_fail int := 0; v_ip_locked timestamptz; v_ip_updated timestamptz;
  v_account public.pin_accounts; v_token text; v_exp timestamptz;
  v_now timestamptz := clock_timestamp();
  c_ip_window constant interval := interval '15 minutes';
  c_ip_max constant int := 20;
begin
  if v_client = '' or v_client !~ '^[A-Za-z0-9._:-]{8,100}$' then return jsonb_build_object('ok', false, 'error', 'invalid_client'); end if;
  if p_pin !~ '^[0-9]{4,6}$' then return jsonb_build_object('ok', false, 'error', 'invalid_pin'); end if;

  -- IP 잠금
  select failed_count, locked_until, updated_at into v_ip_fail, v_ip_locked, v_ip_updated
    from public.pin_login_throttle where client_id = v_ip_key;
  if v_ip_locked is not null and v_ip_locked > v_now then
    return jsonb_build_object('ok', false, 'error', 'locked', 'retry_after_sec', greatest(1, ceil(extract(epoch from (v_ip_locked - v_now)))::int));
  end if;
  if v_ip_updated is null or v_ip_updated < v_now - c_ip_window then v_ip_fail := 0; end if;

  -- 기기(client_id) 잠금
  select failed_count, locked_until into v_fail, v_locked from public.pin_login_throttle where client_id = v_client;
  if v_locked is not null and v_locked > v_now then
    return jsonb_build_object('ok', false, 'error', 'locked', 'retry_after_sec', greatest(1, ceil(extract(epoch from (v_locked - v_now)))::int));
  end if;

  select a.* into v_account
    from public.pin_accounts a
   where a.enabled and crypt(p_pin, a.pin_hash) = a.pin_hash
   order by case a.role when 'admin' then 0 else 1 end
   limit 1;

  if not found then
    -- IP 카운터
    v_ip_fail := coalesce(v_ip_fail, 0) + 1;
    insert into public.pin_login_throttle(client_id, failed_count, locked_until, updated_at)
    values (v_ip_key, case when v_ip_fail >= c_ip_max then 0 else v_ip_fail end,
            case when v_ip_fail >= c_ip_max then v_now + c_ip_window end, v_now)
    on conflict (client_id) do update set failed_count = excluded.failed_count, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
    if v_ip_fail >= c_ip_max then
      return jsonb_build_object('ok', false, 'error', 'locked', 'retry_after_sec', extract(epoch from c_ip_window)::int);
    end if;

    -- 기기 카운터 (기존 동작)
    v_fail := coalesce(v_fail, 0) + 1;
    if v_fail >= 5 then
      insert into public.pin_login_throttle(client_id, failed_count, locked_until, updated_at)
      values (v_client, 0, v_now + interval '5 minutes', v_now)
      on conflict (client_id) do update set failed_count = 0, locked_until = excluded.locked_until, updated_at = v_now;
      return jsonb_build_object('ok', false, 'error', 'locked', 'retry_after_sec', 300);
    else
      insert into public.pin_login_throttle(client_id, failed_count, locked_until, updated_at)
      values (v_client, v_fail, null, v_now)
      on conflict (client_id) do update set failed_count = excluded.failed_count, locked_until = null, updated_at = v_now;
      return jsonb_build_object('ok', false, 'error', 'invalid_pin');
    end if;
  end if;

  delete from public.pin_login_throttle where client_id in (v_client, v_ip_key);
  delete from public.pin_login_throttle where locked_until is null and updated_at < v_now - interval '1 day';
  delete from public.pin_sessions where expires_at <= v_now;
  v_token := encode(gen_random_bytes(32), 'hex');
  v_exp := v_now + interval '12 hours';
  insert into public.pin_sessions(account_id, token_hash, expires_at) values (v_account.id, digest(v_token, 'sha256'), v_exp);
  return jsonb_build_object('ok', true, 'token', v_token, 'role', v_account.role, 'site_id', v_account.site_id, 'expires_at', v_exp);
end $$;
revoke all on function public.pin_login(text,text) from public;
grant execute on function public.pin_login(text,text) to anon,authenticated;
notify pgrst,'reload schema';


-- Site-aware analytics. MANUAL displays are intentionally excluded from player playback metrics.
drop function if exists public.admin_playback_today();
drop function if exists public.admin_building_period_stats(int);

create or replace function public.admin_playback_today(p_site uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_site uuid:=coalesce(p_site,public.default_site_id());
  v_now timestamp:=clock_timestamp() at time zone 'Asia/Seoul'; v_day date; v_elapsed int:=0; v_full int:=0;
  v_open boolean; v_start time; v_end time; v_rooms jsonb; v_overall jsonb;
  v_week_start date; v_month_start date; v_today_summary jsonb; v_week_summary jsonb; v_month_summary jsonb; v_room_count int:=0;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if not exists(select 1 from public.sites where id=v_site) then raise exception 'site not found'; end if;
  select count(*) into v_room_count from public.rooms r where r.site_id=v_site and coalesce(r.display_control_mode,'remote') in ('remote','hybrid');
  v_day:=v_now::date;
  select is_open,start_time,end_time,planned_seconds into v_open,v_start,v_end,v_full from public.signage_operating_window(v_day);
  if not v_open then v_elapsed:=0;
  elsif v_now::time<=v_start then v_elapsed:=0;
  elsif v_now::time>=v_end then v_elapsed:=v_full;
  else v_elapsed:=greatest(0,extract(epoch from (v_now::time-v_start))::int); end if;

  select coalesce(jsonb_agg(jsonb_build_object('room_id',r.id,'name',r.name,'group_name',g.name,'planned_seconds',v_elapsed,
    'online_seconds',coalesce(d.online_seconds,0),'playing_seconds',least(v_elapsed,coalesce(d.playing_seconds,0)),
    'default_seconds',coalesce(d.default_seconds,0),'custom_seconds',coalesce(d.custom_seconds,0),'override_seconds',coalesce(d.override_seconds,0),
    'error_seconds',coalesce(d.error_seconds,0),'paused_seconds',coalesce(d.paused_seconds,0),'error_count',coalesce(d.error_count,0),'reconnect_count',coalesce(d.reconnect_count,0),
    'rate',case when v_elapsed>0 then round(least(100,coalesce(d.playing_seconds,0)*100.0/v_elapsed),1) else 0 end,
    'last_seen_at',r.last_seen_at) order by coalesce(g.sort_order,2147483647),r.sort_order,r.created_at),'[]'::jsonb) into v_rooms
  from public.rooms r left join public.signage_groups g on g.id=r.group_id left join public.room_playback_daily d on d.room_id=r.id and d.day=v_day
  where r.site_id=v_site and coalesce(r.display_control_mode,'remote') in ('remote','hybrid');

  select jsonb_build_object('planned_seconds',v_elapsed*v_room_count,'playing_seconds',coalesce(sum(least(v_elapsed,coalesce(d.playing_seconds,0))),0),
    'error_count',coalesce(sum(d.error_count),0),'reconnect_count',coalesce(sum(d.reconnect_count),0),
    'rate',case when v_elapsed>0 and v_room_count>0 then round(coalesce(sum(least(v_elapsed,coalesce(d.playing_seconds,0))),0)*100.0/(v_elapsed*v_room_count),1) else 0 end) into v_overall
  from public.rooms r left join public.room_playback_daily d on d.room_id=r.id and d.day=v_day
  where r.site_id=v_site and coalesce(r.display_control_mode,'remote') in ('remote','hybrid');

  v_week_start:=v_day-(extract(isodow from v_day)::int-1); v_month_start:=date_trunc('month',v_day)::date;

  with expected as (select v_elapsed::bigint sec), actual as (
    select coalesce(sum(d.playing_seconds),0)::bigint playing,coalesce(sum(d.error_count),0)::bigint errors,coalesce(sum(d.reconnect_count),0)::bigint reconnects
    from public.room_playback_daily d join public.rooms r on r.id=d.room_id where d.day=v_day and r.site_id=v_site and coalesce(r.display_control_mode,'remote') in ('remote','hybrid')
  ) select jsonb_build_object('planned_seconds',expected.sec*v_room_count,'playing_seconds',least(expected.sec*v_room_count,actual.playing),'error_count',actual.errors,'reconnect_count',actual.reconnects,'rate',case when expected.sec>0 and v_room_count>0 then round(least(100,actual.playing*100.0/(expected.sec*v_room_count)),1) else 0 end) into v_today_summary from expected,actual;

  with days as (select x::date report_day from generate_series(v_week_start,v_day,'1 day') x), expected as (
    select sum(case when d.report_day=v_day then v_elapsed else w.planned_seconds end)::bigint sec from days d cross join lateral public.signage_operating_window(d.report_day) w
  ), actual as (
    select coalesce(sum(d.playing_seconds),0)::bigint playing,coalesce(sum(d.error_count),0)::bigint errors,coalesce(sum(d.reconnect_count),0)::bigint reconnects
    from public.room_playback_daily d join public.rooms r on r.id=d.room_id where d.day between v_week_start and v_day and r.site_id=v_site and coalesce(r.display_control_mode,'remote') in ('remote','hybrid')
  ) select jsonb_build_object('planned_seconds',expected.sec*v_room_count,'playing_seconds',least(expected.sec*v_room_count,actual.playing),'error_count',actual.errors,'reconnect_count',actual.reconnects,'rate',case when expected.sec>0 and v_room_count>0 then round(least(100,actual.playing*100.0/(expected.sec*v_room_count)),1) else 0 end) into v_week_summary from expected,actual;

  with days as (select x::date report_day from generate_series(v_month_start,v_day,'1 day') x), expected as (
    select sum(case when d.report_day=v_day then v_elapsed else w.planned_seconds end)::bigint sec from days d cross join lateral public.signage_operating_window(d.report_day) w
  ), actual as (
    select coalesce(sum(d.playing_seconds),0)::bigint playing,coalesce(sum(d.error_count),0)::bigint errors,coalesce(sum(d.reconnect_count),0)::bigint reconnects
    from public.room_playback_daily d join public.rooms r on r.id=d.room_id where d.day between v_month_start and v_day and r.site_id=v_site and coalesce(r.display_control_mode,'remote') in ('remote','hybrid')
  ) select jsonb_build_object('planned_seconds',expected.sec*v_room_count,'playing_seconds',least(expected.sec*v_room_count,actual.playing),'error_count',actual.errors,'reconnect_count',actual.reconnects,'rate',case when expected.sec>0 and v_room_count>0 then round(least(100,actual.playing*100.0/(expected.sec*v_room_count)),1) else 0 end) into v_month_summary from expected,actual;

  return jsonb_build_object('site_id',v_site,'day',v_day,'is_open',v_open,'operating_start',v_start,'operating_end',v_end,'elapsed_seconds',v_elapsed,'overall',coalesce(v_overall,'{}'::jsonb),'rooms',coalesce(v_rooms,'[]'::jsonb),'periods',jsonb_build_object('today',v_today_summary,'week',v_week_summary,'month',v_month_summary));
end $$;
revoke all on function public.admin_playback_today(uuid) from public;
grant execute on function public.admin_playback_today(uuid) to anon,authenticated;

create or replace function public.admin_building_period_stats(p_days int default 7,p_site uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_today date:=(clock_timestamp() at time zone 'Asia/Seoul')::date; v_days int:=greatest(1,least(coalesce(p_days,7),31)); v_from date; v_rooms jsonb; v_site uuid:=coalesce(p_site,public.default_site_id());
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if not exists(select 1 from public.sites where id=v_site) then raise exception 'site not found'; end if;
  v_from:=v_today-(v_days-1);
  with expected as (
    select coalesce(sum(w.planned_seconds),0)::bigint sec from generate_series(v_from,v_today,'1 day') d(day) cross join lateral public.signage_operating_window(d.day::date) w
  ), agg as (
    select r.id room_id,r.group_id,coalesce(sum(d.playing_seconds),0)::bigint playing_seconds,coalesce(sum(d.error_count),0)::bigint error_count,coalesce(sum(d.reconnect_count),0)::bigint reconnect_count
    from public.rooms r left join public.room_playback_daily d on d.room_id=r.id and d.day between v_from and v_today
    where r.site_id=v_site and coalesce(r.display_control_mode,'remote') in ('remote','hybrid') group by r.id,r.group_id
  ) select coalesce(jsonb_agg(jsonb_build_object('room_id',a.room_id,'group_id',a.group_id,'planned_seconds',e.sec,'playing_seconds',least(e.sec,a.playing_seconds),'error_count',a.error_count,'reconnect_count',a.reconnect_count,'rate',case when e.sec>0 then round(least(100,a.playing_seconds*100.0/e.sec),1) else 0 end)),'[]'::jsonb) into v_rooms from agg a cross join expected e;
  return jsonb_build_object('site_id',v_site,'from',v_from,'to',v_today,'days',v_days,'rooms',v_rooms);
end $$;
revoke all on function public.admin_building_period_stats(int,uuid) from public;
grant execute on function public.admin_building_period_stats(int,uuid) to anon,authenticated;

notify pgrst,'reload schema';
-- Site-specific playlist management for hospital administrators.
drop index if exists public.playlists_name_uidx;
create unique index if not exists playlists_global_name_uidx on public.playlists(lower(name)) where site_id is null;
create unique index if not exists playlists_site_name_uidx on public.playlists(site_id,lower(name)) where site_id is not null;

create or replace function public.staff_save_site_playlist(p_id uuid,p_name text,p_video_ids uuid[])
returns uuid language plpgsql security definer set search_path=public as $$
declare v_site uuid:=public.pin_session_site_id(); v_id uuid; v_video uuid; v_pos int:=0;
begin
  if public.pin_session_role()<>'staff' or v_site is null then raise exception 'not allowed'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception '플레이리스트 이름을 입력하세요'; end if;
  if exists(select 1 from unnest(coalesce(p_video_ids,'{}'::uuid[])) x where not exists(select 1 from public.videos v where v.id=x and v.active and (v.site_id is null or v.site_id=v_site))) then raise exception '사용할 수 없는 영상이 포함되어 있습니다'; end if;
  if p_id is null then
    insert into public.playlists(site_id,name,kind,active,sort_order,updated_at) values(v_site,trim(p_name),'default',true,coalesce((select max(sort_order)+10 from public.playlists where site_id=v_site),10),clock_timestamp()) returning id into v_id;
  else
    update public.playlists set name=trim(p_name),active=true,updated_at=clock_timestamp() where id=p_id and site_id=v_site returning id into v_id;
    if v_id is null then raise exception '병원 플레이리스트를 찾을 수 없습니다'; end if;
    delete from public.playlist_items where playlist_id=v_id;
  end if;
  foreach v_video in array coalesce(p_video_ids,'{}'::uuid[]) loop
    v_pos:=v_pos+10;
    insert into public.playlist_items(playlist_id,video_id,sort_order) values(v_id,v_video,v_pos) on conflict(playlist_id,video_id) do update set sort_order=excluded.sort_order;
  end loop;
  perform public.audit_event(v_site,'update','playlist',v_id::text,'병원 플레이리스트 저장',null,jsonb_build_object('name',trim(p_name),'video_count',coalesce(array_length(p_video_ids,1),0)));
  return v_id;
end $$;
revoke all on function public.staff_save_site_playlist(uuid,text,uuid[]) from public;
grant execute on function public.staff_save_site_playlist(uuid,text,uuid[]) to anon,authenticated;

create or replace function public.staff_delete_site_playlist(p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_site uuid:=public.pin_session_site_id();
begin
  if public.pin_session_role()<>'staff' or v_site is null then raise exception 'not allowed'; end if;
  if exists(select 1 from public.rooms where site_id=v_site and default_playlist_id=p_id) or exists(select 1 from public.signage_groups where site_id=v_site and default_playlist_id=p_id) then raise exception '사용 중인 플레이리스트는 삭제할 수 없습니다'; end if;
  delete from public.playlists where id=p_id and site_id=v_site;
  if not found then raise exception '병원 플레이리스트를 찾을 수 없습니다'; end if;
  perform public.audit_event(v_site,'delete','playlist',p_id::text,'병원 플레이리스트 삭제',null,null);
end $$;
revoke all on function public.staff_delete_site_playlist(uuid) from public;
grant execute on function public.staff_delete_site_playlist(uuid) to anon,authenticated;
notify pgrst,'reload schema';


-- Manual displays stay black/idle even if an old player URL is still open.
create or replace function public.player_get_state(p_key uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  r public.rooms; b public.broadcast; s public.app_settings; gb public.group_broadcasts; hs public.broadcast_schedules; gs public.broadcast_schedules;
  v_mode text; v_expires timestamptz; v_playlist jsonb:='[]'::jsonb; v_emergency jsonb; v_playlist_id uuid;
  v_notice text; v_effective timestamptz; v_revision text:='0'; v_next_transition timestamptz; v_operating jsonb; v_operating_end timestamptz;
begin
  select * into r from public.rooms where player_key=p_key; if not found then return null; end if;
  select * into b from public.broadcast where id=1; select * into s from public.app_settings where id=1;
  if coalesce(r.display_control_mode,'remote')='manual' then
    return jsonb_build_object('room',jsonb_build_object('id',r.id,'name',r.name,'group_id',r.group_id,'room_mode',r.room_mode,'force_mute',true,'volume',0,'paused',true,'overlay_text',null,'reload_nonce',r.reload_nonce),'mode','closed','priority','manual','manual_control',true,'playlist','[]'::jsonb,'emergency_video',null,'operating',jsonb_build_object('active',false,'reason','manual_display'),'sync_revision','manual:'||r.id::text,'next_transition_at',null,'media_server_url',coalesce(s.media_server_url,''),'server_time',clock_timestamp());
  end if;
  v_operating:=public.signage_room_operating_status(r.id,clock_timestamp());
  if coalesce((v_operating->>'active')::boolean,false)=false then
    return jsonb_build_object('room',jsonb_build_object('id',r.id,'name',r.name,'group_id',r.group_id,'room_mode',r.room_mode,'force_mute',r.force_mute,'volume',r.volume,'paused',r.paused,'overlay_text',r.overlay_text,'reload_nonce',r.reload_nonce),'mode','closed','priority','closed','playlist','[]'::jsonb,'emergency_video',null,'operating',v_operating,'sync_revision','closed:'||coalesce(v_operating->>'next_start_at','none'),'next_transition_at',v_operating->>'next_start_at','media_server_url',coalesce(s.media_server_url,''),'server_time',clock_timestamp());
  end if;
  v_operating_end:=nullif(v_operating->>'current_end_at','')::timestamptz;
  if r.group_id is not null then select * into gb from public.group_broadcasts where group_id=r.group_id; end if;
  select * into hs from public.broadcast_schedules x where x.enabled and x.scope_type='hospital' and x.starts_at<=clock_timestamp() and x.ends_at>clock_timestamp() order by x.starts_at desc limit 1;
  if r.group_id is not null then select * into gs from public.broadcast_schedules x where x.enabled and x.scope_type='group' and x.group_id=r.group_id and x.starts_at<=clock_timestamp() and x.ends_at>clock_timestamp() order by x.starts_at desc limit 1; end if;
  select min(t) into v_next_transition from (
    select starts_at t from public.broadcast_schedules x where x.enabled and x.starts_at>clock_timestamp() and (x.scope_type='hospital' or (x.scope_type='group' and x.group_id=r.group_id))
    union all select ends_at t from public.broadcast_schedules x where x.enabled and x.ends_at>clock_timestamp() and (x.scope_type='hospital' or (x.scope_type='group' and x.group_id=r.group_id))
    union all select b.starts_at where b.active and b.starts_at is not null and b.starts_at>clock_timestamp()
    union all select b.ends_at where b.active and b.ends_at is not null and b.ends_at>clock_timestamp()
    union all select r.manual_starts_at where r.manual_active and r.manual_starts_at is not null and r.manual_starts_at>clock_timestamp()
    union all select r.manual_ends_at where r.manual_active and r.manual_ends_at is not null and r.manual_ends_at>clock_timestamp()
    union all select starts_at t from public.room_video_rules rr where rr.room_id=r.id and rr.starts_at>clock_timestamp()
    union all select ends_at t from public.room_video_rules rr where rr.room_id=r.id and rr.ends_at>clock_timestamp()
  ) q;
  if v_operating_end is not null and (v_next_transition is null or v_operating_end<v_next_transition) then v_next_transition:=v_operating_end; end if;
  if r.session_started_at is not null and r.session_timeout_min>0 then v_expires:=r.session_started_at+make_interval(mins=>r.session_timeout_min); end if;

  if b.active and (b.starts_at is null or b.starts_at<=clock_timestamp()) and (b.ends_at is null or b.ends_at>clock_timestamp()) and coalesce(array_length(b.video_ids,1),0)>0 then
    select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by array_position(b.video_ids,v.id)),'[]'::jsonb) into v_playlist from public.videos v where v.id=any(b.video_ids) and v.active and (v.source<>'local' or v.available);
    if jsonb_array_length(v_playlist)>0 then v_mode:='broadcast';v_notice:=b.notice_text;v_effective:=b.effective_at;v_revision:='b:'||b.revision; end if;
  end if;
  if v_mode is null and hs.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by array_position(hs.video_ids,v.id)),'[]'::jsonb) into v_playlist from public.videos v where v.id=any(hs.video_ids) and v.active and (v.source<>'local' or v.available);
    if jsonb_array_length(v_playlist)>0 then v_mode:='broadcast_schedule';v_notice:=hs.notice_text;v_effective:=hs.starts_at;v_revision:='hs:'||hs.id::text||':'||extract(epoch from hs.starts_at)::bigint; end if;
  end if;
  if v_mode is null and r.manual_active and (r.manual_starts_at is null or r.manual_starts_at<=clock_timestamp()) and (r.manual_ends_at is null or r.manual_ends_at>clock_timestamp()) and coalesce(array_length(r.manual_video_ids,1),0)>0 then
    select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by array_position(r.manual_video_ids,v.id)),'[]'::jsonb) into v_playlist from public.videos v where v.id=any(r.manual_video_ids) and v.active and (v.source<>'local' or v.available);
    if jsonb_array_length(v_playlist)>0 then v_mode:='manual';v_revision:='m:'||coalesce(extract(epoch from r.manual_updated_at)::bigint,0); end if;
  end if;
  if v_mode is null and gb.group_id is not null and gb.active and coalesce(array_length(gb.video_ids,1),0)>0 then
    select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by array_position(gb.video_ids,v.id)),'[]'::jsonb) into v_playlist from public.videos v where v.id=any(gb.video_ids) and v.active and (v.source<>'local' or v.available);
    if jsonb_array_length(v_playlist)>0 then v_mode:='group';v_notice:=gb.notice_text;v_effective:=gb.effective_at;v_revision:='g:'||gb.revision; end if;
  end if;
  if v_mode is null and gs.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by array_position(gs.video_ids,v.id)),'[]'::jsonb) into v_playlist from public.videos v where v.id=any(gs.video_ids) and v.active and (v.source<>'local' or v.available);
    if jsonb_array_length(v_playlist)>0 then v_mode:='group_schedule';v_notice:=gs.notice_text;v_effective:=gs.starts_at;v_revision:='gs:'||gs.id::text||':'||extract(epoch from gs.starts_at)::bigint; end if;
  end if;

  if v_mode is null and r.room_mode in ('treatment','consultation') and r.session_treatment is not null and r.session_started_at is not null and (v_expires is null or v_expires>clock_timestamp()) then
    select p.id into v_playlist_id from public.playlists p where p.active and p.kind='patient' and (p.site_id is null or p.site_id=r.site_id)
      and (coalesce(array_length(p.target_treatment,1),0)=0 or r.session_treatment=any(p.target_treatment))
      and (coalesce(array_length(p.target_age,1),0)=0 or (r.session_age_group is not null and r.session_age_group=any(p.target_age)))
      and (coalesce(array_length(p.target_gender,1),0)=0 or (r.session_gender is not null and r.session_gender=any(p.target_gender)))
    order by (case when p.site_id=r.site_id then 1000 else 0 end + case when coalesce(array_length(p.target_treatment,1),0)>0 then 100 else 0 end + case when coalesce(array_length(p.target_age,1),0)>0 then 10 else 0 end + case when coalesce(array_length(p.target_gender,1),0)>0 then 5 else 0 end) desc,p.sort_order,p.created_at limit 1;
    if v_playlist_id is not null then
      select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by pi.sort_order,pi.created_at),'[]'::jsonb) into v_playlist from public.playlist_items pi join public.videos v on v.id=pi.video_id where pi.playlist_id=v_playlist_id and v.active and (v.site_id is null or v.site_id=r.site_id) and (v.source<>'local' or v.available);
      if jsonb_array_length(v_playlist)>0 then v_mode:='patient';v_revision:='pp:'||v_playlist_id::text||':'||coalesce(extract(epoch from r.session_started_at)::bigint,0); end if;
    end if;
    if v_mode is null then
      with candidates as (select v.*,(case when coalesce(array_length(v.target_treatment,1),0)>0 then 100 else 0 end + case when coalesce(array_length(v.target_age,1),0)>0 then 10 else 0 end + case when coalesce(array_length(v.target_gender,1),0)>0 then 5 else 0 end) score from public.videos v where v.active and (v.site_id is null or v.site_id=r.site_id) and (v.source<>'local' or v.available) and (coalesce(array_length(v.target_treatment,1),0)=0 or r.session_treatment=any(v.target_treatment)) and (coalesce(array_length(v.target_age,1),0)=0 or (r.session_age_group is not null and r.session_age_group=any(v.target_age))) and (coalesce(array_length(v.target_gender,1),0)=0 or (r.session_gender is not null and r.session_gender=any(v.target_gender)))), best as (select max(score) score from candidates)
      select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'source',c.source,'file_path',c.file_path,'url',c.url,'size',c.size_bytes,'file_modified_at',c.file_modified_at) order by c.sort_order,c.created_at),'[]'::jsonb) into v_playlist from candidates c cross join best where c.score=best.score;
      if jsonb_array_length(v_playlist)>0 then v_mode:='patient';v_revision:='legacy-p:'||coalesce(extract(epoch from r.session_started_at)::bigint,0); end if;
    end if;
  end if;

  if v_mode is null then
    v_mode:='default';v_expires:=null;
    v_playlist_id:=r.default_playlist_id;
    if v_playlist_id is null and r.group_id is not null then select default_playlist_id into v_playlist_id from public.signage_groups where id=r.group_id; end if;
    if v_playlist_id is null then select id into v_playlist_id from public.playlists where active and kind='default' and (site_id is null or site_id=r.site_id) order by (site_id=r.site_id) desc,sort_order,created_at limit 1; end if;
    if v_playlist_id is not null then select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by pi.sort_order,pi.created_at),'[]'::jsonb) into v_playlist from public.playlist_items pi join public.videos v on v.id=pi.video_id where pi.playlist_id=v_playlist_id and v.active and (v.site_id is null or v.site_id=r.site_id) and (v.source<>'local' or v.available); end if;
    if jsonb_array_length(v_playlist)=0 then select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by v.sort_order,v.created_at),'[]'::jsonb) into v_playlist from public.videos v where v.active and (v.site_id is null or v.site_id=r.site_id) and (v.source<>'local' or v.available) and v.tags&&r.default_tags; end if;
    v_revision:='d:'||coalesce(v_playlist_id::text,'legacy');
  end if;
  if v_mode in ('manual','patient','default') then
    v_playlist:=public.apply_room_video_rules(r.id,v_playlist);
    v_revision:=v_revision||':rr:'||coalesce((select extract(epoch from max(updated_at))::bigint::text from public.room_video_rules where room_id=r.id),'0');
  end if;
  if s.emergency_video_id is not null then select jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) into v_emergency from public.videos v where v.id=s.emergency_video_id and v.active and (v.source<>'local' or v.available); end if;
  return jsonb_build_object('room',jsonb_build_object('id',r.id,'name',r.name,'group_id',r.group_id,'room_mode',r.room_mode,'force_mute',r.force_mute,'volume',r.volume,'paused',r.paused,'overlay_text',r.overlay_text,'reload_nonce',r.reload_nonce),'mode',v_mode,'priority',v_mode,'operating',v_operating,'session_expires_at',case when v_mode='patient' then v_expires end,'notice_text',v_notice,'playlist',v_playlist,'emergency_video',v_emergency,'sync_effective_at',v_effective,'sync_revision',v_revision,'next_transition_at',v_next_transition,'media_server_url',coalesce(s.media_server_url,''),'server_time',clock_timestamp());
end $$;
revoke all on function public.player_get_state(uuid) from public;
grant execute on function public.player_get_state(uuid) to anon,authenticated;
notify pgrst,'reload schema';
