-- =====================================================================
-- Clinic Signage v2.24.0 · 보안 핫픽스 (가장 먼저, 반드시 실행)
--
-- 1) PIN 없이 관리자/스텝 RPC 호출이 가능한 문제
--    is_admin()/is_member() 는 세션이 없으면 false 가 아니라 NULL 을 반환합니다.
--    모든 관리 함수가 `if not public.is_admin() then raise ...` 형태라서
--    NOT NULL = NULL → IF 조건 불성립 → 예외 없이 통과합니다.
--    결과: 웹 JS 에 공개된 anon key 만으로 PIN 없이 전체 송출 시작/공지 문구 변경/
--          영상 규칙 변경 등 admin_* · staff_* RPC 46곳이 모두 실행됩니다.
--    (RLS 정책은 NULL 을 거부로 처리하므로 테이블 직접 접근은 안전했습니다.)
--    수정: 두 함수가 항상 true/false 만 반환하도록 coalesce. 호출부 46곳은 수정 불필요.
--
-- 2) admin_change_pin 이 crypt() 를 찾지 못하는 문제
--    pgcrypto 는 extensions 스키마에 있는데 search_path=public 으로 고정되어 있어
--    관리자 화면의 PIN 변경이 "function crypt(...) does not exist" 로 실패합니다.
--
-- 여러 번 실행해도 안전합니다.
-- =====================================================================

create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.pin_session_role() in ('admin', 'staff'), false);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.pin_session_role() = 'admin', false);
$$;

alter function public.admin_change_pin(text, text) set search_path = public, extensions;

-- 확인용 (SQL Editor 에서 세션 헤더 없이 실행 → 둘 다 false 여야 정상)
-- select public.is_admin(), public.is_member();
