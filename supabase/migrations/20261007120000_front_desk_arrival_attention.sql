-- Business-date aware arrival alerts for front desk and management dashboards.

create or replace function public.get_arrival_attention(target_hotel_id uuid)
returns table (
  reservation_id uuid,
  reservation_number text,
  guest_name text,
  room_number text,
  room_type_name text,
  check_in_date date,
  arrival_state text
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  target_business_date date;
begin
  if not public.has_hotel_permission(target_hotel_id, 'reservations.read') then
    raise exception 'Not authorised to view expected arrivals';
  end if;

  target_business_date := public.hotel_business_date(target_hotel_id);
  if target_business_date is null then raise exception 'Hotel business date is unavailable'; end if;

  return query
  select r.id,
    r.reservation_number,
    g.full_name,
    rm.room_number,
    rt.name,
    r.check_in_date,
    case when r.check_in_date < target_business_date then 'overdue' else 'due_today' end
  from public.reservations r
  join public.guests g on g.id = r.guest_id and g.hotel_id = r.hotel_id
  join public.room_types rt on rt.id = r.room_type_id and rt.hotel_id = r.hotel_id
  left join public.rooms rm on rm.id = r.room_id and rm.hotel_id = r.hotel_id
  where r.hotel_id = target_hotel_id
    and r.status in ('pending', 'confirmed')
    and r.check_in_date <= target_business_date
  order by r.check_in_date, g.full_name, r.reservation_number;
end;
$$;

revoke all on function public.get_arrival_attention(uuid) from public, anon;
grant execute on function public.get_arrival_attention(uuid) to authenticated;
