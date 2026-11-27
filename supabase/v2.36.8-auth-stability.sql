BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.schema_version WHERE version='2.36.7') THEN RAISE EXCEPTION 'Apply v2.36.7-security-stability.sql first'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pin_login(p_pin text,p_client_id text,p_site_code text default null)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE
 v_client text:=coalesce(p_client_id,''); v_scope text:=lower(trim(coalesce(p_site_code,'')));
 v_scope_key text; v_client_key text; v_ip_key text; v_trusted boolean:=false;
 v_account public.pin_accounts%ROWTYPE; v_token text; v_device text; v_exp timestamptz; v_now timestamptz:=clock_timestamp();
BEGIN
 IF v_client !~ '^[A-Za-z0-9._:-]{8,100}$' OR p_pin IS NULL OR p_pin !~ '^[0-9]{4,6}$' OR (v_scope<>'' AND v_scope !~ '^[a-z0-9_-]{1,64}$') THEN RETURN jsonb_build_object('ok',false,'error','invalid_pin'); END IF;
 v_scope_key:='login:v2:scope:'||CASE WHEN v_scope='' THEN 'admin' ELSE 'site:'||v_scope END;
 v_ip_key:='login:v2:ip:'||coalesce(public.pin_request_ip(),'unknown');
 IF v_scope='' THEN SELECT a.* INTO v_account FROM public.pin_accounts a WHERE a.enabled AND a.role='admin' ORDER BY a.id LIMIT 1;
 ELSE SELECT a.* INTO v_account FROM public.pin_accounts a JOIN public.sites s ON s.id=a.site_id WHERE a.enabled AND a.role='staff' AND s.active AND s.code=v_scope ORDER BY a.id LIMIT 1; END IF;
 v_client_key:='login:v2:client:'||encode(digest(v_client,'sha256'),'hex');
 IF public.signage_throttle_count(v_client_key,interval '5 minutes')>=5 THEN RETURN jsonb_build_object('ok',false,'error','locked','retry_after_sec',300); END IF;
 IF public.signage_throttle_hit(v_client_key,interval '5 minutes')>5 THEN RETURN jsonb_build_object('ok',false,'error','locked','retry_after_sec',300); END IF;
 -- Only a server-issued, unexpired secret tied to the account and current PIN may bypass the anonymous scope budget.
 IF v_client ~ '^trusted\.[0-9a-f]{64}$' AND v_account.id IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM public.pin_trusted_devices d WHERE d.token_hash=digest(v_client,'sha256') AND d.account_id=v_account.id AND d.pin_updated_at=v_account.updated_at AND d.expires_at>v_now) INTO v_trusted;
 END IF;
 IF NOT v_trusted THEN
  IF public.signage_throttle_count(v_ip_key,interval '15 minutes')>=20 OR public.signage_throttle_count(v_scope_key,interval '15 minutes')>=10 THEN RETURN jsonb_build_object('ok',false,'error','locked','retry_after_sec',900); END IF;
  IF public.signage_throttle_hit(v_ip_key,interval '15 minutes')>20 THEN RETURN jsonb_build_object('ok',false,'error','locked','retry_after_sec',900); END IF;
  IF public.signage_throttle_hit(v_scope_key,interval '15 minutes')>10 THEN RETURN jsonb_build_object('ok',false,'error','locked','retry_after_sec',900); END IF;
 END IF;
 IF v_account.id IS NULL OR crypt(p_pin,v_account.pin_hash) IS DISTINCT FROM v_account.pin_hash THEN
  IF v_trusted THEN DELETE FROM public.pin_trusted_devices WHERE token_hash=digest(v_client,'sha256'); END IF;
  RETURN jsonb_build_object('ok',false,'error','invalid_pin');
 END IF;
 PERFORM 1 FROM public.pin_accounts WHERE id=v_account.id AND enabled AND updated_at=v_account.updated_at FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','invalid_pin'); END IF;
 -- Do not clear anonymous budgets on success: another request may be waiting on their row locks.
 DELETE FROM public.pin_login_throttle WHERE client_id=v_client_key;
 -- Bounded cleanup; skip rows held by concurrent authentication requests.
 DELETE FROM public.pin_login_throttle WHERE client_id IN (
  SELECT client_id FROM public.pin_login_throttle WHERE updated_at < v_now - interval '1 day'
  ORDER BY updated_at,client_id LIMIT 500 FOR UPDATE SKIP LOCKED
 );
 DELETE FROM public.pin_sessions WHERE expires_at<=v_now;
 DELETE FROM public.pin_trusted_devices WHERE expires_at<=v_now;
 IF v_trusted THEN v_device:=v_client;
 ELSE
  v_device:='trusted.'||encode(gen_random_bytes(32),'hex');
  INSERT INTO public.pin_trusted_devices(token_hash,account_id,pin_updated_at,expires_at) VALUES(digest(v_device,'sha256'),v_account.id,v_account.updated_at,v_now+interval '30 days');
 END IF;
 v_token:=encode(gen_random_bytes(32),'hex'); v_exp:=v_now+interval '12 hours';
 INSERT INTO public.pin_sessions(account_id,token_hash,expires_at) VALUES(v_account.id,digest(v_token,'sha256'),v_exp);
 RETURN jsonb_build_object('ok',true,'token',v_token,'role',v_account.role,'site_id',v_account.site_id,'expires_at',v_exp,'trusted_device',v_device);
END $$;
REVOKE ALL ON FUNCTION public.pin_login(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pin_login(text,text,text) TO anon,authenticated;
CREATE OR REPLACE FUNCTION public.app_db_version()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('version','2.36.8','features',jsonb_build_array('pairing_v2','display_key_reset','pairing_v3','site_catalog_v1','video_delete_impact_v1','layout_atomic_v1','selected_reload_v1','security_v1','trusted_revoke_v1'))
$$;
INSERT INTO public.schema_version(version,applied_at) VALUES('2.36.8',clock_timestamp()) ON CONFLICT(version) DO UPDATE SET applied_at=excluded.applied_at;
NOTIFY pgrst,'reload schema';
COMMIT;
