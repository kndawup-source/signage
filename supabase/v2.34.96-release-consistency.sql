-- Clinic Signage v2.34.96 — release consistency + space-specific journey copy
-- Safe to rerun after v2.34.78.
begin;

-- 3) Replace all-hospital content wake-ups with site-scoped, statement-level wake-ups.
-- Transition tables ensure a multi-row save wakes each affected site only once.
create or replace function public.notify_video_site_rooms_insert_stmt() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_site uuid;
begin
  for v_site in select distinct site_id from new_rows loop perform public.signal_site_rooms_internal(v_site); end loop;
  return null;
end $$;
create or replace function public.notify_video_site_rooms_update_stmt() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_site uuid;
begin
  for v_site in select distinct site_id from (select site_id from old_rows union select site_id from new_rows) s loop perform public.signal_site_rooms_internal(v_site); end loop;
  return null;
end $$;
create or replace function public.notify_video_site_rooms_delete_stmt() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_site uuid;
begin
  for v_site in select distinct site_id from old_rows loop perform public.signal_site_rooms_internal(v_site); end loop;
  return null;
end $$;

create or replace function public.notify_playlist_site_rooms_insert_stmt() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_site uuid;
begin
  for v_site in select distinct site_id from new_rows loop perform public.signal_site_rooms_internal(v_site); end loop;
  return null;
end $$;
create or replace function public.notify_playlist_site_rooms_update_stmt() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_site uuid;
begin
  for v_site in select distinct site_id from (select site_id from old_rows union select site_id from new_rows) s loop perform public.signal_site_rooms_internal(v_site); end loop;
  return null;
end $$;
create or replace function public.notify_playlist_site_rooms_delete_stmt() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_site uuid;
begin
  for v_site in select distinct site_id from old_rows loop perform public.signal_site_rooms_internal(v_site); end loop;
  return null;
end $$;

create or replace function public.notify_playlist_item_site_rooms_insert_stmt() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_site uuid;
begin
  for v_site in select distinct p.site_id from new_rows x join public.playlists p on p.id=x.playlist_id loop perform public.signal_site_rooms_internal(v_site); end loop;
  return null;
end $$;
create or replace function public.notify_playlist_item_site_rooms_update_stmt() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_site uuid;
begin
  for v_site in
    select distinct p.site_id
    from (select playlist_id from old_rows union select playlist_id from new_rows) x
    join public.playlists p on p.id=x.playlist_id
  loop perform public.signal_site_rooms_internal(v_site); end loop;
  return null;
end $$;
create or replace function public.notify_playlist_item_site_rooms_delete_stmt() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_site uuid;
begin
  for v_site in select distinct p.site_id from old_rows x join public.playlists p on p.id=x.playlist_id loop perform public.signal_site_rooms_internal(v_site); end loop;
  return null;
end $$;

drop trigger if exists videos_notify on public.videos;
drop trigger if exists videos_notify_insert on public.videos;
drop trigger if exists videos_notify_update on public.videos;
drop trigger if exists videos_notify_delete on public.videos;
create trigger videos_notify_insert after insert on public.videos referencing new table as new_rows for each statement execute function public.notify_video_site_rooms_insert_stmt();
create trigger videos_notify_update after update on public.videos referencing old table as old_rows new table as new_rows for each statement execute function public.notify_video_site_rooms_update_stmt();
create trigger videos_notify_delete after delete on public.videos referencing old table as old_rows for each statement execute function public.notify_video_site_rooms_delete_stmt();

drop trigger if exists playlists_notify on public.playlists;
drop trigger if exists playlists_notify_insert on public.playlists;
drop trigger if exists playlists_notify_update on public.playlists;
drop trigger if exists playlists_notify_delete on public.playlists;
create trigger playlists_notify_insert after insert on public.playlists referencing new table as new_rows for each statement execute function public.notify_playlist_site_rooms_insert_stmt();
create trigger playlists_notify_update after update on public.playlists referencing old table as old_rows new table as new_rows for each statement execute function public.notify_playlist_site_rooms_update_stmt();
create trigger playlists_notify_delete after delete on public.playlists referencing old table as old_rows for each statement execute function public.notify_playlist_site_rooms_delete_stmt();

drop trigger if exists playlist_items_notify on public.playlist_items;
drop trigger if exists playlist_items_notify_insert on public.playlist_items;
drop trigger if exists playlist_items_notify_update on public.playlist_items;
drop trigger if exists playlist_items_notify_delete on public.playlist_items;
create trigger playlist_items_notify_insert after insert on public.playlist_items referencing new table as new_rows for each statement execute function public.notify_playlist_item_site_rooms_insert_stmt();
create trigger playlist_items_notify_update after update on public.playlist_items referencing old table as old_rows new table as new_rows for each statement execute function public.notify_playlist_item_site_rooms_update_stmt();
create trigger playlist_items_notify_delete after delete on public.playlist_items referencing old table as old_rows for each statement execute function public.notify_playlist_item_site_rooms_delete_stmt();



-- Space-level patient context/content reason prevent one floor note from being shown for every space.
alter table public.floor_spaces add column if not exists patient_context_note text;
alter table public.floor_spaces add column if not exists content_reason text;

-- Correct analytics index name/column. player_events uses occurred_at, not created_at.
drop index if exists public.player_events_created_idx;
create index if not exists player_events_occurred_idx on public.player_events(occurred_at desc);

-- Keep floor-layout copy behavior consistent with the new space metadata.
create or replace function public.hospital_copy_floor_layout(
  p_site uuid,
  p_source_group uuid,
  p_target_groups uuid[],
  p_copy_spaces boolean default true,
  p_copy_displays boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_target uuid; v_source_count integer; v_target_count integer; v_target_name text;
  v_spaces_copied boolean; v_displays_copied boolean;
  v_applied jsonb:='[]'::jsonb; v_skipped jsonb:='[]'::jsonb;
begin
  if p_site is null or p_source_group is null or coalesce(array_length(p_target_groups,1),0)=0 then raise exception 'INVALID_ARGUMENT'; end if;
  if public.pin_session_role() not in ('admin','staff') or not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  if not exists(select 1 from public.signage_groups g where g.id=p_source_group and g.site_id=p_site) then raise exception 'SOURCE_FLOOR_NOT_FOUND'; end if;
  if not coalesce(p_copy_spaces,false) and not coalesce(p_copy_displays,false) then raise exception 'NOTHING_TO_COPY'; end if;
  select count(*) into v_source_count from public.rooms r where r.site_id=p_site and r.group_id=p_source_group;
  foreach v_target in array p_target_groups loop
    if v_target=p_source_group then continue; end if;
    select g.name into v_target_name from public.signage_groups g where g.id=v_target and g.site_id=p_site;
    if v_target_name is null then
      v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object('id',v_target,'name','알 수 없는 층','reason','TARGET_FLOOR_NOT_FOUND'));
      continue;
    end if;
    v_spaces_copied:=false; v_displays_copied:=false;
    if p_copy_spaces then
      delete from public.floor_spaces where site_id=p_site and group_id=v_target;
      insert into public.floor_spaces(site_id,group_id,name,space_type,x_pct,y_pct,width_pct,height_pct,sort_order,patient_context_note,content_reason)
      select p_site,v_target,fs.name,fs.space_type,fs.x_pct,fs.y_pct,fs.width_pct,fs.height_pct,fs.sort_order,fs.patient_context_note,fs.content_reason
      from public.floor_spaces fs where fs.site_id=p_site and fs.group_id=p_source_group
      order by fs.sort_order,fs.created_at;
      v_spaces_copied:=true;
    end if;
    if p_copy_displays then
      select count(*) into v_target_count from public.rooms r where r.site_id=p_site and r.group_id=v_target;
      if v_target_count=v_source_count then
        with src as (
          select r.map_x_pct,r.map_y_pct,row_number() over(order by r.sort_order,r.name,r.created_at,r.id) rn
          from public.rooms r where r.site_id=p_site and r.group_id=p_source_group
        ), dst as (
          select r.id,row_number() over(order by r.sort_order,r.name,r.created_at,r.id) rn
          from public.rooms r where r.site_id=p_site and r.group_id=v_target
        )
        update public.rooms r set map_x_pct=src.map_x_pct,map_y_pct=src.map_y_pct
        from src join dst on dst.rn=src.rn where r.id=dst.id;
        v_displays_copied:=true;
      else
        v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object('id',v_target,'name',v_target_name,'reason','DISPLAY_COUNT_MISMATCH','source_count',v_source_count,'target_count',v_target_count,'spaces_copied',v_spaces_copied,'displays_copied',false));
      end if;
    end if;
    if v_spaces_copied or v_displays_copied then
      perform public.audit_event(p_site,'update','floor_layout',v_target::text,'층 도면 배치 복사',null,jsonb_build_object('source_group',p_source_group,'target_group',v_target,'spaces_copied',v_spaces_copied,'displays_copied',v_displays_copied));
      v_applied:=v_applied||jsonb_build_array(jsonb_build_object('id',v_target,'name',v_target_name,'spaces_copied',v_spaces_copied,'displays_copied',v_displays_copied));
    end if;
  end loop;
  return jsonb_build_object('ok',true,'applied',v_applied,'skipped',v_skipped);
end $$;
revoke all on function public.hospital_copy_floor_layout(uuid,uuid,uuid[],boolean,boolean) from public;
grant execute on function public.hospital_copy_floor_layout(uuid,uuid,uuid[],boolean,boolean) to anon,authenticated;

insert into public.schema_version(version,applied_at) values('2.34.96',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
commit;
