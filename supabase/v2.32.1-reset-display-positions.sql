-- Clinic Signage v2.32.1
-- One-time cleanup: remove all previously stored display map positions.
-- Safe to run once when adopting manual-only display placement.

begin;

update public.rooms
set map_x_pct = null,
    map_y_pct = null
where map_x_pct is not null
   or map_y_pct is not null;

commit;

select pg_notify('pgrst', 'reload schema');
