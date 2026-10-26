-- Clinic Signage v2.34.11 · launch blockers
-- Apply after v2.34.8 then v2.34.9. Safe to re-run.
begin;

-- 1) Cascading site deletion must not write audit rows that reference a site already being deleted.
create or replace function public.audit_floor_space_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_site uuid; v_id text;
begin
  if tg_op='DELETE' then v_site:=old.site_id; v_id:=old.id::text; else v_site:=new.site_id; v_id:=new.id::text; end if;
  if tg_op='DELETE' and not exists(select 1 from public.sites where id=v_site) then return old; end if;
  if public.pin_session_role() in ('admin','staff') then
    insert into public.audit_log(site_id,actor_role,action,entity_type,entity_id,summary,before_state,after_state)
    values(v_site,public.pin_session_role(),lower(tg_op),'floor_space',v_id,'도면 공간 구분 변경',case when tg_op='INSERT' then null else to_jsonb(old) end,case when tg_op='DELETE' then null else to_jsonb(new) end);
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;

create or replace function public.audit_site_settings_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_site uuid;
begin
  if tg_op='DELETE' then v_site:=old.site_id; else v_site:=new.site_id; end if;
  if tg_op='DELETE' and not exists(select 1 from public.sites where id=v_site) then return old; end if;
  if public.pin_session_role() in ('admin','staff') then
    insert into public.audit_log(site_id,actor_role,action,entity_type,entity_id,summary,before_state,after_state)
    values(v_site,public.pin_session_role(),lower(tg_op),'site_settings',v_site::text,'병원 도면/운영 설정 변경',case when tg_op='INSERT' then null else to_jsonb(old) end,case when tg_op='DELETE' then null else to_jsonb(new) end);
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;

-- 2) Inactive hospitals cannot be managed by hospital-admin sessions or re-enabled by changing their PIN.
create or replace function public.can_manage_site(p_site uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select coalesce(case public.pin_session_role()
    when 'admin' then p_site is not null
    when 'staff' then p_site is not null and public.pin_session_site_id()=p_site and exists(select 1 from public.sites s where s.id=p_site and s.active)
    else false end,false);
$$;
revoke all on function public.can_manage_site(uuid) from public;
grant execute on function public.can_manage_site(uuid) to anon,authenticated;

create or replace function public.admin_set_site_staff_pin(p_site uuid,p_pin text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_account bigint;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if not exists(select 1 from public.sites where id=p_site) then raise exception 'site not found'; end if;
  if not exists(select 1 from public.sites where id=p_site and active) then raise exception '비활성 병원은 PIN을 변경할 수 없습니다'; end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception '병원 관리자 PIN은 숫자 4~6자리여야 합니다'; end if;
  if exists(select 1 from public.pin_accounts a where a.enabled and a.role='admin' and crypt(p_pin,a.pin_hash)=a.pin_hash) then raise exception '슈퍼어드민 PIN과 병원 관리자 PIN은 달라야 합니다'; end if;
  if exists(select 1 from public.pin_accounts a where a.enabled and a.role='staff' and a.site_id is distinct from p_site and crypt(p_pin,a.pin_hash)=a.pin_hash) then raise exception '다른 병원에서 사용 중인 PIN입니다'; end if;
  select id into v_account from public.pin_accounts where role='staff' and site_id=p_site order by id limit 1;
  if v_account is null then insert into public.pin_accounts(role,site_id,pin_hash,enabled,updated_at) values('staff',p_site,crypt(p_pin,gen_salt('bf',10)),true,clock_timestamp()) returning id into v_account;
  else update public.pin_accounts set pin_hash=crypt(p_pin,gen_salt('bf',10)),enabled=true,updated_at=clock_timestamp() where id=v_account; end if;
  delete from public.pin_sessions where account_id=v_account;
  perform public.audit_event(p_site,'update','access',v_account::text,'병원 관리자 PIN 변경',null,null);
end $$;
revoke all on function public.admin_set_site_staff_pin(uuid,text) from public;
grant execute on function public.admin_set_site_staff_pin(uuid,text) to anon,authenticated;

-- 3) Duplicate floor names are rejected instead of moving the existing floor.
create or replace function public.hospital_create_floor(p_site uuid,p_floor smallint,p_name text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_name text;
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  if p_floor<1 or p_floor>99 then raise exception 'floor must be 1..99'; end if;
  v_name:=coalesce(nullif(trim(p_name),''),p_floor::text||'F');
  if exists(select 1 from public.signage_groups where site_id=p_site and lower(name)=lower(v_name)) then raise exception '같은 이름의 층이 이미 있습니다'; end if;
  if exists(select 1 from public.signage_groups where site_id=p_site and kind='floor' and floor_number=p_floor) then raise exception '같은 층 번호가 이미 있습니다'; end if;
  insert into public.signage_groups(site_id,name,kind,floor_number,care_type,sort_order) values(p_site,v_name,'floor',p_floor,'other',100-p_floor) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.hospital_create_floor(uuid,smallint,text) from public;
grant execute on function public.hospital_create_floor(uuid,smallint,text) to anon,authenticated;

-- 4) Hospital-wide broadcast is an explicit site-scoped RPC.
create or replace function public.hospital_set_broadcast(p_site uuid,p_active boolean,p_playlist uuid default null,p_notice text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_ids uuid[]:='{}'::uuid[];
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  if coalesce(p_active,false) then
    if p_playlist is null or not exists(select 1 from public.playlists where id=p_playlist and site_id=p_site and active) then raise exception '병원 플레이리스트를 선택하세요'; end if;
    select coalesce(array_agg(v.id order by pi.sort_order,pi.created_at),'{}'::uuid[]) into v_ids
      from public.playlist_items pi join public.videos v on v.id=pi.video_id
      where pi.playlist_id=p_playlist and v.active and (v.site_id is null or v.site_id=p_site) and (v.source<>'local' or v.available);
    if coalesce(array_length(v_ids,1),0)=0 then raise exception '재생 가능한 영상이 없습니다'; end if;
  end if;
  insert into public.site_broadcasts(site_id,active,video_ids,notice_text,effective_at,revision,updated_at)
  values(p_site,coalesce(p_active,false),case when p_active then v_ids else '{}'::uuid[] end,nullif(trim(coalesce(p_notice,'')),''),clock_timestamp(),1,clock_timestamp())
  on conflict(site_id) do update set active=excluded.active,video_ids=excluded.video_ids,notice_text=excluded.notice_text,effective_at=clock_timestamp(),revision=public.site_broadcasts.revision+1,updated_at=clock_timestamp();
  perform public.signal_site_rooms(p_site);
end $$;
revoke all on function public.hospital_set_broadcast(uuid,boolean,uuid,text) from public;
grant execute on function public.hospital_set_broadcast(uuid,boolean,uuid,text) to anon,authenticated;

-- 5) Retire legacy single-hospital controls that no longer affect v2.34 players.
revoke all on function public.admin_set_broadcast(boolean,uuid[],text,int) from anon,authenticated;
revoke all on function public.admin_stop_broadcast(text) from anon,authenticated;
revoke all on function public.admin_undo_control(bigint) from anon,authenticated;
revoke all on function public.admin_reopen_today() from anon,authenticated;

insert into public.schema_version(version) values('2.34.11') on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
commit;
