-- Clinic Signage v2.36.0 | tenant-specific catalogs and onboarding
-- Existing TV keys, playlists, sessions and media are not changed. Run after 2.35.87.
begin;
select pg_advisory_xact_lock(23600);
do $$ begin
  if not exists(select 1 from public.schema_version where version='2.35.87') then
    raise exception '먼저 v2.35.86 및 v2.35.87 마이그레이션을 적용하세요.';
  end if;
  if to_regprocedure('public.app_db_version()') is null or to_regprocedure('public.can_manage_site(uuid)') is null or to_regprocedure('public.admin_create_site(text,text,text)') is null or to_regprocedure('public.admin_set_site_staff_pin(uuid,text)') is null or to_regprocedure('public.hospital_create_floor(uuid,smallint,text)') is null then
    raise exception '2.35.87 필수 DB 함수가 없습니다. 이전 마이그레이션을 확인하세요.';
  end if;
  if not coalesce((public.app_db_version()->'features') ? 'pairing_v3',false) then raise exception '2.35.87 연결 기능이 없습니다. 이전 마이그레이션을 확인하세요.'; end if;
end $$;
alter table public.sites add column if not exists catalog_config jsonb;
-- Retain existing choices and referenced codes, including historical custom values.
-- Only the existing branded site or a site with its own legacy references gets the legacy branded entry.
with refs as (
  select site_id,session_treatment as code from public.rooms where session_treatment is not null
  union select site_id,treatment from public.patient_sessions where treatment is not null
  union select site_id,unnest(target_treatment) from public.playlists where site_id is not null
  union select site_id,unnest(target_treatment) from public.videos where site_id is not null
), initial as (
  select s.id, '{"revision":1,"treatments":[{"code":"general","label":"일반 진료","active":true},{"code":"checkup","label":"검진","active":true},{"code":"aftercare","label":"치료 후 관리","active":true}],"floor_types":[{"code":"general","label":"일반진료","active":true},{"code":"common","label":"공용","active":true},{"code":"support","label":"지원","active":true},{"code":"other","label":"기타","active":true}],"space_types":[{"code":"treatment","label":"진료실","active":true},{"code":"consultation","label":"상담실","active":true},{"code":"waiting","label":"대기","active":true},{"code":"lounge","label":"라운지","active":true},{"code":"reception","label":"접수/안내","active":true},{"code":"lobby","label":"로비","active":true},{"code":"staff","label":"스탭","active":true},{"code":"support","label":"지원","active":true},{"code":"public","label":"공용","active":true},{"code":"other","label":"기타","active":true}],"logo":null}'::jsonb || jsonb_build_object(
    'treatments',coalesce((select jsonb_agg(x order by ord) from jsonb_array_elements('[{"code":"minish","label":"미니쉬","active":true},{"code":"implant","label":"임플란트","active":true},{"code":"whitening","label":"미백","active":true},{"code":"orthodontics","label":"교정","active":true},{"code":"checkup","label":"검진","active":true},{"code":"aftercare","label":"수술 후 관리","active":true},{"code":"general","label":"일반 진료","active":true}]'::jsonb) with ordinality a(x,ord)
      where x->>'code'<>'minish' or s.code='minish' or exists(select 1 from refs where site_id=s.id and code='minish')), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('code',q.code,'label',q.code,'active',true) order by q.code) from
          (select distinct code from refs where site_id=s.id and nullif(btrim(code),'') is not null and not exists(select 1 from jsonb_array_elements('[{"code":"minish","label":"미니쉬","active":true},{"code":"implant","label":"임플란트","active":true},{"code":"whitening","label":"미백","active":true},{"code":"orthodontics","label":"교정","active":true},{"code":"checkup","label":"검진","active":true},{"code":"aftercare","label":"수술 후 관리","active":true},{"code":"general","label":"일반 진료","active":true}]'::jsonb) a where a->>'code'=refs.code)) q),'[]'::jsonb),
    'floor_types',case when s.code='minish' or exists(select 1 from public.signage_groups g where g.site_id=s.id and g.care_type='minish') then '[{"code":"general","label":"일반진료","active":true},{"code":"minish","label":"MINISH","active":true},{"code":"common","label":"공용","active":true},{"code":"support","label":"지원","active":true},{"code":"other","label":"기타","active":true}]'::jsonb else '[{"code":"general","label":"일반진료","active":true},{"code":"common","label":"공용","active":true},{"code":"support","label":"지원","active":true},{"code":"other","label":"기타","active":true}]'::jsonb end
  ) as cfg from public.sites s where s.catalog_config is null
) update public.sites s set catalog_config=i.cfg from initial i where s.id=i.id;
alter table public.sites alter column catalog_config set default '{"revision":1,"treatments":[{"code":"general","label":"일반 진료","active":true},{"code":"checkup","label":"검진","active":true},{"code":"aftercare","label":"치료 후 관리","active":true}],"floor_types":[{"code":"general","label":"일반진료","active":true},{"code":"common","label":"공용","active":true},{"code":"support","label":"지원","active":true},{"code":"other","label":"기타","active":true}],"space_types":[{"code":"treatment","label":"진료실","active":true},{"code":"consultation","label":"상담실","active":true},{"code":"waiting","label":"대기","active":true},{"code":"lounge","label":"라운지","active":true},{"code":"reception","label":"접수/안내","active":true},{"code":"lobby","label":"로비","active":true},{"code":"staff","label":"스탭","active":true},{"code":"support","label":"지원","active":true},{"code":"public","label":"공용","active":true},{"code":"other","label":"기타","active":true}],"logo":null}'::jsonb;
alter table public.sites alter column catalog_config set not null;

-- Codes are stable identifiers: disabling a code retains historical labels and references.
create or replace function public.site_catalog_has_code(p_site uuid,p_kind text,p_code text,p_active boolean default false)
returns boolean language sql stable security definer set search_path=public as $$
  select coalesce(exists(select 1 from public.sites s cross join lateral jsonb_array_elements(s.catalog_config->p_kind) e
    where s.id=p_site and e->>'code'=p_code and (not p_active or e->'active'='true'::jsonb)),false)
$$;
revoke all on function public.site_catalog_has_code(uuid,text,text,boolean) from public,anon,authenticated;

create or replace function public.hospital_save_site_catalog(p_site uuid,p_revision integer,p_catalog jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare old_cfg jsonb; cfg jsonb; category text; item jsonb; old_item jsonb; arr jsonb; code text; label text; seen text[]; logo text; next_revision integer;
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed' using errcode='42501'; end if;
  select catalog_config into old_cfg from public.sites where id=p_site for update;
  if not found then raise exception '병원을 찾을 수 없습니다.'; end if;
  if p_revision is distinct from (old_cfg->>'revision')::integer then raise exception '다른 관리자가 설정을 변경했습니다. 새로고침 후 다시 시도하세요.' using errcode='40001'; end if;
  if jsonb_typeof(p_catalog) is distinct from 'object' or octet_length(p_catalog::text)>300000 then raise exception '설정 형식 또는 용량이 올바르지 않습니다.'; end if;
  cfg:='{}'::jsonb;
  foreach category in array array['treatments','floor_types','space_types'] loop
    if jsonb_typeof(p_catalog->category) is distinct from 'array' then raise exception '분류 목록이 올바르지 않습니다.'; end if;
    if jsonb_array_length(p_catalog->category)>150 then raise exception '분류는 최대 150개까지 등록할 수 있습니다.'; end if;
    arr:='[]'::jsonb; seen:='{}'::text[];
    for item in select value from jsonb_array_elements(p_catalog->category) loop
      code:=item->>'code'; label:=btrim(coalesce(item->>'label',''));
      if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'code') is distinct from 'string' or jsonb_typeof(item->'label') is distinct from 'string' or code is null or code='' or code=any(seen) or jsonb_typeof(item->'active') is distinct from 'boolean' or label='' or length(label)>80 then raise exception '중복 또는 잘못된 분류 항목입니다.'; end if;
      if not exists(select 1 from jsonb_array_elements(old_cfg->category) e where e->>'code'=code) and (code !~ '^[a-z][a-z0-9_-]{0,47}$' or code='veneer') then raise exception '분류 식별자는 영문 소문자·숫자·하이픈·밑줄만 사용할 수 있습니다.'; end if;
      seen:=array_append(seen,code);
      arr:=arr||jsonb_build_array(jsonb_build_object('code',code,'label',label,'active',item->'active'));
    end loop;
    -- Never physically remove existing codes. Old media/session tags still resolve.
    for old_item in select value from jsonb_array_elements(old_cfg->category) loop
      if not (old_item->>'code'=any(seen)) then arr:=arr||jsonb_build_array(old_item||'{"active":false}'::jsonb); end if;
    end loop;
    if category in ('floor_types','space_types') and not exists(select 1 from jsonb_array_elements(arr) e where e->>'code'='other' and e->'active'='true'::jsonb) then raise exception '기타 분류는 항상 사용 가능해야 합니다.'; end if;
    if not exists(select 1 from jsonb_array_elements(arr) e where e->'active'='true'::jsonb) then raise exception '한 개 이상의 사용 중인 분류가 필요합니다.'; end if;
    if jsonb_array_length(arr)>150 then raise exception '보관 항목을 포함해 최대 150개입니다.'; end if;
    cfg:=jsonb_set(cfg,array[category],arr,true);
  end loop;
  logo:=nullif(p_catalog->>'logo','');
  if logo is not null and (length(logo)>68300 or logo !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$') then raise exception '로고는 50KB 이하 PNG/JPG/WebP 이미지여야 합니다.'; end if;
  next_revision:=(old_cfg->>'revision')::integer+1;
  cfg:=cfg||jsonb_build_object('revision',next_revision,'logo',logo);
  update public.sites set catalog_config=cfg,updated_at=clock_timestamp() where id=p_site;
  return cfg;
end $$;
revoke all on function public.hospital_save_site_catalog(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.hospital_save_site_catalog(uuid,integer,jsonb) to anon,authenticated;

-- Replace closed enums with site catalog validation. Other is the required default.
alter table public.signage_groups drop constraint if exists signage_groups_care_type_check;
alter table public.floor_spaces drop constraint if exists floor_spaces_space_type_check;
create or replace function public.enforce_site_catalog_type()
returns trigger language plpgsql security definer set search_path=public as $$
declare category text; code text;
begin
  if tg_table_name='signage_groups' then category:='floor_types'; code:=new.care_type;
  else category:='space_types'; code:=new.space_type; end if;
  -- Existing inactive codes may still be retained/restored, but a code from another hospital is invalid.
  if not public.site_catalog_has_code(new.site_id,category,code,false) then raise exception '이 병원에 등록되지 않은 분류입니다.' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.enforce_site_catalog_type() from public,anon,authenticated;
drop trigger if exists signage_groups_site_catalog_guard on public.signage_groups;
create trigger signage_groups_site_catalog_guard before insert or update of site_id,care_type on public.signage_groups for each row execute function public.enforce_site_catalog_type();
drop trigger if exists floor_spaces_site_catalog_guard on public.floor_spaces;
create trigger floor_spaces_site_catalog_guard before insert or update of site_id,space_type on public.floor_spaces for each row execute function public.enforce_site_catalog_type();

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
  v_care text:=coalesce(nullif(btrim(p_care),''),'other');
begin
  if not public.can_manage_site(p_site) then raise exception 'not allowed'; end if;
  if v_name is null then raise exception '층 이름을 입력하세요'; end if;
  if not public.site_catalog_has_code(p_site,'floor_types',v_care,true) and not exists(select 1 from public.signage_groups where id=p_group and site_id=p_site and care_type=v_care) then raise exception '이 병원에서 사용 가능한 층 유형을 선택하세요.'; end if;
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

create or replace function public.staff_quick_set_room(p_room uuid,p_treatment text,p_age_group text default null,p_gender text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_mode text; v_site uuid:=public.manageable_room_site(p_room);
begin
  if not public.is_member() or v_site is null or not public.staff_can_remote_control_room(p_room) then raise exception 'not allowed'; end if;
  if not public.site_catalog_has_code(v_site,'treatments',p_treatment,true) then raise exception '이 병원에서 사용 가능한 진료 항목을 선택하세요.'; end if;
  select room_mode into v_mode from public.rooms where id=p_room and site_id=v_site for update;
  if not found then raise exception '진료실을 찾을 수 없습니다'; end if;
  if v_mode not in ('treatment','consultation') then raise exception '맞춤 송출이 가능한 공간이 아닙니다'; end if;
  if exists(select 1 from public.patient_sessions where site_id=v_site and room_id=p_room and status in ('assigned','in_progress')) then raise exception '등록 환자가 배정된 진료실입니다. 환자 관리에서 변경하세요'; end if;
  update public.rooms set session_age_group=nullif(trim(coalesce(p_age_group,'')),''),session_gender=nullif(trim(coalesce(p_gender,'')),''),session_treatment=p_treatment,
    session_tags=array_remove(array[nullif(trim(coalesce(p_age_group,'')),''),nullif(trim(coalesce(p_gender,'')),''),p_treatment]::text[],null),session_started_at=clock_timestamp()
  where id=p_room and site_id=v_site;
end $$;

create or replace function public.staff_create_patient(p_label text,p_age_group text,p_gender text,p_treatment text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_queue bigint; v_site uuid;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  v_site:=coalesce(public.pin_session_site_id(),public.default_site_id());
  if v_site is null or not public.can_manage_site(v_site) then raise exception '병원을 지정하세요.'; end if;
  if not public.site_catalog_has_code(v_site,'treatments',p_treatment,true) then raise exception '이 병원에서 사용 가능한 진료 항목을 선택하세요.'; end if;
  insert into public.patient_sessions(site_id,label,age_group,gender,treatment)
  values(v_site,nullif(trim(coalesce(p_label,'')),''),nullif(trim(coalesce(p_age_group,'')),''),nullif(trim(coalesce(p_gender,'')),''),p_treatment)
  returning id,queue_no into v_id,v_queue;
  update public.patient_sessions set label=coalesce(label,'대기 '||lpad(v_queue::text,3,'0')) where id=v_id;
  return v_id;
end $$;

CREATE OR REPLACE FUNCTION public.admin_import_site_config(p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_site uuid; g jsonb; r jsonb; sp jsonb; v_groups int:=0; v_rooms int:=0; v_spaces int:=0;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  v_site:=coalesce(nullif(p_config#>>'{site,id}','')::uuid,public.default_site_id());
  if not exists(select 1 from public.sites where id=v_site) then raise exception 'site not found'; end if;
  if jsonb_typeof(p_config#>'{site,catalog_config}')='object' then
    perform public.hospital_save_site_catalog(v_site,(select (catalog_config->>'revision')::integer from public.sites where id=v_site),p_config#>'{site,catalog_config}');
  end if;
  update public.sites set name=coalesce(nullif(p_config#>>'{site,name}',''),name),building_label=coalesce(nullif(p_config#>>'{site,building_label}',''),building_label),updated_at=clock_timestamp() where id=v_site;
  if jsonb_typeof(p_config->'settings')='object' then insert into public.site_settings(site_id,floorplan_assets,operating_config,updated_at) values(v_site,coalesce(p_config#>'{settings,floorplan_assets}','{}'::jsonb),coalesce(p_config#>'{settings,operating_config}','{}'::jsonb),clock_timestamp()) on conflict(site_id) do update set floorplan_assets=excluded.floorplan_assets,operating_config=excluded.operating_config,updated_at=clock_timestamp(); end if;
  if jsonb_typeof(p_config->'groups')='array' then for g in select * from jsonb_array_elements(p_config->'groups') loop update public.signage_groups set name=coalesce(nullif(g->>'name',''),name),kind=coalesce(nullif(g->>'kind',''),kind),floor_number=coalesce((g->>'floor_number')::smallint,floor_number),care_type=coalesce(nullif(g->>'care_type',''),care_type),signage_purpose=g->>'signage_purpose',target_audience=g->>'target_audience',waiting_area_note=g->>'waiting_area_note',signage_reason=g->>'signage_reason',content_intro=g->>'content_intro',content_topics=coalesce(array(select jsonb_array_elements_text(coalesce(g->'content_topics','[]'::jsonb))),'{}'::text[]),role_label=g->>'role_label',default_playlist_id=nullif(g->>'default_playlist_id','')::uuid,sort_order=coalesce((g->>'sort_order')::int,sort_order) where id=(g->>'id')::uuid and site_id=v_site; if found then v_groups:=v_groups+1; end if; end loop; end if;
  if jsonb_typeof(p_config->'rooms')='array' then for r in select * from jsonb_array_elements(p_config->'rooms') loop update public.rooms set name=coalesce(nullif(r->>'name',''),name),group_id=nullif(r->>'group_id','')::uuid,room_mode=coalesce(nullif(r->>'room_mode',''),room_mode),map_x_pct=nullif(r->>'map_x_pct','')::numeric,map_y_pct=nullif(r->>'map_y_pct','')::numeric,display_control_mode=coalesce(nullif(r->>'display_control_mode',''),display_control_mode),display_note=r->>'display_note' where id=(r->>'id')::uuid and site_id=v_site; if found then v_rooms:=v_rooms+1; end if; end loop; end if;
  if jsonb_typeof(p_config->'spaces')='array' then delete from public.floor_spaces where site_id=v_site; for sp in select * from jsonb_array_elements(p_config->'spaces') loop insert into public.floor_spaces(id,site_id,group_id,name,space_type,x_pct,y_pct,width_pct,height_pct,sort_order) values(coalesce(nullif(sp->>'id','')::uuid,gen_random_uuid()),v_site,nullif(sp->>'group_id','')::uuid,coalesce(nullif(sp->>'name',''),'공간'),coalesce(nullif(sp->>'space_type',''),'other'),coalesce((sp->>'x_pct')::numeric,0),coalesce((sp->>'y_pct')::numeric,0),coalesce((sp->>'width_pct')::numeric,10),coalesce((sp->>'height_pct')::numeric,10),coalesce((sp->>'sort_order')::int,0)); v_spaces:=v_spaces+1; end loop; end if;
  perform public.audit_event(v_site,'restore','site_config',v_site::text,'사이트 설정 백업 복원',null,jsonb_build_object('groups',v_groups,'rooms',v_rooms,'spaces',v_spaces));
  return jsonb_build_object('ok',true,'groups',v_groups,'rooms',v_rooms,'spaces',v_spaces);
end $function$;

-- One transaction: no partially-created hospital if PIN or optional floor setup fails.
create or replace function public.admin_onboard_site(p_name text,p_code text,p_pin text,p_building text default 'MAIN BUILDING',p_floors integer default 1)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb; v_site uuid; n integer;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then raise exception '병원 관리자 PIN은 4~6자리 숫자여야 합니다.'; end if;
  if p_floors is null or p_floors<0 or p_floors>30 then raise exception '초기 층 수는 0~30이어야 합니다.'; end if;
  result:=public.admin_create_site(p_name,p_code,p_building);
  if result->>'ok'<>'true' or result->>'existing'='true' then return result; end if;
  v_site:=(result#>>'{site,id}')::uuid;
  perform public.admin_set_site_staff_pin(v_site,p_pin);
  for n in 1..p_floors loop perform public.hospital_create_floor(v_site,n::smallint,null); end loop;
  return result||jsonb_build_object('floor_count',p_floors);
end $$;
revoke all on function public.admin_onboard_site(text,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.admin_onboard_site(text,text,text,text,integer) to anon,authenticated;

create or replace function public.app_db_version()
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('version','2.36.0','features',jsonb_build_array('pairing_v2','display_key_reset','pairing_v3','site_catalog_v1'))
$$;
insert into public.schema_version(version,applied_at) values('2.36.0',clock_timestamp()) on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst,'reload schema';
commit;
