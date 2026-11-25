-- Clinic Signage v2.27.0 — timed hospital and per-room output
-- Safe to run repeatedly after v2.25.0+ canonical schema.

alter table public.broadcast add column if not exists starts_at timestamptz;
alter table public.broadcast add column if not exists ends_at timestamptz;
alter table public.rooms add column if not exists manual_starts_at timestamptz;
alter table public.rooms add column if not exists manual_ends_at timestamptz;

do $$ begin
  if not exists(select 1 from pg_constraint where conname='broadcast_time_window_check') then
    alter table public.broadcast add constraint broadcast_time_window_check check(ends_at is null or starts_at is null or ends_at>starts_at);
  end if;
  if not exists(select 1 from pg_constraint where conname='rooms_manual_time_window_check') then
    alter table public.rooms add constraint rooms_manual_time_window_check check(manual_ends_at is null or manual_starts_at is null or manual_ends_at>manual_starts_at);
  end if;
end $$;

create or replace function public.admin_set_broadcast(p_active boolean,p_video_ids uuid[],p_notice text default null,p_delay_ms int default 3000)
returns void language plpgsql security definer set search_path=public as $$
declare v_ids uuid[]; v_before jsonb; v_after jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select to_jsonb(b) into v_before from public.broadcast b where id=1;
  if coalesce(p_active,false) then
    select coalesce(array_agg(v.id order by array_position(p_video_ids,v.id)),'{}'::uuid[]) into v_ids
    from public.videos v where v.id=any(coalesce(p_video_ids,'{}'::uuid[])) and v.active and (v.source<>'local' or v.available);
  else v_ids:=coalesce(p_video_ids,'{}'::uuid[]); end if;
  update public.broadcast set
    active=coalesce(p_active,false) and coalesce(array_length(v_ids,1),0)>0,
    video_ids=v_ids,notice_text=nullif(trim(coalesce(p_notice,'')),''),
    starts_at=null,ends_at=null,
    effective_at=case when coalesce(p_active,false) and coalesce(array_length(v_ids,1),0)>0 then clock_timestamp()+make_interval(secs=>greatest(0,least(coalesce(p_delay_ms,3000),10000))/1000.0) else null end,
    revision=revision+1,updated_at=clock_timestamp() where id=1;
  select to_jsonb(b) into v_after from public.broadcast b where id=1;
  insert into public.control_history(scope_type,action,label,before_state,after_state) values('hospital',case when p_active then 'start' else 'stop' end,'전체 병원',v_before,v_after);
end $$;

create or replace function public.admin_set_broadcast_timed(p_active boolean,p_video_ids uuid[],p_notice text default null,p_starts_at timestamptz default null,p_ends_at timestamptz default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_ids uuid[]; v_before jsonb; v_after jsonb; v_start timestamptz;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_starts_at is not null and p_ends_at is not null and p_ends_at<=p_starts_at then raise exception '종료시각은 시작시각 이후여야 합니다'; end if;
  if p_ends_at is not null and p_starts_at is null and p_ends_at<=clock_timestamp() then raise exception '종료시각은 현재 이후여야 합니다'; end if;
  select to_jsonb(b) into v_before from public.broadcast b where id=1;
  if coalesce(p_active,false) then
    select coalesce(array_agg(v.id order by array_position(p_video_ids,v.id)),'{}'::uuid[]) into v_ids from public.videos v
    where v.id=any(coalesce(p_video_ids,'{}'::uuid[])) and v.active and (v.source<>'local' or v.available);
  else v_ids:=coalesce(p_video_ids,'{}'::uuid[]); end if;
  v_start:=case when coalesce(p_active,false) then p_starts_at else null end;
  update public.broadcast set
    active=coalesce(p_active,false) and coalesce(array_length(v_ids,1),0)>0,video_ids=v_ids,notice_text=nullif(trim(coalesce(p_notice,'')),''),
    starts_at=v_start,ends_at=case when coalesce(p_active,false) then p_ends_at else null end,
    effective_at=case when coalesce(p_active,false) and coalesce(array_length(v_ids,1),0)>0 then coalesce(v_start,clock_timestamp()) else null end,
    revision=revision+1,updated_at=clock_timestamp() where id=1;
  select to_jsonb(b) into v_after from public.broadcast b where id=1;
  insert into public.control_history(scope_type,action,label,before_state,after_state) values('hospital',case when p_active then 'timed_start' else 'stop' end,'전체 병원',v_before,v_after);
end $$;

create or replace function public.admin_set_rooms_manual(p_rooms uuid[],p_video_ids uuid[],p_active boolean)
returns void language plpgsql security definer set search_path=public as $$
declare v_ids uuid[]; v_before jsonb; v_after jsonb; v_count int;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if coalesce(array_length(p_rooms,1),0)=0 then return; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids,'manual_starts_at',r.manual_starts_at,'manual_ends_at',r.manual_ends_at)),'[]'::jsonb),count(*) into v_before,v_count from public.rooms r where r.id=any(p_rooms);
  if p_active then
    select coalesce(array_agg(v.id order by array_position(p_video_ids,v.id)),'{}'::uuid[]) into v_ids from public.videos v
    where v.id=any(coalesce(p_video_ids,'{}'::uuid[])) and v.active and (v.source<>'local' or v.available);
  else v_ids:='{}'::uuid[]; end if;
  update public.rooms set manual_video_ids=v_ids,manual_active=p_active and coalesce(array_length(v_ids,1),0)>0,manual_starts_at=null,manual_ends_at=null,manual_updated_at=clock_timestamp() where id=any(p_rooms);
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids,'manual_starts_at',r.manual_starts_at,'manual_ends_at',r.manual_ends_at)),'[]'::jsonb) into v_after from public.rooms r where r.id=any(p_rooms);
  insert into public.control_history(scope_type,action,label,before_state,after_state) values('rooms',case when p_active then 'manual_start' else 'manual_clear' end,v_count||'개 공간',v_before,v_after);
end $$;

create or replace function public.admin_set_rooms_manual_timed(p_rooms uuid[],p_video_ids uuid[],p_active boolean,p_starts_at timestamptz default null,p_ends_at timestamptz default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_ids uuid[]; v_before jsonb; v_after jsonb; v_count int;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if coalesce(array_length(p_rooms,1),0)=0 then return; end if;
  if p_starts_at is not null and p_ends_at is not null and p_ends_at<=p_starts_at then raise exception '종료시각은 시작시각 이후여야 합니다'; end if;
  if p_ends_at is not null and p_starts_at is null and p_ends_at<=clock_timestamp() then raise exception '종료시각은 현재 이후여야 합니다'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids,'manual_starts_at',r.manual_starts_at,'manual_ends_at',r.manual_ends_at)),'[]'::jsonb),count(*) into v_before,v_count from public.rooms r where r.id=any(p_rooms);
  if p_active then
    select coalesce(array_agg(v.id order by array_position(p_video_ids,v.id)),'{}'::uuid[]) into v_ids from public.videos v
    where v.id=any(coalesce(p_video_ids,'{}'::uuid[])) and v.active and (v.source<>'local' or v.available);
  else v_ids:='{}'::uuid[]; end if;
  update public.rooms set manual_video_ids=v_ids,manual_active=p_active and coalesce(array_length(v_ids,1),0)>0,
    manual_starts_at=case when p_active then p_starts_at else null end,manual_ends_at=case when p_active then p_ends_at else null end,manual_updated_at=clock_timestamp()
  where id=any(p_rooms);
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids,'manual_starts_at',r.manual_starts_at,'manual_ends_at',r.manual_ends_at)),'[]'::jsonb) into v_after from public.rooms r where r.id=any(p_rooms);
  insert into public.control_history(scope_type,action,label,before_state,after_state) values('rooms',case when p_active then 'manual_timed' else 'manual_clear' end,v_count||'개 공간',v_before,v_after);
end $$;

create or replace function public.player_get_state(p_key uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  r public.rooms; b public.broadcast; s public.app_settings; gb public.group_broadcasts; hs public.broadcast_schedules; gs public.broadcast_schedules;
  v_mode text; v_expires timestamptz; v_playlist jsonb:='[]'::jsonb; v_emergency jsonb; v_playlist_id uuid;
  v_notice text; v_effective timestamptz; v_revision text:='0'; v_next_transition timestamptz;
begin
  select * into r from public.rooms where player_key=p_key; if not found then return null; end if;
  select * into b from public.broadcast where id=1; select * into s from public.app_settings where id=1;
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
    select p.id into v_playlist_id from public.playlists p where p.active and p.kind='patient'
      and (coalesce(array_length(p.target_treatment,1),0)=0 or r.session_treatment=any(p.target_treatment))
      and (coalesce(array_length(p.target_age,1),0)=0 or (r.session_age_group is not null and r.session_age_group=any(p.target_age)))
      and (coalesce(array_length(p.target_gender,1),0)=0 or (r.session_gender is not null and r.session_gender=any(p.target_gender)))
    order by (case when coalesce(array_length(p.target_treatment,1),0)>0 then 100 else 0 end + case when coalesce(array_length(p.target_age,1),0)>0 then 10 else 0 end + case when coalesce(array_length(p.target_gender,1),0)>0 then 5 else 0 end) desc,p.sort_order,p.created_at limit 1;
    if v_playlist_id is not null then
      select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by pi.sort_order,pi.created_at),'[]'::jsonb) into v_playlist from public.playlist_items pi join public.videos v on v.id=pi.video_id where pi.playlist_id=v_playlist_id and v.active and (v.source<>'local' or v.available);
      if jsonb_array_length(v_playlist)>0 then v_mode:='patient';v_revision:='pp:'||v_playlist_id::text||':'||coalesce(extract(epoch from r.session_started_at)::bigint,0); end if;
    end if;
    if v_mode is null then
      with candidates as (select v.*,(case when coalesce(array_length(v.target_treatment,1),0)>0 then 100 else 0 end + case when coalesce(array_length(v.target_age,1),0)>0 then 10 else 0 end + case when coalesce(array_length(v.target_gender,1),0)>0 then 5 else 0 end) score from public.videos v where v.active and (v.source<>'local' or v.available) and (coalesce(array_length(v.target_treatment,1),0)=0 or r.session_treatment=any(v.target_treatment)) and (coalesce(array_length(v.target_age,1),0)=0 or (r.session_age_group is not null and r.session_age_group=any(v.target_age))) and (coalesce(array_length(v.target_gender,1),0)=0 or (r.session_gender is not null and r.session_gender=any(v.target_gender)))), best as (select max(score) score from candidates)
      select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'source',c.source,'file_path',c.file_path,'url',c.url,'size',c.size_bytes,'file_modified_at',c.file_modified_at) order by c.sort_order,c.created_at),'[]'::jsonb) into v_playlist from candidates c cross join best where c.score=best.score;
      if jsonb_array_length(v_playlist)>0 then v_mode:='patient';v_revision:='legacy-p:'||coalesce(extract(epoch from r.session_started_at)::bigint,0); end if;
    end if;
  end if;

  if v_mode is null then
    v_mode:='default';v_expires:=null;
    v_playlist_id:=r.default_playlist_id;
    if v_playlist_id is null then select id into v_playlist_id from public.playlists where active and kind='default' order by sort_order,created_at limit 1; end if;
    if v_playlist_id is not null then select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by pi.sort_order,pi.created_at),'[]'::jsonb) into v_playlist from public.playlist_items pi join public.videos v on v.id=pi.video_id where pi.playlist_id=v_playlist_id and v.active and (v.source<>'local' or v.available); end if;
    if jsonb_array_length(v_playlist)=0 then select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) order by v.sort_order,v.created_at),'[]'::jsonb) into v_playlist from public.videos v where v.active and (v.source<>'local' or v.available) and v.tags&&r.default_tags; end if;
    v_revision:='d:'||coalesce(v_playlist_id::text,'legacy');
  end if;
  if v_mode in ('manual','patient','default') then
    v_playlist:=public.apply_room_video_rules(r.id,v_playlist);
    v_revision:=v_revision||':rr:'||coalesce((select extract(epoch from max(updated_at))::bigint::text from public.room_video_rules where room_id=r.id),'0');
  end if;
  if s.emergency_video_id is not null then select jsonb_build_object('id',v.id,'title',v.title,'source',v.source,'file_path',v.file_path,'url',v.url,'size',v.size_bytes,'file_modified_at',v.file_modified_at,'thumbnail',v.thumbnail_data_url) into v_emergency from public.videos v where v.id=s.emergency_video_id and v.active and (v.source<>'local' or v.available); end if;
  return jsonb_build_object('room',jsonb_build_object('id',r.id,'name',r.name,'group_id',r.group_id,'room_mode',r.room_mode,'force_mute',r.force_mute,'volume',r.volume,'paused',r.paused,'overlay_text',r.overlay_text,'reload_nonce',r.reload_nonce),'mode',v_mode,'session_expires_at',case when v_mode='patient' then v_expires end,'notice_text',v_notice,'playlist',v_playlist,'emergency_video',v_emergency,'sync_effective_at',v_effective,'sync_revision',v_revision,'next_transition_at',v_next_transition,'media_server_url',coalesce(s.media_server_url,''),'server_time',clock_timestamp());
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
     where pi.playlist_id=v_playlist and v.active and (v.source<>'local' or v.available);
  end if;
  if not (p_video=any(coalesce(v_ids,'{}'::uuid[]))) then v_ids:=array_append(coalesce(v_ids,'{}'::uuid[]),p_video); end if;
  update public.rooms set manual_video_ids=v_ids,manual_active=true,
    manual_starts_at=case when v_keep_window then r.manual_starts_at else null end,
    manual_ends_at=case when v_keep_window then r.manual_ends_at else null end,
    manual_updated_at=clock_timestamp() where id=p_room;
  insert into public.control_history(scope_type,scope_id,action,label,before_state,after_state)
  values('rooms',p_room,'video_add',v_title,v_before,(select jsonb_build_object('manual_active',manual_active,'manual_video_ids',manual_video_ids,'manual_starts_at',manual_starts_at,'manual_ends_at',manual_ends_at,'default_playlist_id',default_playlist_id) from public.rooms where id=p_room));
end $$;

create or replace function public.staff_add_room_video(p_room uuid,p_video uuid)
returns void language plpgsql security definer set search_path=public as $$
declare r public.rooms; v_ids uuid[]; v_playlist uuid; v_title text; v_keep_window boolean;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select * into r from public.rooms where id=p_room for update;
  if not found then raise exception '공간을 찾을 수 없습니다'; end if;
  select title into v_title from public.videos where id=p_video and active and (source<>'local' or available);
  if v_title is null then raise exception '사용 가능한 영상이 아닙니다'; end if;
  v_keep_window:=r.manual_active and (r.manual_ends_at is null or r.manual_ends_at>clock_timestamp());
  if v_keep_window and coalesce(array_length(r.manual_video_ids,1),0)>0 then
    v_ids:=r.manual_video_ids;
  else
    v_playlist:=r.default_playlist_id;
    if v_playlist is null then select id into v_playlist from public.playlists where active and kind='default' order by sort_order,created_at limit 1; end if;
    select coalesce(array_agg(v.id order by pi.sort_order,pi.created_at),'{}'::uuid[]) into v_ids
      from public.playlist_items pi join public.videos v on v.id=pi.video_id
     where pi.playlist_id=v_playlist and v.active and (v.source<>'local' or v.available);
  end if;
  if not (p_video=any(coalesce(v_ids,'{}'::uuid[]))) then v_ids:=array_append(coalesce(v_ids,'{}'::uuid[]),p_video); end if;
  update public.rooms set manual_video_ids=v_ids,manual_active=true,
    manual_starts_at=case when v_keep_window then r.manual_starts_at else null end,
    manual_ends_at=case when v_keep_window then r.manual_ends_at else null end,
    manual_updated_at=clock_timestamp() where id=p_room;
end $$;

create or replace function public.staff_clear_room_manual(p_room uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  update public.rooms set manual_active=false,manual_video_ids='{}'::uuid[],manual_starts_at=null,manual_ends_at=null,manual_updated_at=clock_timestamp() where id=p_room;
end $$;

revoke all on function public.admin_set_broadcast_timed(boolean,uuid[],text,timestamptz,timestamptz) from public;
revoke all on function public.admin_set_rooms_manual_timed(uuid[],uuid[],boolean,timestamptz,timestamptz) from public;
grant execute on function public.admin_set_broadcast_timed(boolean,uuid[],text,timestamptz,timestamptz) to anon,authenticated;
grant execute on function public.admin_set_rooms_manual_timed(uuid[],uuid[],boolean,timestamptz,timestamptz) to anon,authenticated;

select 'Clinic Signage 2.27.0 timed output' as release;
