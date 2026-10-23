-- Clinic Signage v2.33.1 — idempotent site creation / 409 conflict fix
-- Safe to run after v2.33.0, including partially completed site creation attempts.

insert into public.site_settings(site_id)
select s.id from public.sites s
on conflict(site_id) do nothing;

create or replace function public.admin_create_site(
  p_name text,
  p_code text,
  p_building_label text default 'MAIN BUILDING'
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_name text:=btrim(coalesce(p_name,''));
  v_code text:=lower(btrim(coalesce(p_code,'')));
  v_building text:=coalesce(nullif(btrim(coalesce(p_building_label,'')),''),'MAIN BUILDING');
  v_site public.sites%rowtype;
begin
  if not public.is_admin() then
    raise exception 'not allowed';
  end if;
  if v_name='' then
    return jsonb_build_object('ok',false,'code','SITE_NAME_REQUIRED','message','병원명을 입력하세요.');
  end if;
  if v_code='' or length(v_code)>32 or v_code !~ '^[a-z0-9][a-z0-9_-]*$' then
    return jsonb_build_object('ok',false,'code','SITE_CODE_INVALID','message','병원 코드는 영문 소문자, 숫자, - 또는 _만 사용할 수 있습니다.');
  end if;

  insert into public.sites(code,name,building_label)
  values(v_code,v_name,v_building)
  on conflict(code) do nothing
  returning * into v_site;

  if v_site.id is null then
    select * into v_site from public.sites where code=v_code limit 1;
    insert into public.site_settings(site_id) values(v_site.id)
    on conflict(site_id) do nothing;
    return jsonb_build_object('ok',true,'existing',true,'code','SITE_CODE_EXISTS','message','이미 등록된 병원입니다.','site',to_jsonb(v_site));
  end if;

  insert into public.site_settings(site_id) values(v_site.id)
  on conflict(site_id) do nothing;

  return jsonb_build_object('ok',true,'existing',false,'site',to_jsonb(v_site));
end
$$;

revoke all on function public.admin_create_site(text,text,text) from public;
grant execute on function public.admin_create_site(text,text,text) to anon,authenticated;
select pg_notify('pgrst','reload schema');
