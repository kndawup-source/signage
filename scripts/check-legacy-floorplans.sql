-- Read-only preflight. Any returned row requires verified migration before deployment.
select s.site_id, e.key as floor, k.v as object_key
from public.site_settings s
cross join lateral jsonb_each(coalesce(s.floorplan_assets,'{}'::jsonb)) e
cross join lateral (select coalesce(e.value->>'key',e.value->>'object_key',e.value->>'path',case when jsonb_typeof(e.value)='string' then e.value#>>'{}' end) v) k
where k.v is not null and (e.key !~ '^[0-9]{1,2}$' or k.v not like ('floorplans/'||s.site_id::text||'/'||lpad(e.key,2,'0')||'/%'))
union all
select site_id,floor_number::text,object_key from public.floorplan_versions
where object_key not like ('floorplans/'||site_id::text||'/'||lpad(floor_number::text,2,'0')||'/%');
