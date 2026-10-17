-- Give the room board a per-room-type inventory summary. Counts are derived
-- from the same business-date-aware board used for individual room cards.

create or replace view public.room_type_occupancy_summary as
select
  rt.hotel_id,
  rt.id as room_type_id,
  rt.name as room_type_name,
  count(rb.id) as total_room_count,
  count(rb.id) filter (where rb.status <> 'blocked') as active_room_count,
  count(rb.id) filter (where rb.status = 'available') as available_room_count,
  count(rb.id) filter (where rb.status = 'reserved') as reserved_room_count,
  count(rb.id) filter (where rb.status = 'occupied') as occupied_room_count,
  count(rb.id) filter (where rb.status = 'blocked') as blocked_room_count
from public.room_types rt
left join public.room_board rb on rb.room_type_id = rt.id
group by rt.hotel_id, rt.id, rt.name;

alter view public.room_type_occupancy_summary set (security_invoker = true);
grant select on public.room_type_occupancy_summary to authenticated;
