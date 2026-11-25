-- Clinic Signage v2.35.86 — TV 연결 코드 보안·안정성, 기기 교체(인증 키 재발급), 내부 함수 권한 정리, DB 버전 확인
-- Safe to rerun. 기존 병원·TV·재생목록·영상 데이터는 변경하거나 삭제하지 않는다.
-- (진행 중이던 연결 코드 행에만 상태 컬럼이 추가된다. TV 인증 키는 관리자가 '기기 교체'를 실행할 때만 바뀐다.)
--
-- 연결 코드 상태
--   issued    : 설치형 플레이어가 코드 발급 (10분 유효)
--   approved  : 병원 관리자가 디스플레이에 연결 승인 (승인 시점부터 10분 안에 기기가 받아가야 함)
--   delivered : 기기가 인증 정보를 받아감 (같은 기기는 만료 전까지 몇 번이든 다시 받을 수 있음 → 네트워크 장애 재시도)
--   confirmed : 기기가 인증 정보를 저장했다고 확인 → 이후 이 코드로는 인증 정보를 받을 수 없음
--   (만료)    : expires_at 경과. 상태와 관계없이 사용 불가, 정리 대상
-- 인증 정보는 코드를 발급한 기기(기기ID + 코드 둘 다 일치)에게만 전달된다. 다른 기기는 받을 수 없다.

begin;

-- ---------- 1. 연결 코드 상태 컬럼 ----------
alter table public.player_pairing_codes add column if not exists status text not null default 'issued';
alter table public.player_pairing_codes add column if not exists approved_at timestamptz;
alter table public.player_pairing_codes add column if not exists delivered_at timestamptz;
alter table public.player_pairing_codes add column if not exists delivery_count integer not null default 0;
alter table public.player_pairing_codes add column if not exists confirmed_at timestamptz;
alter table public.player_pairing_codes add column if not exists replaced_key boolean not null default false;
update public.player_pairing_codes set status='approved', approved_at=coalesce(approved_at,paired_at) where room_id is not null and status='issued';
do $$
begin
  if not exists(select 1 from pg_constraint where conname='player_pairing_codes_status_check') then
    alter table public.player_pairing_codes add constraint player_pairing_codes_status_check
      check (status in ('issued','approved','delivered','confirmed'));
  end if;
end $$;
create index if not exists player_pairing_codes_room_idx on public.player_pairing_codes(room_id) where room_id is not null;

-- ---------- 2. 원자적 횟수 제한 도우미 ----------
-- 고정 창(window) 안의 횟수를 한 문장(upsert)으로 올리고 결과를 돌려준다. 동시 요청에도 누락되지 않는다.
create or replace function public.signage_throttle_hit(p_key text,p_window interval)
returns integer language sql security definer set search_path=public as $$
  insert into public.pin_login_throttle(client_id,failed_count,locked_until,updated_at)
  values(p_key,1,null,clock_timestamp())
  on conflict(client_id) do update set
    failed_count=case when public.pin_login_throttle.updated_at<clock_timestamp()-p_window then 1 else public.pin_login_throttle.failed_count+1 end,
    updated_at=case when public.pin_login_throttle.updated_at<clock_timestamp()-p_window then clock_timestamp() else public.pin_login_throttle.updated_at end
  returning failed_count
$$;
create or replace function public.signage_throttle_count(p_key text,p_window interval)
returns integer language sql stable security definer set search_path=public as $$
  select coalesce((select failed_count from public.pin_login_throttle where client_id=p_key and updated_at>=clock_timestamp()-p_window),0)
$$;
revoke all on function public.signage_throttle_hit(text,interval), public.signage_throttle_count(text,interval) from public, anon, authenticated;

create or replace function public.signage_pairing_cleanup()
returns void language sql security definer set search_path=public as $$
  delete from public.player_pairing_codes
   where (status<>'confirmed' and expires_at<clock_timestamp())
      or (status='confirmed' and confirmed_at<clock_timestamp()-interval '1 day')
$$;
revoke all on function public.signage_pairing_cleanup() from public, anon, authenticated;

-- ---------- 3. 플레이어: 코드 발급 ----------
create or replace function public.pairing_request(p_device_id text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  v_device text:=trim(coalesce(p_device_id,''));
  v_now timestamptz:=clock_timestamp();
  v_hits int; v_row public.player_pairing_codes; v_code text; i int;
begin
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

-- ---------- 4. 플레이어: 연결 확인 + 인증 정보 받기 ----------
-- 같은 기기는 만료 전까지 몇 번이든 다시 받을 수 있다(응답 유실 대비). 저장 확인(confirm) 후에는 받을 수 없다.
create or replace function public.pairing_poll(p_device_id text,p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_row public.player_pairing_codes; v_key uuid; v_name text; v_site text; v_now timestamptz:=clock_timestamp();
begin
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
  -- approved / delivered: 현재 TV 인증 키 전달 (승인 뒤 기기 교체가 일어났으면 새 키)
  select r.player_key,r.name,s.name into v_key,v_name,v_site from public.rooms r join public.sites s on s.id=r.site_id where r.id=v_row.room_id;
  if v_key is null then
    delete from public.player_pairing_codes where code=v_row.code;
    return jsonb_build_object('ok',true,'status','expired');
  end if;
  update public.player_pairing_codes set status='delivered',delivered_at=v_now,delivery_count=delivery_count+1 where code=v_row.code;
  return jsonb_build_object('ok',true,'status','paired','player_key',v_key,'room_name',v_name,'site_name',v_site,
    'ttl_sec',greatest(1,floor(extract(epoch from v_row.expires_at-v_now))::int));
end $$;

-- ---------- 5. 플레이어: 저장 완료 확인 ----------
create or replace function public.pairing_confirm(p_device_id text,p_code text,p_player_key uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_row public.player_pairing_codes; v_key uuid; v_site uuid; v_now timestamptz:=clock_timestamp();
begin
  if coalesce(p_device_id,'') !~ '^[A-Za-z0-9_-]{16,64}$' or coalesce(p_code,'') !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok',false,'error','invalid');
  end if;
  select * into v_row from public.player_pairing_codes where device_id=p_device_id and code=p_code for update;
  if v_row.code is null or v_row.status not in ('delivered','confirmed') then return jsonb_build_object('ok',false,'error','not_delivered'); end if;
  if v_row.status='confirmed' then return jsonb_build_object('ok',true,'status','confirmed'); end if; -- 재시도 허용
  if v_row.expires_at<=v_now then return jsonb_build_object('ok',false,'error','expired'); end if;
  select player_key,site_id into v_key,v_site from public.rooms where id=v_row.room_id;
  if v_key is null or v_key<>p_player_key then return jsonb_build_object('ok',false,'error','key_mismatch'); end if;
  update public.player_pairing_codes set status='confirmed',confirmed_at=v_now where code=v_row.code;
  insert into public.audit_log(site_id,actor_role,action,entity_type,entity_id,summary,after_state)
  values(v_site,null,'update','display',v_row.room_id::text,'설치형 플레이어 연결 완료(기기 저장 확인)',
         jsonb_build_object('delivery_count',v_row.delivery_count,'replaced_key',v_row.replaced_key));
  return jsonb_build_object('ok',true,'status','confirmed');
end $$;

-- ---------- 6. 관리자: 연결 승인 ----------
-- 2인자 버전은 실패 시 예외로 실패 횟수가 롤백되는 문제가 있어 제거한다. (예전 화면은 'DB 업데이트 필요'로 안내됨)
drop function if exists public.hospital_pair_display(uuid,text);
create or replace function public.hospital_pair_display(p_room uuid,p_code text,p_replace boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_site uuid; v_name text; v_code text:=regexp_replace(coalesce(p_code,''),'[^0-9]','','g');
  v_fail_key text; v_fails int; v_row public.player_pairing_codes; v_now timestamptz:=clock_timestamp();
begin
  select r.site_id,r.name into v_site,v_name from public.rooms r where r.id=p_room;
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

  if coalesce(p_replace,false) then
    update public.rooms set player_key=gen_random_uuid() where id=p_room;
    delete from public.player_pairing_codes where room_id=p_room and code<>v_code;
  end if;
  update public.player_pairing_codes
     set status='approved',room_id=p_room,approved_at=v_now,paired_at=v_now,
         expires_at=v_now+interval '10 minutes',replaced_key=coalesce(p_replace,false)
   where code=v_code;
  delete from public.pin_login_throttle where client_id=v_fail_key;
  perform public.audit_event(v_site,'update','display',p_room::text,
    case when coalesce(p_replace,false) then 'TV 연결 코드 승인 (기존 기기 해제·인증 키 교체)' else 'TV 연결 코드 승인' end,
    null,jsonb_build_object('room',v_name,'replace',coalesce(p_replace,false)));
  return jsonb_build_object('ok',true,'room_name',v_name,'replaced',coalesce(p_replace,false));
end $$;

-- ---------- 7. 관리자: 기존 기기 연결 해제 (인증 키 교체) ----------
-- 이전 키로는 상태 조회·보고·영상 목록 조회가 모두 거부된다 (모든 플레이어 함수가 rooms.player_key로 찾기 때문).
create or replace function public.hospital_reset_display_key(p_room uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_site uuid; v_name text;
begin
  select site_id,name into v_site,v_name from public.rooms where id=p_room;
  if v_site is null then return jsonb_build_object('ok',false,'error','room_not_found','message','디스플레이를 찾을 수 없습니다.'); end if;
  if not public.can_manage_site(v_site) then raise exception 'not allowed' using errcode='42501'; end if;
  update public.rooms set player_key=gen_random_uuid() where id=p_room;
  delete from public.player_pairing_codes where room_id=p_room and status<>'confirmed';
  perform public.audit_event(v_site,'update','display',p_room::text,'기존 TV 기기 연결 해제 (인증 키 교체)',null,jsonb_build_object('room',v_name));
  return jsonb_build_object('ok',true,'room_name',v_name);
end $$;

-- 관리자 화면 표시용: 이 디스플레이의 마지막 설치형 플레이어 연결
create or replace function public.hospital_display_pairing_info(p_room uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_site uuid; v_row record;
begin
  select site_id into v_site from public.rooms where id=p_room;
  if v_site is null or not public.can_manage_site(v_site) then raise exception 'not allowed' using errcode='42501'; end if;
  select status,approved_at,confirmed_at,expires_at,replaced_key into v_row
    from public.player_pairing_codes where room_id=p_room order by approved_at desc nulls last limit 1;
  return jsonb_build_object('status',v_row.status,'approved_at',v_row.approved_at,'confirmed_at',v_row.confirmed_at,
                            'expires_at',v_row.expires_at,'replaced_key',v_row.replaced_key);
end $$;

revoke all on function public.pairing_request(text), public.pairing_poll(text,text), public.pairing_confirm(text,text,uuid),
  public.hospital_pair_display(uuid,text,boolean), public.hospital_reset_display_key(uuid), public.hospital_display_pairing_info(uuid) from public;
grant execute on function public.pairing_request(text), public.pairing_poll(text,text), public.pairing_confirm(text,text,uuid),
  public.hospital_pair_display(uuid,text,boolean), public.hospital_reset_display_key(uuid), public.hospital_display_pairing_info(uuid) to anon,authenticated;

-- ---------- 8. DB 버전 확인 (관리자 화면이 호환 여부를 판단) ----------
create or replace function public.app_db_version()
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('version','2.35.86','features',jsonb_build_array('pairing_v2','display_key_reset'))
$$;
revoke all on function public.app_db_version() from public;
grant execute on function public.app_db_version() to anon,authenticated;

-- ---------- 9. 내부 전용 함수의 외부 호출 차단 ----------
-- 화면·API·TV가 직접 호출하지 않고, 보안 정의(security definer) 함수와 트리거 안에서만 쓰는 함수.
-- 트리거 함수는 실행 권한과 무관하게 동작하고, 보안 정의 함수 안에서의 호출은 소유자 권한으로 실행된다.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and (pg_get_function_result(p.oid)='trigger'
            or p.proname in ('apply_room_video_rules','audit_event','hospital_display_slot_key',
                             'room_operating_status','room_operating_window','signage_operating_window',
                             'signage_room_operating_status','signage_room_operating_window','site_operating_config',
                             'player_get_state_operating','signal_site_rooms_internal'))
       and not exists(select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

insert into public.schema_version(version,applied_at) values('2.35.86',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
commit;
