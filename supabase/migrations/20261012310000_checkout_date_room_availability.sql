-- A checked-in guest blocks a room only through the stay's expected checkout
-- date. Hotel date ranges are half-open: the room is not occupied on checkout
-- day for a future reservation, while same-business-day turnover remains
-- blocked until checkout/housekeeping has happened.

create or replace function public.search_available_rooms(
  target_hotel_id uuid,
  target_room_type_id uuid,
  arrival_date date,
  departure_date date
)
returns table (id uuid, room_number text, room_type_name text, current_rate_kobo bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'reservations.read') then
    raise exception 'Not authorised to view availability';
  end if;
  if departure_date <= arrival_date then
    raise exception 'Checkout date must be after check-in date';
  end if;

  return query
  select r.id, r.room_number, rt.name, coalesce(r.rate_override_kobo, rt.base_rate_kobo)
  from public.rooms r
  join public.room_types rt on rt.id = r.room_type_id
  where r.hotel_id = target_hotel_id
    and r.room_type_id = target_room_type_id
    and r.active
    and r.blocked_at is null
    and rt.active
    and (arrival_date > public.hotel_business_date(target_hotel_id) or r.turnover_status = 'clean')
    -- An occupied room cannot be sold for today, even if today is its checkout
    -- date; turnover must still occur. A future arrival on checkout day is
    -- allowed because the stay range ends at (and excludes) checkout.
    and (arrival_date > public.hotel_business_date(target_hotel_id) or not exists (
      select 1 from public.stays active_stay
      where active_stay.room_id = r.id and active_stay.status = 'checked_in'
    ))
    and not exists (
      select 1 from public.reservations rv
      where rv.room_id = r.id
        and rv.status in ('pending', 'confirmed', 'checked_in')
        and daterange(rv.check_in_date, rv.check_out_date, '[)')
          && daterange(arrival_date, departure_date, '[)')
    )
    and not exists (
      select 1 from public.stays active_stay
      where active_stay.room_id = r.id
        and active_stay.status = 'checked_in'
        and daterange(active_stay.actual_check_in_date, active_stay.expected_check_out_date, '[)')
          && daterange(arrival_date, departure_date, '[)')
    )
  order by r.room_number;
end;
$$;

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
  if not public.has_hotel_permission(target_hotel_id, 'reservations.create') then
    raise exception 'Not authorised to create reservations';
  end if;
  if departure_date <= arrival_date then raise exception 'Checkout date must be after check-in date'; end if;
  if adult_count is null or adult_count < 1 then raise exception 'At least one adult is required'; end if;
  if child_count is null or child_count < 0 then raise exception 'Children cannot be negative'; end if;
  if agreed_rate <= 0 then raise exception 'The agreed nightly rate must be greater than zero'; end if;
  if deposit_expected is null or deposit_expected < 0 then raise exception 'Expected deposit cannot be negative'; end if;
  if not exists (
    select 1 from public.guests
    where id = target_guest_id and hotel_id = target_hotel_id and active
  ) then raise exception 'Guest is not available for this hotel'; end if;

  select capacity into room_capacity
  from public.room_types
  where id = target_room_type_id and hotel_id = target_hotel_id and active;
  if room_capacity is null then raise exception 'Room type is not available'; end if;
  if adult_count + child_count > room_capacity then
    raise exception 'Guest count exceeds the room type capacity of %', room_capacity;
  end if;

  if target_room_id is not null then
    -- Serialize booking creation against stay extensions and other bookings.
    perform 1 from public.rooms where id = target_room_id and hotel_id = target_hotel_id for update;
    if not found then raise exception 'Room is not available for this room type'; end if;

    if not exists (
      select 1 from public.rooms
      where id = target_room_id and hotel_id = target_hotel_id
        and room_type_id = target_room_type_id and active and blocked_at is null
        and (arrival_date > public.hotel_business_date(target_hotel_id) or turnover_status = 'clean')
    ) then raise exception 'Room is not available for this room type'; end if;

    if exists (
      select 1 from public.reservations rv
      where rv.room_id = target_room_id and rv.status in ('pending', 'confirmed', 'checked_in')
        and daterange(rv.check_in_date, rv.check_out_date, '[)')
          && daterange(arrival_date, departure_date, '[)')
    ) then raise exception 'The room is already reserved for part of those dates'; end if;

    if exists (
      select 1 from public.stays active_stay
      where active_stay.room_id = target_room_id and active_stay.status = 'checked_in'
        and (
          (arrival_date <= public.hotel_business_date(target_hotel_id))
          or daterange(active_stay.actual_check_in_date, active_stay.expected_check_out_date, '[)')
            && daterange(arrival_date, departure_date, '[)')
        )
    ) then raise exception 'The room is occupied during the requested dates'; end if;
  end if;

  new_reservation_number := public.next_document_number(target_hotel_id, 'RSV');
  insert into public.reservations (
    hotel_id, reservation_number, guest_id, room_type_id, room_id, check_in_date, check_out_date,
    adults, children, agreed_rate_kobo, deposit_expected_kobo, booking_source, status, notes,
    created_by, updated_by
  ) values (
    target_hotel_id, new_reservation_number, target_guest_id, target_room_type_id, target_room_id,
    arrival_date, departure_date, adult_count, child_count, agreed_rate, deposit_expected,
    nullif(trim(source), ''), 'confirmed', nullif(trim(reservation_notes), ''), auth.uid(), auth.uid()
  ) returning id into new_reservation_id;

  perform public.log_activity(target_hotel_id, 'reservation.created', 'reservation', new_reservation_id,
    jsonb_build_object('reservation_number', new_reservation_number, 'adults', adult_count,
      'children', child_count, 'source', nullif(trim(source), '')));
  return new_reservation_id;
end;
$$;

create or replace function public.amend_reservation(
  target_reservation_id uuid, target_room_type_id uuid, target_room_id uuid,
  arrival_date date, departure_date date, agreed_rate bigint, amendment_reason text
)
returns void language plpgsql security definer set search_path = public
as $$
declare target public.reservations;
begin
  select * into target from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(target.hotel_id, 'reservations.manage') then
    raise exception 'Not authorised to manage reservations';
  end if;
  if target.status not in ('pending', 'confirmed') then
    raise exception 'Only pending or confirmed reservations can be amended';
  end if;
  if departure_date <= arrival_date then raise exception 'Checkout date must be after check-in date'; end if;
  if nullif(trim(amendment_reason), '') is null then raise exception 'An amendment reason is required'; end if;
  if agreed_rate <= 0 then raise exception 'The agreed nightly rate must be greater than zero'; end if;
  if not exists (
    select 1 from public.room_types
    where id = target_room_type_id and hotel_id = target.hotel_id and active
  ) then raise exception 'Room type is not available'; end if;

  perform 1 from public.rooms where id = target_room_id and hotel_id = target.hotel_id for update;
  if not found or not exists (
    select 1 from public.rooms
    where id = target_room_id and hotel_id = target.hotel_id
      and room_type_id = target_room_type_id and active and blocked_at is null
      and (arrival_date > public.hotel_business_date(target.hotel_id) or turnover_status = 'clean')
  ) then raise exception 'Room is not available'; end if;

  if exists (
    select 1 from public.reservations rv
    where rv.id <> target.id and rv.room_id = target_room_id
      and rv.status in ('pending', 'confirmed', 'checked_in')
      and daterange(rv.check_in_date, rv.check_out_date, '[)')
        && daterange(arrival_date, departure_date, '[)')
  ) then raise exception 'The room is already reserved for part of those dates'; end if;
  if exists (
    select 1 from public.stays active_stay
    where active_stay.room_id = target_room_id and active_stay.status = 'checked_in'
      and (
        (arrival_date <= public.hotel_business_date(target.hotel_id))
        or daterange(active_stay.actual_check_in_date, active_stay.expected_check_out_date, '[)')
          && daterange(arrival_date, departure_date, '[)')
      )
  ) then raise exception 'The room is occupied during the requested dates'; end if;

  update public.reservations
  set room_type_id = target_room_type_id, room_id = target_room_id,
      check_in_date = arrival_date, check_out_date = departure_date,
      agreed_rate_kobo = agreed_rate, updated_by = auth.uid(), updated_at = now()
  where id = target.id;
  perform public.log_activity(target.hotel_id, 'reservation.amended', 'reservation', target.id,
    jsonb_build_object('reason', trim(amendment_reason)));
end;
$$;

revoke all on function public.search_available_rooms(uuid, uuid, date, date),
  public.create_reservation(uuid, uuid, uuid, uuid, date, date, bigint, smallint, smallint, bigint, text, text),
  public.amend_reservation(uuid, uuid, uuid, date, date, bigint, text)
from public, anon;
grant execute on function public.search_available_rooms(uuid, uuid, date, date),
  public.create_reservation(uuid, uuid, uuid, uuid, date, date, bigint, smallint, smallint, bigint, text, text),
  public.amend_reservation(uuid, uuid, uuid, date, date, bigint, text)
to authenticated;
