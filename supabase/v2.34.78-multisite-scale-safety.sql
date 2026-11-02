-- Clinic Signage v2.34.78 — multi-site scale + release safety
-- Safe to rerun after v2.34.77.
begin;

-- 1) schema_version is migration metadata, never a client-writable API table.
alter table public.schema_version enable row level security;
revoke all on table public.schema_version from anon, authenticated;

-- 2) Scope the canonical control signal by site. This removes the 100-room IN filter
-- and automatically includes displays created after the hospital page was opened.
alter table public.player_control_signals add column if not exists site_id uuid references public.sites(id) on delete cascade;
update public.player_control_signals pcs
set site_id=r.site_id
from public.rooms r
where r.id=pcs.room_id and pcs.site_id is distinct from r.site_id;
create index if not exists player_control_signals_site_updated_idx on public.player_control_signals(site_id,updated_at desc);

create or replace function public.ensure_player_control_signal()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.player_control_signals(room_id,site_id,revision,updated_at)
  values(new.id,new.site_id,0,clock_timestamp())
  on conflict(room_id) do update set site_id=excluded.site_id;
  return new;
end $$;

-- Internal refresh helper. NULL means truly global legacy content; normal site content
-- only wakes players belonging to that site.
create or replace function public.signal_site_rooms_internal(p_site uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer:=0;
begin
  insert into public.player_control_signals(room_id,site_id,revision,updated_at)
  select r.id,r.site_id,1,clock_timestamp()
  from public.rooms r
  where (p_site is null or r.site_id=p_site)
    and coalesce(r.display_control_mode,'remote') in ('remote','hybrid')
  on conflict(room_id) do update
    set site_id=excluded.site_id,revision=public.player_control_signals.revision+1,updated_at=excluded.updated_at;
  get diagnostics v_count=row_count;
  return v_count;
end $$;
revoke all on function public.signal_site_rooms_internal(uuid) from public,anon,authenticated;

create or replace function public.signal_site_rooms(p_site uuid)
returns integer language plpgsql security definer set search_path=public as $$
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  return public.signal_site_rooms_internal(p_site);
end $$;
revoke all on function public.signal_site_rooms(uuid) from public;
grant execute on function public.signal_site_rooms(uuid) to anon,authenticated;

create or replace function public.signal_signage_rooms(p_room_ids uuid[] default null,p_group uuid default null,p_all boolean default false)
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer:=0; v_site uuid:=coalesce(public.pin_session_site_id(),public.default_site_id());
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  if (coalesce(p_all,false) or p_group is not null) and not public.is_admin() then raise exception 'not allowed'; end if;
  if not public.is_admin() and exists(select 1 from unnest(coalesce(p_room_ids,'{}'::uuid[])) x where not public.staff_can_remote_control_room(x)) then raise exception 'not allowed'; end if;
  if not coalesce(p_all,false) and p_group is null and coalesce(array_length(p_room_ids,1),0)=0 then return 0; end if;
  insert into public.player_control_signals(room_id,site_id,revision,updated_at)
  select r.id,r.site_id,1,clock_timestamp() from public.rooms r
  where coalesce(r.display_control_mode,'remote') in ('remote','hybrid') and (
        (public.is_admin() and (coalesce(p_all,false) or (p_group is not null and r.group_id=p_group)))
     or (coalesce(array_length(p_room_ids,1),0)>0 and r.id=any(p_room_ids) and (public.is_admin() or r.site_id=v_site)))
  on conflict(room_id) do update set site_id=excluded.site_id,revision=public.player_control_signals.revision+1,updated_at=excluded.updated_at;
  get diagnostics v_count=row_count; return v_count;
end $$;
revoke all on function public.signal_signage_rooms(uuid[],uuid,boolean) from public;
grant execute on function public.signal_signage_rooms(uuid[],uuid,boolean) to anon,authenticated;


-- rooms is no longer a Realtime data source. Control wake-ups use player_control_signals
-- and live status uses player_live_status/RPC, so heartbeat writes must not fan out via WAL Realtime.
do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
     and exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='rooms') then
    alter publication supabase_realtime drop table public.rooms;
  end if;
end $$;

-- 3) Replace all-hospital content wake-ups with site-scoped wake-ups.
create or replace function public.notify_video_site_rooms() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if tg_op='UPDATE' and old.site_id is distinct from new.site_id then
    perform public.signal_site_rooms_internal(old.site_id);
    perform public.signal_site_rooms_internal(new.site_id);
  else
    perform public.signal_site_rooms_internal(case when tg_op='DELETE' then old.site_id else new.site_id end);
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

create or replace function public.notify_playlist_site_rooms() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if tg_op='UPDATE' and old.site_id is distinct from new.site_id then
    perform public.signal_site_rooms_internal(old.site_id);
    perform public.signal_site_rooms_internal(new.site_id);
  else
    perform public.signal_site_rooms_internal(case when tg_op='DELETE' then old.site_id else new.site_id end);
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

create or replace function public.notify_playlist_item_site_rooms() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_site uuid; v_playlist uuid;
begin
  v_playlist:=case when tg_op='DELETE' then old.playlist_id else new.playlist_id end;
  select p.site_id into v_site from public.playlists p where p.id=v_playlist;
  perform public.signal_site_rooms_internal(v_site);
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists videos_notify on public.videos;
create trigger videos_notify after insert or update or delete on public.videos for each row execute function public.notify_video_site_rooms();
drop trigger if exists playlists_notify on public.playlists;
create trigger playlists_notify after insert or update or delete on public.playlists for each row execute function public.notify_playlist_site_rooms();
drop trigger if exists playlist_items_notify on public.playlist_items;
create trigger playlist_items_notify after insert or update or delete on public.playlist_items for each row execute function public.notify_playlist_item_site_rooms();

-- 4) Login: at most one super-admin hash plus one requested hospital hash are checked.
-- Direct hospital login uses the site code already present in /hospital.html?site=... .
drop function if exists public.pin_login(text,text,text);
create or replace function public.pin_login(p_pin text,p_client_id text,p_site_code text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  v_client text:=left(trim(coalesce(p_client_id,'')),100);
  v_site_code text:=lower(trim(coalesce(p_site_code,'')));
  v_ip_key text:='ip:'||coalesce(public.pin_request_ip(),'unknown');
  v_fail int:=0; v_locked timestamptz; v_ip_fail int:=0; v_ip_locked timestamptz; v_ip_updated timestamptz;
  v_account public.pin_accounts; v_token text; v_exp timestamptz; v_now timestamptz:=clock_timestamp();
  c_ip_window constant interval:=interval '15 minutes'; c_ip_max constant int:=20;
begin
  if v_client='' or v_client !~ '^[A-Za-z0-9._:-]{8,100}$' then return jsonb_build_object('ok',false,'error','invalid_client'); end if;
  if p_pin !~ '^[0-9]{4,6}$' then return jsonb_build_object('ok',false,'error','invalid_pin'); end if;
  select failed_count,locked_until,updated_at into v_ip_fail,v_ip_locked,v_ip_updated from public.pin_login_throttle where client_id=v_ip_key;
  if v_ip_locked is not null and v_ip_locked>v_now then return jsonb_build_object('ok',false,'error','locked','retry_after_sec',greatest(1,ceil(extract(epoch from(v_ip_locked-v_now)))::int)); end if;
  if v_ip_updated is null or v_ip_updated<v_now-c_ip_window then v_ip_fail:=0; end if;
  select failed_count,locked_until into v_fail,v_locked from public.pin_login_throttle where client_id=v_client;
  if v_locked is not null and v_locked>v_now then return jsonb_build_object('ok',false,'error','locked','retry_after_sec',greatest(1,ceil(extract(epoch from(v_locked-v_now)))::int)); end if;

  -- Constant-size lookup: super admin first (normally one row), then the requested site's one staff account.
  select a.* into v_account from public.pin_accounts a
   where a.enabled and a.role='admin' and crypt(p_pin,a.pin_hash)=a.pin_hash
   order by a.id limit 1;
  if not found and v_site_code<>'' then
    select a.* into v_account
    from public.pin_accounts a join public.sites s on s.id=a.site_id
    where a.enabled and a.role='staff' and s.active and s.code=v_site_code
      and crypt(p_pin,a.pin_hash)=a.pin_hash
    order by a.id limit 1;
  end if;

  if v_account.id is null then
    v_ip_fail:=coalesce(v_ip_fail,0)+1;
    insert into public.pin_login_throttle(client_id,failed_count,locked_until,updated_at)
    values(v_ip_key,case when v_ip_fail>=c_ip_max then 0 else v_ip_fail end,case when v_ip_fail>=c_ip_max then v_now+c_ip_window end,v_now)
    on conflict(client_id) do update set failed_count=excluded.failed_count,locked_until=excluded.locked_until,updated_at=excluded.updated_at;
    if v_ip_fail>=c_ip_max then return jsonb_build_object('ok',false,'error','locked','retry_after_sec',extract(epoch from c_ip_window)::int); end if;
    v_fail:=coalesce(v_fail,0)+1;
    if v_fail>=5 then
      insert into public.pin_login_throttle(client_id,failed_count,locked_until,updated_at) values(v_client,0,v_now+interval '5 minutes',v_now)
      on conflict(client_id) do update set failed_count=0,locked_until=excluded.locked_until,updated_at=v_now;
      return jsonb_build_object('ok',false,'error','locked','retry_after_sec',300);
    end if;
    insert into public.pin_login_throttle(client_id,failed_count,locked_until,updated_at) values(v_client,v_fail,null,v_now)
    on conflict(client_id) do update set failed_count=excluded.failed_count,locked_until=null,updated_at=v_now;
    return jsonb_build_object('ok',false,'error','invalid_pin');
  end if;

  delete from public.pin_login_throttle where client_id in(v_client,v_ip_key);
  delete from public.pin_login_throttle where locked_until is null and updated_at<v_now-interval '1 day';
  delete from public.pin_sessions where expires_at<=v_now;
  v_token:=encode(gen_random_bytes(32),'hex'); v_exp:=v_now+interval '12 hours';
  insert into public.pin_sessions(account_id,token_hash,expires_at) values(v_account.id,digest(v_token,'sha256'),v_exp);
  return jsonb_build_object('ok',true,'token',v_token,'role',v_account.role,'site_id',v_account.site_id,'expires_at',v_exp);
end $$;
revoke all on function public.pin_login(text,text,text) from public;
grant execute on function public.pin_login(text,text,text) to anon,authenticated;
-- Old two-argument endpoint is intentionally no longer executable, preventing an all-account scan path.
revoke all on function public.pin_login(text,text) from public,anon,authenticated;

-- 5) Useful tenant indexes before the tables become large.
create index if not exists videos_site_sort_idx on public.videos(site_id,sort_order,created_at);
create index if not exists playlists_site_sort_idx on public.playlists(site_id,sort_order,created_at);
create index if not exists player_events_created_idx on public.player_events(created_at desc);

-- 6) "오늘 완료" is a Korea-local day, converted back to timestamptz for comparison.
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
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'site_id',r.site_id,'name',r.name,'sort_order',r.sort_order,'group_id',r.group_id,'group_name',g.name,'room_mode',r.room_mode,'last_seen_at',r.last_seen_at,'player_status',coalesce(r.player_status,'{}'::jsonb),'session_timeout_min',r.session_timeout_min,'session_started_at',r.session_started_at,'session_age_group',r.session_age_group,'session_gender',r.session_gender,'session_treatment',r.session_treatment,'default_playlist_id',r.default_playlist_id,'manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids,'map_x_pct',r.map_x_pct,'map_y_pct',r.map_y_pct,'display_control_mode',r.display_control_mode,'manual_check_status',r.manual_check_status,'manual_checked_at',r.manual_checked_at,'manual_checked_by',r.manual_checked_by,'display_note',r.display_note,'floor_space_id',r.floor_space_id) order by coalesce(g.sort_order,2147483647),r.sort_order,r.created_at),'[]'::jsonb) into v_rooms from public.rooms r left join public.signage_groups g on g.id=r.group_id where r.site_id=v_site;
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'site_id',g.site_id,'name',g.name,'kind',g.kind,'floor_number',g.floor_number,'care_type',g.care_type,'signage_purpose',g.signage_purpose,'target_audience',g.target_audience,'waiting_area_note',g.waiting_area_note,'signage_reason',g.signage_reason,'content_intro',g.content_intro,'content_topics',g.content_topics,'role_label',g.role_label,'default_playlist_id',g.default_playlist_id,'sort_order',g.sort_order) order by g.sort_order,g.floor_number,g.created_at),'[]'::jsonb) into v_groups from public.signage_groups g where g.site_id=v_site;
  select coalesce(jsonb_agg(to_jsonb(x) order by case x.status when 'in_progress' then 0 when 'assigned' then 1 when 'waiting' then 2 else 3 end,x.waiting_started_at),'[]'::jsonb) into v_patients from (select * from public.patient_sessions where site_id=v_site and (status in ('waiting','assigned','in_progress') or (status='completed' and completed_at >= (date_trunc('day', clock_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')))) x;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'site_id',p.site_id,'name',p.name,'kind',p.kind,'active',p.active,'sort_order',p.sort_order,'target_treatment',p.target_treatment,'target_age',p.target_age,'target_gender',p.target_gender) order by p.sort_order,p.created_at),'[]'::jsonb) into v_playlists from public.playlists p where p.active and (p.site_id is null or p.site_id=v_site);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',v.id,
    'site_id',v.site_id,
    'title',v.title,
    'active',v.active,
    'duration_sec',v.duration_sec,
    'thumbnail_data_url',v.thumbnail_data_url,
    'url',v.url,
    'source',v.source,
    'storage_path',v.storage_path,
    'file_path',v.file_path,
    'target_treatment',v.target_treatment,
    'target_age',v.target_age,
    'target_gender',v.target_gender
  ) order by v.sort_order,v.created_at),'[]'::jsonb) into v_videos
  from public.videos v
  where v.active and (v.site_id is null or v.site_id=v_site) and (v.source<>'local' or v.available);
  select coalesce(jsonb_agg(jsonb_build_object('playlist_id',pi.playlist_id,'video_id',pi.video_id,'sort_order',pi.sort_order) order by pi.playlist_id,pi.sort_order,pi.created_at),'[]'::jsonb) into v_items from public.playlist_items pi join public.playlists p on p.id=pi.playlist_id where p.site_id is null or p.site_id=v_site;
  select coalesce(jsonb_agg(jsonb_build_object('room_id',rr.room_id,'video_id',rr.video_id,'enabled',rr.enabled,'sort_order',rr.sort_order,'starts_at',rr.starts_at,'ends_at',rr.ends_at,'updated_at',rr.updated_at)),'[]'::jsonb) into v_rules from public.room_video_rules rr join public.rooms r on r.id=rr.room_id where r.site_id=v_site;
  select jsonb_build_object('active',active,'video_ids',video_ids,'notice_text',notice_text,'starts_at',starts_at,'ends_at',ends_at,'revision',revision) into v_broadcast from public.site_broadcasts where site_id=v_site;
  return jsonb_build_object('site',v_site_row,'site_settings',coalesce(v_settings,'{}'::jsonb),'floorplan_assets',coalesce(v_floorplans,'{}'::jsonb),'floorplan_versions',coalesce(v_versions,'[]'::jsonb),'spaces',coalesce(v_spaces,'[]'::jsonb),'rooms',v_rooms,'groups',v_groups,'patients',v_patients,'playlists',v_playlists,'videos',v_videos,'playlist_items',v_items,'room_video_rules',v_rules,'broadcast',coalesce(v_broadcast,'{}'::jsonb),'server_time',clock_timestamp());
end $$;

revoke all on function public.hospital_reception_state(uuid) from public;
grant execute on function public.hospital_reception_state(uuid) to anon,authenticated;

insert into public.schema_version(version,applied_at) values('2.34.67',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;



insert into public.schema_version(version,applied_at) values('2.34.78',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
commit;
