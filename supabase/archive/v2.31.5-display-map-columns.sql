-- Clinic Signage v2.31.5
-- Canonical compatibility migration for display placement on floor maps.
-- Safe to re-run. Does not modify existing coordinates.

alter table public.rooms add column if not exists map_x_pct numeric(5,2);
alter table public.rooms add column if not exists map_y_pct numeric(5,2);

alter table public.rooms drop constraint if exists rooms_map_x_pct_check;
alter table public.rooms add constraint rooms_map_x_pct_check
  check (map_x_pct is null or map_x_pct between 0 and 100);

alter table public.rooms drop constraint if exists rooms_map_y_pct_check;
alter table public.rooms add constraint rooms_map_y_pct_check
  check (map_y_pct is null or map_y_pct between 0 and 100);

-- Ask PostgREST to expose the new columns immediately.
select pg_notify('pgrst','reload schema');
