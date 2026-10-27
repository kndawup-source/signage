-- Clinic Signage v2.34.49 — editable floor names + content strategy
begin;

alter table public.signage_groups add column if not exists content_intro text;
alter table public.signage_groups add column if not exists content_topics text[] not null default '{}';
alter table public.signage_groups add column if not exists role_label text;

-- Floor names are labels, not identifiers. The same label can be used on multiple floors.
drop index if exists public.signage_groups_site_name_uidx;
create index if not exists signage_groups_site_name_idx on public.signage_groups(site_id,lower(name));

-- Floor number is the stable unique key within one hospital.
do $$
begin
  if exists (
    select 1 from public.signage_groups
    where kind='floor' and floor_number is not null
    group by site_id,floor_number having count(*)>1
  ) then
    raise exception 'duplicate floor numbers exist; resolve them before v2.34.49';
  end if;
end $$;
create unique index if not exists signage_groups_site_floor_uidx
  on public.signage_groups(site_id,floor_number)
  where kind='floor' and floor_number is not null;

-- Seed the requested MINISH content strategy as editable DB data.
with cfg(floor_number,name,content_intro,content_topics,role_label,signage_purpose,target_audience,waiting_area_note,signage_reason,care_type) as (
  values
    (1,'초진 고객 / 닥터미니쉬 오프라인 / 디스플레이 공간','처음 온 고객이 병원과 공간을 이해하는 층',array['차량 입·출차 / 발렛 안내','미카 소개 · 이동 · 충전','닥터미니쉬 오프라인 공간 안내','초진 고객 동선 안내']::text[],'첫 안내','첫 방문 고객의 이동과 공간 이해','초진 고객','1F 진입·이동 구간','처음 방문한 고객이 병원과 공간을 빠르게 이해하도록 안내','common'),
    (2,'재진 고객 / 대기 공간','다시 방문한 고객이 기다리며 필요한 정보를 보는 층',array['치료 전후 사례','관리 방법','재진 고객 안내','FAQ']::text[],'이해','재진 고객의 치료 이해와 대기 경험','재진 고객','2F 대기 공간','대기 시간에 필요한 치료 정보와 관리 정보를 제공','common'),
    (4,'일반교정과','교정 고객에게 필요한 정보',array['교정 과정','치료 사례','관리 방법','자주 묻는 질문']::text[],'교정 안내','교정 치료 과정과 관리 안내','교정 고객',null,'교정 고객이 치료 과정과 관리 방법을 이해하도록 안내','general'),
    (5,'기공소','치료 결과를 만드는 과정',array['기공 제작 과정','정밀 제작','디지털 제작 과정','기공팀 소개']::text[],'제작 과정','치료 결과가 만들어지는 제작 과정 소개','병원 방문 고객 / 관계자',null,'기공 제작 과정을 보여주어 치료 결과에 대한 이해를 높임','support'),
    (6,'기공소','기공 기술과 완성도',array['실제 제작 과정','품질 관리','재료 / 정밀도','기공 기술']::text[],'기술 신뢰','기공 기술과 품질 관리에 대한 신뢰 형성','병원 방문 고객 / 관계자',null,'정밀도와 품질 관리 과정을 보여주어 기술 신뢰를 형성','support'),
    (7,'예방과','치료 이후까지 관리',array['예방 관리','구강 관리','정기 검진','유지 관리']::text[],'예방','치료 이후의 예방과 유지 관리 안내','예방·유지관리 고객',null,'치료 이후에도 지속적인 관리가 필요함을 안내','general'),
    (8,'미니쉬 진료층','현재 고객에게 필요한 영상을 맞춤 송출',array['현재 치료 관련 영상','미니쉬 전후 사례','치료 과정','치료 후 관리']::text[],'고객 맞춤','현재 치료 단계에 맞는 개인화 영상 송출','미니쉬 진료 고객',null,'현재 고객의 치료 내용에 맞춰 필요한 영상을 송출','minish'),
    (9,'미니쉬 진료층','현재 고객에게 필요한 영상을 맞춤 송출',array['현재 치료 관련 영상','미니쉬 전후 사례','치료 과정','치료 후 관리']::text[],'고객 맞춤','현재 치료 단계에 맞는 개인화 영상 송출','미니쉬 진료 고객',null,'현재 고객의 치료 내용에 맞춰 필요한 영상을 송출','minish'),
    (10,'미니쉬 진료층','현재 고객에게 필요한 영상을 맞춤 송출',array['현재 치료 관련 영상','미니쉬 전후 사례','치료 과정','치료 후 관리']::text[],'고객 맞춤','현재 치료 단계에 맞는 개인화 영상 송출','미니쉬 진료 고객',null,'현재 고객의 치료 내용에 맞춰 필요한 영상을 송출','minish'),
    (13,'컨퍼런스홀','병원의 전문성과 활동',array['세미나','학술 활동','의료진 교육','국내외 협업']::text[],'전문성','병원의 학술·교육 활동과 전문성 전달','세미나·교육·방문 고객',null,'학술 활동과 협업을 통해 병원의 전문성을 전달','support'),
    (14,'미니쉬 라운지','치료 경험을 마무리하는 공간',array['브랜드 콘텐츠','고객 스토리','라이프스타일 콘텐츠','미니쉬 경험']::text[],'경험 확장','치료 이후 브랜드 경험 확장','라운지 이용 고객','14F 라운지','치료 경험을 브랜드와 라이프스타일 경험으로 자연스럽게 확장','common')
), target as (
  select id from public.sites where code='minish' limit 1
)
update public.signage_groups g
set name=cfg.name, content_intro=cfg.content_intro, content_topics=cfg.content_topics,
    role_label=cfg.role_label, signage_purpose=cfg.signage_purpose,
    target_audience=cfg.target_audience, waiting_area_note=cfg.waiting_area_note,
    signage_reason=cfg.signage_reason, care_type=cfg.care_type
from cfg,target
where g.site_id=target.id and g.kind='floor' and g.floor_number=cfg.floor_number;

with cfg(floor_number,name,content_intro,content_topics,role_label,signage_purpose,target_audience,waiting_area_note,signage_reason,care_type) as (
  values
    (1,'초진 고객 / 닥터미니쉬 오프라인 / 디스플레이 공간','처음 온 고객이 병원과 공간을 이해하는 층',array['차량 입·출차 / 발렛 안내','미카 소개 · 이동 · 충전','닥터미니쉬 오프라인 공간 안내','초진 고객 동선 안내']::text[],'첫 안내','첫 방문 고객의 이동과 공간 이해','초진 고객','1F 진입·이동 구간','처음 방문한 고객이 병원과 공간을 빠르게 이해하도록 안내','common'),
    (2,'재진 고객 / 대기 공간','다시 방문한 고객이 기다리며 필요한 정보를 보는 층',array['치료 전후 사례','관리 방법','재진 고객 안내','FAQ']::text[],'이해','재진 고객의 치료 이해와 대기 경험','재진 고객','2F 대기 공간','대기 시간에 필요한 치료 정보와 관리 정보를 제공','common'),
    (4,'일반교정과','교정 고객에게 필요한 정보',array['교정 과정','치료 사례','관리 방법','자주 묻는 질문']::text[],'교정 안내','교정 치료 과정과 관리 안내','교정 고객',null,'교정 고객이 치료 과정과 관리 방법을 이해하도록 안내','general'),
    (5,'기공소','치료 결과를 만드는 과정',array['기공 제작 과정','정밀 제작','디지털 제작 과정','기공팀 소개']::text[],'제작 과정','치료 결과가 만들어지는 제작 과정 소개','병원 방문 고객 / 관계자',null,'기공 제작 과정을 보여주어 치료 결과에 대한 이해를 높임','support'),
    (6,'기공소','기공 기술과 완성도',array['실제 제작 과정','품질 관리','재료 / 정밀도','기공 기술']::text[],'기술 신뢰','기공 기술과 품질 관리에 대한 신뢰 형성','병원 방문 고객 / 관계자',null,'정밀도와 품질 관리 과정을 보여주어 기술 신뢰를 형성','support'),
    (7,'예방과','치료 이후까지 관리',array['예방 관리','구강 관리','정기 검진','유지 관리']::text[],'예방','치료 이후의 예방과 유지 관리 안내','예방·유지관리 고객',null,'치료 이후에도 지속적인 관리가 필요함을 안내','general'),
    (8,'미니쉬 진료층','현재 고객에게 필요한 영상을 맞춤 송출',array['현재 치료 관련 영상','미니쉬 전후 사례','치료 과정','치료 후 관리']::text[],'고객 맞춤','현재 치료 단계에 맞는 개인화 영상 송출','미니쉬 진료 고객',null,'현재 고객의 치료 내용에 맞춰 필요한 영상을 송출','minish'),
    (9,'미니쉬 진료층','현재 고객에게 필요한 영상을 맞춤 송출',array['현재 치료 관련 영상','미니쉬 전후 사례','치료 과정','치료 후 관리']::text[],'고객 맞춤','현재 치료 단계에 맞는 개인화 영상 송출','미니쉬 진료 고객',null,'현재 고객의 치료 내용에 맞춰 필요한 영상을 송출','minish'),
    (10,'미니쉬 진료층','현재 고객에게 필요한 영상을 맞춤 송출',array['현재 치료 관련 영상','미니쉬 전후 사례','치료 과정','치료 후 관리']::text[],'고객 맞춤','현재 치료 단계에 맞는 개인화 영상 송출','미니쉬 진료 고객',null,'현재 고객의 치료 내용에 맞춰 필요한 영상을 송출','minish'),
    (13,'컨퍼런스홀','병원의 전문성과 활동',array['세미나','학술 활동','의료진 교육','국내외 협업']::text[],'전문성','병원의 학술·교육 활동과 전문성 전달','세미나·교육·방문 고객',null,'학술 활동과 협업을 통해 병원의 전문성을 전달','support'),
    (14,'미니쉬 라운지','치료 경험을 마무리하는 공간',array['브랜드 콘텐츠','고객 스토리','라이프스타일 콘텐츠','미니쉬 경험']::text[],'경험 확장','치료 이후 브랜드 경험 확장','라운지 이용 고객','14F 라운지','치료 경험을 브랜드와 라이프스타일 경험으로 자연스럽게 확장','common')
), target as (select id from public.sites where code='minish' limit 1)
insert into public.signage_groups(site_id,name,kind,floor_number,care_type,content_intro,content_topics,role_label,signage_purpose,target_audience,waiting_area_note,signage_reason,sort_order)
select target.id,cfg.name,'floor',cfg.floor_number,cfg.care_type,cfg.content_intro,cfg.content_topics,cfg.role_label,cfg.signage_purpose,cfg.target_audience,cfg.waiting_area_note,cfg.signage_reason,100-cfg.floor_number
from cfg,target
where not exists(select 1 from public.signage_groups g where g.site_id=target.id and g.kind='floor' and g.floor_number=cfg.floor_number);

with target as (select id from public.sites where code='minish' limit 1)
update public.signage_groups g
set content_intro='짧은 대기 시간에 신뢰를 쌓는 콘텐츠',
    content_topics=array['미니쉬 전후 영상','셀럽 직접 작성 편지','실제 고객 메시지','브랜드 필름']::text[],
    role_label='신뢰', signage_purpose='이동 대기 시간의 브랜드 신뢰 형성',
    target_audience='병원 내 이동 고객', signage_reason='짧은 이동 대기 시간에도 신뢰를 쌓는 콘텐츠를 송출'
from target where g.site_id=target.id and g.kind='zone' and lower(g.name)=lower('엘리베이터 앞');

with target as (select id from public.sites where code='minish' limit 1)
insert into public.signage_groups(site_id,name,kind,floor_number,care_type,content_intro,content_topics,role_label,signage_purpose,target_audience,signage_reason,sort_order)
select target.id,'엘리베이터 앞','zone',null,'common','짧은 대기 시간에 신뢰를 쌓는 콘텐츠',array['미니쉬 전후 영상','셀럽 직접 작성 편지','실제 고객 메시지','브랜드 필름']::text[],'신뢰','이동 대기 시간의 브랜드 신뢰 형성','병원 내 이동 고객','짧은 이동 대기 시간에도 신뢰를 쌓는 콘텐츠를 송출',1000
from target
where not exists(select 1 from public.signage_groups g where g.site_id=target.id and g.kind='zone' and lower(g.name)=lower('엘리베이터 앞'));

create or replace function public.hospital_reception_state(p_site uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_site uuid; v_rooms jsonb; v_groups jsonb; v_patients jsonb; v_broadcast jsonb; v_playlists jsonb; v_videos jsonb; v_items jsonb; v_rules jsonb; v_site_row jsonb; v_floorplans jsonb; v_spaces jsonb; v_versions jsonb; v_settings jsonb;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  v_site:=case when public.is_admin() then p_site else public.pin_session_site_id() end;
  if v_site is null or (not public.is_admin() and p_site is not null and p_site<>v_site) or not public.can_manage_site(v_site) then raise exception 'not allowed'; end if;
  select to_jsonb(s) into v_site_row from public.sites s where s.id=v_site; if v_site_row is null then raise exception 'site not found'; end if;
  select coalesce(ss.floorplan_assets,'{}'::jsonb),coalesce(ss.operating_config,'{}'::jsonb) into v_floorplans,v_settings from public.site_settings ss where ss.site_id=v_site;
  select coalesce(jsonb_agg(to_jsonb(fs) order by fs.sort_order,fs.created_at),'[]'::jsonb) into v_spaces from public.floor_spaces fs where fs.site_id=v_site;
  select coalesce(jsonb_agg(to_jsonb(fv) order by fv.created_at desc),'[]'::jsonb) into v_versions from public.floorplan_versions fv where fv.site_id=v_site;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'site_id',r.site_id,'name',r.name,'sort_order',r.sort_order,'group_id',r.group_id,'group_name',g.name,'room_mode',r.room_mode,'last_seen_at',r.last_seen_at,'player_status',coalesce(r.player_status,'{}'::jsonb),'session_timeout_min',r.session_timeout_min,'session_started_at',r.session_started_at,'session_age_group',r.session_age_group,'session_gender',r.session_gender,'session_treatment',r.session_treatment,'default_playlist_id',r.default_playlist_id,'manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids,'map_x_pct',r.map_x_pct,'map_y_pct',r.map_y_pct,'display_control_mode',r.display_control_mode,'manual_check_status',r.manual_check_status,'manual_checked_at',r.manual_checked_at,'manual_checked_by',r.manual_checked_by,'display_note',r.display_note) order by coalesce(g.sort_order,2147483647),r.sort_order,r.created_at),'[]'::jsonb) into v_rooms from public.rooms r left join public.signage_groups g on g.id=r.group_id where r.site_id=v_site;
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'site_id',g.site_id,'name',g.name,'kind',g.kind,'floor_number',g.floor_number,'care_type',g.care_type,'signage_purpose',g.signage_purpose,'target_audience',g.target_audience,'waiting_area_note',g.waiting_area_note,'signage_reason',g.signage_reason,'content_intro',g.content_intro,'content_topics',g.content_topics,'role_label',g.role_label,'default_playlist_id',g.default_playlist_id,'sort_order',g.sort_order) order by g.sort_order,g.floor_number,g.created_at),'[]'::jsonb) into v_groups from public.signage_groups g where g.site_id=v_site;
  select coalesce(jsonb_agg(to_jsonb(x) order by case x.status when 'in_progress' then 0 when 'assigned' then 1 when 'waiting' then 2 else 3 end,x.waiting_started_at),'[]'::jsonb) into v_patients from (select * from public.patient_sessions where site_id=v_site and (status in ('waiting','assigned','in_progress') or (status='completed' and completed_at>=date_trunc('day',clock_timestamp())))) x;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'site_id',p.site_id,'name',p.name,'kind',p.kind,'active',p.active,'sort_order',p.sort_order,'target_treatment',p.target_treatment,'target_age',p.target_age,'target_gender',p.target_gender) order by p.sort_order,p.created_at),'[]'::jsonb) into v_playlists from public.playlists p where p.active and (p.site_id is null or p.site_id=v_site);
  select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'site_id',v.site_id,'title',v.title,'active',v.active,'duration_sec',v.duration_sec,'thumbnail_data_url',v.thumbnail_data_url,'target_treatment',v.target_treatment,'target_age',v.target_age,'target_gender',v.target_gender) order by v.sort_order,v.created_at),'[]'::jsonb) into v_videos from public.videos v where v.active and (v.site_id is null or v.site_id=v_site) and (v.source<>'local' or v.available);
  select coalesce(jsonb_agg(jsonb_build_object('playlist_id',pi.playlist_id,'video_id',pi.video_id,'sort_order',pi.sort_order) order by pi.playlist_id,pi.sort_order,pi.created_at),'[]'::jsonb) into v_items from public.playlist_items pi join public.playlists p on p.id=pi.playlist_id where p.site_id is null or p.site_id=v_site;
  select coalesce(jsonb_agg(jsonb_build_object('room_id',rr.room_id,'video_id',rr.video_id,'enabled',rr.enabled,'sort_order',rr.sort_order,'starts_at',rr.starts_at,'ends_at',rr.ends_at,'updated_at',rr.updated_at)),'[]'::jsonb) into v_rules from public.room_video_rules rr join public.rooms r on r.id=rr.room_id where r.site_id=v_site;
  select jsonb_build_object('active',active,'video_ids',video_ids,'notice_text',notice_text,'starts_at',starts_at,'ends_at',ends_at,'revision',revision) into v_broadcast from public.site_broadcasts where site_id=v_site;
  return jsonb_build_object('site',v_site_row,'site_settings',coalesce(v_settings,'{}'::jsonb),'floorplan_assets',coalesce(v_floorplans,'{}'::jsonb),'floorplan_versions',coalesce(v_versions,'[]'::jsonb),'spaces',coalesce(v_spaces,'[]'::jsonb),'rooms',v_rooms,'groups',v_groups,'patients',v_patients,'playlists',v_playlists,'videos',v_videos,'playlist_items',v_items,'room_video_rules',v_rules,'broadcast',coalesce(v_broadcast,'{}'::jsonb),'server_time',clock_timestamp());
end $$;
revoke all on function public.hospital_reception_state(uuid) from public;
grant execute on function public.hospital_reception_state(uuid) to anon,authenticated;
insert into public.schema_version(version,applied_at) values('2.34.49',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;
notify pgrst, 'reload schema';
commit;
