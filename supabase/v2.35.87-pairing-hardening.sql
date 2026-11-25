-- v2.35.87: persistent pairing ownership, credential snapshots, status reset.
-- Apply after v2.35.86. Existing playback keys are NOT rotated by migration.
begin;
-- 2.35.86이 먼저 적용되어 있어야 한다 (연결 코드 상태 컬럼·보조 함수 의존).
do $$ begin
  if not exists(select 1 from public.schema_version where version='2.35.86') then
    raise exception '먼저 supabase/v2.35.86-pairing-hardening.sql을 실행한 뒤 이 파일을 실행하세요.';
  end if;
end $$;
alter table public.player_pairing_codes add column if not exists approved_key uuid;
create table if not exists public.display_pairing_owner (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  device_id text not null,
  player_key uuid not null,
  approved_at timestamptz not null default clock_timestamp()
);
alter table public.display_pairing_owner enable row level security;
revoke all on public.display_pairing_owner from public, anon, authenticated;
-- Serialize short pairing transactions (not playback/reporting). Consistent lock order.
select pg_advisory_xact_lock(hashtext('signage-pairing-v3'));
-- Preserve existing keys; old approvals without a trustworthy snapshot must not deliver a key.
do $$ begin
  if not exists(select 1 from public.schema_version where version='2.35.87') then
    insert into public.display_pairing_owner(room_id,device_id,player_key,approved_at)
      select distinct on (c.room_id) c.room_id,c.device_id,r.player_key,coalesce(c.approved_at,c.paired_at,clock_timestamp())
      from public.player_pairing_codes c join public.rooms r on r.id=c.room_id
      where c.status in ('approved','delivered','confirmed')
      order by c.room_id,c.approved_at desc nulls last,c.code
      on conflict(room_id) do nothing;
    delete from public.player_pairing_codes where status in ('approved','delivered');
    -- Confirmed rows may acknowledge retries only if the supplied key still matches.
    update public.player_pairing_codes c set approved_key=o.player_key
      from public.display_pairing_owner o where c.room_id=o.room_id and c.device_id=o.device_id and c.status='confirmed';
  end if;
end $$;
-- Reset current status while preserving playlists, patients and historical events.
-- A tombstone is needed because incremental live polling otherwise retains the old status.
create or replace function public.signage_reset_pairing_status(p_room uuid)
returns void language plpgsql security definer set search_path=public as $$
declare t timestamptz:=clock_timestamp();
begin
  update public.rooms set last_seen_at=null,player_status='{}'::jsonb where id=p_room;
  insert into public.player_live_status(room_id,last_seen_at,player_status,updated_at,changed_at,status_fp)
  values(p_room,t,'{"pairing_reset":true}'::jsonb,t,t,'pairing_reset')
  on conflict(room_id) do update set last_seen_at=excluded.last_seen_at,player_status=excluded.player_status,
    updated_at=excluded.updated_at,changed_at=excluded.changed_at,status_fp=excluded.status_fp;
end $$;
revoke all on function public.signage_reset_pairing_status(uuid) from public,anon,authenticated;
-- Preserve deployed report implementations; serialize key lookup with key rotation.
-- Abort transaction if a deployed signature/body is unexpected rather than silently weakening it.
do $$
declare f regprocedure; src text; patched text;
begin
  foreach f in array array['public.player_report(uuid,jsonb)'::regprocedure,'public.player_live_ping(uuid,jsonb)'::regprocedure] loop
    src:=pg_get_functiondef(f);
    patched:=regexp_replace(src,'(where player_key[[:space:]]*=[[:space:]]*p_key)[[:space:]]*;', '\1 for share;', 'i');
    if patched=src and src !~* 'where player_key[[:space:]]*=[[:space:]]*p_key[[:space:]]+for (share|update)' then
      raise exception 'Unexpected report function: %', f;
    end if;
    if patched<>src then execute patched; end if;
  end loop;
end $$;
create or replace function public.pairing_request(p_device_id text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  v_device text:=trim(coalesce(p_device_id,''));
  v_now timestamptz:=clock_timestamp();
  v_hits int; v_row public.player_pairing_codes; v_code text; i int;
begin
  perform pg_advisory_xact_lock(hashtext('signage-pairing-v3'));
  v_now:=clock_timestamp();
  if v_device !~ '^[A-Za-z0-9_-]{16,64}$' then return jsonb_build_object('ok',false,'error','invalid_device'); end if;
  -- 같은 IP 10분에 60회 (병원 한 곳에서 여러 대를 동시에 설치해도 충분). 원자적으로 센다.
  v_hits:=public.signage_throttle_hit('pair:'||coalesce(public.pin_request_ip(),'unknown'),interval '10 minutes');
  if v_hits>60 then return jsonb_build_object('ok',false,'error','rate_limited','retry_after_sec',600); end if;

  perform public.signage_pairing_cleanup();
  -- 같은 기기의 요청은 순서대로 처리 (동시 요청으로 코드가 두 개 생기지 않게)
  perform pg_advisory_xact_lock(hashtext('signage-pair-device:'||v_device));

  select * into v_row from public.player_pairing_codes where device_id=v_device;
  if v_row.code is not null and v_row.status<>'confirmed' and v_row.expires_at>v_now then
    return jsonb_build_object('ok',true,'code',v_row.code,'status',v_row.status,
      'ttl_sec',greatest(1,floor(extract(epoch from v_row.expires_at-v_now))::int));
  end if;
  delete from public.player_pairing_codes where device_id=v_device;

  for i in 1..30 loop
    v_code:=lpad(((('x'||encode(gen_random_bytes(4),'hex'))::bit(32)::bigint)%1000000)::text,6,'0');
    begin
      insert into public.player_pairing_codes(code,device_id,status,expires_at) values(v_code,v_device,'issued',v_now+interval '10 minutes');
      return jsonb_build_object('ok',true,'code',v_code,'status','issued','ttl_sec',600);
    exception when unique_violation then null; -- 코드 충돌 → 다시 뽑기
    end;
  end loop;
  return jsonb_build_object('ok',false,'error','busy','retry_after_sec',10);
end $$;

create or replace function public.pairing_poll(p_device_id text,p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_row public.player_pairing_codes; v_key uuid; v_name text; v_site text; v_now timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtext('signage-pairing-v3'));
  v_now:=clock_timestamp();
  if coalesce(p_device_id,'') !~ '^[A-Za-z0-9_-]{16,64}$' or coalesce(p_code,'') !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok',true,'status','expired');
  end if;
  select * into v_row from public.player_pairing_codes where device_id=p_device_id and code=p_code for update;
  if v_row.code is null then return jsonb_build_object('ok',true,'status','expired'); end if;
  if v_row.status='confirmed' then return jsonb_build_object('ok',true,'status','confirmed'); end if;
  if v_row.expires_at<=v_now then
    delete from public.player_pairing_codes where code=v_row.code;
    return jsonb_build_object('ok',true,'status','expired');
  end if;
  if v_row.status='issued' then
    return jsonb_build_object('ok',true,'status','pending','ttl_sec',greatest(1,floor(extract(epoch from v_row.expires_at-v_now))::int));
  end if;
  -- Only the credential snapshot approved for this device may be delivered.
  select r.player_key,r.name,s.name into v_key,v_name,v_site from public.rooms r join public.sites s on s.id=r.site_id where r.id=v_row.room_id;
  if v_key is null or v_row.approved_key is distinct from v_key or not exists(select 1 from public.display_pairing_owner o where o.room_id=v_row.room_id and o.device_id=p_device_id and o.player_key=v_key) then
    delete from public.player_pairing_codes where code=v_row.code;
    return jsonb_build_object('ok',true,'status','expired');
  end if;
  update public.player_pairing_codes set status='delivered',delivered_at=v_now,delivery_count=delivery_count+1 where code=v_row.code;
  return jsonb_build_object('ok',true,'status','paired','player_key',v_key,'room_name',v_name,'site_name',v_site,
    'ttl_sec',greatest(1,floor(extract(epoch from v_row.expires_at-v_now))::int));
end $$;

create or replace function public.pairing_confirm(p_device_id text,p_code text,p_player_key uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_row public.player_pairing_codes; v_key uuid; v_site uuid; v_now timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtext('signage-pairing-v3'));
  v_now:=clock_timestamp();
  if coalesce(p_device_id,'') !~ '^[A-Za-z0-9_-]{16,64}$' or coalesce(p_code,'') !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok',false,'error','invalid');
  end if;
  select * into v_row from public.player_pairing_codes where device_id=p_device_id and code=p_code for update;
  if v_row.code is null or v_row.status not in ('delivered','confirmed') then return jsonb_build_object('ok',false,'error','not_delivered'); end if;
  select player_key,site_id into v_key,v_site from public.rooms where id=v_row.room_id;
  if v_key is null or v_key is distinct from p_player_key or v_row.approved_key is distinct from v_key or not exists(select 1 from public.display_pairing_owner o where o.room_id=v_row.room_id and o.device_id=p_device_id and o.player_key=v_key) then return jsonb_build_object('ok',false,'error','key_mismatch'); end if;
  if v_row.status='confirmed' then return jsonb_build_object('ok',true,'status','confirmed'); end if;
  if v_row.expires_at<=v_now then return jsonb_build_object('ok',false,'error','expired'); end if;
  update public.player_pairing_codes set status='confirmed',confirmed_at=v_now where code=v_row.code;
  insert into public.audit_log(site_id,actor_role,action,entity_type,entity_id,summary,after_state)
  values(v_site,null,'update','display',v_row.room_id::text,'설치형 플레이어 연결 완료(기기 저장 확인)',
         jsonb_build_object('delivery_count',v_row.delivery_count,'replaced_key',v_row.replaced_key));
  return jsonb_build_object('ok',true,'status','confirmed');
end $$;

create or replace function public.hospital_pair_display(p_room uuid,p_code text,p_replace boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_site uuid; v_name text; v_code text:=regexp_replace(coalesce(p_code,''),'[^0-9]','','g');
  v_existing boolean; v_key uuid; v_fail_key text; v_fails int; v_row public.player_pairing_codes; v_now timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtext('signage-pairing-v3'));
  v_now:=clock_timestamp();
  select r.site_id,r.name into v_site,v_name from public.rooms r where r.id=p_room for update;
  if v_site is null then return jsonb_build_object('ok',false,'error','room_not_found','message','디스플레이를 찾을 수 없습니다.'); end if;
  if not public.can_manage_site(v_site) then raise exception 'not allowed' using errcode='42501'; end if;

  -- 병원 단위로 순서대로 처리 → 동시 오입력도 정확히 센다
  perform pg_advisory_xact_lock(hashtext('signage-pairfail:'||v_site::text));
  v_fail_key:='pairfail:'||v_site::text;
  v_fails:=public.signage_throttle_count(v_fail_key,interval '10 minutes');
  if v_fails>=10 then
    return jsonb_build_object('ok',false,'error','locked','retry_after_sec',600,
      'message','연결 코드를 여러 번 잘못 입력했습니다. 10분 후 다시 시도하세요.');
  end if;
  if v_code !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok',false,'error','invalid_format','message','TV 화면에 표시된 6자리 숫자를 입력하세요.');
  end if;

  select * into v_row from public.player_pairing_codes where code=v_code for update;
  if v_row.code is null or v_row.status<>'issued' or v_row.expires_at<=v_now then
    v_fails:=public.signage_throttle_hit(v_fail_key,interval '10 minutes'); -- 예외를 던지지 않으므로 기록이 유지된다
    return jsonb_build_object('ok',false,'error','invalid_code','remaining',greatest(0,10-v_fails),
      'message',case when v_fails>=10 then '연결 코드를 여러 번 잘못 입력했습니다. 10분 후 다시 시도하세요.'
                     else '연결 코드가 없거나 만료되었습니다. TV 화면의 코드를 다시 확인하세요. (남은 시도 '||greatest(0,10-v_fails)||'회)' end);
  end if;

  -- DB ownership survives code cleanup and does not depend on a first heartbeat.
  v_existing:=exists(select 1 from public.display_pairing_owner where room_id=p_room)
    or exists(select 1 from public.rooms where id=p_room and last_seen_at is not null)
    or exists(select 1 from public.player_live_status where room_id=p_room and not coalesce(player_status->>'pairing_reset'='true',false));
  if v_existing and not coalesce(p_replace,false) then
    return jsonb_build_object('ok',false,'error','replace_required','message','기존 연결이 있습니다. 기기 교체를 승인하세요.');
  end if;
  -- Rotate on EVERY new approval, including first setup, to invalidate any unreported legacy URL.
  update public.rooms set player_key=gen_random_uuid() where id=p_room returning player_key into v_key;
  delete from public.player_pairing_codes where room_id=p_room and code<>v_code;
  insert into public.display_pairing_owner(room_id,device_id,player_key,approved_at)
    values(p_room,v_row.device_id,v_key,v_now)
    on conflict(room_id) do update set device_id=excluded.device_id,player_key=excluded.player_key,approved_at=excluded.approved_at;
  perform public.signage_reset_pairing_status(p_room);
  update public.player_pairing_codes
     set status='approved',approved_key=v_key,room_id=p_room,approved_at=v_now,paired_at=v_now,
         expires_at=v_now+interval '10 minutes',replaced_key=coalesce(p_replace,false)
   where code=v_code;
  delete from public.pin_login_throttle where client_id=v_fail_key;
  perform public.audit_event(v_site,'update','display',p_room::text,
    case when coalesce(p_replace,false) then 'TV 연결 코드 승인 (기존 기기 해제·인증 키 교체)' else 'TV 연결 코드 승인' end,
    null,jsonb_build_object('room',v_name,'replace',coalesce(p_replace,false)));
  return jsonb_build_object('ok',true,'room_name',v_name,'replaced',coalesce(p_replace,false));
end $$;

create or replace function public.hospital_reset_display_key(p_room uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_site uuid; v_name text;
begin
  perform pg_advisory_xact_lock(hashtext('signage-pairing-v3'));
    select site_id,name into v_site,v_name from public.rooms where id=p_room for update;
  if v_site is null then return jsonb_build_object('ok',false,'error','room_not_found','message','디스플레이를 찾을 수 없습니다.'); end if;
  if not public.can_manage_site(v_site) then raise exception 'not allowed' using errcode='42501'; end if;
  update public.rooms set player_key=gen_random_uuid() where id=p_room;
  delete from public.player_pairing_codes where room_id=p_room;
  delete from public.display_pairing_owner where room_id=p_room;
  perform public.signage_reset_pairing_status(p_room);
  perform public.audit_event(v_site,'update','display',p_room::text,'기존 TV 기기 연결 해제 (인증 키 교체)',null,jsonb_build_object('room',v_name));
  return jsonb_build_object('ok',true,'room_name',v_name);
end $$;

create or replace function public.hospital_display_pairing_info(p_room uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_site uuid; v_row record;
begin
  select site_id into v_site from public.rooms where id=p_room;
  if v_site is null or not public.can_manage_site(v_site) then raise exception 'not allowed' using errcode='42501'; end if;
  select status,approved_at,confirmed_at,expires_at,replaced_key into v_row
    from public.player_pairing_codes where room_id=p_room order by approved_at desc nulls last limit 1;
  return jsonb_build_object('has_owner',exists(select 1 from public.display_pairing_owner where room_id=p_room),'status',v_row.status,'approved_at',v_row.approved_at,'confirmed_at',v_row.confirmed_at,
                            'expires_at',v_row.expires_at,'replaced_key',v_row.replaced_key);
end $$;
create or replace function public.app_db_version()
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('version','2.35.87','features',jsonb_build_array('pairing_v2','display_key_reset','pairing_v3'))
$$;
insert into public.schema_version(version,applied_at) values('2.35.87',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
commit;
