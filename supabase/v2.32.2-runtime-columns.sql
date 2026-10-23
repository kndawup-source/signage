-- Clinic Signage v2.32.2
-- Runtime compatibility columns required by the current admin UI.
-- Safe to re-run. Existing values are preserved.

begin;

alter table public.rooms
  add column if not exists map_x_pct numeric(5,2),
  add column if not exists map_y_pct numeric(5,2);

alter table public.rooms drop constraint if exists rooms_map_x_pct_check;
alter table public.rooms add constraint rooms_map_x_pct_check
  check (map_x_pct is null or map_x_pct between 0 and 100);

alter table public.rooms drop constraint if exists rooms_map_y_pct_check;
alter table public.rooms add constraint rooms_map_y_pct_check
  check (map_y_pct is null or map_y_pct between 0 and 100);

alter table public.app_settings
  add column if not exists site_name text not null default 'CLINIC SIGNAGE',
  add column if not exists building_label text not null default 'MAIN BUILDING';

insert into public.app_settings(id)
values (1)
on conflict (id) do nothing;

commit;

select pg_notify('pgrst', 'reload schema');
