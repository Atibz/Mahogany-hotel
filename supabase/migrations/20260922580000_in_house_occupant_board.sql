-- Front-desk visibility for current occupants and departure action.
-- Access requires the same room, stay, and folio permissions used by the
-- underlying operational screens; knowing the RPC URL is not sufficient.

create or replace function public.get_in_house_room_occupants(target_hotel_id uuid)
returns table (
  stay_id uuid,
  room_id uuid,
  room_number text,
  room_type_name text,
  guest_id uuid,
  guest_name text,
  guest_phone text,
  guest_email text,
  actual_check_in_date date,
  expected_check_out_date date,
  business_date date,
  departure_state text,
  days_overdue integer,
  folio_id uuid,
  folio_number text,
  balance_kobo bigint
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  current_business_date date := public.hotel_business_date(target_hotel_id);
begin
  if not public.has_hotel_permission(target_hotel_id, 'rooms.read')
     or not public.has_hotel_permission(target_hotel_id, 'stays.read')
     or not public.has_hotel_permission(target_hotel_id, 'folios.read') then
    raise exception 'Not authorised to view in-house occupants';
  end if;

  return query
  select
    s.id,
    r.id,
    r.room_number,
    rt.name,
    g.id,
    g.full_name,
    g.phone,
    g.email,
    s.actual_check_in_date,
    s.expected_check_out_date,
    current_business_date,
    case
      when s.expected_check_out_date < current_business_date then 'overdue'
      when s.expected_check_out_date = current_business_date then 'due_today'
      else 'in_house'
    end,
    greatest(current_business_date - s.expected_check_out_date, 0),
    gf.id,
    gf.folio_number,
    public.folio_balance(gf.id)
  from public.stays s
  join public.rooms r on r.id = s.room_id and r.hotel_id = s.hotel_id
  join public.room_types rt on rt.id = r.room_type_id and rt.hotel_id = s.hotel_id
  join public.guests g on g.id = s.guest_id and g.hotel_id = s.hotel_id
  join public.guest_folios gf on gf.stay_id = s.id and gf.hotel_id = s.hotel_id
  where s.hotel_id = target_hotel_id
    and s.status = 'checked_in'
  order by
    case
      when s.expected_check_out_date < current_business_date then 0
      when s.expected_check_out_date = current_business_date then 1
      else 2
    end,
    s.expected_check_out_date,
    r.room_number;
end;
$$;

revoke all on function public.get_in_house_room_occupants(uuid) from public, anon;
grant execute on function public.get_in_house_room_occupants(uuid) to authenticated;
