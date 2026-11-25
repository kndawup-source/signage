-- v2.34.70 floor-space exact duplicate guard
with ranked as (
  select
    fs.id,
    first_value(fs.id) over (
      partition by fs.site_id,fs.group_id,lower(btrim(fs.name)),coalesce(fs.space_type,'other'),fs.x_pct,fs.y_pct,fs.width_pct,fs.height_pct
      order by fs.created_at nulls last,fs.id
    ) as keep_id,
    row_number() over (
      partition by fs.site_id,fs.group_id,lower(btrim(fs.name)),coalesce(fs.space_type,'other'),fs.x_pct,fs.y_pct,fs.width_pct,fs.height_pct
      order by fs.created_at nulls last,fs.id
    ) as rn
  from public.floor_spaces fs
), dupes as (
  select id,keep_id from ranked where rn>1
)
update public.rooms r set floor_space_id=d.keep_id from dupes d where r.floor_space_id=d.id;

with ranked as (
  select fs.id,row_number() over (
    partition by fs.site_id,fs.group_id,lower(btrim(fs.name)),coalesce(fs.space_type,'other'),fs.x_pct,fs.y_pct,fs.width_pct,fs.height_pct
    order by fs.created_at nulls last,fs.id
  ) as rn
  from public.floor_spaces fs
)
delete from public.floor_spaces fs using ranked r where fs.id=r.id and r.rn>1;

create unique index if not exists floor_spaces_exact_unique_idx
on public.floor_spaces (
  site_id,group_id,lower(btrim(name)),coalesce(space_type,'other'),x_pct,y_pct,width_pct,height_pct
);

insert into public.schema_version(version,applied_at) values('2.34.70',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';

