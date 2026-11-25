begin;
-- Clinic Signage v2.34.8 · launch fixes
-- Safe to re-run. Apply after v2.34.0 / v2.34.3 on existing DBs.

create table if not exists public.schema_version (
  version text primary key,
  applied_at timestamptz not null default clock_timestamp()
);

-- 1) Prefer hospital-local default playlists over global defaults.
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
    if v_playlist_id is null then select id into v_playlist_id from public.playlists where active and kind='default' and (site_id is null or site_id=r.site_id) order by coalesce(site_id=r.site_id,false) desc,sort_order,created_at limit 1; end if;
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

-- 2) Operating config: validate input, preserve early close, and fail safe on malformed stored values.
create or replace function public.site_operating_config(p_site uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare c jsonb; outc jsonb; t text; d date; u uuid;
begin
  select coalesce(operating_config,'{}'::jsonb) into c from public.site_settings where site_id=p_site;
  if c is null then c:='{}'::jsonb; end if;
  outc:=jsonb_build_object('weekday_enabled',true,'weekday_start','09:00','weekday_end','20:00','saturday_enabled',true,'saturday_start','09:00','saturday_end','17:00','sunday_enabled',false,'sunday_start','09:00','sunday_end','17:00');
  foreach t in array array['weekday_start','weekday_end','saturday_start','saturday_end','sunday_start','sunday_end'] loop
    if coalesce(c->>t,'') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then outc:=jsonb_set(outc,array[t],to_jsonb(c->>t),true); end if;
  end loop;
  foreach t in array array['weekday_enabled','saturday_enabled','sunday_enabled'] loop
    if lower(coalesce(c->>t,'')) in ('true','false') then outc:=jsonb_set(outc,array[t],to_jsonb((c->>t)::boolean),true); end if;
  end loop;
  begin d:=nullif(c->>'early_closed_date','')::date; if d is not null then outc:=jsonb_set(outc,'{early_closed_date}',to_jsonb(d::text),true); end if; exception when others then null; end;
  begin u:=nullif(c->>'emergency_video_id','')::uuid; if u is not null and exists(select 1 from public.videos where id=u) then outc:=jsonb_set(outc,'{emergency_video_id}',to_jsonb(u::text),true); end if; exception when others then null; end;
  return outc;
end $$;

create or replace function public.hospital_save_operating_config(p_site uuid,p_config jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare c jsonb; oldc jsonb; k text; v text;
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  foreach k in array array['weekday_start','weekday_end','saturday_start','saturday_end','sunday_start','sunday_end'] loop
    v:=coalesce(p_config->>k,''); if v !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception '% must be HH:MM',k; end if;
  end loop;
  foreach k in array array['weekday_enabled','saturday_enabled','sunday_enabled'] loop
    v:=lower(coalesce(p_config->>k,'')); if v not in ('true','false') then raise exception '% must be boolean',k; end if;
  end loop;
  select coalesce(operating_config,'{}'::jsonb) into oldc from public.site_settings where site_id=p_site;
  c:=coalesce(oldc,'{}'::jsonb) || jsonb_build_object(
    'weekday_enabled',(p_config->>'weekday_enabled')::boolean,'weekday_start',p_config->>'weekday_start','weekday_end',p_config->>'weekday_end',
    'saturday_enabled',(p_config->>'saturday_enabled')::boolean,'saturday_start',p_config->>'saturday_start','saturday_end',p_config->>'saturday_end',
    'sunday_enabled',(p_config->>'sunday_enabled')::boolean,'sunday_start',p_config->>'sunday_start','sunday_end',p_config->>'sunday_end'
  );
  if p_config ? 'emergency_video_id' then
    if nullif(p_config->>'emergency_video_id','') is null then c:=c-'emergency_video_id';
    elsif exists(select 1 from public.videos where id::text=p_config->>'emergency_video_id' and active and (site_id is null or site_id=p_site)) then c:=jsonb_set(c,'{emergency_video_id}',to_jsonb(p_config->>'emergency_video_id'),true);
    else raise exception 'invalid emergency_video_id'; end if;
  end if;
  insert into public.site_settings(site_id,operating_config,updated_at) values(p_site,c,clock_timestamp()) on conflict(site_id) do update set operating_config=excluded.operating_config,updated_at=clock_timestamp();
  perform public.signal_site_rooms(p_site);
end $$;

-- Direct writes to site_settings are disabled; mutations go through validated RPCs.
drop policy if exists site_settings_manage on public.site_settings;
drop policy if exists site_settings_select on public.site_settings;
create policy site_settings_select on public.site_settings for select to anon,authenticated using(public.can_manage_site(site_id));
revoke insert,update,delete on public.site_settings from anon,authenticated;
grant select on public.site_settings to anon,authenticated;

-- 3) Hospital setup RPCs replacing orphaned admin.js setup actions.
create or replace function public.hospital_create_floor(p_site uuid,p_floor smallint,p_name text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_name text;
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  if p_floor<1 or p_floor>99 then raise exception 'floor must be 1..99'; end if;
  v_name:=coalesce(nullif(trim(p_name),''),p_floor::text||'F');
  insert into public.signage_groups(site_id,name,kind,floor_number,care_type,sort_order) values(p_site,v_name,'floor',p_floor,'other',100-p_floor)
  on conflict(site_id,lower(name)) do update set floor_number=excluded.floor_number returning id into v_id;
  return v_id;
end $$;

create or replace function public.hospital_create_display(p_site uuid,p_group uuid,p_name text,p_mode text default 'remote')
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_sort int;
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  if not exists(select 1 from public.signage_groups where id=p_group and site_id=p_site) then raise exception 'invalid floor'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'display name required'; end if;
  if p_mode not in ('remote','manual','hybrid') then raise exception 'invalid display mode'; end if;
  select coalesce(max(sort_order),-1)+1 into v_sort from public.rooms where site_id=p_site and group_id=p_group;
  insert into public.rooms(site_id,group_id,name,sort_order,display_control_mode,manual_check_status) values(p_site,p_group,trim(p_name),v_sort,p_mode,case when p_mode='manual' then 'needs_check' else 'not_required' end) returning id into v_id;
  return v_id;
end $$;

revoke all on function public.hospital_create_floor(uuid,smallint,text),public.hospital_create_display(uuid,uuid,text,text) from public;
grant execute on function public.hospital_create_floor(uuid,smallint,text),public.hospital_create_display(uuid,uuid,text,text) to anon,authenticated;


-- 5) Retire global single-hospital RPCs that no longer affect v2.34 players.
revoke all on function public.admin_set_broadcast_timed(boolean,uuid[],text,timestamptz,timestamptz) from anon,authenticated;
revoke all on function public.admin_close_today() from anon,authenticated;
revoke all on function public.admin_create_schedule(text,uuid,uuid[],text,timestamptz,timestamptz) from anon,authenticated;

-- 4) Ensure admin PIN helper search_path is set only after the function exists.
alter function public.admin_change_pin(text,text) set search_path=public,extensions;

insert into public.schema_version(version) values('2.34.8') on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
commit;
