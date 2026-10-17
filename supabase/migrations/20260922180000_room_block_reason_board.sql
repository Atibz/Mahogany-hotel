-- Surface the recorded operational reason alongside a blocked room's status.

create or replace view public.room_board as
select
  r.id,
  r.hotel_id,
  r.room_number,
  r.room_type_id,
  rt.name as room_type_name,
  coalesce(r.rate_override_kobo, rt.base_rate_kobo) as current_rate_kobo,
  case
    when not r.active or r.blocked_at is not null then 'blocked'
    when exists (select 1 from public.stays s where s.room_id = r.id and s.status = 'checked_in') then 'occupied'
    when exists (
      select 1 from public.reservations rv
      where rv.room_id = r.id
        and rv.status in ('pending', 'confirmed')
        and daterange(rv.check_in_date, rv.check_out_date, '[)') @> public.hotel_business_date(r.hotel_id)
    ) then 'reserved'
    else 'available'
  end as status,
  rt.size_sqft,
  rt.capacity,
  coalesce(r.blocked_reason, case when not r.active then 'Room is inactive' end) as blocked_reason
from public.rooms r
join public.room_types rt on rt.id = r.room_type_id;

alter view public.room_board set (security_invoker = true);
grant select on public.room_board to authenticated;
