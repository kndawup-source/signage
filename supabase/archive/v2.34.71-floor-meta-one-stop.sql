-- Clinic Signage v2.34.71 — one-stop editable floor metadata + floor-name regression guard
begin;

create or replace function public.hospital_update_floor_meta(
  p_site uuid,
  p_group uuid,
  p_name text,
  p_care text default 'other',
  p_intro text default null,
  p_topics text[] default '{}',
  p_role text default null,
  p_purpose text default null,
  p_audience text default null,
  p_waiting text default null,
  p_reason text default null,
  p_playlist uuid default null
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_name text:=nullif(btrim(coalesce(p_name,'')),'');
  v_care text:=lower(coalesce(nullif(btrim(p_care),''),'other'));
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  if v_name is null then raise exception '층 이름을 입력하세요'; end if;
  if v_care not in ('general','minish','common','support','other') then v_care:='other'; end if;
  if p_playlist is not null and not exists(
    select 1 from public.playlists p where p.id=p_playlist and p.active and (p.site_id is null or p.site_id=p_site)
  ) then raise exception '사용할 수 없는 플레이리스트입니다'; end if;

  update public.signage_groups g
  set name=v_name,
      care_type=v_care,
      content_intro=nullif(btrim(coalesce(p_intro,'')),''),
      content_topics=coalesce(p_topics,'{}'::text[]),
      role_label=nullif(btrim(coalesce(p_role,'')),''),
      signage_purpose=nullif(btrim(coalesce(p_purpose,'')),''),
      target_audience=nullif(btrim(coalesce(p_audience,'')),''),
      waiting_area_note=nullif(btrim(coalesce(p_waiting,'')),''),
      signage_reason=nullif(btrim(coalesce(p_reason,'')),''),
      default_playlist_id=p_playlist
  where g.id=p_group and g.site_id=p_site and g.kind='floor';
  if not found then raise exception '층 정보를 찾을 수 없습니다'; end if;
end $$;

revoke all on function public.hospital_update_floor_meta(uuid,uuid,text,text,text,text[],text,text,text,text,text,uuid) from public;
grant execute on function public.hospital_update_floor_meta(uuid,uuid,text,text,text,text[],text,text,text,text,text,uuid) to anon,authenticated;

-- Only repair the known regression state. Never overwrite a real custom floor name.
with target as (select id from public.sites where code='minish' limit 1)
update public.signage_groups g
set name=case g.floor_number when 11 then '의국·사무' when 12 then '사무공간' else g.name end
from target t
where g.site_id=t.id and g.kind='floor' and g.floor_number in (11,12)
  and lower(regexp_replace(btrim(coalesce(g.name,'')),'[[:space:]_./-]+','','g')) in (
    'ev','e/v','엘리베이터','11층','11f','11','12층','12f','12'
  );

insert into public.schema_version(version,applied_at) values('2.34.71',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst, 'reload schema';
commit;
