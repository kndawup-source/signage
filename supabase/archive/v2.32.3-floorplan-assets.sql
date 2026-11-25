-- Clinic Signage v2.32.3 — admin-managed floor plan assets
-- Re-runnable. Does not modify existing display positions or uploaded metadata.

alter table public.app_settings
  add column if not exists floorplan_assets jsonb not null default '{}'::jsonb;

update public.app_settings
set floorplan_assets='{}'::jsonb
where id=1 and floorplan_assets is null;

select pg_notify('pgrst','reload schema');
