-- Clinic Signage v2.31.0
-- Safe to rerun after canonical schema.

alter table public.app_settings add column if not exists site_name text not null default 'CLINIC SIGNAGE';
alter table public.app_settings add column if not exists building_label text not null default 'MAIN BUILDING';
alter table public.rooms drop constraint if exists rooms_room_mode_check;
alter table public.rooms add constraint rooms_room_mode_check check(room_mode in ('treatment','consultation','waiting','lounge','reception','lobby','public','staff','vip','other'));


-- Clinic Signage v2.31.0 — building-period dashboard, reusable site labels.
create or replace function public.admin_building_period_stats(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_today date := (clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_days int := greatest(1,least(coalesce(p_days,7),31));
  v_from date;
  v_rooms jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  v_from:=v_today-(v_days-1);
  with expected as (
    select coalesce(sum(w.planned_seconds),0)::bigint sec
    from generate_series(v_from,v_today,'1 day') d(day)
    cross join lateral public.signage_operating_window(d.day::date) w
  ), agg as (
    select r.id room_id,r.group_id,coalesce(sum(d.playing_seconds),0)::bigint playing_seconds,
      coalesce(sum(d.error_count),0)::bigint error_count,coalesce(sum(d.reconnect_count),0)::bigint reconnect_count
    from public.rooms r left join public.room_playback_daily d on d.room_id=r.id and d.day between v_from and v_today
    group by r.id,r.group_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('room_id',a.room_id,'group_id',a.group_id,
    'planned_seconds',e.sec,'playing_seconds',least(e.sec,a.playing_seconds),'error_count',a.error_count,'reconnect_count',a.reconnect_count,
    'rate',case when e.sec>0 then round(least(100,a.playing_seconds*100.0/e.sec),1) else 0 end)),'[]'::jsonb)
  into v_rooms from agg a cross join expected e;
  return jsonb_build_object('from',v_from,'to',v_today,'days',v_days,'rooms',v_rooms);
end $$;
revoke all on function public.admin_building_period_stats(int) from public;
grant execute on function public.admin_building_period_stats(int) to anon,authenticated;
