-- Clinic Signage v2.35.84 — 로그인 반복 시도 차단 강화 + 병원 PIN 설정 속도 개선
-- Safe to rerun. 데이터 삭제 없음 (함수 2개 교체 + schema_version 기록).
--
-- 1) pin_login
--    - 병원 주소(?site=코드)로 로그인 → 그 병원 관리자 PIN만 검사
--      기본 주소(병원 코드 없음)      → 슈퍼어드민 PIN만 검사
--      (이전에는 병원 주소에서도 슈퍼어드민 PIN을 먼저 검사해서, 병원 주소 100곳이 모두
--       슈퍼어드민 PIN을 대입해 볼 수 있는 통로였음)
--    - 계정(범위)별 잠금 추가: 같은 대상에 15분 안에 10번 틀리면 15분 잠금.
--      기존 기기 ID(p_client_id)·IP 잠금은 둘 다 요청자가 바꿀 수 있어서 우회 가능했음.
--      PIN 자리수 정책은 그대로.
-- 2) admin_set_site_staff_pin
--    - "다른 병원에서 사용 중인 PIN" 검사 제거. 로그인이 병원 코드로 분리되어 있어 PIN이 겹쳐도 문제가 없고,
--      이 검사는 모든 병원 계정에 bcrypt를 한 번씩 돌려서 병원 수에 비례해 느려짐
--      (병원 수십 곳부터 Supabase 기본 statement timeout에 걸려 PIN 설정이 실패할 수 있음).

begin;

create or replace function public.pin_login(p_pin text,p_client_id text,p_site_code text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  v_client text:=left(trim(coalesce(p_client_id,'')),100);
  v_site_code text:=lower(trim(coalesce(p_site_code,'')));
  v_ip_key text:='ip:'||coalesce(public.pin_request_ip(),'unknown');
  v_scope_key text;
  v_fail int:=0; v_locked timestamptz;
  v_ip_fail int:=0; v_ip_locked timestamptz; v_ip_updated timestamptz;
  v_scope_fail int:=0; v_scope_locked timestamptz; v_scope_updated timestamptz;
  v_account public.pin_accounts; v_token text; v_exp timestamptz; v_now timestamptz:=clock_timestamp();
  c_window constant interval:=interval '15 minutes';
  c_ip_max constant int:=20;
  c_scope_max constant int:=10;
begin
  if v_client='' or v_client !~ '^[A-Za-z0-9._:-]{8,100}$' then return jsonb_build_object('ok',false,'error','invalid_client'); end if;
  if p_pin !~ '^[0-9]{4,6}$' then return jsonb_build_object('ok',false,'error','invalid_pin'); end if;
  if v_site_code<>'' and v_site_code !~ '^[a-z0-9_-]{1,64}$' then return jsonb_build_object('ok',false,'error','invalid_pin'); end if;
  v_scope_key:=case when v_site_code='' then 'scope:admin' else 'scope:site:'||v_site_code end;

  -- 잠금 확인: 대상(범위) → IP → 기기 순
  select failed_count,locked_until,updated_at into v_scope_fail,v_scope_locked,v_scope_updated from public.pin_login_throttle where client_id=v_scope_key;
  if v_scope_locked is not null and v_scope_locked>v_now then return jsonb_build_object('ok',false,'error','locked','retry_after_sec',greatest(1,ceil(extract(epoch from(v_scope_locked-v_now)))::int)); end if;
  if v_scope_updated is null or v_scope_updated<v_now-c_window then v_scope_fail:=0; end if;

  select failed_count,locked_until,updated_at into v_ip_fail,v_ip_locked,v_ip_updated from public.pin_login_throttle where client_id=v_ip_key;
  if v_ip_locked is not null and v_ip_locked>v_now then return jsonb_build_object('ok',false,'error','locked','retry_after_sec',greatest(1,ceil(extract(epoch from(v_ip_locked-v_now)))::int)); end if;
  if v_ip_updated is null or v_ip_updated<v_now-c_window then v_ip_fail:=0; end if;

  select failed_count,locked_until into v_fail,v_locked from public.pin_login_throttle where client_id=v_client;
  if v_locked is not null and v_locked>v_now then return jsonb_build_object('ok',false,'error','locked','retry_after_sec',greatest(1,ceil(extract(epoch from(v_locked-v_now)))::int)); end if;

  -- 계정 조회: 주소에 따라 한 종류만 (bcrypt 1회)
  if v_site_code='' then
    select a.* into v_account from public.pin_accounts a
     where a.enabled and a.role='admin' and crypt(p_pin,a.pin_hash)=a.pin_hash
     order by a.id limit 1;
  else
    select a.* into v_account
    from public.pin_accounts a join public.sites s on s.id=a.site_id
    where a.enabled and a.role='staff' and s.active and s.code=v_site_code
      and crypt(p_pin,a.pin_hash)=a.pin_hash
    order by a.id limit 1;
  end if;

  if v_account.id is null then
    -- 대상(범위) 잠금: 요청자가 바꿀 수 없는 기준
    v_scope_fail:=coalesce(v_scope_fail,0)+1;
    insert into public.pin_login_throttle(client_id,failed_count,locked_until,updated_at)
    values(v_scope_key,case when v_scope_fail>=c_scope_max then 0 else v_scope_fail end,case when v_scope_fail>=c_scope_max then v_now+c_window end,v_now)
    on conflict(client_id) do update set failed_count=excluded.failed_count,locked_until=excluded.locked_until,updated_at=excluded.updated_at;

    v_ip_fail:=coalesce(v_ip_fail,0)+1;
    insert into public.pin_login_throttle(client_id,failed_count,locked_until,updated_at)
    values(v_ip_key,case when v_ip_fail>=c_ip_max then 0 else v_ip_fail end,case when v_ip_fail>=c_ip_max then v_now+c_window end,v_now)
    on conflict(client_id) do update set failed_count=excluded.failed_count,locked_until=excluded.locked_until,updated_at=excluded.updated_at;

    if v_scope_fail>=c_scope_max or v_ip_fail>=c_ip_max then
      -- 비로그인 상태라 audit_event(권한 검사)를 쓰지 않고 직접 기록. 슈퍼어드민 화면 감사 로그에서 확인.
      insert into public.audit_log(site_id,actor_role,action,entity_type,entity_id,summary,after_state)
      values((select s.id from public.sites s where v_site_code<>'' and s.code=v_site_code limit 1),null,'security','login_lock',v_scope_key,
             'PIN 반복 실패로 로그인 잠금',jsonb_build_object('scope',v_scope_key,'scope_fail',v_scope_fail,'ip_fail',v_ip_fail));
      return jsonb_build_object('ok',false,'error','locked','retry_after_sec',extract(epoch from c_window)::int);
    end if;

    v_fail:=coalesce(v_fail,0)+1;
    if v_fail>=5 then
      insert into public.pin_login_throttle(client_id,failed_count,locked_until,updated_at) values(v_client,0,v_now+interval '5 minutes',v_now)
      on conflict(client_id) do update set failed_count=0,locked_until=excluded.locked_until,updated_at=v_now;
      return jsonb_build_object('ok',false,'error','locked','retry_after_sec',300);
    end if;
    insert into public.pin_login_throttle(client_id,failed_count,locked_until,updated_at) values(v_client,v_fail,null,v_now)
    on conflict(client_id) do update set failed_count=excluded.failed_count,locked_until=null,updated_at=v_now;
    return jsonb_build_object('ok',false,'error','invalid_pin');
  end if;

  delete from public.pin_login_throttle where client_id in(v_client,v_ip_key,v_scope_key);
  delete from public.pin_login_throttle where locked_until is null and updated_at<v_now-interval '1 day';
  delete from public.pin_sessions where expires_at<=v_now;
  v_token:=encode(gen_random_bytes(32),'hex'); v_exp:=v_now+interval '12 hours';
  insert into public.pin_sessions(account_id,token_hash,expires_at) values(v_account.id,digest(v_token,'sha256'),v_exp);
  return jsonb_build_object('ok',true,'token',v_token,'role',v_account.role,'site_id',v_account.site_id,'expires_at',v_exp);
end $$;
revoke all on function public.pin_login(text,text,text) from public;
grant execute on function public.pin_login(text,text,text) to anon,authenticated;

create or replace function public.admin_set_site_staff_pin(p_site uuid,p_pin text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_account bigint;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if not exists(select 1 from public.sites where id=p_site) then raise exception 'site not found'; end if;
  if not exists(select 1 from public.sites where id=p_site and active) then raise exception '비활성 병원은 PIN을 변경할 수 없습니다'; end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception '병원 관리자 PIN은 숫자 4~6자리여야 합니다'; end if;
  -- 슈퍼어드민 계정은 보통 1개라 비용이 작다. 같은 PIN이면 운영 혼선이 생기므로 유지.
  if exists(select 1 from public.pin_accounts a where a.enabled and a.role='admin' and crypt(p_pin,a.pin_hash)=a.pin_hash) then raise exception '슈퍼어드민 PIN과 병원 관리자 PIN은 달라야 합니다'; end if;
  select id into v_account from public.pin_accounts where role='staff' and site_id=p_site order by id limit 1;
  if v_account is null then insert into public.pin_accounts(role,site_id,pin_hash,enabled,updated_at) values('staff',p_site,crypt(p_pin,gen_salt('bf',10)),true,clock_timestamp()) returning id into v_account;
  else update public.pin_accounts set pin_hash=crypt(p_pin,gen_salt('bf',10)),enabled=true,updated_at=clock_timestamp() where id=v_account; end if;
  delete from public.pin_sessions where account_id=v_account;
  delete from public.pin_login_throttle where client_id='scope:site:'||(select lower(code) from public.sites where id=p_site);
  perform public.audit_event(p_site,'update','access',v_account::text,'병원 관리자 PIN 변경',null,null);
end $$;
revoke all on function public.admin_set_site_staff_pin(uuid,text) from public;
grant execute on function public.admin_set_site_staff_pin(uuid,text) to anon,authenticated;

insert into public.schema_version(version,applied_at) values('2.35.84',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
commit;
