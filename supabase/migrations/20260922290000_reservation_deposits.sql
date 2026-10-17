-- A reservation deposit is a payment held before a stay/folio exists. It is
-- allocated to the original payment at check-in; it is never room revenue.

create table public.reservation_deposits (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  payment_id uuid not null unique references public.payments(id) on delete restrict,
  receipt_number text not null,
  received_by uuid references public.profiles(id) on delete set null,
  received_at timestamptz not null default now(),
  unique (hotel_id, receipt_number)
);
create index reservation_deposits_reservation_idx on public.reservation_deposits(reservation_id, received_at desc);

insert into public.permissions (code, name, description) values
  ('deposits.create', 'Receive reservation deposits', 'Receive an advance reservation deposit before check-in.'),
  ('deposits.read', 'View reservation deposits', 'View reservation deposits and their payment evidence.')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('deposits.create', 'deposits.read')
where r.code in ('general_manager', 'cashier', 'accountant')
  or (r.code = 'receptionist' and p.code = 'deposits.create')
on conflict do nothing;

create or replace function public.record_reservation_deposit(target_reservation_id uuid, target_payment_method_id uuid, deposit_amount_kobo bigint, payment_reference text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare reservation_record public.reservations; payment_id uuid; deposit_id uuid; payment_number text; deposit_receipt_number text; requires_reference boolean; current_shift_id uuid; maximum_deposit bigint; already_received bigint;
begin
  select * into reservation_record from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(reservation_record.hotel_id, 'deposits.create') then raise exception 'Not authorised to receive reservation deposits'; end if;
  if reservation_record.status not in ('pending', 'confirmed') then raise exception 'Deposits may only be received before check-in'; end if;
  if deposit_amount_kobo <= 0 then raise exception 'Deposit must be greater than zero'; end if;
  select requires_reference into requires_reference from public.payment_methods where id = target_payment_method_id and hotel_id = reservation_record.hotel_id and active;
  if not found then raise exception 'Payment method is not available'; end if;
  if requires_reference and nullif(trim(payment_reference), '') is null then raise exception 'A reference is required for this payment method'; end if;
  maximum_deposit := reservation_record.agreed_rate_kobo * (reservation_record.check_out_date - reservation_record.check_in_date);
  select coalesce(sum(p.amount_kobo), 0) into already_received from public.reservation_deposits rd join public.payments p on p.id = rd.payment_id where rd.reservation_id = reservation_record.id and p.status in ('completed', 'refunded');
  if already_received + deposit_amount_kobo > maximum_deposit then raise exception 'Deposit cannot exceed the reserved room value'; end if;
  if exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.profile_id = auth.uid() and r.hotel_id = reservation_record.hotel_id and r.code = 'cashier' and r.active) then
    select id into current_shift_id from public.cashier_shifts where hotel_id = reservation_record.hotel_id and opened_by = auth.uid() and status = 'open' for update;
    if current_shift_id is null then raise exception 'Open a cashier shift before receiving a deposit'; end if;
  end if;
  payment_number := public.next_document_number(reservation_record.hotel_id, 'PAY');
  insert into public.payments (hotel_id, payment_number, payment_method_id, amount_kobo, reference, received_by, cashier_shift_id) values (reservation_record.hotel_id, payment_number, target_payment_method_id, deposit_amount_kobo, nullif(trim(payment_reference), ''), auth.uid(), current_shift_id) returning id into payment_id;
  deposit_receipt_number := public.next_document_number(reservation_record.hotel_id, 'RCP');
  insert into public.reservation_deposits (hotel_id, reservation_id, payment_id, receipt_number, received_by) values (reservation_record.hotel_id, reservation_record.id, payment_id, deposit_receipt_number, auth.uid()) returning id into deposit_id;
  perform public.log_activity(reservation_record.hotel_id, 'reservation.deposit_received', 'reservation_deposit', deposit_id, jsonb_build_object('reservation_id', reservation_record.id, 'payment_id', payment_id, 'amount_kobo', deposit_amount_kobo, 'receipt_number', deposit_receipt_number));
  return deposit_id;
end;
$$;

create or replace function public.check_in_reservation(target_reservation_id uuid, check_in_on date default current_date)
returns uuid language plpgsql security definer set search_path = public as $$
declare reservation_record public.reservations; new_stay_id uuid; new_folio_id uuid; new_folio_number text;
begin
  select * into reservation_record from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(reservation_record.hotel_id, 'stays.check_in') then raise exception 'Not authorised to check in guests'; end if;
  if reservation_record.status not in ('pending', 'confirmed') then raise exception 'Only pending or confirmed reservations can be checked in'; end if;
  if reservation_record.room_id is null then raise exception 'Assign a room before check-in'; end if;
  if check_in_on < reservation_record.check_in_date or check_in_on >= reservation_record.check_out_date then raise exception 'Check-in date is outside the reservation dates'; end if;
  if exists (select 1 from public.stays where room_id = reservation_record.room_id and status = 'checked_in') then raise exception 'This room already has an active stay'; end if;
  insert into public.stays (hotel_id, reservation_id, guest_id, room_id, actual_check_in_date, expected_check_out_date, agreed_rate_kobo, status, checked_in_by, notes) values (reservation_record.hotel_id, reservation_record.id, reservation_record.guest_id, reservation_record.room_id, check_in_on, reservation_record.check_out_date, reservation_record.agreed_rate_kobo, 'checked_in', auth.uid(), reservation_record.notes) returning id into new_stay_id;
  insert into public.stay_rate_periods (stay_id, effective_from, rate_kobo, reason, approved_by) values (new_stay_id, check_in_on, reservation_record.agreed_rate_kobo, 'Rate agreed at reservation', auth.uid());
  new_folio_number := public.next_document_number(reservation_record.hotel_id, 'FOL');
  insert into public.guest_folios (hotel_id, stay_id, folio_number) values (reservation_record.hotel_id, new_stay_id, new_folio_number) returning id into new_folio_id;
  insert into public.payment_allocations (payment_id, folio_id, amount_kobo) select rd.payment_id, new_folio_id, p.amount_kobo from public.reservation_deposits rd join public.payments p on p.id = rd.payment_id where rd.reservation_id = reservation_record.id and p.status = 'completed';
  update public.reservations set status = 'checked_in', updated_by = auth.uid() where id = reservation_record.id;
  perform public.log_activity(reservation_record.hotel_id, 'stay.checked_in', 'stay', new_stay_id, jsonb_build_object('reservation_id', reservation_record.id, 'room_id', reservation_record.room_id, 'deposit_allocated', exists(select 1 from public.reservation_deposits where reservation_id = reservation_record.id)));
  return new_stay_id;
end;
$$;

revoke all on public.reservation_deposits from public, anon, authenticated;
grant select on public.reservation_deposits to authenticated;
alter table public.reservation_deposits enable row level security;
create policy reservation_deposits_read on public.reservation_deposits for select to authenticated using (public.has_hotel_permission(hotel_id, 'deposits.read'));
revoke all on function public.record_reservation_deposit(uuid, uuid, bigint, text) from public, anon;
grant execute on function public.record_reservation_deposit(uuid, uuid, bigint, text) to authenticated;
