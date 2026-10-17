-- Keep the turnover-aware walk-in workflow lint-clean without changing its behavior.

create or replace function public.create_walk_in_stay(
  target_hotel_id uuid, guest_full_name text, guest_phone text, guest_email text,
  target_room_id uuid, check_in_on date, check_out_on date, agreed_rate bigint
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_room public.rooms;
  guest_id uuid;
  stay_id uuid;
  folio_number text;
begin
  if not public.has_hotel_permission(target_hotel_id, 'stays.manage') then raise exception 'Not authorised to create walk-in stays'; end if;
  if nullif(trim(guest_full_name), '') is null then raise exception 'Guest name is required'; end if;
  if check_out_on <= check_in_on then raise exception 'Checkout date must be after check-in date'; end if;
  if agreed_rate < 0 then raise exception 'Rate cannot be negative'; end if;

  select * into target_room from public.rooms where id = target_room_id and hotel_id = target_hotel_id for update;
  if not found or not target_room.active or target_room.blocked_at is not null then raise exception 'Room is not available'; end if;
  if target_room.turnover_status <> 'clean' then raise exception 'Room is awaiting housekeeping turnover'; end if;
  if exists (select 1 from public.stays where room_id = target_room_id and status = 'checked_in') then raise exception 'Room already has an active stay'; end if;
  if exists (select 1 from public.reservations where room_id = target_room_id and status in ('pending', 'confirmed', 'checked_in') and daterange(check_in_date, check_out_date, '[)') && daterange(check_in_on, check_out_on, '[)')) then raise exception 'Room is reserved for part of those dates'; end if;

  insert into public.guests (hotel_id, full_name, phone, email, created_by, updated_by)
  values (target_hotel_id, trim(guest_full_name), nullif(trim(guest_phone), ''), nullif(lower(trim(guest_email)), ''), auth.uid(), auth.uid())
  returning id into guest_id;
  insert into public.stays (hotel_id, guest_id, room_id, actual_check_in_date, expected_check_out_date, agreed_rate_kobo, status, checked_in_by)
  values (target_hotel_id, guest_id, target_room_id, check_in_on, check_out_on, agreed_rate, 'checked_in', auth.uid())
  returning id into stay_id;
  insert into public.stay_rate_periods (stay_id, effective_from, rate_kobo, reason, approved_by)
  values (stay_id, check_in_on, agreed_rate, 'Walk-in rate at check-in', auth.uid());
  folio_number := public.next_document_number(target_hotel_id, 'FOL');
  insert into public.guest_folios (hotel_id, stay_id, folio_number)
  values (target_hotel_id, stay_id, folio_number);
  perform public.log_activity(target_hotel_id, 'stay.walk_in_checked_in', 'stay', stay_id,
    jsonb_build_object('guest_id', guest_id, 'room_id', target_room_id));
  return stay_id;
end;
$$;

revoke all on function public.create_walk_in_stay(uuid, text, text, text, uuid, date, date, bigint) from public, anon;
grant execute on function public.create_walk_in_stay(uuid, text, text, text, uuid, date, date, bigint) to authenticated;
