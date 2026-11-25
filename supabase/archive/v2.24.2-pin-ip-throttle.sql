-- =====================================================================
-- Clinic Signage v2.24.2 · PIN 무차별 대입 방어 보강 (권장)
--
-- 문제
--   기존 pin_login 은 브라우저가 보내는 p_client_id 기준으로만 5회 실패 잠금을 겁니다.
--   client_id 는 클라이언트가 마음대로 바꿀 수 있으므로, 요청마다 새 값을 보내면 잠금이 걸리지 않습니다.
--   스텝 PIN 4자리(1만 가지)는 수십 분 안에 전수 대입이 가능합니다.
--
-- 변경
--   - 기존 client_id 잠금(5회/5분)은 그대로 유지
--   - 요청 IP 기준 잠금 추가: 15분 안에 20회 실패 → 15분 잠금
--   - IP 헤더를 못 읽는 환경이면 'ip:unknown' 하나로 묶여 전역 잠금처럼 동작
--     (병원 내부 직원들은 보통 같은 공인 IP 를 쓰므로 정상 사용자의 오입력 몇 번은 영향 없음)
--   - PIN 원문/해시 처리, 세션 12시간, 반환 형식은 기존과 동일
--
-- 실행 전 현재 정의 백업:  select pg_get_functiondef('public.pin_login(text,text)'::regprocedure);
-- =====================================================================

create or replace function public.pin_request_ip()
returns text language sql stable security definer set search_path = public as $$
  select nullif(left(trim(coalesce(
           h->>'cf-connecting-ip',
           h->>'x-real-ip',
           split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1)
         )), 64), '')
    from (select coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb as h) x;
$$;
revoke all on function public.pin_request_ip() from public, anon, authenticated;

create or replace function public.pin_login(p_pin text, p_client_id text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_client text := left(trim(coalesce(p_client_id, '')), 100);
  v_ip_key text := 'ip:' || coalesce(public.pin_request_ip(), 'unknown');
  v_fail int := 0; v_locked timestamptz;
  v_ip_fail int := 0; v_ip_locked timestamptz; v_ip_updated timestamptz;
  v_account public.pin_accounts; v_token text; v_exp timestamptz;
  v_now timestamptz := clock_timestamp();
  c_ip_window constant interval := interval '15 minutes';
  c_ip_max constant int := 20;
begin
  if v_client = '' or v_client !~ '^[A-Za-z0-9._:-]{8,100}$' then return jsonb_build_object('ok', false, 'error', 'invalid_client'); end if;
  if p_pin !~ '^[0-9]{4,6}$' then return jsonb_build_object('ok', false, 'error', 'invalid_pin'); end if;

  -- IP 잠금
  select failed_count, locked_until, updated_at into v_ip_fail, v_ip_locked, v_ip_updated
    from public.pin_login_throttle where client_id = v_ip_key;
  if v_ip_locked is not null and v_ip_locked > v_now then
    return jsonb_build_object('ok', false, 'error', 'locked', 'retry_after_sec', greatest(1, ceil(extract(epoch from (v_ip_locked - v_now)))::int));
  end if;
  if v_ip_updated is null or v_ip_updated < v_now - c_ip_window then v_ip_fail := 0; end if;

  -- 기기(client_id) 잠금
  select failed_count, locked_until into v_fail, v_locked from public.pin_login_throttle where client_id = v_client;
  if v_locked is not null and v_locked > v_now then
    return jsonb_build_object('ok', false, 'error', 'locked', 'retry_after_sec', greatest(1, ceil(extract(epoch from (v_locked - v_now)))::int));
  end if;

  select a.* into v_account
    from public.pin_accounts a
   where a.enabled and crypt(p_pin, a.pin_hash) = a.pin_hash
   order by case a.role when 'admin' then 0 else 1 end
   limit 1;

  if not found then
    -- IP 카운터
    v_ip_fail := coalesce(v_ip_fail, 0) + 1;
    insert into public.pin_login_throttle(client_id, failed_count, locked_until, updated_at)
    values (v_ip_key, case when v_ip_fail >= c_ip_max then 0 else v_ip_fail end,
            case when v_ip_fail >= c_ip_max then v_now + c_ip_window end, v_now)
    on conflict (client_id) do update set failed_count = excluded.failed_count, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
    if v_ip_fail >= c_ip_max then
      return jsonb_build_object('ok', false, 'error', 'locked', 'retry_after_sec', extract(epoch from c_ip_window)::int);
    end if;

    -- 기기 카운터 (기존 동작)
    v_fail := coalesce(v_fail, 0) + 1;
    if v_fail >= 5 then
      insert into public.pin_login_throttle(client_id, failed_count, locked_until, updated_at)
      values (v_client, 0, v_now + interval '5 minutes', v_now)
      on conflict (client_id) do update set failed_count = 0, locked_until = excluded.locked_until, updated_at = v_now;
      return jsonb_build_object('ok', false, 'error', 'locked', 'retry_after_sec', 300);
    else
      insert into public.pin_login_throttle(client_id, failed_count, locked_until, updated_at)
      values (v_client, v_fail, null, v_now)
      on conflict (client_id) do update set failed_count = excluded.failed_count, locked_until = null, updated_at = v_now;
      return jsonb_build_object('ok', false, 'error', 'invalid_pin');
    end if;
  end if;

  delete from public.pin_login_throttle where client_id in (v_client, v_ip_key);
  delete from public.pin_login_throttle where locked_until is null and updated_at < v_now - interval '1 day';
  delete from public.pin_sessions where expires_at <= v_now;
  v_token := encode(gen_random_bytes(32), 'hex');
  v_exp := v_now + interval '12 hours';
  insert into public.pin_sessions(account_id, token_hash, expires_at) values (v_account.id, digest(v_token, 'sha256'), v_exp);
  return jsonb_build_object('ok', true, 'token', v_token, 'role', v_account.role, 'expires_at', v_exp);
end $$;
revoke all on function public.pin_login(text, text) from public;
grant execute on function public.pin_login(text, text) to anon, authenticated;
