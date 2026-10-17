-- Correct direct-RPC bypasses found during the operational controls audit.
-- These rules protect the workflow even when a caller bypasses the user interface.

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
    when r.turnover_status = 'dirty' then 'dirty'
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
  coalesce(
    r.blocked_reason,
    case when not r.active then 'Room is inactive' end,
    case when r.turnover_status = 'dirty' then 'Awaiting housekeeping turnover' end
  ) as blocked_reason,
  r.turnover_status,
  (r.maintenance_ticket_id is not null) as is_maintenance_out_of_service
from public.rooms r
join public.room_types rt on rt.id = r.room_type_id;

alter view public.room_board set (security_invoker = true);
grant select on public.room_board to authenticated;

-- A maintenance block can only be released by the maintenance return-to-service workflow.
create or replace function public.set_room_blocked(target_room_id uuid, should_block boolean, block_reason text default null)
returns void
language plpgsql
security definer set search_path = public
as $$
declare target_room public.rooms;
begin
  select * into target_room from public.rooms where id = target_room_id for update;
  if not found then raise exception 'Room not found'; end if;
  if not public.has_hotel_permission(target_room.hotel_id, 'rooms.manage') then raise exception 'Not authorised to manage rooms'; end if;
  if target_room.maintenance_ticket_id is not null then
    raise exception 'This room is controlled by an active maintenance ticket; use the Maintenance workflow';
  end if;
  if should_block and nullif(trim(block_reason), '') is null then raise exception 'A block reason is required'; end if;
  if should_block and exists (select 1 from public.stays where room_id = target_room.id and status = 'checked_in') then raise exception 'An active stay prevents blocking this room'; end if;
  if should_block and exists (
    select 1 from public.reservations
    where room_id = target_room.id and status in ('pending', 'confirmed')
      and check_out_date > public.hotel_business_date(target_room.hotel_id)
  ) then raise exception 'A current or future reservation prevents blocking this room'; end if;

  update public.rooms
  set blocked_at = case when should_block then now() else null end,
      blocked_reason = case when should_block then trim(block_reason) else null end,
      updated_at = now()
  where id = target_room.id;
  perform public.log_activity(target_room.hotel_id, case when should_block then 'room.blocked' else 'room.unblocked' end,
    'room', target_room.id, jsonb_build_object('reason', nullif(trim(block_reason), '')));
end;
$$;

-- Tickets are closed only when the controlled room is formally returned to service.
create or replace function public.update_room_maintenance_ticket(target_ticket_id uuid, next_status text, resolution_notes_value text default null)
returns void language plpgsql security definer set search_path = public as $$
declare ticket public.maintenance_tickets;
begin
  select * into ticket from public.maintenance_tickets where id = target_ticket_id for update;
  if not found then raise exception 'Maintenance ticket not found'; end if;
  if not public.has_hotel_permission(ticket.hotel_id, 'maintenance.manage') then raise exception 'Not authorised to manage maintenance tickets'; end if;
  if next_status not in ('in_progress', 'resolved') then raise exception 'Maintenance tickets can only be started or resolved; return the room to service to close the ticket'; end if;
  if ticket.status in ('resolved', 'closed') then raise exception 'A resolved maintenance ticket cannot be changed'; end if;
  if next_status = 'resolved' and nullif(trim(resolution_notes_value), '') is null then raise exception 'Resolution notes are required'; end if;

  update public.maintenance_tickets
  set status = next_status,
      started_at = case when next_status = 'in_progress' then coalesce(started_at, now()) else started_at end,
      resolved_at = case when next_status = 'resolved' then now() else null end,
      resolved_by = case when next_status = 'resolved' then auth.uid() else null end,
      resolution_notes = case when next_status = 'resolved' then trim(resolution_notes_value) else resolution_notes end
  where id = ticket.id;
  perform public.log_activity(ticket.hotel_id, 'maintenance.status_changed', 'maintenance_ticket', ticket.id,
    jsonb_build_object('status', next_status));
end;
$$;

create or replace function public.raise_room_maintenance_ticket(target_room_id uuid, fault_description text, fault_priority text default 'normal')
returns uuid language plpgsql security definer set search_path = public as $$
declare target_room public.rooms; ticket_id uuid; ticket_number text;
begin
  select * into target_room from public.rooms where id = target_room_id for update;
  if not found then raise exception 'Room not found'; end if;
  if not public.has_hotel_permission(target_room.hotel_id, 'maintenance.create') then raise exception 'Not authorised to report maintenance faults'; end if;
  if target_room.maintenance_ticket_id is not null then raise exception 'This room is already out of service under a maintenance ticket'; end if;
  if nullif(trim(fault_description), '') is null then raise exception 'A fault description is required'; end if;
  if fault_priority not in ('low', 'normal', 'high', 'urgent') then raise exception 'Maintenance priority is invalid'; end if;
  ticket_number := public.next_document_number(target_room.hotel_id, 'MNT');
  insert into public.maintenance_tickets (hotel_id, room_id, ticket_number, description, priority, reported_by)
  values (target_room.hotel_id, target_room.id, ticket_number, trim(fault_description), fault_priority, auth.uid())
  returning id into ticket_id;
  perform public.log_activity(target_room.hotel_id, 'maintenance.reported', 'maintenance_ticket', ticket_id,
    jsonb_build_object('room_id', target_room.id, 'priority', fault_priority));
  return ticket_id;
end;
$$;

-- A dirty room may be reserved for a future arrival, but is not selectable for today.
create or replace function public.search_available_rooms(target_hotel_id uuid, target_room_type_id uuid, arrival_date date, departure_date date)
returns table (id uuid, room_number text, room_type_name text, current_rate_kobo bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'reservations.read') then raise exception 'Not authorised to view availability'; end if;
  if departure_date <= arrival_date then raise exception 'Checkout date must be after check-in date'; end if;
  return query
  select r.id, r.room_number, rt.name, coalesce(r.rate_override_kobo, rt.base_rate_kobo)
  from public.rooms r join public.room_types rt on rt.id = r.room_type_id
  where r.hotel_id = target_hotel_id and r.room_type_id = target_room_type_id and r.active and r.blocked_at is null and rt.active
    and (arrival_date > public.hotel_business_date(target_hotel_id) or r.turnover_status = 'clean')
    and not exists (select 1 from public.reservations rv where rv.room_id = r.id and rv.status in ('pending', 'confirmed', 'checked_in') and daterange(rv.check_in_date, rv.check_out_date, '[)') && daterange(arrival_date, departure_date, '[)'))
    and not exists (select 1 from public.stays s where s.room_id = r.id and s.status = 'checked_in')
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
declare new_reservation_id uuid; new_reservation_number text;
begin
  if not public.has_hotel_permission(target_hotel_id, 'reservations.create') then raise exception 'Not authorised to create reservations'; end if;
  if departure_date <= arrival_date then raise exception 'Checkout date must be after check-in date'; end if;
  if not exists (select 1 from public.guests where id = target_guest_id and hotel_id = target_hotel_id and active) then raise exception 'Guest is not available for this hotel'; end if;
  if not exists (select 1 from public.room_types where id = target_room_type_id and hotel_id = target_hotel_id and active) then raise exception 'Room type is not available'; end if;
  if target_room_id is not null and not exists (
    select 1 from public.rooms
    where id = target_room_id and hotel_id = target_hotel_id and room_type_id = target_room_type_id and active and blocked_at is null
      and (arrival_date > public.hotel_business_date(target_hotel_id) or turnover_status = 'clean')
  ) then raise exception 'Room is not available for this room type'; end if;
  new_reservation_number := public.next_document_number(target_hotel_id, 'RSV');
  insert into public.reservations (hotel_id, reservation_number, guest_id, room_type_id, room_id, check_in_date, check_out_date, adults, children, agreed_rate_kobo, deposit_expected_kobo, booking_source, status, notes, created_by, updated_by)
  values (target_hotel_id, new_reservation_number, target_guest_id, target_room_type_id, target_room_id, arrival_date, departure_date, adult_count, child_count, agreed_rate, deposit_expected, nullif(trim(source), ''), 'confirmed', nullif(trim(reservation_notes), ''), auth.uid(), auth.uid())
  returning id into new_reservation_id;
  perform public.log_activity(target_hotel_id, 'reservation.created', 'reservation', new_reservation_id, jsonb_build_object('reservation_number', new_reservation_number));
  return new_reservation_id;
end;
$$;

create or replace function public.amend_reservation(target_reservation_id uuid, target_room_type_id uuid, target_room_id uuid, arrival_date date, departure_date date, agreed_rate bigint, amendment_reason text)
returns void language plpgsql security definer set search_path = public
as $$
declare target public.reservations;
begin
  select * into target from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(target.hotel_id, 'reservations.manage') then raise exception 'Not authorised to manage reservations'; end if;
  if target.status not in ('pending', 'confirmed') then raise exception 'Only pending or confirmed reservations can be amended'; end if;
  if departure_date <= arrival_date then raise exception 'Checkout date must be after check-in date'; end if;
  if nullif(trim(amendment_reason), '') is null then raise exception 'An amendment reason is required'; end if;
  if not exists (select 1 from public.room_types where id = target_room_type_id and hotel_id = target.hotel_id and active) then raise exception 'Room type is not available'; end if;
  if not exists (
    select 1 from public.rooms
    where id = target_room_id and hotel_id = target.hotel_id and room_type_id = target_room_type_id and active and blocked_at is null
      and (arrival_date > public.hotel_business_date(target.hotel_id) or turnover_status = 'clean')
  ) then raise exception 'Room is not available'; end if;
  if exists (
    select 1 from public.reservations rv
    where rv.id <> target.id and rv.room_id = target_room_id and rv.status in ('pending', 'confirmed', 'checked_in')
      and daterange(rv.check_in_date, rv.check_out_date, '[)') && daterange(arrival_date, departure_date, '[)')
  ) then raise exception 'The room is already reserved for part of those dates'; end if;
  update public.reservations
  set room_type_id = target_room_type_id, room_id = target_room_id, check_in_date = arrival_date, check_out_date = departure_date,
      agreed_rate_kobo = agreed_rate, updated_by = auth.uid(), updated_at = now()
  where id = target.id;
  perform public.log_activity(target.hotel_id, 'reservation.amended', 'reservation', target.id, jsonb_build_object('reason', trim(amendment_reason)));
end;
$$;

revoke all on function public.set_room_blocked(uuid, boolean, text), public.update_room_maintenance_ticket(uuid, text, text), public.raise_room_maintenance_ticket(uuid, text, text), public.search_available_rooms(uuid, uuid, date, date), public.create_reservation(uuid, uuid, uuid, uuid, date, date, bigint, smallint, smallint, bigint, text, text), public.amend_reservation(uuid, uuid, uuid, date, date, bigint, text) from public, anon;
grant execute on function public.set_room_blocked(uuid, boolean, text), public.update_room_maintenance_ticket(uuid, text, text), public.raise_room_maintenance_ticket(uuid, text, text), public.search_available_rooms(uuid, uuid, date, date), public.create_reservation(uuid, uuid, uuid, uuid, date, date, bigint, smallint, smallint, bigint, text, text), public.amend_reservation(uuid, uuid, uuid, date, date, bigint, text) to authenticated;
