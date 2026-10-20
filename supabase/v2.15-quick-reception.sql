-- Clinic Signage v2.15 — quick room customization without patient registration
-- Run once after v2.14. Safe to rerun.

create or replace function public.staff_quick_set_room(p_room uuid,p_treatment text,p_age_group text default null,p_gender text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_mode text;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  if nullif(trim(coalesce(p_treatment,'')),'') is null then raise exception '진료유형을 선택하세요'; end if;
  select room_mode into v_mode from public.rooms where id=p_room for update;
  if not found then raise exception '진료실을 찾을 수 없습니다'; end if;
  if v_mode not in ('treatment','consultation') then raise exception '맞춤 송출이 가능한 공간이 아닙니다'; end if;
  if exists(select 1 from public.patient_sessions where room_id=p_room and status in ('assigned','in_progress')) then
    raise exception '등록 환자가 배정된 진료실입니다. 환자 관리에서 변경하세요';
  end if;
  update public.rooms set
    session_age_group=nullif(trim(coalesce(p_age_group,'')),''),
    session_gender=nullif(trim(coalesce(p_gender,'')),''),
    session_treatment=case when p_treatment='veneer' then 'minish' else p_treatment end,
    session_tags=array_remove(array[nullif(trim(coalesce(p_age_group,'')),''),nullif(trim(coalesce(p_gender,'')),''),case when p_treatment='veneer' then 'minish' else p_treatment end]::text[],null),
    session_started_at=clock_timestamp()
  where id=p_room;
end $$;

create or replace function public.staff_quick_clear_room(p_room uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  if exists(select 1 from public.patient_sessions where room_id=p_room and status in ('assigned','in_progress')) then
    raise exception '등록 환자가 배정된 진료실입니다. 환자 관리에서 종료하세요';
  end if;
  update public.rooms set session_tags='{}',session_started_at=null,session_age_group=null,session_gender=null,session_treatment=null where id=p_room;
  if not found then raise exception '진료실을 찾을 수 없습니다'; end if;
end $$;

create or replace function public.staff_reception_state()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_rooms jsonb; v_patients jsonb; v_broadcast jsonb;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,'name',r.name,'sort_order',r.sort_order,'group_id',r.group_id,'group_name',g.name,'room_mode',r.room_mode,
    'last_seen_at',r.last_seen_at,'player_status',coalesce(r.player_status,'{}'::jsonb),'session_timeout_min',r.session_timeout_min,
    'session_started_at',r.session_started_at,'session_age_group',r.session_age_group,'session_gender',r.session_gender,'session_treatment',r.session_treatment
  ) order by coalesce(g.sort_order,2147483647),r.sort_order,r.created_at),'[]'::jsonb) into v_rooms
  from public.rooms r left join public.signage_groups g on g.id=r.group_id where r.room_mode in ('treatment','consultation');
  select coalesce(jsonb_agg(to_jsonb(x) order by case x.status when 'in_progress' then 0 when 'assigned' then 1 when 'waiting' then 2 else 3 end,x.waiting_started_at),'[]'::jsonb) into v_patients
  from (select * from public.patient_sessions where (status in ('waiting','assigned','in_progress')) or (status='completed' and completed_at>=date_trunc('day',clock_timestamp())) ) x;
  select jsonb_build_object('active',active,'notice_text',notice_text) into v_broadcast from public.broadcast where id=1;
  return jsonb_build_object('rooms',v_rooms,'patients',v_patients,'broadcast',coalesce(v_broadcast,'{}'::jsonb),'server_time',clock_timestamp());
end $$;

revoke all on function public.staff_quick_set_room(uuid,text,text,text) from public;
revoke all on function public.staff_quick_clear_room(uuid) from public;
grant execute on function public.staff_quick_set_room(uuid,text,text,text) to anon,authenticated;
grant execute on function public.staff_quick_clear_room(uuid) to anon,authenticated;
