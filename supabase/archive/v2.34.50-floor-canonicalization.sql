-- Clinic Signage v2.34.50 — one canonical group per physical floor
-- Fixes legacy zone/other groups that still carry floor_number and therefore appear as duplicate floors.
begin;

-- A physical floor is represented only by kind='floor'.
-- Before removing legacy same-floor groups, migrate all runtime references and useful settings.
do $$
declare
  d record;
  c public.signage_groups%rowtype;
  legacy_b public.group_broadcasts%rowtype;
begin
  for d in
    select g.*
    from public.signage_groups g
    where g.kind <> 'floor'
      and g.floor_number is not null
      and exists (
        select 1 from public.signage_groups f
        where f.site_id=g.site_id
          and f.kind='floor'
          and f.floor_number=g.floor_number
      )
    order by g.site_id,g.floor_number,g.created_at
  loop
    select * into c
    from public.signage_groups f
    where f.site_id=d.site_id
      and f.kind='floor'
      and f.floor_number=d.floor_number
    order by f.created_at
    limit 1;

    -- Keep the existing displays and drawn spaces, but attach them to the canonical floor.
    update public.rooms set group_id=c.id where group_id=d.id;
    update public.floor_spaces set group_id=c.id, updated_at=clock_timestamp() where group_id=d.id;

    -- Preserve useful legacy floor defaults when the canonical floor does not have them yet.
    update public.signage_groups f
    set default_playlist_id=coalesce(f.default_playlist_id,d.default_playlist_id),
        signage_purpose=coalesce(nullif(f.signage_purpose,''),d.signage_purpose),
        target_audience=coalesce(nullif(f.target_audience,''),d.target_audience),
        waiting_area_note=coalesce(nullif(f.waiting_area_note,''),d.waiting_area_note),
        signage_reason=coalesce(nullif(f.signage_reason,''),d.signage_reason)
    where f.id=c.id;

    -- Move scheduled floor broadcasts to the canonical floor.
    update public.broadcast_schedules set group_id=c.id where group_id=d.id;

    -- Preserve an active/current legacy group broadcast if present.
    select * into legacy_b from public.group_broadcasts where group_id=d.id;
    if found then
      insert into public.group_broadcasts(group_id,active,video_ids,notice_text,effective_at,revision,updated_at)
      values(c.id,legacy_b.active,legacy_b.video_ids,legacy_b.notice_text,legacy_b.effective_at,legacy_b.revision,legacy_b.updated_at)
      on conflict(group_id) do update set
        active=case when excluded.active then true else public.group_broadcasts.active end,
        video_ids=case when excluded.active or coalesce(array_length(public.group_broadcasts.video_ids,1),0)=0 then excluded.video_ids else public.group_broadcasts.video_ids end,
        notice_text=coalesce(public.group_broadcasts.notice_text,excluded.notice_text),
        effective_at=coalesce(public.group_broadcasts.effective_at,excluded.effective_at),
        revision=greatest(public.group_broadcasts.revision,excluded.revision),
        updated_at=greatest(public.group_broadcasts.updated_at,excluded.updated_at);
      delete from public.group_broadcasts where group_id=d.id;
    end if;

    -- The legacy object no longer represents a separate floor/group.
    delete from public.signage_groups where id=d.id;
  end loop;
end $$;

-- Enforce the model going forward: only floor groups may own floor_number.
update public.signage_groups
set floor_number=null
where kind <> 'floor' and floor_number is not null;

alter table public.signage_groups drop constraint if exists signage_groups_floor_number_kind_check;
alter table public.signage_groups add constraint signage_groups_floor_number_kind_check
  check ((kind='floor' and floor_number is not null) or (kind<>'floor' and floor_number is null));

-- Exactly one canonical row per physical floor in one hospital.
drop index if exists public.signage_groups_site_floor_uidx;
create unique index signage_groups_site_floor_uidx
  on public.signage_groups(site_id,floor_number)
  where kind='floor';

insert into public.schema_version(version,applied_at) values('2.34.50',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst, 'reload schema';
commit;
