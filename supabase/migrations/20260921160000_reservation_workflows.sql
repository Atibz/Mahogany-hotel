-- Reservation workflows: date-aware availability, amendments, and controlled cancellation.

insert into public.permissions (code, name, description)
values ('reservations.manage', 'Manage reservations', 'Amend, cancel, and mark reservations as no-show.')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.hotel_id = '00000000-0000-4000-8000-000000000001'
  and r.code in ('owner', 'general_manager', 'receptionist')
  and p.code = 'reservations.manage'
on conflict do nothing;

create or replace function public.search_available_rooms(
  target_hotel_id uuid,
  target_room_type_id uuid,
  arrival_date date,
  departure_date date
)
returns table (id uuid, room_number text, room_type_name text, current_rate_kobo bigint)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'reservations.read') then
    raise exception 'Not authorised to view availability';
  end if;
  if departure_date <= arrival_date then raise exception 'Checkout date must be after check-in date'; end if;
  return query
  select r.id, r.room_number, rt.name, coalesce(r.rate_override_kobo, rt.base_rate_kobo)
  from public.rooms r
  join public.room_types rt on rt.id = r.room_type_id
  where r.hotel_id = target_hotel_id
    and r.room_type_id = target_room_type_id
    and r.active
    and r.blocked_at is null
    and rt.active
    and not exists (
      select 1 from public.reservations rv
      where rv.room_id = r.id
        and rv.status in ('pending', 'confirmed', 'checked_in')
        and daterange(rv.check_in_date, rv.check_out_date, '[)') && daterange(arrival_date, departure_date, '[)')
    )
    and not exists (
      select 1 from public.stays s
      where s.room_id = r.id and s.status = 'checked_in'
    )
  order by r.room_number;
end;
$$;

create or replace function public.amend_reservation(
  target_reservation_id uuid,
  target_room_type_id uuid,
  target_room_id uuid,
  arrival_date date,
  departure_date date,
  agreed_rate bigint,
  amendment_reason text
)
returns void
language plpgsql
security definer set search_path = public
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
  if not exists (select 1 from public.rooms where id = target_room_id and hotel_id = target.hotel_id and room_type_id = target_room_type_id and active and blocked_at is null) then raise exception 'Room is not available'; end if;
  if exists (
    select 1 from public.reservations rv
    where rv.id <> target.id and rv.room_id = target_room_id and rv.status in ('pending', 'confirmed', 'checked_in')
      and daterange(rv.check_in_date, rv.check_out_date, '[)') && daterange(arrival_date, departure_date, '[)')
  ) then raise exception 'The room is already reserved for part of those dates'; end if;

  update public.reservations
  set room_type_id = target_room_type_id, room_id = target_room_id, check_in_date = arrival_date,
      check_out_date = departure_date, agreed_rate_kobo = agreed_rate, updated_by = auth.uid(), updated_at = now()
  where id = target.id;
  perform public.log_activity(target.hotel_id, 'reservation.amended', 'reservation', target.id,
    jsonb_build_object('reason', trim(amendment_reason)));
end;
$$;

create or replace function public.cancel_reservation(target_reservation_id uuid, cancellation_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare target public.reservations;
begin
  select * into target from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(target.hotel_id, 'reservations.manage') then raise exception 'Not authorised to manage reservations'; end if;
  if target.status not in ('pending', 'confirmed') then raise exception 'Only pending or confirmed reservations can be cancelled'; end if;
  if nullif(trim(cancellation_reason), '') is null then raise exception 'A cancellation reason is required'; end if;
  update public.reservations set status = 'cancelled', notes = concat_ws(E'\n', notes, '[Cancelled] ' || trim(cancellation_reason)), updated_by = auth.uid(), updated_at = now() where id = target.id;
  perform public.log_activity(target.hotel_id, 'reservation.cancelled', 'reservation', target.id, jsonb_build_object('reason', trim(cancellation_reason)));
end;
$$;

create or replace function public.mark_reservation_no_show(target_reservation_id uuid, no_show_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare target public.reservations;
begin
  select * into target from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(target.hotel_id, 'reservations.manage') then raise exception 'Not authorised to manage reservations'; end if;
  if target.status not in ('pending', 'confirmed') then raise exception 'Only pending or confirmed reservations can be marked no-show'; end if;
  if nullif(trim(no_show_reason), '') is null then raise exception 'A no-show reason is required'; end if;
  update public.reservations set status = 'no_show', notes = concat_ws(E'\n', notes, '[No-show] ' || trim(no_show_reason)), updated_by = auth.uid(), updated_at = now() where id = target.id;
  perform public.log_activity(target.hotel_id, 'reservation.no_show', 'reservation', target.id, jsonb_build_object('reason', trim(no_show_reason)));
end;
$$;

revoke all on function public.search_available_rooms(uuid, uuid, date, date), public.amend_reservation(uuid, uuid, uuid, date, date, bigint, text), public.cancel_reservation(uuid, text), public.mark_reservation_no_show(uuid, text) from public;
grant execute on function public.search_available_rooms(uuid, uuid, date, date), public.amend_reservation(uuid, uuid, uuid, date, date, bigint, text), public.cancel_reservation(uuid, text), public.mark_reservation_no_show(uuid, text) to authenticated;
