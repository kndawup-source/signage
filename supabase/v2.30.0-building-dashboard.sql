begin;

alter table public.signage_groups add column if not exists floor_number smallint;
alter table public.signage_groups add column if not exists care_type text not null default 'other';
alter table public.signage_groups add column if not exists signage_purpose text;
alter table public.signage_groups add column if not exists target_audience text;
alter table public.signage_groups add column if not exists waiting_area_note text;
alter table public.signage_groups add column if not exists signage_reason text;
alter table public.signage_groups add column if not exists default_playlist_id uuid;
alter table public.signage_groups drop constraint if exists signage_groups_default_playlist_fk;
alter table public.signage_groups add constraint signage_groups_default_playlist_fk foreign key(default_playlist_id) references public.playlists(id) on delete set null;
alter table public.signage_groups drop constraint if exists signage_groups_kind_check;
alter table public.signage_groups add constraint signage_groups_kind_check check(kind in ('floor','zone','consultation','waiting','vip','other'));
alter table public.signage_groups drop constraint if exists signage_groups_care_type_check;
alter table public.signage_groups add constraint signage_groups_care_type_check check(care_type in ('general','minish','common','support','other'));
alter table public.signage_groups drop constraint if exists signage_groups_floor_number_check;
alter table public.signage_groups add constraint signage_groups_floor_number_check check(floor_number is null or floor_number between 1 and 99);
update public.signage_groups set floor_number=(regexp_match(trim(name),'^([0-9]+)(?:F|층)?$'))[1]::smallint where floor_number is null and trim(name) ~ '^([0-9]+)(?:F|층)?$';

alter table public.rooms add column if not exists map_x_pct numeric(5,2);
alter table public.rooms add column if not exists map_y_pct numeric(5,2);
alter table public.rooms drop constraint if exists rooms_map_x_pct_check;
alter table public.rooms add constraint rooms_map_x_pct_check check(map_x_pct is null or map_x_pct between 0 and 100);
alter table public.rooms drop constraint if exists rooms_map_y_pct_check;
alter table public.rooms add constraint rooms_map_y_pct_check check(map_y_pct is null or map_y_pct between 0 and 100);
alter table public.rooms drop constraint if exists rooms_room_mode_check;
alter table public.rooms add constraint rooms_room_mode_check check(room_mode in ('treatment','consultation','waiting','lobby','vip','other'));

create or replace function public.staff_reception_state()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_rooms jsonb; v_groups jsonb; v_patients jsonb; v_broadcast jsonb; v_playlists jsonb; v_videos jsonb; v_items jsonb; v_rules jsonb;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,'name',r.name,'sort_order',r.sort_order,'group_id',r.group_id,'group_name',g.name,'room_mode',r.room_mode,
    'last_seen_at',r.last_seen_at,'player_status',coalesce(r.player_status,'{}'::jsonb),'session_timeout_min',r.session_timeout_min,
    'session_started_at',r.session_started_at,'session_age_group',r.session_age_group,'session_gender',r.session_gender,'session_treatment',r.session_treatment,
    'default_playlist_id',r.default_playlist_id,'manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids,'map_x_pct',r.map_x_pct,'map_y_pct',r.map_y_pct
  ) order by coalesce(g.sort_order,2147483647),r.sort_order,r.created_at),'[]'::jsonb) into v_rooms
  from public.rooms r left join public.signage_groups g on g.id=r.group_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'kind',g.kind,'floor_number',g.floor_number,'care_type',g.care_type,'signage_purpose',g.signage_purpose,'target_audience',g.target_audience,'waiting_area_note',g.waiting_area_note,'signage_reason',g.signage_reason,'default_playlist_id',g.default_playlist_id,'sort_order',g.sort_order) order by g.sort_order,g.floor_number,g.created_at),'[]'::jsonb) into v_groups from public.signage_groups g;
  select coalesce(jsonb_agg(to_jsonb(x) order by case x.status when 'in_progress' then 0 when 'assigned' then 1 when 'waiting' then 2 else 3 end,x.waiting_started_at),'[]'::jsonb) into v_patients
  from (select * from public.patient_sessions where (status in ('waiting','assigned','in_progress')) or (status='completed' and completed_at>=date_trunc('day',clock_timestamp())) ) x;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'kind',p.kind,'active',p.active,'sort_order',p.sort_order,'target_treatment',p.target_treatment,'target_age',p.target_age,'target_gender',p.target_gender) order by p.sort_order,p.created_at),'[]'::jsonb) into v_playlists from public.playlists p where p.active;
  select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'active',v.active,'duration_sec',v.duration_sec,'thumbnail_data_url',v.thumbnail_data_url,'target_treatment',v.target_treatment,'target_age',v.target_age,'target_gender',v.target_gender) order by v.sort_order,v.created_at),'[]'::jsonb) into v_videos from public.videos v where v.active and (v.source<>'local' or v.available);
  select coalesce(jsonb_agg(jsonb_build_object('playlist_id',pi.playlist_id,'video_id',pi.video_id,'sort_order',pi.sort_order) order by pi.playlist_id,pi.sort_order,pi.created_at),'[]'::jsonb) into v_items from public.playlist_items pi;
  select coalesce(jsonb_agg(jsonb_build_object('room_id',rr.room_id,'video_id',rr.video_id,'enabled',rr.enabled,'sort_order',rr.sort_order,'starts_at',rr.starts_at,'ends_at',rr.ends_at,'updated_at',rr.updated_at)),'[]'::jsonb) into v_rules from public.room_video_rules rr;
  select jsonb_build_object('active',active,'notice_text',notice_text) into v_broadcast from public.broadcast where id=1;
  return jsonb_build_object('rooms',v_rooms,'groups',v_groups,'patients',v_patients,'playlists',v_playlists,'videos',v_videos,'playlist_items',v_items,'room_video_rules',v_rules,'broadcast',coalesce(v_broadcast,'{}'::jsonb),'server_time',clock_timestamp());
end $$;
revoke all on function public.staff_reception_state() from public;
grant execute on function public.staff_reception_state() to anon,authenticated;

create or replace function public.player_get_state(p_key uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  r public.rooms; b public.broadcast; s public.app_settings; gb public.group_broadcasts; hs public.broadcast_schedules; gs public.broadcast_schedules;
  v_mode text; v_expires timestamptz; v_playlist jsonb:='[]'::jsonb; v_emergency jsonb; v_playlist_id uuid;
  v_notice text; v_effective timestamptz; v_revision text:='0'; v_next_transition timestamptz; v_operating jsonb; v_operating_end timestamptz;
begin
  select * into r from public.rooms where player_key=p_key; if not found then return null; end if;
  select * into b from public.broadcast where id=1; select * into s from public.app_settings where id=1;
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
    if v_playlist_id is null and r.group_id is not null then select default_playlist_id into v_playlist_id from public.signage_groups where id=r.group_id; end if;
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
  return jsonb_build_object('room',jsonb_build_object('id',r.id,'name',r.name,'group_id',r.group_id,'room_mode',r.room_mode,'force_mute',r.force_mute,'volume',r.volume,'paused',r.paused,'overlay_text',r.overlay_text,'reload_nonce',r.reload_nonce),'mode',v_mode,'priority',v_mode,'operating',v_operating,'session_expires_at',case when v_mode='patient' then v_expires end,'notice_text',v_notice,'playlist',v_playlist,'emergency_video',v_emergency,'sync_effective_at',v_effective,'sync_revision',v_revision,'next_transition_at',v_next_transition,'media_server_url',coalesce(s.media_server_url,''),'server_time',clock_timestamp());
end $$;
revoke all on function public.player_get_state(uuid) from public;
grant execute on function public.player_get_state(uuid) to anon,authenticated;

commit;
