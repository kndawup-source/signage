-- TEST DATABASE ONLY. Synthetic fixtures, rolled back at the end. Requires SQL Editor owner privileges.
-- Apply v2.36.0 first. No actual hospital PIN is required; temporary sessions are generated.
begin;
set local search_path=public,extensions;
do $$
declare admin_id bigint; account bigint; ta text:=encode(gen_random_bytes(32),'hex'); tb text:=encode(gen_random_bytes(32),'hex'); tm text:=encode(gen_random_bytes(32),'hex');
  suffix text:=encode(gen_random_bytes(8),'hex'); a uuid; b uuid; result jsonb; cfg jsonb; p text; i integer;
begin
  if NOT (public.app_db_version()->'features' ? 'site_catalog_v1') then raise exception 'Apply v2.36.0 first'; end if;
  select id into admin_id from public.pin_accounts where role='admin' and enabled limit 1;
  if admin_id is null then raise exception 'Configure an enabled test admin first'; end if;
  insert into public.pin_sessions(account_id,token_hash,expires_at) values(admin_id,digest(tm,'sha256'),now()+interval '1 hour');
  perform set_config('request.headers',jsonb_build_object('x-signage-session',tm)::text,true);
  for i in 1..2 loop
    loop
      p:=lpad((floor(random()*1000000)::integer)::text,6,'0');
      exit when not exists(select 1 from public.pin_accounts where enabled and crypt(p,pin_hash)=pin_hash);
    end loop;
    result:=public.admin_onboard_site('QA hospital '||i,'qa_'||suffix||'_'||i,p,'QA',i);
    if result->>'ok' is distinct from 'true' or result->>'existing' is distinct from 'false' then raise exception 'Onboarding failed: %',result; end if;
    if i=1 then a:=(result#>>'{site,id}')::uuid; else b:=(result#>>'{site,id}')::uuid; end if;
  end loop;
  if (select count(*) from public.signage_groups where site_id=a and kind='floor')<>1 or (select count(*) from public.signage_groups where site_id=b and kind='floor')<>2 then raise exception 'Incorrect initial floor count'; end if;
  select catalog_config into cfg from public.sites where id=a;
  if exists(select 1 from jsonb_array_elements(cfg->'treatments') e where e->>'code'='minish') then raise exception 'New site contains branded defaults'; end if;
  cfg:=jsonb_set(cfg,'{treatments}',(cfg->'treatments')||jsonb_build_array(jsonb_build_object('code','qa_private','label','QA private','active',true)));
  cfg:=public.hospital_save_site_catalog(a,(cfg->>'revision')::integer,cfg);
  select id into account from public.pin_accounts where role='staff' and site_id=a;
  insert into public.pin_sessions(account_id,token_hash,expires_at) values(account,digest(ta,'sha256'),now()+interval '1 hour');
  select id into account from public.pin_accounts where role='staff' and site_id=b;
  insert into public.pin_sessions(account_id,token_hash,expires_at) values(account,digest(tb,'sha256'),now()+interval '1 hour');
  perform set_config('qa.a',a::text,true);perform set_config('qa.b',b::text,true);perform set_config('qa.ta',ta,true);perform set_config('qa.tb',tb,true);perform set_config('qa.tm',tm,true);
end $$;
set local role anon;
do $$
declare a uuid:=current_setting('qa.a')::uuid; b uuid:=current_setting('qa.b')::uuid; cfg jsonb; rev integer; n integer;
begin
  perform set_config('request.headers',jsonb_build_object('x-signage-session',current_setting('qa.ta'))::text,true);
  if not exists(select 1 from public.sites where id=a) or exists(select 1 from public.sites where id=b) then raise exception 'Tenant A read isolation failed'; end if;
  select catalog_config into cfg from public.sites where id=a;rev:=(cfg->>'revision')::integer;
  begin perform public.hospital_save_site_catalog(b,1,cfg);raise exception 'Cross-tenant save unexpectedly allowed'; exception when insufficient_privilege then null; end;
  begin perform public.admin_onboard_site('Denied','qa_denied','123456','QA',0);raise exception 'Staff onboarding unexpectedly allowed'; exception when insufficient_privilege then null; end;
  if has_function_privilege(current_user,'public.site_catalog_has_code(uuid,text,text,boolean)','EXECUTE') then raise exception 'Internal lookup exposed'; end if;
  cfg:=jsonb_set(cfg,'{treatments}',(select jsonb_agg(e) from jsonb_array_elements(cfg->'treatments') e where e->>'code'<>'qa_private'));
  cfg:=public.hospital_save_site_catalog(a,rev,cfg);
  if not exists(select 1 from jsonb_array_elements(cfg->'treatments') e where e->>'code'='qa_private' and e->'active'='false'::jsonb) then raise exception 'Historical code was not archived'; end if;
  begin perform public.hospital_save_site_catalog(a,rev,cfg);raise exception 'Stale revision accepted'; exception when serialization_failure then null; end;
  perform set_config('request.headers',jsonb_build_object('x-signage-session',current_setting('qa.tb'))::text,true);
  if not exists(select 1 from public.sites where id=b) or exists(select 1 from public.sites where id=a) then raise exception 'Tenant B read isolation failed'; end if;
  select catalog_config into cfg from public.sites where id=b;
  if exists(select 1 from jsonb_array_elements(cfg->'treatments') e where e->>'code'='qa_private') then raise exception 'Tenant catalog leaked'; end if;
  perform set_config('request.headers',jsonb_build_object('x-signage-session',current_setting('qa.tm'))::text,true);
  select count(*) into n from public.sites where id in (a,b);if n<>2 then raise exception 'Admin read failed';end if;
  perform public.hospital_save_site_catalog(b,(cfg->>'revision')::integer,cfg);
end $$;
reset role;
rollback;
select 'PASS: onboarding, own-site save, cross-site denial, archive, revision, admin access' as result;
