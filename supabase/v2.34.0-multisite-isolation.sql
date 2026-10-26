-- Clinic Signage v2.34.0 multi-site isolation migration
-- Run once in Supabase SQL Editor before deploying v2.34.0 web files.

begin;


-- Hospital admin accounts must always belong to a site; deleting a site with active hospital admins is blocked.
alter table public.pin_accounts drop constraint if exists pin_accounts_site_id_fkey;
alter table public.pin_accounts add constraint pin_accounts_site_id_fkey foreign key(site_id) references public.sites(id) on delete restrict;
alter table public.pin_accounts drop constraint if exists pin_accounts_staff_site_required;
alter table public.pin_accounts add constraint pin_accounts_staff_site_required check(role<>'staff' or site_id is not null);
-- 1) Site-scoped hospital broadcast state.
create table if not exists public.site_broadcasts (
  site_id uuid primary key references public.sites(id) on delete cascade,
  active boolean not null default false,
  video_ids uuid[] not null default '{}',
  notice_text text,
  starts_at timestamptz,
  ends_at timestamptz,
  effective_at timestamptz,
  revision bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  check(ends_at is null or starts_at is null or ends_at>starts_at)
);
insert into public.site_broadcasts(site_id,active,video_ids,notice_text,starts_at,ends_at,effective_at,revision,updated_at)
select public.default_site_id(),b.active,b.video_ids,b.notice_text,b.starts_at,b.ends_at,b.effective_at,b.revision,b.updated_at
from public.broadcast b where b.id=1 and public.default_site_id() is not null
on conflict(site_id) do nothing;
insert into public.site_broadcasts(site_id) select id from public.sites on conflict(site_id) do nothing;
alter table public.site_broadcasts enable row level security;
drop policy if exists site_broadcasts_manage on public.site_broadcasts;
create policy site_broadcasts_manage on public.site_broadcasts for all to anon,authenticated using(public.can_manage_site(site_id)) with check(public.can_manage_site(site_id));
grant select,insert,update,delete on public.site_broadcasts to anon,authenticated;

-- 2) Hospital schedules belong to a site.
alter table public.broadcast_schedules add column if not exists site_id uuid references public.sites(id) on delete cascade;
update public.broadcast_schedules bs set site_id=coalesce((select g.site_id from public.signage_groups g where g.id=bs.group_id),public.default_site_id()) where bs.site_id is null;
create index if not exists broadcast_schedules_site_active_idx on public.broadcast_schedules(site_id,enabled,scope_type,starts_at,ends_at);
drop policy if exists schedules_admin on public.broadcast_schedules;
drop policy if exists schedules_site_manage on public.broadcast_schedules;
create policy schedules_site_manage on public.broadcast_schedules for all to anon,authenticated using(site_id is not null and public.can_manage_site(site_id)) with check(site_id is not null and public.can_manage_site(site_id));

-- 3) Existing default-site operating settings move into site_settings.operating_config.
update public.site_settings ss set operating_config = coalesce(ss.operating_config,'{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
  'weekday_enabled',a.operating_weekday_enabled,'weekday_start',a.operating_weekday_start::text,'weekday_end',a.operating_weekday_end::text,
  'saturday_enabled',a.operating_saturday_enabled,'saturday_start',a.operating_saturday_start::text,'saturday_end',a.operating_saturday_end::text,
  'sunday_enabled',a.operating_sunday_enabled,'sunday_start',a.operating_sunday_start::text,'sunday_end',a.operating_sunday_end::text,
  'early_closed_date',a.early_closed_date::text,'emergency_video_id',a.emergency_video_id::text
)),updated_at=clock_timestamp()
from public.app_settings a where a.id=1 and ss.site_id=public.default_site_id();

-- Helper: site config with safe defaults.
create or replace function public.site_operating_config(p_site uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'weekday_enabled',coalesce((ss.operating_config->>'weekday_enabled')::boolean,true),
    'weekday_start',coalesce(nullif(ss.operating_config->>'weekday_start','')::time,'09:00'::time),
    'weekday_end',coalesce(nullif(ss.operating_config->>'weekday_end','')::time,'20:00'::time),
    'saturday_enabled',coalesce((ss.operating_config->>'saturday_enabled')::boolean,true),
    'saturday_start',coalesce(nullif(ss.operating_config->>'saturday_start','')::time,'09:00'::time),
    'saturday_end',coalesce(nullif(ss.operating_config->>'saturday_end','')::time,'17:00'::time),
    'sunday_enabled',coalesce((ss.operating_config->>'sunday_enabled')::boolean,false),
    'sunday_start',coalesce(nullif(ss.operating_config->>'sunday_start','')::time,'09:00'::time),
    'sunday_end',coalesce(nullif(ss.operating_config->>'sunday_end','')::time,'17:00'::time),
    'early_closed_date',nullif(ss.operating_config->>'early_closed_date','')::date,
    'emergency_video_id',nullif(ss.operating_config->>'emergency_video_id','')
  ) from public.site_settings ss where ss.site_id=p_site;
$$;
revoke all on function public.site_operating_config(uuid) from public;
grant execute on function public.site_operating_config(uuid) to anon,authenticated;

create or replace function public.signage_room_operating_window(p_room uuid,p_day date)
returns table(is_open boolean,start_time time,end_time time,planned_seconds int)
language plpgsql stable security definer set search_path=public as $$
declare r public.rooms; c jsonb; dow int;
begin
  select * into r from public.rooms where id=p_room;
  if r.id is null then is_open:=false;start_time:='00:00';end_time:='00:00';planned_seconds:=0;return next;return;end if;
  c:=coalesce(public.site_operating_config(r.site_id),'{}'::jsonb); dow:=extract(isodow from p_day)::int;
  if r.operating_override then
    if dow between 1 and 5 then is_open:=r.operating_weekday_enabled;start_time:=r.operating_weekday_start;end_time:=r.operating_weekday_end;
    elsif dow=6 then is_open:=r.operating_saturday_enabled;start_time:=r.operating_saturday_start;end_time:=r.operating_saturday_end;
    else is_open:=r.operating_sunday_enabled;start_time:=r.operating_sunday_start;end_time:=r.operating_sunday_end; end if;
  else
    if dow between 1 and 5 then is_open:=coalesce((c->>'weekday_enabled')::boolean,true);start_time:=coalesce((c->>'weekday_start')::time,'09:00');end_time:=coalesce((c->>'weekday_end')::time,'20:00');
    elsif dow=6 then is_open:=coalesce((c->>'saturday_enabled')::boolean,true);start_time:=coalesce((c->>'saturday_start')::time,'09:00');end_time:=coalesce((c->>'saturday_end')::time,'17:00');
    else is_open:=coalesce((c->>'sunday_enabled')::boolean,false);start_time:=coalesce((c->>'sunday_start')::time,'09:00');end_time:=coalesce((c->>'sunday_end')::time,'17:00'); end if;
  end if;
  if nullif(c->>'early_closed_date','')::date=p_day then is_open:=false; end if;
  if not coalesce(is_open,false) or start_time is null or end_time is null or end_time<=start_time then is_open:=false;planned_seconds:=0; else planned_seconds:=extract(epoch from (end_time-start_time))::int; end if;
  return next;
end $$;

-- 4) Site-safe content policies. Global (site_id NULL) content stays shared by design.
drop policy if exists videos_select on public.videos;
create policy videos_select on public.videos for select to anon,authenticated using(public.is_admin() or (public.is_member() and (site_id is null or public.can_manage_site(site_id))));
drop policy if exists videos_admin on public.videos;
create policy videos_admin on public.videos for all to anon,authenticated using(public.is_admin() or (site_id is not null and public.can_manage_site(site_id))) with check(public.is_admin() or (site_id is not null and public.can_manage_site(site_id)));
drop policy if exists playlists_select on public.playlists;
create policy playlists_select on public.playlists for select to anon,authenticated using(public.is_admin() or (public.is_member() and (site_id is null or public.can_manage_site(site_id))));
drop policy if exists playlists_admin on public.playlists;
create policy playlists_admin on public.playlists for all to anon,authenticated using(public.is_admin() or (site_id is not null and public.can_manage_site(site_id))) with check(public.is_admin() or (site_id is not null and public.can_manage_site(site_id)));
drop policy if exists playlist_items_select on public.playlist_items;
create policy playlist_items_select on public.playlist_items for select to anon,authenticated using(exists(select 1 from public.playlists p where p.id=playlist_id and (public.is_admin() or (public.is_member() and (p.site_id is null or public.can_manage_site(p.site_id))))));
drop policy if exists playlist_items_admin on public.playlist_items;
create policy playlist_items_admin on public.playlist_items for all to anon,authenticated using(exists(select 1 from public.playlists p where p.id=playlist_id and (public.is_admin() or (p.site_id is not null and public.can_manage_site(p.site_id))))) with check(exists(select 1 from public.playlists p where p.id=playlist_id and (public.is_admin() or (p.site_id is not null and public.can_manage_site(p.site_id)))));

-- Never silently map a hospital administrator with no site to the default hospital.
create or replace function public.can_manage_site(p_site uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select coalesce(case public.pin_session_role() when 'admin' then p_site is not null when 'staff' then p_site is not null and public.pin_session_site_id()=p_site else false end,false);
$$;
revoke all on function public.can_manage_site(uuid) from public;
grant execute on function public.can_manage_site(uuid) to anon,authenticated;

-- Resolve the site of a room; used by room-level controls for both superadmin and hospital admin.
create or replace function public.manageable_room_site(p_room uuid)
returns uuid language sql stable security definer set search_path=public as $$
  select r.site_id from public.rooms r where r.id=p_room and public.can_manage_site(r.site_id) limit 1;
$$;
revoke all on function public.manageable_room_site(uuid) from public,anon,authenticated;

-- Strict video order validation (no cross-hospital video IDs).
create or replace function public.staff_set_room_video_order(p_room uuid,p_video_ids uuid[])
returns void language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_pos int:=0; v_site uuid:=public.manageable_room_site(p_room);
begin
  if not public.is_member() or v_site is null or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  if exists(select 1 from unnest(coalesce(p_video_ids,'{}'::uuid[])) x where not exists(select 1 from public.videos v where v.id=x and v.active and (v.site_id is null or v.site_id=v_site))) then raise exception '다른 병원의 영상이 포함되어 있습니다'; end if;
  foreach v_id in array coalesce(p_video_ids,'{}'::uuid[]) loop v_pos:=v_pos+10; insert into public.room_video_rules(room_id,video_id,sort_order,updated_at) values(p_room,v_id,v_pos,clock_timestamp()) on conflict(room_id,video_id) do update set sort_order=excluded.sort_order,updated_at=clock_timestamp(); end loop;
end $$;

-- Floor space group must belong to the same site.
create or replace function public.enforce_floor_space_group_site() returns trigger language plpgsql set search_path=public as $$
begin
  if new.group_id is not null and not exists(select 1 from public.signage_groups g where g.id=new.group_id and g.site_id=new.site_id) then raise exception '층/구역이 다른 병원에 속해 있습니다'; end if;
  return new;
end $$;
drop trigger if exists floor_spaces_group_site_guard on public.floor_spaces;
create trigger floor_spaces_group_site_guard before insert or update of site_id,group_id on public.floor_spaces for each row execute function public.enforce_floor_space_group_site();

-- Hospital page state explicitly selects a site.
create or replace function public.hospital_reception_state(p_site uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_site uuid; v_rooms jsonb; v_groups jsonb; v_patients jsonb; v_broadcast jsonb; v_playlists jsonb; v_videos jsonb; v_items jsonb; v_rules jsonb; v_site_row jsonb; v_floorplans jsonb; v_spaces jsonb; v_versions jsonb; v_settings jsonb;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  v_site:=case when public.is_admin() then p_site else public.pin_session_site_id() end;
  if v_site is null or (not public.is_admin() and p_site is not null and p_site<>v_site) or not public.can_manage_site(v_site) then raise exception 'not allowed'; end if;
  select to_jsonb(s) into v_site_row from public.sites s where s.id=v_site; if v_site_row is null then raise exception 'site not found'; end if;
  select coalesce(ss.floorplan_assets,'{}'::jsonb),coalesce(ss.operating_config,'{}'::jsonb) into v_floorplans,v_settings from public.site_settings ss where ss.site_id=v_site;
  select coalesce(jsonb_agg(to_jsonb(fs) order by fs.sort_order,fs.created_at),'[]'::jsonb) into v_spaces from public.floor_spaces fs where fs.site_id=v_site;
  select coalesce(jsonb_agg(to_jsonb(fv) order by fv.created_at desc),'[]'::jsonb) into v_versions from public.floorplan_versions fv where fv.site_id=v_site;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'site_id',r.site_id,'name',r.name,'sort_order',r.sort_order,'group_id',r.group_id,'group_name',g.name,'room_mode',r.room_mode,'last_seen_at',r.last_seen_at,'player_status',coalesce(r.player_status,'{}'::jsonb),'session_timeout_min',r.session_timeout_min,'session_started_at',r.session_started_at,'session_age_group',r.session_age_group,'session_gender',r.session_gender,'session_treatment',r.session_treatment,'default_playlist_id',r.default_playlist_id,'manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids,'map_x_pct',r.map_x_pct,'map_y_pct',r.map_y_pct,'display_control_mode',r.display_control_mode,'manual_check_status',r.manual_check_status,'manual_checked_at',r.manual_checked_at,'manual_checked_by',r.manual_checked_by,'display_note',r.display_note) order by coalesce(g.sort_order,2147483647),r.sort_order,r.created_at),'[]'::jsonb) into v_rooms from public.rooms r left join public.signage_groups g on g.id=r.group_id where r.site_id=v_site;
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'site_id',g.site_id,'name',g.name,'kind',g.kind,'floor_number',g.floor_number,'care_type',g.care_type,'signage_purpose',g.signage_purpose,'target_audience',g.target_audience,'waiting_area_note',g.waiting_area_note,'signage_reason',g.signage_reason,'default_playlist_id',g.default_playlist_id,'sort_order',g.sort_order) order by g.sort_order,g.floor_number,g.created_at),'[]'::jsonb) into v_groups from public.signage_groups g where g.site_id=v_site;
  select coalesce(jsonb_agg(to_jsonb(x) order by case x.status when 'in_progress' then 0 when 'assigned' then 1 when 'waiting' then 2 else 3 end,x.waiting_started_at),'[]'::jsonb) into v_patients from (select * from public.patient_sessions where site_id=v_site and (status in ('waiting','assigned','in_progress') or (status='completed' and completed_at>=date_trunc('day',clock_timestamp())))) x;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'site_id',p.site_id,'name',p.name,'kind',p.kind,'active',p.active,'sort_order',p.sort_order,'target_treatment',p.target_treatment,'target_age',p.target_age,'target_gender',p.target_gender) order by p.sort_order,p.created_at),'[]'::jsonb) into v_playlists from public.playlists p where p.active and (p.site_id is null or p.site_id=v_site);
  select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'site_id',v.site_id,'title',v.title,'active',v.active,'duration_sec',v.duration_sec,'thumbnail_data_url',v.thumbnail_data_url,'target_treatment',v.target_treatment,'target_age',v.target_age,'target_gender',v.target_gender) order by v.sort_order,v.created_at),'[]'::jsonb) into v_videos from public.videos v where v.active and (v.site_id is null or v.site_id=v_site) and (v.source<>'local' or v.available);
  select coalesce(jsonb_agg(jsonb_build_object('playlist_id',pi.playlist_id,'video_id',pi.video_id,'sort_order',pi.sort_order) order by pi.playlist_id,pi.sort_order,pi.created_at),'[]'::jsonb) into v_items from public.playlist_items pi join public.playlists p on p.id=pi.playlist_id where p.site_id is null or p.site_id=v_site;
  select coalesce(jsonb_agg(jsonb_build_object('room_id',rr.room_id,'video_id',rr.video_id,'enabled',rr.enabled,'sort_order',rr.sort_order,'starts_at',rr.starts_at,'ends_at',rr.ends_at,'updated_at',rr.updated_at)),'[]'::jsonb) into v_rules from public.room_video_rules rr join public.rooms r on r.id=rr.room_id where r.site_id=v_site;
  select jsonb_build_object('active',active,'video_ids',video_ids,'notice_text',notice_text,'starts_at',starts_at,'ends_at',ends_at,'revision',revision) into v_broadcast from public.site_broadcasts where site_id=v_site;
  return jsonb_build_object('site',v_site_row,'site_settings',coalesce(v_settings,'{}'::jsonb),'floorplan_assets',coalesce(v_floorplans,'{}'::jsonb),'floorplan_versions',coalesce(v_versions,'[]'::jsonb),'spaces',coalesce(v_spaces,'[]'::jsonb),'rooms',v_rooms,'groups',v_groups,'patients',v_patients,'playlists',v_playlists,'videos',v_videos,'playlist_items',v_items,'room_video_rules',v_rules,'broadcast',coalesce(v_broadcast,'{}'::jsonb),'server_time',clock_timestamp());
end $$;
revoke all on function public.hospital_reception_state(uuid) from public;
grant execute on function public.hospital_reception_state(uuid) to anon,authenticated;

-- Site-level hospital settings work for both superadmin and that hospital's admin.
create or replace function public.hospital_update_site_identity(p_site uuid,p_name text,p_building_label text) returns void language plpgsql security definer set search_path=public as $$ begin if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if; update public.sites set name=coalesce(nullif(trim(p_name),''),name),building_label=coalesce(nullif(trim(p_building_label),''),building_label),updated_at=clock_timestamp() where id=p_site; if not found then raise exception 'site not found'; end if; end $$;
create or replace function public.hospital_set_floorplan_assets(p_site uuid,p_assets jsonb) returns void language plpgsql security definer set search_path=public as $$ begin if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if; insert into public.site_settings(site_id,floorplan_assets,updated_at) values(p_site,coalesce(p_assets,'{}'::jsonb),clock_timestamp()) on conflict(site_id) do update set floorplan_assets=excluded.floorplan_assets,updated_at=clock_timestamp(); end $$;
create or replace function public.hospital_save_site_playlist(p_site uuid,p_id uuid,p_name text,p_video_ids uuid[]) returns uuid language plpgsql security definer set search_path=public as $$ declare v_id uuid; v_video uuid; v_pos int:=0; begin if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if; if nullif(trim(coalesce(p_name,'')),'') is null then raise exception '플레이리스트 이름을 입력하세요'; end if; if exists(select 1 from unnest(coalesce(p_video_ids,'{}'::uuid[])) x where not exists(select 1 from public.videos v where v.id=x and v.active and (v.site_id is null or v.site_id=p_site))) then raise exception '다른 병원의 영상이 포함되어 있습니다'; end if; if p_id is null then insert into public.playlists(site_id,name,kind,active,sort_order,updated_at) values(p_site,trim(p_name),'default',true,coalesce((select max(sort_order)+10 from public.playlists where site_id=p_site),10),clock_timestamp()) returning id into v_id; else update public.playlists set name=trim(p_name),active=true,updated_at=clock_timestamp() where id=p_id and site_id=p_site returning id into v_id; if v_id is null then raise exception '병원 플레이리스트를 찾을 수 없습니다'; end if; delete from public.playlist_items where playlist_id=v_id; end if; foreach v_video in array coalesce(p_video_ids,'{}'::uuid[]) loop v_pos:=v_pos+10; insert into public.playlist_items(playlist_id,video_id,sort_order) values(v_id,v_video,v_pos) on conflict(playlist_id,video_id) do update set sort_order=excluded.sort_order; end loop; return v_id; end $$;
create or replace function public.hospital_delete_site_playlist(p_site uuid,p_id uuid) returns void language plpgsql security definer set search_path=public as $$ begin if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if; if exists(select 1 from public.rooms where site_id=p_site and default_playlist_id=p_id) or exists(select 1 from public.signage_groups where site_id=p_site and default_playlist_id=p_id) then raise exception '사용 중인 플레이리스트는 삭제할 수 없습니다'; end if; delete from public.playlists where id=p_id and site_id=p_site; if not found then raise exception '병원 플레이리스트를 찾을 수 없습니다'; end if; end $$;
revoke all on function public.hospital_update_site_identity(uuid,text,text), public.hospital_set_floorplan_assets(uuid,jsonb), public.hospital_save_site_playlist(uuid,uuid,text,uuid[]), public.hospital_delete_site_playlist(uuid,uuid) from public;
grant execute on function public.hospital_update_site_identity(uuid,text,text), public.hospital_set_floorplan_assets(uuid,jsonb), public.hospital_save_site_playlist(uuid,uuid,text,uuid[]), public.hospital_delete_site_playlist(uuid,uuid) to anon,authenticated;

-- Site-specific close/reopen and broadcast controls.
create or replace function public.signal_site_rooms(p_site uuid) returns integer language plpgsql security definer set search_path=public as $$ declare v_count int; begin if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if; insert into public.player_control_signals(room_id,revision,updated_at) select r.id,1,clock_timestamp() from public.rooms r where r.site_id=p_site and coalesce(r.display_control_mode,'remote') in ('remote','hybrid') on conflict(room_id) do update set revision=public.player_control_signals.revision+1,updated_at=excluded.updated_at; get diagnostics v_count=row_count; return v_count; end $$;
create or replace function public.hospital_close_today(p_site uuid) returns void language plpgsql security definer set search_path=public as $$ begin if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if; update public.site_settings set operating_config=jsonb_set(coalesce(operating_config,'{}'::jsonb),'{early_closed_date}',to_jsonb((clock_timestamp() at time zone 'Asia/Seoul')::date::text),true),updated_at=clock_timestamp() where site_id=p_site; perform public.signal_site_rooms(p_site); end $$;
create or replace function public.hospital_reopen_today(p_site uuid) returns void language plpgsql security definer set search_path=public as $$ begin if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if; update public.site_settings set operating_config=coalesce(operating_config,'{}'::jsonb)-'early_closed_date',updated_at=clock_timestamp() where site_id=p_site; perform public.signal_site_rooms(p_site); end $$;
revoke all on function public.signal_site_rooms(uuid),public.hospital_close_today(uuid),public.hospital_reopen_today(uuid) from public; grant execute on function public.signal_site_rooms(uuid),public.hospital_close_today(uuid),public.hospital_reopen_today(uuid) to anon,authenticated;

-- Canonical player state now scopes broadcast/schedule/operating/emergency by room.site_id.
create or replace function public.player_get_state(p_key uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  r public.rooms; b public.site_broadcasts; s public.app_settings; ss public.site_settings; gb public.group_broadcasts; hs public.broadcast_schedules; gs public.broadcast_schedules;
  v_mode text; v_expires timestamptz; v_playlist jsonb:='[]'::jsonb; v_emergency jsonb; v_playlist_id uuid;
  v_notice text; v_effective timestamptz; v_revision text:='0'; v_next_transition timestamptz; v_operating jsonb; v_operating_end timestamptz;
begin
  select * into r from public.rooms where player_key=p_key; if not found then return null; end if;
  select * into b from public.site_broadcasts where site_id=r.site_id; select * into s from public.app_settings where id=1; select * into ss from public.site_settings where site_id=r.site_id;
  if coalesce(r.display_control_mode,'remote')='manual' then
    return jsonb_build_object('room',jsonb_build_object('id',r.id,'site_id',r.site_id,'name',r.name,'group_id',r.group_id,'room_mode',r.room_mode,'force_mute',true,'volume',0,'paused',true,'overlay_text',null,'reload_nonce',r.reload_nonce),'mode','closed','priority','manual','manual_control',true,'playlist','[]'::jsonb,'emergency_video',null,'operating',jsonb_build_object('active',false,'reason','manual_display'),'sync_revision','manual:'||r.id::text,'next_transition_at',null,'media_server_url',coalesce(s.media_server_url,''),'server_time',clock_timestamp());
  end if;
  v_operating:=public.signage_room_operating_status(r.id,clock_timestamp());
  if coalesce((v_operating->>'active')::boolean,false)=false then
    return jsonb_build_object('room',jsonb_build_object('id',r.id,'site_id',r.site_id,'name',r.name,'group_id',r.group_id,'room_mode',r.room_mode,'force_mute',r.force_mute,'volume',r.volume,'paused',r.paused,'overlay_text',r.overlay_text,'reload_nonce',r.reload_nonce),'mode','closed','priority','closed','playlist','[]'::jsonb,'emergency_video',null,'operating',v_operating,'sync_revision','closed:'||coalesce(v_operating->>'next_start_at','none'),'next_transition_at',v_operating->>'next_start_at','media_server_url',coalesce(s.media_server_url,''),'server_time',clock_timestamp());
  end if;
  v_operating_end:=nullif(v_operating->>'current_end_at','')::timestamptz;
  if r.group_id is not null then select * into gb from public.group_broadcasts where group_id=r.group_id; end if;
  select * into hs from public.broadcast_schedules x where x.enabled and x.site_id=r.site_id and x.scope_type='hospital' and x.starts_at<=clock_timestamp() and x.ends_at>clock_timestamp() order by x.starts_at desc limit 1;
  if r.group_id is not null then select * into gs from public.broadcast_schedules x where x.enabled and x.site_id=r.site_id and x.scope_type='group' and x.group_id=r.group_id and x.starts_at<=clock_timestamp() and x.ends_at>clock_timestamp() order by x.starts_at desc limit 1; end if;
  select min(t) into v_next_transition from (
    select starts_at t from public.broadcast_schedules x where x.enabled and x.site_id=r.site_id and x.starts_at>clock_timestamp() and (x.scope_type='hospital' or (x.scope_type='group' and x.group_id=r.group_id))
    union all select ends_at t from public.broadcast_schedules x where x.enabled and x.site_id=r.site_id and x.ends_at>clock_timestamp() and (x.scope_type='hospital' or (x.scope_type='group' and x.group_id=r.group_id))
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
    select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by array_position(b.video_ids,v.id)),'[]'::jsonb) into v_playlist from public.videos v where v.id=any(b.video_ids) and v.active and (v.site_id is null or v.site_id=r.site_id) and (v.source<>'local' or v.available);
    if jsonb_array_length(v_playlist)>0 then v_mode:='broadcast';v_notice:=b.notice_text;v_effective:=b.effective_at;v_revision:='b:'||b.revision; end if;
  end if;
  if v_mode is null and hs.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by array_position(hs.video_ids,v.id)),'[]'::jsonb) into v_playlist from public.videos v where v.id=any(hs.video_ids) and v.active and (v.site_id is null or v.site_id=r.site_id) and (v.source<>'local' or v.available);
    if jsonb_array_length(v_playlist)>0 then v_mode:='broadcast_schedule';v_notice:=hs.notice_text;v_effective:=hs.starts_at;v_revision:='hs:'||hs.id::text||':'||extract(epoch from hs.starts_at)::bigint; end if;
  end if;
  if v_mode is null and r.manual_active and (r.manual_starts_at is null or r.manual_starts_at<=clock_timestamp()) and (r.manual_ends_at is null or r.manual_ends_at>clock_timestamp()) and coalesce(array_length(r.manual_video_ids,1),0)>0 then
    select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by array_position(r.manual_video_ids,v.id)),'[]'::jsonb) into v_playlist from public.videos v where v.id=any(r.manual_video_ids) and v.active and (v.site_id is null or v.site_id=r.site_id) and (v.source<>'local' or v.available);
    if jsonb_array_length(v_playlist)>0 then v_mode:='manual';v_revision:='m:'||coalesce(extract(epoch from r.manual_updated_at)::bigint,0); end if;
  end if;
  if v_mode is null and gb.group_id is not null and gb.active and coalesce(array_length(gb.video_ids,1),0)>0 then
    select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by array_position(gb.video_ids,v.id)),'[]'::jsonb) into v_playlist from public.videos v where v.id=any(gb.video_ids) and v.active and (v.site_id is null or v.site_id=r.site_id) and (v.source<>'local' or v.available);
    if jsonb_array_length(v_playlist)>0 then v_mode:='group';v_notice:=gb.notice_text;v_effective:=gb.effective_at;v_revision:='g:'||gb.revision; end if;
  end if;
  if v_mode is null and gs.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by array_position(gs.video_ids,v.id)),'[]'::jsonb) into v_playlist from public.videos v where v.id=any(gs.video_ids) and v.active and (v.site_id is null or v.site_id=r.site_id) and (v.source<>'local' or v.available);
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
  if nullif(ss.operating_config->>'emergency_video_id','') is not null then select jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) into v_emergency from public.videos v where v.id=(ss.operating_config->>'emergency_video_id')::uuid and v.active and (v.site_id is null or v.site_id=r.site_id) and (v.source<>'local' or v.available); end if;
  return jsonb_build_object('room',jsonb_build_object('id',r.id,'site_id',r.site_id,'name',r.name,'group_id',r.group_id,'room_mode',r.room_mode,'force_mute',r.force_mute,'volume',r.volume,'paused',r.paused,'overlay_text',r.overlay_text,'reload_nonce',r.reload_nonce),'mode',v_mode,'priority',v_mode,'operating',v_operating,'session_expires_at',case when v_mode='patient' then v_expires end,'notice_text',v_notice,'playlist',v_playlist,'emergency_video',v_emergency,'sync_effective_at',v_effective,'sync_revision',v_revision,'next_transition_at',v_next_transition,'media_server_url',coalesce(s.media_server_url,''),'server_time',clock_timestamp());
end $$;


create or replace function public.admin_add_room_video(p_room uuid,p_video uuid)
returns void language plpgsql security definer set search_path=public as $$
declare
  r public.rooms; v_ids uuid[]; v_title text; v_playlist uuid; v_before jsonb; v_keep_window boolean;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select * into r from public.rooms where id=p_room for update;
  if not found then raise exception '공간을 찾을 수 없습니다'; end if;
  select title into v_title from public.videos where id=p_video and active and (source<>'local' or available);
  if v_title is null then raise exception '사용 가능한 영상이 아닙니다'; end if;
  v_keep_window:=r.manual_active and (r.manual_ends_at is null or r.manual_ends_at>clock_timestamp());
  v_before:=jsonb_build_object('manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids,'manual_starts_at',r.manual_starts_at,'manual_ends_at',r.manual_ends_at,'default_playlist_id',r.default_playlist_id);
  if v_keep_window and coalesce(array_length(r.manual_video_ids,1),0)>0 then
    v_ids:=r.manual_video_ids;
  else
    v_playlist:=r.default_playlist_id;
    if v_playlist is null then select id into v_playlist from public.playlists where active and kind='default' order by sort_order,created_at limit 1; end if;
    select coalesce(array_agg(v.id order by pi.sort_order,pi.created_at),'{}'::uuid[]) into v_ids
      from public.playlist_items pi join public.videos v on v.id=pi.video_id
     where pi.playlist_id=v_playlist and v.active and (v.site_id is null or v.site_id=r.site_id) and (v.source<>'local' or v.available);
  end if;
  if not (p_video=any(coalesce(v_ids,'{}'::uuid[]))) then v_ids:=array_append(coalesce(v_ids,'{}'::uuid[]),p_video); end if;
  update public.rooms set manual_video_ids=v_ids,manual_active=true,
    manual_starts_at=case when v_keep_window then r.manual_starts_at else null end,
    manual_ends_at=case when v_keep_window then r.manual_ends_at else null end,
    manual_updated_at=clock_timestamp() where id=p_room;
  insert into public.control_history(scope_type,scope_id,action,label,before_state,after_state)
  values('rooms',p_room,'video_add',v_title,v_before,(select jsonb_build_object('manual_active',manual_active,'manual_video_ids',manual_video_ids,'manual_starts_at',manual_starts_at,'manual_ends_at',manual_ends_at,'default_playlist_id',default_playlist_id) from public.rooms where id=p_room));
end $$;


revoke all on function public.player_get_state(uuid) from public; grant execute on function public.player_get_state(uuid) to anon,authenticated;
revoke all on function public.staff_set_room_video_order(uuid,uuid[]) from public; grant execute on function public.staff_set_room_video_order(uuid,uuid[]) to anon,authenticated;
notify pgrst,'reload schema';

-- Superadmin-safe room controls: derive site from target room, never from default_site_id().
create or replace function public.staff_quick_set_room(p_room uuid,p_treatment text,p_age_group text default null,p_gender text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_mode text; v_site uuid:=public.manageable_room_site(p_room);
begin
  if not public.is_member() or v_site is null or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
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
declare v_site uuid:=public.manageable_room_site(p_room);
begin
  if not public.is_member() or v_site is null or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  if exists(select 1 from public.patient_sessions where site_id=v_site and room_id=p_room and status in ('assigned','in_progress')) then raise exception '등록 환자가 배정된 진료실입니다. 환자 관리에서 종료하세요'; end if;
  update public.rooms set session_tags='{}',session_started_at=null,session_age_group=null,session_gender=null,session_treatment=null where id=p_room and site_id=v_site;
  if not found then raise exception '진료실을 찾을 수 없습니다'; end if;
end $$;

create or replace function public.staff_set_room_playlist(p_room uuid,p_playlist uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_name text; v_count int; v_site uuid:=public.manageable_room_site(p_room);
begin
  if not public.is_member() or v_site is null or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
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
declare r public.rooms; v_ids uuid[]; v_playlist uuid; v_title text; v_keep_window boolean; v_site uuid:=public.manageable_room_site(p_room);
begin
  if not public.is_member() or v_site is null or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
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

create or replace function public.staff_set_room_video_rule(p_room uuid,p_video uuid,p_enabled boolean)
returns void language plpgsql security definer set search_path=public as $$
declare v_site uuid:=public.manageable_room_site(p_room);
begin
  if not public.is_member() or v_site is null or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  if not exists(select 1 from public.videos v where v.id=p_video and v.active and (v.site_id is null or v.site_id=v_site)) then raise exception '영상을 찾을 수 없습니다'; end if;
  insert into public.room_video_rules(room_id,video_id,enabled,updated_at) values(p_room,p_video,coalesce(p_enabled,true),clock_timestamp())
  on conflict(room_id,video_id) do update set enabled=excluded.enabled,updated_at=clock_timestamp();
end $$;

revoke all on function public.staff_quick_set_room(uuid,text,text,text), public.staff_quick_clear_room(uuid), public.staff_set_room_playlist(uuid,uuid), public.staff_add_room_video(uuid,uuid), public.staff_set_room_video_rule(uuid,uuid,boolean) from public;
grant execute on function public.staff_quick_set_room(uuid,text,text,text), public.staff_quick_clear_room(uuid), public.staff_set_room_playlist(uuid,uuid), public.staff_add_room_video(uuid,uuid), public.staff_set_room_video_rule(uuid,uuid,boolean) to anon,authenticated;

create or replace function public.hospital_save_operating_config(p_site uuid,p_config jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare c jsonb;
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  c:=jsonb_strip_nulls(jsonb_build_object(
    'weekday_enabled',coalesce((p_config->>'weekday_enabled')::boolean,true),
    'weekday_start',coalesce(nullif(p_config->>'weekday_start',''),'09:00'),
    'weekday_end',coalesce(nullif(p_config->>'weekday_end',''),'20:00'),
    'saturday_enabled',coalesce((p_config->>'saturday_enabled')::boolean,true),
    'saturday_start',coalesce(nullif(p_config->>'saturday_start',''),'09:00'),
    'saturday_end',coalesce(nullif(p_config->>'saturday_end',''),'17:00'),
    'sunday_enabled',coalesce((p_config->>'sunday_enabled')::boolean,false),
    'sunday_start',coalesce(nullif(p_config->>'sunday_start',''),'09:00'),
    'sunday_end',coalesce(nullif(p_config->>'sunday_end',''),'17:00'),
    'early_closed_date',nullif(p_config->>'early_closed_date',''),
    'emergency_video_id',nullif(p_config->>'emergency_video_id','')
  ));
  insert into public.site_settings(site_id,operating_config,updated_at) values(p_site,c,clock_timestamp())
  on conflict(site_id) do update set operating_config=excluded.operating_config,updated_at=clock_timestamp();
  perform public.signal_site_rooms(p_site);
end $$;
revoke all on function public.hospital_save_operating_config(uuid,jsonb) from public;
grant execute on function public.hospital_save_operating_config(uuid,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
commit;
