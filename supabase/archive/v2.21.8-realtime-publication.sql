-- Clinic Signage v2.21.8
-- Ensure tables used for immediate player/admin updates are in Supabase Realtime publication.
-- Safe to re-run: tables already present are skipped.

do $$
declare
  t text;
  wanted text[] := array[
    'rooms',
    'broadcast',
    'group_broadcasts',
    'room_video_rules',
    'playlist_items',
    'playlists',
    'videos',
    'broadcast_schedules'
  ];
begin
  foreach t in array wanted loop
    if to_regclass(format('public.%I', t)) is not null
       and not exists (
         select 1
         from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = t
       ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
