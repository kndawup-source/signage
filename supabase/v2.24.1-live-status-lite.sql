-- =====================================================================
-- Clinic Signage v2.24.1 · 저비용 송출 상태 확인 (Realtime 상태 브로드캐스트 제거)
--
-- 바뀌는 점
--   1) player_report         : 플레이어 상태 보고 (이벤트 시 + 60초 presence). 화이트리스트/크기 제한,
--                              변경 지문(status_fp)으로 "실제 변경" 시각(changed_at)만 갱신.
--   2) signage_live_status   : 관리자/스텝용 상태 조회. p_since 이후 변경된 행만 반환 + 전체 last_seen 목록.
--                              PIN 세션 검증(is_member). 관리자 송출 확인(ack)과 30초 delta 조회에 사용.
--   3) player_get_state_lite : player_get_state 결과에서 썸네일(base64)을 제거해 플레이어 egress 절감.
--   4) player_live_status 를 supabase_realtime publication 에서 제외 (더 이상 구독자가 없음).
--
-- 안전성
--   - 기존 함수(player_get_state, player_live_ping, player_heartbeat, signal_signage_rooms)는 수정하지 않습니다.
--   - 프론트엔드는 새 함수가 없으면 기존 함수로 자동 fallback 하므로, SQL/프론트 배포 순서는 무관합니다.
--   - 여러 번 실행해도 안전합니다.
-- =====================================================================

-- 1. player_live_status: 기존 테이블을 유지하면서 필요한 컬럼만 보강 --------------------------------
create table if not exists public.player_live_status (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  last_seen_at timestamptz,
  player_status jsonb,
  updated_at timestamptz not null default now()
);
alter table public.player_live_status add column if not exists last_seen_at timestamptz;
alter table public.player_live_status add column if not exists player_status jsonb;
alter table public.player_live_status add column if not exists updated_at timestamptz default now();
alter table public.player_live_status add column if not exists changed_at timestamptz;
alter table public.player_live_status add column if not exists status_fp text;
create unique index if not exists player_live_status_room_uidx on public.player_live_status(room_id);
create index if not exists player_live_status_changed_idx on public.player_live_status(changed_at);
update public.player_live_status
   set changed_at = coalesce(updated_at, last_seen_at, now()),
       player_status = case when player_status ? 'thumbnail' then player_status - 'thumbnail' else player_status end
 where changed_at is null or player_status ? 'thumbnail';

alter table public.player_live_status enable row level security;
drop policy if exists player_live_status_member_select on public.player_live_status;
create policy player_live_status_member_select on public.player_live_status
  for select to anon, authenticated using (public.is_member());
grant select on public.player_live_status to anon, authenticated;

-- 2. 플레이어 상태 보고 ------------------------------------------------------------------------------
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
    'synced_at',       v_synced
  )) || jsonb_build_object('reported_at', v_now);

  -- 재생 위치/보고 시각을 제외한 "의미 있는 변경" 지문
  v_fp := md5((v_clean - 'current_time' - 'reported_at')::text);

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
revoke all on function public.player_report(uuid, jsonb) from public;
grant execute on function public.player_report(uuid, jsonb) to anon, authenticated;

-- 3. 관리자/스텝 상태 조회 (delta + ack) ---------------------------------------------------------------
create or replace function public.signage_live_status(p_room_ids uuid[] default null, p_since timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.is_member(), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'server_time', clock_timestamp(),
    'seen', coalesce((
      select jsonb_agg(jsonb_build_object('room_id', s.room_id, 'last_seen_at', s.last_seen_at))
        from public.player_live_status s
       where p_room_ids is null or s.room_id = any(p_room_ids)), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'room_id', s.room_id,
               'last_seen_at', s.last_seen_at,
               'player_status', coalesce(s.player_status, '{}'::jsonb) - 'thumbnail',
               'changed_at', coalesce(s.changed_at, s.updated_at, s.last_seen_at)))
        from public.player_live_status s
       where (p_room_ids is null or s.room_id = any(p_room_ids))
         and (p_since is null or coalesce(s.changed_at, s.updated_at, s.last_seen_at) > p_since)), '[]'::jsonb)
  );
end $$;
revoke all on function public.signage_live_status(uuid[], timestamptz) from public;
grant execute on function public.signage_live_status(uuid[], timestamptz) to anon, authenticated;

-- 4. 플레이어용 상태 (썸네일 제거) -------------------------------------------------------------------
create or replace function public.player_get_state_lite(p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s jsonb;
begin
  s := public.player_get_state(p_key);
  if s is null then return null; end if;
  return s || jsonb_build_object(
    'playlist', coalesce((
      select jsonb_agg(case when jsonb_typeof(x.e) = 'object' then x.e - 'thumbnail' else x.e end order by x.o)
        from jsonb_array_elements(case when jsonb_typeof(s->'playlist') = 'array' then s->'playlist' else '[]'::jsonb end) with ordinality as x(e, o)
    ), '[]'::jsonb),
    'emergency_video', case when jsonb_typeof(s->'emergency_video') = 'object' then (s->'emergency_video') - 'thumbnail' else coalesce(s->'emergency_video', 'null'::jsonb) end
  );
end $$;
revoke all on function public.player_get_state_lite(uuid) from public;
grant execute on function public.player_get_state_lite(uuid) to anon, authenticated;

-- 5. Realtime publication 정리 ----------------------------------------------------------------------
-- 플레이어 상태는 더 이상 postgres_changes 로 구독하지 않습니다. 보고 1회마다 생기던 WAL 디코딩/RLS 평가 제거.
do $$
begin
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'player_live_status') then
    alter publication supabase_realtime drop table public.player_live_status;
  end if;
end $$;

-- 참고(선택): rooms 는 player_heartbeat 가 60초마다 갱신하지만, 관리자 화면의 rooms postgres_changes 구독은
-- PIN 세션 RLS(is_admin) 때문에 Realtime 에서 통과하지 못해 실제로 전달되지 않았습니다. v2.24 프론트는 rooms 를
-- 구독하지 않으므로 아래를 실행해도 됩니다. 플레이어 깨우기는 room:{key} realtime.send 트리거가 담당합니다.
-- alter publication supabase_realtime drop table public.rooms;
