-- Clinic Signage v2.35.85 — TV 연결 코드(페어링)
-- Safe to rerun. 기존 데이터 변경 없음 (테이블 1개 + 함수 3개 추가).
--
-- 흐름
--   1) 설치형 플레이어가 처음 켜지면 pairing_request(기기ID) → 6자리 코드를 TV 화면에 크게 표시
--   2) 병원 관리자가 디스플레이 설정에서 그 코드를 입력 → hospital_pair_display(디스플레이, 코드)
--   3) 플레이어가 pairing_poll(기기ID, 코드)로 확인 → 그 디스플레이의 player_key를 받아 송출 시작
-- player_key는 코드를 만든 기기(기기ID+코드 둘 다 일치)에게만, 한 번만 전달된다.

begin;

create table if not exists public.player_pairing_codes (
  code text primary key check (code ~ '^[0-9]{6}$'),
  device_id text not null unique check (device_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  room_id uuid references public.rooms(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  paired_at timestamptz
);
create index if not exists player_pairing_codes_expires_idx on public.player_pairing_codes(expires_at);
alter table public.player_pairing_codes enable row level security;
revoke all on table public.player_pairing_codes from public, anon, authenticated;

-- 플레이어: 연결 코드 발급 (같은 기기는 만료 전까지 같은 코드)
create or replace function public.pairing_request(p_device_id text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  v_device text:=trim(coalesce(p_device_id,''));
  v_now timestamptz:=clock_timestamp();
  v_ip_key text:='pair:'||coalesce(public.pin_request_ip(),'unknown');
  v_count int; v_updated timestamptz;
  v_row public.player_pairing_codes;
  v_code text; i int;
begin
  if v_device !~ '^[A-Za-z0-9_-]{16,64}$' then return jsonb_build_object('ok',false,'error','invalid_device'); end if;

  -- 같은 IP에서 10분에 60회까지 (병원 한 곳에서 TV 여러 대를 동시에 설치해도 충분)
  select failed_count,updated_at into v_count,v_updated from public.pin_login_throttle where client_id=v_ip_key;
  if v_updated is null or v_updated<v_now-interval '10 minutes' then v_count:=0; end if;
  if v_count>=60 then return jsonb_build_object('ok',false,'error','rate_limited','retry_after_sec',600); end if;
  insert into public.pin_login_throttle(client_id,failed_count,locked_until,updated_at) values(v_ip_key,v_count+1,null,case when v_count=0 then v_now else coalesce(v_updated,v_now) end)
  on conflict(client_id) do update set failed_count=excluded.failed_count,updated_at=excluded.updated_at;

  delete from public.player_pairing_codes where expires_at<v_now;

  select * into v_row from public.player_pairing_codes where device_id=v_device;
  if v_row.code is not null and v_row.room_id is null then
    return jsonb_build_object('ok',true,'code',v_row.code,'expires_at',v_row.expires_at,'ttl_sec',greatest(1,floor(extract(epoch from v_row.expires_at-v_now))::int));
  end if;
  if v_row.code is not null then
    -- 이미 연결된 코드: 플레이어가 poll로 받아가야 함
    return jsonb_build_object('ok',true,'code',v_row.code,'expires_at',v_row.expires_at,'ttl_sec',greatest(1,floor(extract(epoch from v_row.expires_at-v_now))::int),'paired',true);
  end if;

  for i in 1..30 loop
    v_code:=lpad(((('x'||encode(gen_random_bytes(4),'hex'))::bit(32)::bigint)%1000000)::text,6,'0');
    begin
      insert into public.player_pairing_codes(code,device_id,expires_at) values(v_code,v_device,v_now+interval '10 minutes');
      return jsonb_build_object('ok',true,'code',v_code,'expires_at',v_now+interval '10 minutes','ttl_sec',600);
    exception when unique_violation then
      -- 코드 충돌이면 다시 뽑기. 기기ID 충돌(동시 요청)이면 기존 코드 반환
      select * into v_row from public.player_pairing_codes where device_id=v_device;
      if v_row.code is not null then
        return jsonb_build_object('ok',true,'code',v_row.code,'expires_at',v_row.expires_at,'ttl_sec',greatest(1,floor(extract(epoch from v_row.expires_at-v_now))::int));
      end if;
    end;
  end loop;
  return jsonb_build_object('ok',false,'error','busy');
end $$;

-- 플레이어: 연결 여부 확인. 연결되면 player_key를 한 번만 전달하고 코드 삭제
create or replace function public.pairing_poll(p_device_id text,p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_row public.player_pairing_codes; v_key uuid; v_name text; v_site text;
begin
  if coalesce(p_device_id,'') !~ '^[A-Za-z0-9_-]{16,64}$' or coalesce(p_code,'') !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok',false,'status','expired');
  end if;
  select * into v_row from public.player_pairing_codes where device_id=p_device_id and code=p_code;
  if v_row.code is null then return jsonb_build_object('ok',true,'status','expired'); end if;
  if v_row.room_id is null then
    if v_row.expires_at<clock_timestamp() then
      delete from public.player_pairing_codes where code=v_row.code;
      return jsonb_build_object('ok',true,'status','expired');
    end if;
    return jsonb_build_object('ok',true,'status','pending','ttl_sec',greatest(1,floor(extract(epoch from v_row.expires_at-clock_timestamp()))::int));
  end if;
  select r.player_key,r.name,s.name into v_key,v_name,v_site from public.rooms r left join public.sites s on s.id=r.site_id where r.id=v_row.room_id;
  delete from public.player_pairing_codes where code=v_row.code;
  if v_key is null then return jsonb_build_object('ok',true,'status','expired'); end if;
  return jsonb_build_object('ok',true,'status','paired','player_key',v_key,'room_name',v_name,'site_name',v_site);
end $$;

-- 병원 관리자/슈퍼어드민: TV 화면의 코드를 입력해 디스플레이에 연결
create or replace function public.hospital_pair_display(p_room uuid,p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_site uuid; v_name text; v_code text:=regexp_replace(coalesce(p_code,''),'[^0-9]','','g');
  v_fail_key text; v_fail int; v_updated timestamptz; v_now timestamptz:=clock_timestamp(); v_device text;
begin
  select r.site_id,r.name into v_site,v_name from public.rooms r where r.id=p_room;
  if v_site is null then raise exception '디스플레이를 찾을 수 없습니다'; end if;
  if not public.can_manage_site(v_site) then raise exception 'not allowed'; end if;
  if v_code !~ '^[0-9]{6}$' then raise exception 'TV 화면의 6자리 숫자를 입력하세요'; end if;

  -- 잘못된 코드 반복 입력 제한 (병원당 10분에 10회)
  v_fail_key:='pairfail:'||v_site::text;
  select failed_count,updated_at into v_fail,v_updated from public.pin_login_throttle where client_id=v_fail_key;
  if v_updated is null or v_updated<v_now-interval '10 minutes' then v_fail:=0; end if;
  if v_fail>=10 then raise exception '연결 코드를 여러 번 잘못 입력했습니다. 10분 후 다시 시도하세요'; end if;

  update public.player_pairing_codes set room_id=p_room,paired_at=v_now
   where code=v_code and room_id is null and expires_at>v_now
  returning device_id into v_device;
  if v_device is null then
    insert into public.pin_login_throttle(client_id,failed_count,locked_until,updated_at) values(v_fail_key,v_fail+1,null,case when v_fail=0 then v_now else v_updated end)
    on conflict(client_id) do update set failed_count=excluded.failed_count,updated_at=excluded.updated_at;
    raise exception '연결 코드가 없거나 만료되었습니다. TV 화면의 코드를 다시 확인하세요';
  end if;
  delete from public.pin_login_throttle where client_id=v_fail_key;
  perform public.audit_event(v_site,'update','display',p_room::text,'TV 연결 코드로 플레이어 연결',null,jsonb_build_object('room',v_name));
  return jsonb_build_object('ok',true,'room_name',v_name);
end $$;

revoke all on function public.pairing_request(text), public.pairing_poll(text,text), public.hospital_pair_display(uuid,text) from public;
grant execute on function public.pairing_request(text), public.pairing_poll(text,text), public.hospital_pair_display(uuid,text) to anon,authenticated;

insert into public.schema_version(version,applied_at) values('2.35.85',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
commit;
