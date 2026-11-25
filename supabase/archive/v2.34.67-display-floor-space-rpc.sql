begin;

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
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'site_id',r.site_id,'name',r.name,'sort_order',r.sort_order,'group_id',r.group_id,'group_name',g.name,'room_mode',r.room_mode,'last_seen_at',r.last_seen_at,'player_status',coalesce(r.player_status,'{}'::jsonb),'session_timeout_min',r.session_timeout_min,'session_started_at',r.session_started_at,'session_age_group',r.session_age_group,'session_gender',r.session_gender,'session_treatment',r.session_treatment,'default_playlist_id',r.default_playlist_id,'manual_active',r.manual_active,'manual_video_ids',r.manual_video_ids,'map_x_pct',r.map_x_pct,'map_y_pct',r.map_y_pct,'display_control_mode',r.display_control_mode,'manual_check_status',r.manual_check_status,'manual_checked_at',r.manual_checked_at,'manual_checked_by',r.manual_checked_by,'display_note',r.display_note,'floor_space_id',r.floor_space_id) order by coalesce(g.sort_order,2147483647),r.sort_order,r.created_at),'[]'::jsonb) into v_rooms from public.rooms r left join public.signage_groups g on g.id=r.group_id where r.site_id=v_site;
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'site_id',g.site_id,'name',g.name,'kind',g.kind,'floor_number',g.floor_number,'care_type',g.care_type,'signage_purpose',g.signage_purpose,'target_audience',g.target_audience,'waiting_area_note',g.waiting_area_note,'signage_reason',g.signage_reason,'content_intro',g.content_intro,'content_topics',g.content_topics,'role_label',g.role_label,'default_playlist_id',g.default_playlist_id,'sort_order',g.sort_order) order by g.sort_order,g.floor_number,g.created_at),'[]'::jsonb) into v_groups from public.signage_groups g where g.site_id=v_site;
  select coalesce(jsonb_agg(to_jsonb(x) order by case x.status when 'in_progress' then 0 when 'assigned' then 1 when 'waiting' then 2 else 3 end,x.waiting_started_at),'[]'::jsonb) into v_patients from (select * from public.patient_sessions where site_id=v_site and (status in ('waiting','assigned','in_progress') or (status='completed' and completed_at>=date_trunc('day',clock_timestamp())))) x;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'site_id',p.site_id,'name',p.name,'kind',p.kind,'active',p.active,'sort_order',p.sort_order,'target_treatment',p.target_treatment,'target_age',p.target_age,'target_gender',p.target_gender) order by p.sort_order,p.created_at),'[]'::jsonb) into v_playlists from public.playlists p where p.active and (p.site_id is null or p.site_id=v_site);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',v.id,
    'site_id',v.site_id,
    'title',v.title,
    'active',v.active,
    'duration_sec',v.duration_sec,
    'thumbnail_data_url',v.thumbnail_data_url,
    'url',v.url,
    'source',v.source,
    'storage_path',v.storage_path,
    'file_path',v.file_path,
    'target_treatment',v.target_treatment,
    'target_age',v.target_age,
    'target_gender',v.target_gender
  ) order by v.sort_order,v.created_at),'[]'::jsonb) into v_videos
  from public.videos v
  where v.active and (v.site_id is null or v.site_id=v_site) and (v.source<>'local' or v.available);
  select coalesce(jsonb_agg(jsonb_build_object('playlist_id',pi.playlist_id,'video_id',pi.video_id,'sort_order',pi.sort_order) order by pi.playlist_id,pi.sort_order,pi.created_at),'[]'::jsonb) into v_items from public.playlist_items pi join public.playlists p on p.id=pi.playlist_id where p.site_id is null or p.site_id=v_site;
  select coalesce(jsonb_agg(jsonb_build_object('room_id',rr.room_id,'video_id',rr.video_id,'enabled',rr.enabled,'sort_order',rr.sort_order,'starts_at',rr.starts_at,'ends_at',rr.ends_at,'updated_at',rr.updated_at)),'[]'::jsonb) into v_rules from public.room_video_rules rr join public.rooms r on r.id=rr.room_id where r.site_id=v_site;
  select jsonb_build_object('active',active,'video_ids',video_ids,'notice_text',notice_text,'starts_at',starts_at,'ends_at',ends_at,'revision',revision) into v_broadcast from public.site_broadcasts where site_id=v_site;
  return jsonb_build_object('site',v_site_row,'site_settings',coalesce(v_settings,'{}'::jsonb),'floorplan_assets',coalesce(v_floorplans,'{}'::jsonb),'floorplan_versions',coalesce(v_versions,'[]'::jsonb),'spaces',coalesce(v_spaces,'[]'::jsonb),'rooms',v_rooms,'groups',v_groups,'patients',v_patients,'playlists',v_playlists,'videos',v_videos,'playlist_items',v_items,'room_video_rules',v_rules,'broadcast',coalesce(v_broadcast,'{}'::jsonb),'server_time',clock_timestamp());
end $$;

revoke all on function public.hospital_reception_state(uuid) from public;
grant execute on function public.hospital_reception_state(uuid) to anon,authenticated;

insert into public.schema_version(version,applied_at) values('2.34.67',clock_timestamp())
on conflict(version) do update set applied_at=excluded.applied_at;

notify pgrst, 'reload schema';
commit;
