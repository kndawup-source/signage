-- Apply to a staging DB first. Preserves RLS and existing tables.
BEGIN;
create or replace function public.player_heartbeat(p_key uuid,p_status jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare
  clean jsonb; v_room uuid; v_prev jsonb; v_last timestamptz; v_now timestamptz:=clock_timestamp();
  v_delta int:=0; v_day date; v_local_time time; v_start time; v_end time; v_open boolean:=false; v_in_hours boolean:=false;
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
    'active_hash',left(coalesce(p_status->>'active_hash',''),100),
    'pending_hash',left(coalesce(p_status->>'pending_hash',''),100),
    'pending_count',case when jsonb_typeof(p_status->'pending_count')='number' then greatest(0,least((p_status->>'pending_count')::int,500)) end,
    'pending_total',case when jsonb_typeof(p_status->'pending_total')='number' then greatest(0,least((p_status->>'pending_total')::int,500)) end,
    'storage_persisted',case when jsonb_typeof(p_status->'storage_persisted')='boolean' then (p_status->>'storage_persisted')::boolean end,
    'offline_cache_error',left(coalesce(p_status->>'offline_cache_error',''),160),
    'failed_videos',coalesce((select jsonb_agg(jsonb_build_object('id',left(coalesce(x.item->>'id',''),100),'title',left(coalesce(x.item->>'title',''),60),'code',left(coalesce(x.item->>'code',''),40))) from jsonb_array_elements(case when jsonb_typeof(p_status->'failed_videos')='array' then p_status->'failed_videos' else '[]'::jsonb end) with ordinality as x(item,ord) where x.ord<=5),'[]'::jsonb),
    'playlist_count',case when jsonb_typeof(p_status->'playlist_count')='number' then greatest(0,least((p_status->>'playlist_count')::int,500)) else 0 end,
    'current_index',case when jsonb_typeof(p_status->'current_index')='number' then greatest(0,least((p_status->>'current_index')::int,499)) else 0 end,
    'next_title',left(coalesce(p_status->>'next_title',''),160),'app_version',left(coalesce(p_status->>'app_version',''),24),'reported_at',left(coalesce(p_status->>'reported_at',''),48)
  );
  v_state:=clean->>'playback_state'; v_mode:=clean->>'mode'; v_prev_state:=coalesce(v_prev->>'playback_state',''); v_prev_mode:=coalesce(v_prev->>'mode','');
  v_day:=(v_now at time zone 'Asia/Seoul')::date; v_local_time:=(v_now at time zone 'Asia/Seoul')::time;
  select is_open,start_time,end_time into v_open,v_start,v_end from public.signage_room_operating_window(v_room,v_day);
  v_in_hours:=v_open and v_local_time>=v_start and v_local_time<v_end;
  if v_last is not null then
    -- Up to one 5-minute telemetry interval, with margin for timer jitter.
    -- Older 60-second caps undercounted playback by ~80% at 5-minute intervals.
    v_delta:=greatest(0,least(360,extract(epoch from (v_now-v_last))::int));
    -- A normal 5-minute interval is not a reconnect.
    if extract(epoch from (v_now-v_last))>600 then v_reconnect:=1; end if;
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
create or replace function public.player_report(p_key uuid, p_status jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_room uuid;
  v_now timestamptz := clock_timestamp();
  v_clean jsonb;
  v_fp text;
  v_prev_fp text;
  v_prev_seen timestamptz;
  v_synced text;
  ts_re constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$';
begin
  select id into v_room from public.rooms where player_key = p_key;
  if v_room is null then return null; end if;
  if p_status is null or jsonb_typeof(p_status) <> 'object' or pg_column_size(p_status) > 8192 then
    return jsonb_build_object('ok', false, 'error', 'invalid_status', 'server_time', v_now);
  end if;

  v_synced := case when jsonb_typeof(p_status->'synced_at') = 'string' and (p_status->>'synced_at') ~ ts_re
                   then left(p_status->>'synced_at', 40) end;

  v_clean := jsonb_strip_nulls(jsonb_build_object(
    'video_id',        case when jsonb_typeof(p_status->'video_id') = 'string' then left(p_status->>'video_id', 64) end,
    'title',           left(coalesce(p_status->>'title', ''), 160),
    'mode',            left(coalesce(p_status->>'mode', ''), 32),
    'playback_state',  left(coalesce(p_status->>'playback_state', ''), 32),
    'current_time',    case when jsonb_typeof(p_status->'current_time') = 'number' then greatest(0, least((p_status->>'current_time')::numeric, 86400)) else 0 end,
    'duration',        case when jsonb_typeof(p_status->'duration') = 'number' then greatest(0, least((p_status->>'duration')::numeric, 86400)) else 0 end,
    'muted',           case when jsonb_typeof(p_status->'muted') = 'boolean' then (p_status->>'muted')::boolean else false end,
    'volume',          case when jsonb_typeof(p_status->'volume') = 'number' then greatest(0, least((p_status->>'volume')::numeric, 100))::int else 0 end,
    'online',          case when jsonb_typeof(p_status->'online') = 'boolean' then (p_status->>'online')::boolean else true end,
    'error',           nullif(left(coalesce(p_status->>'error', ''), 300), ''),
    'source',          left(coalesce(p_status->>'source', ''), 64),
    'recovery_stage',  case when jsonb_typeof(p_status->'recovery_stage') = 'number' then greatest(0, least((p_status->>'recovery_stage')::numeric, 9))::int end,
    'playlist_video_ids', coalesce((
        select jsonb_agg(left(x.value, 64) order by x.ord)
          from jsonb_array_elements_text(case when jsonb_typeof(p_status->'playlist_video_ids') = 'array' then p_status->'playlist_video_ids' else '[]'::jsonb end) with ordinality as x(value, ord)
         where x.ord <= 20), '[]'::jsonb),
    'playlist_titles', coalesce((
        select jsonb_agg(left(x.value, 120) order by x.ord)
          from jsonb_array_elements_text(case when jsonb_typeof(p_status->'playlist_titles') = 'array' then p_status->'playlist_titles' else '[]'::jsonb end) with ordinality as x(value, ord)
         where x.ord <= 12), '[]'::jsonb),
    'playlist_count',  case when jsonb_typeof(p_status->'playlist_count') = 'number' then greatest(0, least((p_status->>'playlist_count')::numeric, 500))::int else 0 end,
    'current_index',   case when jsonb_typeof(p_status->'current_index') = 'number' then greatest(0, least((p_status->>'current_index')::numeric, 499))::int else 0 end,
    'next_title',      nullif(left(coalesce(p_status->>'next_title', ''), 160), ''),
    'app_version',     left(coalesce(p_status->>'app_version', ''), 24),
    'sync_revision',   nullif(left(coalesce(p_status->>'sync_revision', ''), 160), ''),
    'offline_cache_ready', case when jsonb_typeof(p_status->'offline_cache_ready')='boolean' then (p_status->>'offline_cache_ready')::boolean else false end,
    'offline_cache_count', case when jsonb_typeof(p_status->'offline_cache_count')='number' then greatest(0,least((p_status->>'offline_cache_count')::int,500)) else 0 end,
    'offline_cache_total', case when jsonb_typeof(p_status->'offline_cache_total')='number' then greatest(0,least((p_status->>'offline_cache_total')::int,500)) else 0 end,
    'offline_cache_error', nullif(left(coalesce(p_status->>'offline_cache_error',''),160),''),
    'active_hash',left(coalesce(p_status->>'active_hash',''),100),
    'pending_hash',left(coalesce(p_status->>'pending_hash',''),100),
    'pending_count',case when jsonb_typeof(p_status->'pending_count')='number' then greatest(0,least((p_status->>'pending_count')::int,500)) end,
    'pending_total',case when jsonb_typeof(p_status->'pending_total')='number' then greatest(0,least((p_status->>'pending_total')::int,500)) end,
    'storage_persisted',case when jsonb_typeof(p_status->'storage_persisted')='boolean' then (p_status->>'storage_persisted')::boolean end,
        'failed_videos',coalesce((select jsonb_agg(jsonb_build_object('id',left(coalesce(x.item->>'id',''),100),'title',left(coalesce(x.item->>'title',''),60),'code',left(coalesce(x.item->>'code',''),40))) from jsonb_array_elements(case when jsonb_typeof(p_status->'failed_videos')='array' then p_status->'failed_videos' else '[]'::jsonb end) with ordinality as x(item,ord) where x.ord<=5),'[]'::jsonb),
    'operating_active', case when jsonb_typeof(p_status->'operating_active')='boolean' then (p_status->>'operating_active')::boolean else true end,
    'priority', nullif(left(coalesce(p_status->>'priority',''),32),''),
    'update_pending_version', nullif(left(coalesce(p_status->>'update_pending_version',''),24),''),
    'update_error', nullif(left(coalesce(p_status->>'update_error',''),160),''),
    'failed_video_count', case when jsonb_typeof(p_status->'failed_video_count')='number' then greatest(0,least((p_status->>'failed_video_count')::int,500)) else 0 end,
    'synced_at',       v_synced
  )) || jsonb_build_object('reported_at', v_now);

  -- 재생 위치/보고 시각을 제외한 "의미 있는 변경" 지문
  v_fp := md5((v_clean - 'current_time' - 'reported_at' - 'pending_count')::text);

  select status_fp, last_seen_at into v_prev_fp, v_prev_seen
    from public.player_live_status where room_id = v_room;

  -- 같은 내용이 짧은 간격으로 반복되면 쓰기 생략 (오동작 플레이어 보호)
  if v_prev_fp is not distinct from v_fp and v_prev_seen is not null and v_prev_seen > v_now - interval '5 seconds' then
    return jsonb_build_object('ok', true, 'skipped', true, 'server_time', v_now);
  end if;

  insert into public.player_live_status as s (room_id, last_seen_at, player_status, updated_at, changed_at, status_fp)
  values (v_room, v_now, v_clean, v_now, v_now, v_fp)
  on conflict (room_id) do update set
    last_seen_at  = excluded.last_seen_at,
    player_status = excluded.player_status,
    updated_at    = excluded.updated_at,
    changed_at    = case when s.status_fp is distinct from excluded.status_fp then excluded.changed_at else coalesce(s.changed_at, excluded.changed_at) end,
    status_fp     = excluded.status_fp;

  return jsonb_build_object('ok', true, 'server_time', v_now);
end $$;
COMMIT;
