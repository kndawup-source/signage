-- Clinic Signage v2.16 — playback analytics + global operating hours
-- Safe to rerun after v2.15.

alter table public.app_settings add column if not exists operating_start time not null default '09:00';
alter table public.app_settings add column if not exists operating_end time not null default '20:00';

create table if not exists public.room_playback_daily (
  day date not null,
  room_id uuid not null references public.rooms(id) on delete cascade,
  online_seconds bigint not null default 0,
  playing_seconds bigint not null default 0,
  default_seconds bigint not null default 0,
  custom_seconds bigint not null default 0,
  override_seconds bigint not null default 0,
  error_seconds bigint not null default 0,
  paused_seconds bigint not null default 0,
  reconnect_count int not null default 0,
  error_count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key(day,room_id)
);
create index if not exists room_playback_daily_day_idx on public.room_playback_daily(day,room_id);

create table if not exists public.player_events (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  event_type text not null,
  mode text,
  playback_state text,
  video_id text,
  title text,
  error text,
  occurred_at timestamptz not null default clock_timestamp()
);
create index if not exists player_events_room_time_idx on public.player_events(room_id,occurred_at desc);

alter table public.room_playback_daily enable row level security;
alter table public.player_events enable row level security;
drop policy if exists playback_daily_admin on public.room_playback_daily;
create policy playback_daily_admin on public.room_playback_daily for select to anon,authenticated using(public.is_admin());
drop policy if exists player_events_admin on public.player_events;
create policy player_events_admin on public.player_events for select to anon,authenticated using(public.is_admin());
grant select on public.room_playback_daily,public.player_events to anon,authenticated;

create or replace function public.player_heartbeat(p_key uuid,p_status jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare
  clean jsonb; v_room uuid; v_prev jsonb; v_last timestamptz; v_now timestamptz:=clock_timestamp();
  v_delta int:=0; v_day date; v_local_time time; v_start time; v_end time; v_in_hours boolean:=false;
  v_state text; v_mode text; v_prev_state text; v_prev_mode text; v_reconnect int:=0; v_error_transition int:=0;
begin
  select id,player_status,last_seen_at into v_room,v_prev,v_last from public.rooms where player_key=p_key for update;
  if v_room is null then return; end if;
  if p_status is null or jsonb_typeof(p_status)<>'object' or pg_column_size(p_status)>4096 then
    update public.rooms set heartbeat_rejected_count=heartbeat_rejected_count+1 where id=v_room; return;
  end if;
  clean=jsonb_build_object(
    'video_id',case when jsonb_typeof(p_status->'video_id')='string' then left(p_status->>'video_id',64) else null end,
    'title',left(coalesce(p_status->>'title',''),160),'mode',left(coalesce(p_status->>'mode',''),32),
    'playback_state',left(coalesce(p_status->>'playback_state',''),32),
    'current_time',case when jsonb_typeof(p_status->'current_time')='number' then greatest(0,least((p_status->>'current_time')::numeric,86400)) else 0 end,
    'duration',case when jsonb_typeof(p_status->'duration')='number' then greatest(0,least((p_status->>'duration')::numeric,86400)) else 0 end,
    'muted',case when jsonb_typeof(p_status->'muted')='boolean' then (p_status->>'muted')::boolean else false end,
    'volume',case when jsonb_typeof(p_status->'volume')='number' then greatest(0,least((p_status->>'volume')::int,100)) else 0 end,
    'online',case when jsonb_typeof(p_status->'online')='boolean' then (p_status->>'online')::boolean else false end,
    'error',left(coalesce(p_status->>'error',''),300),'source',left(coalesce(p_status->>'source',''),64),
    'playlist_titles',coalesce((select jsonb_agg(left(x.value,120) order by x.ord) from jsonb_array_elements_text(case when jsonb_typeof(p_status->'playlist_titles')='array' then p_status->'playlist_titles' else '[]'::jsonb end) with ordinality as x(value,ord) where x.ord<=12),'[]'::jsonb),
    'playlist_count',case when jsonb_typeof(p_status->'playlist_count')='number' then greatest(0,least((p_status->>'playlist_count')::int,500)) else 0 end,
    'current_index',case when jsonb_typeof(p_status->'current_index')='number' then greatest(0,least((p_status->>'current_index')::int,499)) else 0 end,
    'next_title',left(coalesce(p_status->>'next_title',''),160),'app_version',left(coalesce(p_status->>'app_version',''),24),'reported_at',left(coalesce(p_status->>'reported_at',''),48)
  );
  v_state:=clean->>'playback_state'; v_mode:=clean->>'mode'; v_prev_state:=coalesce(v_prev->>'playback_state',''); v_prev_mode:=coalesce(v_prev->>'mode','');
  select operating_start,operating_end into v_start,v_end from public.app_settings where id=1;
  v_day:=(v_now at time zone 'Asia/Seoul')::date; v_local_time:=(v_now at time zone 'Asia/Seoul')::time;
  v_in_hours:=v_local_time>=v_start and v_local_time<v_end;
  if v_last is not null then
    v_delta:=greatest(0,least(60,extract(epoch from (v_now-v_last))::int));
    if extract(epoch from (v_now-v_last))>30 then v_reconnect:=1; end if;
  end if;
  if coalesce(clean->>'error','')<>'' and coalesce(v_prev->>'error','')='' then v_error_transition:=1; end if;
  if v_in_hours and v_delta>0 then
    insert into public.room_playback_daily(day,room_id,online_seconds,playing_seconds,default_seconds,custom_seconds,override_seconds,error_seconds,paused_seconds,reconnect_count,error_count,updated_at)
    values(v_day,v_room,v_delta,
      case when v_state in ('playing','emergency') then v_delta else 0 end,
      case when v_state in ('playing','emergency') and v_mode='default' then v_delta else 0 end,
      case when v_state in ('playing','emergency') and v_mode in ('patient','session') then v_delta else 0 end,
      case when v_state in ('playing','emergency') and v_mode in ('broadcast','broadcast_schedule','group','group_schedule','manual') then v_delta else 0 end,
      case when v_state='error' then v_delta else 0 end,
      case when v_state='paused' then v_delta else 0 end,v_reconnect,v_error_transition,v_now)
    on conflict(day,room_id) do update set
      online_seconds=room_playback_daily.online_seconds+excluded.online_seconds,
      playing_seconds=room_playback_daily.playing_seconds+excluded.playing_seconds,
      default_seconds=room_playback_daily.default_seconds+excluded.default_seconds,
      custom_seconds=room_playback_daily.custom_seconds+excluded.custom_seconds,
      override_seconds=room_playback_daily.override_seconds+excluded.override_seconds,
      error_seconds=room_playback_daily.error_seconds+excluded.error_seconds,
      paused_seconds=room_playback_daily.paused_seconds+excluded.paused_seconds,
      reconnect_count=room_playback_daily.reconnect_count+excluded.reconnect_count,
      error_count=room_playback_daily.error_count+excluded.error_count,updated_at=v_now;
  end if;
  if v_prev is null or v_state<>v_prev_state or v_mode<>v_prev_mode or coalesce(clean->>'video_id','')<>coalesce(v_prev->>'video_id','') or coalesce(clean->>'error','')<>coalesce(v_prev->>'error','') then
    insert into public.player_events(room_id,event_type,mode,playback_state,video_id,title,error)
    values(v_room,'state_change',nullif(v_mode,''),nullif(v_state,''),nullif(clean->>'video_id',''),nullif(clean->>'title',''),nullif(clean->>'error',''));
  end if;
  update public.rooms set last_seen_at=v_now,player_status=clean where id=v_room;
end $$;
revoke all on function public.player_heartbeat(uuid,jsonb) from public;
grant execute on function public.player_heartbeat(uuid,jsonb) to anon,authenticated;

create or replace function public.admin_playback_today()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare s public.app_settings; v_now timestamp; v_day date; v_elapsed int; v_total int; v_rooms jsonb; v_overall jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select * into s from public.app_settings where id=1;
  v_now:=clock_timestamp() at time zone 'Asia/Seoul'; v_day:=v_now::date;
  v_total:=greatest(0,extract(epoch from (s.operating_end-s.operating_start))::int);
  if v_now::time<=s.operating_start then v_elapsed:=0;
  elsif v_now::time>=s.operating_end then v_elapsed:=v_total;
  else v_elapsed:=greatest(0,extract(epoch from (v_now::time-s.operating_start))::int); end if;
  select coalesce(jsonb_agg(jsonb_build_object('room_id',r.id,'name',r.name,'group_name',g.name,'planned_seconds',v_elapsed,
    'online_seconds',coalesce(d.online_seconds,0),'playing_seconds',least(v_elapsed,coalesce(d.playing_seconds,0)),
    'default_seconds',coalesce(d.default_seconds,0),'custom_seconds',coalesce(d.custom_seconds,0),'override_seconds',coalesce(d.override_seconds,0),
    'error_seconds',coalesce(d.error_seconds,0),'paused_seconds',coalesce(d.paused_seconds,0),'error_count',coalesce(d.error_count,0),'reconnect_count',coalesce(d.reconnect_count,0),
    'rate',case when v_elapsed>0 then round(least(100,coalesce(d.playing_seconds,0)*100.0/v_elapsed),1) else 0 end,
    'last_seen_at',r.last_seen_at) order by coalesce(g.sort_order,2147483647),r.sort_order,r.created_at),'[]'::jsonb) into v_rooms
  from public.rooms r left join public.signage_groups g on g.id=r.group_id left join public.room_playback_daily d on d.room_id=r.id and d.day=v_day;
  select jsonb_build_object('planned_seconds',v_elapsed*count(*),'playing_seconds',coalesce(sum(least(v_elapsed,coalesce(d.playing_seconds,0))),0),
    'error_count',coalesce(sum(d.error_count),0),'reconnect_count',coalesce(sum(d.reconnect_count),0),
    'rate',case when v_elapsed>0 and count(*)>0 then round(coalesce(sum(least(v_elapsed,coalesce(d.playing_seconds,0))),0)*100.0/(v_elapsed*count(*)),1) else 0 end) into v_overall
  from public.rooms r left join public.room_playback_daily d on d.room_id=r.id and d.day=v_day;
  return jsonb_build_object('day',v_day,'operating_start',s.operating_start,'operating_end',s.operating_end,'elapsed_seconds',v_elapsed,'overall',v_overall,'rooms',v_rooms);
end $$;
revoke all on function public.admin_playback_today() from public;
grant execute on function public.admin_playback_today() to anon,authenticated;
