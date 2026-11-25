-- Clinic Signage v2.18 — per-space playlist / single-video controls
-- Safe to rerun after v2.17.1.

create or replace function public.admin_set_room_playlist(p_room uuid,p_playlist uuid)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_before jsonb; v_name text; v_count int;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select name into v_name from public.playlists where id=p_playlist and active;
  if v_name is null then raise exception '사용 가능한 플레이리스트가 아닙니다'; end if;
  select count(*) into v_count from public.playlist_items pi join public.videos v on v.id=pi.video_id
   where pi.playlist_id=p_playlist and v.active and (v.source<>'local' or v.available);
  if v_count=0 then raise exception '플레이리스트에 재생 가능한 영상이 없습니다'; end if;
  select jsonb_build_object('default_playlist_id',default_playlist_id,'manual_active',manual_active,'manual_video_ids',manual_video_ids,
    'session_started_at',session_started_at,'session_age_group',session_age_group,'session_gender',session_gender,'session_treatment',session_treatment)
    into v_before from public.rooms where id=p_room;
  if v_before is null then raise exception '공간을 찾을 수 없습니다'; end if;
  update public.rooms
     set default_playlist_id=p_playlist,
         manual_active=false,
         manual_video_ids='{}'::uuid[],
         manual_updated_at=clock_timestamp(),
         session_started_at=case when exists(select 1 from public.patient_sessions where room_id=p_room and status in ('assigned','in_progress')) then session_started_at else null end,
         session_age_group=case when exists(select 1 from public.patient_sessions where room_id=p_room and status in ('assigned','in_progress')) then session_age_group else null end,
         session_gender=case when exists(select 1 from public.patient_sessions where room_id=p_room and status in ('assigned','in_progress')) then session_gender else null end,
         session_treatment=case when exists(select 1 from public.patient_sessions where room_id=p_room and status in ('assigned','in_progress')) then session_treatment else null end,
         session_tags=case when exists(select 1 from public.patient_sessions where room_id=p_room and status in ('assigned','in_progress')) then session_tags else '{}'::text[] end
   where id=p_room;
  insert into public.control_history(scope_type,scope_id,action,label,before_state,after_state)
  values('rooms',p_room,'playlist_change',v_name,v_before,(select to_jsonb(r) from public.rooms r where r.id=p_room));
end $$;

create or replace function public.admin_add_room_video(p_room uuid,p_video uuid)
returns void language plpgsql security definer set search_path=public as $$
declare
  r public.rooms; v_ids uuid[]; v_title text; v_playlist uuid; v_before jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select * into r from public.rooms where id=p_room for update;
  if not found then raise exception '공간을 찾을 수 없습니다'; end if;
  select title into v_title from public.videos where id=p_video and active and (source<>'local' or available);
  if v_title is null then raise exception '사용 가능한 영상이 아닙니다'; end if;
  v_before:=jsonb_build_object('manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids,'default_playlist_id',r.default_playlist_id);
  if r.manual_active and coalesce(array_length(r.manual_video_ids,1),0)>0 then
    v_ids:=r.manual_video_ids;
  else
    v_playlist:=r.default_playlist_id;
    if v_playlist is null then select id into v_playlist from public.playlists where active and kind='default' order by sort_order,created_at limit 1; end if;
    select coalesce(array_agg(v.id order by pi.sort_order,pi.created_at),'{}'::uuid[]) into v_ids
      from public.playlist_items pi join public.videos v on v.id=pi.video_id
     where pi.playlist_id=v_playlist and v.active and (v.source<>'local' or v.available);
  end if;
  if not (p_video=any(coalesce(v_ids,'{}'::uuid[]))) then v_ids:=array_append(coalesce(v_ids,'{}'::uuid[]),p_video); end if;
  update public.rooms set manual_video_ids=v_ids,manual_active=true,manual_updated_at=clock_timestamp() where id=p_room;
  insert into public.control_history(scope_type,scope_id,action,label,before_state,after_state)
  values('rooms',p_room,'video_add',v_title,v_before,(select jsonb_build_object('manual_active',manual_active,'manual_video_ids',manual_video_ids,'default_playlist_id',default_playlist_id) from public.rooms where id=p_room));
end $$;

create or replace function public.staff_set_room_playlist(p_room uuid,p_playlist uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_name text; v_count int;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select name into v_name from public.playlists where id=p_playlist and active;
  if v_name is null then raise exception '사용 가능한 플레이리스트가 아닙니다'; end if;
  select count(*) into v_count from public.playlist_items pi join public.videos v on v.id=pi.video_id
   where pi.playlist_id=p_playlist and v.active and (v.source<>'local' or v.available);
  if v_count=0 then raise exception '플레이리스트에 재생 가능한 영상이 없습니다'; end if;
  update public.rooms
     set default_playlist_id=p_playlist,
         manual_active=false,
         manual_video_ids='{}'::uuid[],
         manual_updated_at=clock_timestamp(),
         session_started_at=case when exists(select 1 from public.patient_sessions where room_id=p_room and status in ('assigned','in_progress')) then session_started_at else null end,
         session_age_group=case when exists(select 1 from public.patient_sessions where room_id=p_room and status in ('assigned','in_progress')) then session_age_group else null end,
         session_gender=case when exists(select 1 from public.patient_sessions where room_id=p_room and status in ('assigned','in_progress')) then session_gender else null end,
         session_treatment=case when exists(select 1 from public.patient_sessions where room_id=p_room and status in ('assigned','in_progress')) then session_treatment else null end,
         session_tags=case when exists(select 1 from public.patient_sessions where room_id=p_room and status in ('assigned','in_progress')) then session_tags else '{}'::text[] end
   where id=p_room;
  if not found then raise exception '공간을 찾을 수 없습니다'; end if;
end $$;

create or replace function public.staff_add_room_video(p_room uuid,p_video uuid)
returns void language plpgsql security definer set search_path=public as $$
declare r public.rooms; v_ids uuid[]; v_playlist uuid; v_title text;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select * into r from public.rooms where id=p_room for update;
  if not found then raise exception '공간을 찾을 수 없습니다'; end if;
  select title into v_title from public.videos where id=p_video and active and (source<>'local' or available);
  if v_title is null then raise exception '사용 가능한 영상이 아닙니다'; end if;
  if r.manual_active and coalesce(array_length(r.manual_video_ids,1),0)>0 then
    v_ids:=r.manual_video_ids;
  else
    v_playlist:=r.default_playlist_id;
    if v_playlist is null then select id into v_playlist from public.playlists where active and kind='default' order by sort_order,created_at limit 1; end if;
    select coalesce(array_agg(v.id order by pi.sort_order,pi.created_at),'{}'::uuid[]) into v_ids
      from public.playlist_items pi join public.videos v on v.id=pi.video_id
     where pi.playlist_id=v_playlist and v.active and (v.source<>'local' or v.available);
  end if;
  if not (p_video=any(coalesce(v_ids,'{}'::uuid[]))) then v_ids:=array_append(coalesce(v_ids,'{}'::uuid[]),p_video); end if;
  update public.rooms set manual_video_ids=v_ids,manual_active=true,manual_updated_at=clock_timestamp() where id=p_room;
end $$;

create or replace function public.staff_clear_room_manual(p_room uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  update public.rooms set manual_active=false,manual_video_ids='{}'::uuid[],manual_updated_at=clock_timestamp() where id=p_room;
  if not found then raise exception '공간을 찾을 수 없습니다'; end if;
end $$;

create or replace function public.staff_reception_state()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_rooms jsonb; v_patients jsonb; v_broadcast jsonb; v_playlists jsonb; v_videos jsonb;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,'name',r.name,'sort_order',r.sort_order,'group_id',r.group_id,'group_name',g.name,'room_mode',r.room_mode,
    'last_seen_at',r.last_seen_at,'player_status',coalesce(r.player_status,'{}'::jsonb),'session_timeout_min',r.session_timeout_min,
    'session_started_at',r.session_started_at,'session_age_group',r.session_age_group,'session_gender',r.session_gender,'session_treatment',r.session_treatment,
    'default_playlist_id',r.default_playlist_id,'manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids
  ) order by coalesce(g.sort_order,2147483647),r.sort_order,r.created_at),'[]'::jsonb) into v_rooms
  from public.rooms r left join public.signage_groups g on g.id=r.group_id;

  select coalesce(jsonb_agg(to_jsonb(x) order by case x.status when 'in_progress' then 0 when 'assigned' then 1 when 'waiting' then 2 else 3 end,x.waiting_started_at),'[]'::jsonb) into v_patients
  from (select * from public.patient_sessions where (status in ('waiting','assigned','in_progress')) or (status='completed' and completed_at>=date_trunc('day',clock_timestamp())) ) x;

  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'kind',p.kind,'active',p.active,'sort_order',p.sort_order) order by p.sort_order,p.created_at),'[]'::jsonb)
    into v_playlists from public.playlists p where p.active;
  select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'active',v.active) order by v.sort_order,v.created_at),'[]'::jsonb)
    into v_videos from public.videos v where v.active and (v.source<>'local' or v.available);
  select jsonb_build_object('active',active,'notice_text',notice_text) into v_broadcast from public.broadcast where id=1;

  return jsonb_build_object('rooms',v_rooms,'patients',v_patients,'playlists',v_playlists,'videos',v_videos,'broadcast',coalesce(v_broadcast,'{}'::jsonb),'server_time',clock_timestamp());
end $$;

revoke all on function public.admin_set_room_playlist(uuid,uuid) from public;
revoke all on function public.admin_add_room_video(uuid,uuid) from public;
revoke all on function public.staff_set_room_playlist(uuid,uuid) from public;
revoke all on function public.staff_add_room_video(uuid,uuid) from public;
revoke all on function public.staff_clear_room_manual(uuid) from public;
revoke all on function public.staff_reception_state() from public;
grant execute on function public.admin_set_room_playlist(uuid,uuid) to anon,authenticated;
grant execute on function public.admin_add_room_video(uuid,uuid) to anon,authenticated;
grant execute on function public.staff_set_room_playlist(uuid,uuid) to anon,authenticated;
grant execute on function public.staff_add_room_video(uuid,uuid) to anon,authenticated;
grant execute on function public.staff_clear_room_manual(uuid) to anon,authenticated;
grant execute on function public.staff_reception_state() to anon,authenticated;
