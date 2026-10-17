-- Reservation party size and booking context must be captured by every creation
-- path. Capacity is enforced in the database as well as in the interface.

create or replace function public.create_reservation(
  target_hotel_id uuid, target_guest_id uuid, target_room_type_id uuid, target_room_id uuid,
  arrival_date date, departure_date date, agreed_rate bigint, adult_count smallint default 1,
  child_count smallint default 0, deposit_expected bigint default 0, source text default null,
  reservation_notes text default null
)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  new_reservation_id uuid;
  new_reservation_number text;
  room_capacity smallint;
begin
  if not public.has_hotel_permission(target_hotel_id, 'reservations.create') then raise exception 'Not authorised to create reservations'; end if;
  if departure_date <= arrival_date then raise exception 'Checkout date must be after check-in date'; end if;
  if adult_count is null or adult_count < 1 then raise exception 'At least one adult is required'; end if;
  if child_count is null or child_count < 0 then raise exception 'Children cannot be negative'; end if;
  if agreed_rate <= 0 then raise exception 'The agreed nightly rate must be greater than zero'; end if;
  if not exists (select 1 from public.guests where id = target_guest_id and hotel_id = target_hotel_id and active) then raise exception 'Guest is not available for this hotel'; end if;

  select capacity into room_capacity
  from public.room_types
  where id = target_room_type_id and hotel_id = target_hotel_id and active;
  if room_capacity is null then raise exception 'Room type is not available'; end if;
  if adult_count + child_count > room_capacity then
    raise exception 'Guest count exceeds the room type capacity of %', room_capacity;
  end if;

  if target_room_id is not null and not exists (
    select 1 from public.rooms
    where id = target_room_id and hotel_id = target_hotel_id and room_type_id = target_room_type_id and active and blocked_at is null
      and (arrival_date > public.hotel_business_date(target_hotel_id) or turnover_status = 'clean')
  ) then raise exception 'Room is not available for this room type'; end if;
  if target_room_id is not null and exists (
    select 1 from public.reservations rv
    where rv.room_id = target_room_id and rv.status in ('pending', 'confirmed', 'checked_in')
      and daterange(rv.check_in_date, rv.check_out_date, '[)') && daterange(arrival_date, departure_date, '[)')
  ) then raise exception 'The room is already reserved for part of those dates'; end if;
  if target_room_id is not null and exists (
    select 1 from public.stays s where s.room_id = target_room_id and s.status = 'checked_in'
  ) then raise exception 'The room is currently occupied'; end if;

  new_reservation_number := public.next_document_number(target_hotel_id, 'RSV');
  insert into public.reservations (
    hotel_id, reservation_number, guest_id, room_type_id, room_id, check_in_date, check_out_date,
    adults, children, agreed_rate_kobo, deposit_expected_kobo, booking_source, status, notes, created_by, updated_by
  ) values (
    target_hotel_id, new_reservation_number, target_guest_id, target_room_type_id, target_room_id, arrival_date, departure_date,
    adult_count, child_count, agreed_rate, deposit_expected, nullif(trim(source), ''), 'confirmed', nullif(trim(reservation_notes), ''), auth.uid(), auth.uid()
  ) returning id into new_reservation_id;
  perform public.log_activity(target_hotel_id, 'reservation.created', 'reservation', new_reservation_id,
    jsonb_build_object('reservation_number', new_reservation_number, 'adults', adult_count, 'children', child_count, 'source', nullif(trim(source), '')));
  return new_reservation_id;
end;
$$;

drop function if exists public.create_reservation_with_discount_request(uuid, uuid, uuid, uuid, date, date, bigint, text);

create function public.create_reservation_with_discount_request(
  target_hotel_id uuid,
  target_guest_id uuid,
  target_room_type_id uuid,
  target_room_id uuid,
  arrival_date date,
  departure_date date,
  requested_rate_kobo bigint,
  request_reason text,
  adult_count smallint default 1,
  child_count smallint default 0,
  source text default null,
  reservation_notes text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  standard_rate bigint;
  reservation_id uuid;
begin
  select coalesce(r.rate_override_kobo, rt.base_rate_kobo)
  into standard_rate
  from public.room_types rt
  join public.rooms r on r.id = target_room_id and r.room_type_id = rt.id
  where rt.id = target_room_type_id and rt.hotel_id = target_hotel_id;
  if standard_rate is null or standard_rate <= 0 then raise exception 'A valid standard room rate is required'; end if;
  if requested_rate_kobo * 100 >= standard_rate * 80 then
    raise exception 'This workflow is only for discounts above 20%%';
  end if;

  reservation_id := public.create_reservation(
    target_hotel_id, target_guest_id, target_room_type_id, target_room_id,
    arrival_date, departure_date, standard_rate, adult_count, child_count, 0,
    source, reservation_notes
  );
  perform public.request_reservation_discount(reservation_id, requested_rate_kobo, request_reason);
  return reservation_id;
end;
$$;

revoke all on function public.create_reservation(uuid, uuid, uuid, uuid, date, date, bigint, smallint, smallint, bigint, text, text),
  public.create_reservation_with_discount_request(uuid, uuid, uuid, uuid, date, date, bigint, text, smallint, smallint, text, text)
from public, anon;
grant execute on function public.create_reservation(uuid, uuid, uuid, uuid, date, date, bigint, smallint, smallint, bigint, text, text),
  public.create_reservation_with_discount_request(uuid, uuid, uuid, uuid, date, date, bigint, text, smallint, smallint, text, text)
to authenticated;
