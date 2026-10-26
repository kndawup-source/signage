-- Clinic Signage v2.34.9 · hospital lifecycle management
-- Safe to re-run. Apply after v2.34.9.

create or replace function public.admin_set_site_active(p_site uuid,p_active boolean)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare v_account_ids bigint[];
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if not exists(select 1 from public.sites where id=p_site) then raise exception 'site not found'; end if;

  update public.sites set active=coalesce(p_active,false),updated_at=clock_timestamp() where id=p_site;
  select coalesce(array_agg(id),'{}'::bigint[]) into v_account_ids from public.pin_accounts where role='staff' and site_id=p_site;

  if coalesce(p_active,false) then
    update public.pin_accounts set enabled=true,updated_at=clock_timestamp() where role='staff' and site_id=p_site;
  else
    update public.pin_accounts set enabled=false,updated_at=clock_timestamp() where role='staff' and site_id=p_site;
    delete from public.pin_sessions where account_id=any(v_account_ids);
    update public.site_broadcasts set active=false,video_ids='{}'::uuid[],notice_text=null,starts_at=null,ends_at=null,effective_at=clock_timestamp(),revision=revision+1 where site_id=p_site;
  end if;
  perform public.signal_site_rooms(p_site);
end $$;

create or replace function public.admin_delete_site(p_site uuid,p_confirm_name text)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare v_site public.sites; v_account_ids bigint[];
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select * into v_site from public.sites where id=p_site for update;
  if not found then raise exception 'site not found'; end if;
  if v_site.active then raise exception '병원을 먼저 비활성화하세요'; end if;
  if btrim(coalesce(p_confirm_name,''))<>btrim(v_site.name) then raise exception '병원명이 일치하지 않습니다'; end if;

  select coalesce(array_agg(id),'{}'::bigint[]) into v_account_ids from public.pin_accounts where role='staff' and site_id=p_site;
  delete from public.pin_sessions where account_id=any(v_account_ids);
  delete from public.pin_accounts where role='staff' and site_id=p_site;
  delete from public.rooms where site_id=p_site;
  delete from public.sites where id=p_site;
end $$;

revoke all on function public.admin_set_site_active(uuid,boolean),public.admin_delete_site(uuid,text) from public;
grant execute on function public.admin_set_site_active(uuid,boolean),public.admin_delete_site(uuid,text) to anon,authenticated;

-- An inactive hospital never has an active player window. This makes every player close
-- without changing or deleting the display configuration.
create or replace function public.signage_room_operating_window(p_room uuid,p_day date)
returns table(is_open boolean,start_time time,end_time time,planned_seconds int)
language plpgsql stable security definer set search_path=public as $$
declare r public.rooms; c jsonb; dow int; v_site_active boolean;
begin
  select * into r from public.rooms where id=p_room;
  if r.id is null then is_open:=false;start_time:='00:00';end_time:='00:00';planned_seconds:=0;return next;return;end if;
  select active into v_site_active from public.sites where id=r.site_id;
  if not coalesce(v_site_active,false) then is_open:=false;start_time:='00:00';end_time:='00:00';planned_seconds:=0;return next;return;end if;
  c:=coalesce(public.site_operating_config(r.site_id),'{}'::jsonb); dow:=extract(isodow from p_day)::int;
  if r.operating_override then
    if dow between 1 and 5 then is_open:=r.operating_weekday_enabled;start_time:=r.operating_weekday_start;end_time:=r.operating_weekday_end;
    elsif dow=6 then is_open:=r.operating_saturday_enabled;start_time:=r.operating_saturday_start;end_time:=r.operating_saturday_end;
    else is_open:=r.operating_sunday_enabled;start_time:=r.operating_sunday_start;end_time:=r.operating_sunday_end; end if;
  else
    if dow between 1 and 5 then is_open:=coalesce((c->>'weekday_enabled')::boolean,true);start_time:=coalesce((c->>'weekday_start')::time,'09:00');end_time:=coalesce((c->>'weekday_end')::time,'20:00');
    elsif dow=6 then is_open:=coalesce((c->>'saturday_enabled')::boolean,true);start_time:=coalesce((c->>'saturday_start')::time,'09:00');end_time:=coalesce((c->>'saturday_end')::time,'17:00');
    else is_open:=coalesce((c->>'sunday_enabled')::boolean,false);start_time:=coalesce((c->>'sunday_start')::time,'09:00');end_time:=coalesce((c->>'sunday_end')::time,'17:00'); end if;
  end if;
  if nullif(c->>'early_closed_date','')::date=p_day then is_open:=false; end if;
  if not coalesce(is_open,false) or start_time is null or end_time is null or end_time<=start_time then is_open:=false;planned_seconds:=0; else planned_seconds:=extract(epoch from (end_time-start_time))::int; end if;
  return next;
end $$;

revoke all on function public.signage_room_operating_window(uuid,date) from public;
grant execute on function public.signage_room_operating_window(uuid,date) to anon,authenticated;

insert into public.schema_version(version) values('2.34.9') on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
