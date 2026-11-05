-- IMPORTANT: run only after testing RLS policies in staging with staff,
-- hospital admin, and superadmin roles. No policy should broaden access.
-- This migration is separate from v2.35.20-scale-heartbeat.sql.
-- =====================================================================
-- Clinic Signage v2.35.21 · RLS at multi-hospital scale
-- Safe to re-run (already-rewritten policies no longer match and are skipped).
--
-- Policies whose condition does not depend on the row (is_admin() / is_member()) were
-- evaluated once PER ROW. Each call parses request headers, hashes the PIN token and joins
-- pin_sessions, so the superadmin "rooms" read cost grew with the total number of TVs.
-- Wrapping the call in (select ...) makes Postgres evaluate it once per statement.
-- Measured locally, 100 hospitals / 1,500 TVs, superadmin reading rooms: 220 ms -> 0.7 ms.
-- Access rules are unchanged (verified: staff sees 0 rooms / own site, admin sees all).
-- =====================================================================
do $$
declare p record; v_using text; v_check text;
begin
  for p in
    select tablename,policyname,cmd,qual,with_check from pg_policies
    where schemaname='public'
      and (coalesce(qual,'') ~ '^\(?(is_admin|is_member)\(\)\)?$' or coalesce(with_check,'') ~ '^\(?(is_admin|is_member)\(\)\)?$')
  loop
    v_using:=case when p.qual ~ '^\(?(is_admin|is_member)\(\)\)?$' then format('(select public.%s())',substring(p.qual from '(is_admin|is_member)')) end;
    v_check:=case when p.with_check ~ '^\(?(is_admin|is_member)\(\)\)?$' then format('(select public.%s())',substring(p.with_check from '(is_admin|is_member)')) end;
    if v_using is not null and v_check is not null then
      execute format('alter policy %I on public.%I using (%s) with check (%s)',p.policyname,p.tablename,v_using,v_check);
    elsif v_using is not null then
      execute format('alter policy %I on public.%I using (%s)',p.policyname,p.tablename,v_using);
    elsif v_check is not null then
      execute format('alter policy %I on public.%I with check (%s)',p.policyname,p.tablename,v_check);
    end if;
  end loop;
end $$;

insert into public.schema_version(version,applied_at) values('2.35.21',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
