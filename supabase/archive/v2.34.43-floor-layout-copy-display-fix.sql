-- Clinic Signage v2.34.43 compatibility migration
-- The v2.34.44 floor-layout implementation fully supersedes the unreleased 2.34.43 draft.
-- This marker keeps existing upgrade checklists continuous; apply 2.34.44 immediately after it.
begin;
insert into public.schema_version(version,applied_at) values('2.34.43',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
commit;
