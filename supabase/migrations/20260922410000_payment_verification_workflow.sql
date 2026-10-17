-- Bank transfers are evidence of a claimed payment, not proof of settlement.
-- Pending payments do not reduce a folio, become a usable deposit, or receive
-- an official receipt until a finance approver verifies them.

alter table public.payment_methods
  add column if not exists requires_verification boolean not null default false;

-- Preserve historical completed payments. Only new bank-transfer payments are
-- pending. The standard method code is seeded and used by the hotel setup.
update public.payment_methods
set requires_verification = true
where lower(code) in ('bank_transfer', 'bank-transfer', 'transfer');

alter table public.payments
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references public.profiles(id) on delete set null,
  add column if not exists verification_note text;

alter table public.reservation_deposits
  alter column receipt_number drop not null;

insert into public.permissions (code, name, description)
values ('payments.verify', 'Verify pending payments', 'Confirm or reject a pending non-cash payment with an audit note.')
on conflict (code) do nothing;

create or replace function public.provision_payment_verification_permissions(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.code = 'payments.verify'
  where r.hotel_id = target_hotel_id
    and r.code in ('general_manager', 'accountant')
  on conflict do nothing;
$$;

select public.provision_payment_verification_permissions(id) from public.hotels;

create or replace function public.handle_hotel_payment_verification_permission_provisioning()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_payment_verification_permissions(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzzz_hotel_payment_verification_permission on public.hotels;
create trigger zzzzzzz_hotel_payment_verification_permission
after insert on public.hotels
for each row execute function public.handle_hotel_payment_verification_permission_provisioning();

create or replace function public.record_folio_payment(
  target_folio_id uuid,
  target_payment_method_id uuid,
  payment_amount_kobo bigint,
  payment_reference text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_folio public.guest_folios;
  payment_id uuid;
  payment_number text;
  issued_receipt_number text;
  settled_balance bigint;
  pending_amount bigint;
  payment_requires_reference boolean;
  payment_requires_verification boolean;
  payment_method_code text;
  current_shift_id uuid;
  initial_status public.payment_status;
begin
  select * into target_folio from public.guest_folios where id = target_folio_id for update;
  if not found then raise exception 'Folio not found'; end if;
  if not public.has_hotel_permission(target_folio.hotel_id, 'payments.create') then raise exception 'Not authorised to record payments'; end if;
  if target_folio.status <> 'open' then raise exception 'Only open folios can receive payments'; end if;
  if payment_amount_kobo <= 0 then raise exception 'Payment amount must be greater than zero'; end if;

  select pm.requires_reference, pm.requires_verification, pm.code
    into payment_requires_reference, payment_requires_verification, payment_method_code
  from public.payment_methods pm
  where pm.id = target_payment_method_id and pm.hotel_id = target_folio.hotel_id and pm.active;
  if not found then raise exception 'Payment method is not available'; end if;
  if payment_requires_reference and nullif(trim(payment_reference), '') is null then raise exception 'A reference is required for this payment method'; end if;
  if payment_method_code = 'cash' and payment_requires_verification then raise exception 'Cash cannot require payment verification'; end if;

  if payment_method_code = 'cash' then
    if not public.has_hotel_permission(target_folio.hotel_id, 'cashier_shifts.open') then raise exception 'Only a cashier, general manager, or owner with an open shift may receive cash'; end if;
    select id into current_shift_id from public.cashier_shifts
    where hotel_id = target_folio.hotel_id and opened_by = auth.uid() and status = 'open'
    for update;
    if current_shift_id is null then raise exception 'Open a cashier shift before receiving cash'; end if;
  end if;

  settled_balance := public.folio_balance(target_folio_id);
  select coalesce(sum(pa.amount_kobo), 0) into pending_amount
  from public.payment_allocations pa join public.payments p on p.id = pa.payment_id
  where pa.folio_id = target_folio_id and p.status = 'pending_verification';
  if payment_amount_kobo > settled_balance - pending_amount then raise exception 'Payment cannot exceed the remaining folio balance, including pending payments'; end if;

  initial_status := case when payment_requires_verification then 'pending_verification' else 'completed' end;
  payment_number := public.next_document_number(target_folio.hotel_id, 'PAY');
  insert into public.payments (hotel_id, payment_number, payment_method_id, amount_kobo, reference, status, received_by, cashier_shift_id)
  values (target_folio.hotel_id, payment_number, target_payment_method_id, payment_amount_kobo, nullif(trim(payment_reference), ''), initial_status, auth.uid(), current_shift_id)
  returning id into payment_id;
  insert into public.payment_allocations (payment_id, folio_id, amount_kobo) values (payment_id, target_folio_id, payment_amount_kobo);

  if initial_status = 'completed' then
    issued_receipt_number := public.next_document_number(target_folio.hotel_id, 'RCP');
    insert into public.receipts (hotel_id, receipt_number, folio_id, payment_id, issued_by)
    values (target_folio.hotel_id, issued_receipt_number, target_folio_id, payment_id, auth.uid());
  end if;
  perform public.log_activity(target_folio.hotel_id, 'payment.created', 'payment', payment_id,
    jsonb_build_object('folio_id', target_folio_id, 'amount_kobo', payment_amount_kobo, 'status', initial_status,
      'receipt_number', issued_receipt_number, 'cashier_shift_id', current_shift_id));
  return payment_id;
end;
$$;

create or replace function public.record_reservation_deposit(
  target_reservation_id uuid,
  target_payment_method_id uuid,
  deposit_amount_kobo bigint,
  payment_reference text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  reservation_record public.reservations;
  payment_id uuid;
  deposit_id uuid;
  payment_number text;
  deposit_receipt_number text;
  payment_requires_reference boolean;
  payment_requires_verification boolean;
  payment_method_code text;
  current_shift_id uuid;
  maximum_deposit bigint;
  already_committed bigint;
  initial_status public.payment_status;
begin
  select * into reservation_record from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(reservation_record.hotel_id, 'deposits.create') then raise exception 'Not authorised to receive reservation deposits'; end if;
  if reservation_record.status not in ('pending', 'confirmed') then raise exception 'Deposits may only be received before check-in'; end if;
  if deposit_amount_kobo <= 0 then raise exception 'Deposit must be greater than zero'; end if;

  select pm.requires_reference, pm.requires_verification, pm.code
    into payment_requires_reference, payment_requires_verification, payment_method_code
  from public.payment_methods pm
  where pm.id = target_payment_method_id and pm.hotel_id = reservation_record.hotel_id and pm.active;
  if not found then raise exception 'Payment method is not available'; end if;
  if payment_requires_reference and nullif(trim(payment_reference), '') is null then raise exception 'A reference is required for this payment method'; end if;
  if payment_method_code = 'cash' and payment_requires_verification then raise exception 'Cash cannot require payment verification'; end if;

  maximum_deposit := reservation_record.agreed_rate_kobo * (reservation_record.check_out_date - reservation_record.check_in_date);
  select coalesce(sum(p.amount_kobo), 0) into already_committed
  from public.reservation_deposits rd join public.payments p on p.id = rd.payment_id
  where rd.reservation_id = reservation_record.id and p.status in ('completed', 'pending_verification');
  if already_committed + deposit_amount_kobo > maximum_deposit then raise exception 'Deposit cannot exceed the reserved room value'; end if;

  if payment_method_code = 'cash' then
    if not public.has_hotel_permission(reservation_record.hotel_id, 'cashier_shifts.open') then raise exception 'Only a cashier, general manager, or owner with an open shift may receive cash'; end if;
    select id into current_shift_id from public.cashier_shifts
    where hotel_id = reservation_record.hotel_id and opened_by = auth.uid() and status = 'open'
    for update;
    if current_shift_id is null then raise exception 'Open a cashier shift before receiving cash'; end if;
  end if;

  initial_status := case when payment_requires_verification then 'pending_verification' else 'completed' end;
  payment_number := public.next_document_number(reservation_record.hotel_id, 'PAY');
  insert into public.payments (hotel_id, payment_number, payment_method_id, amount_kobo, reference, status, received_by, cashier_shift_id)
  values (reservation_record.hotel_id, payment_number, target_payment_method_id, deposit_amount_kobo, nullif(trim(payment_reference), ''), initial_status, auth.uid(), current_shift_id)
  returning id into payment_id;
  if initial_status = 'completed' then deposit_receipt_number := public.next_document_number(reservation_record.hotel_id, 'RCP'); end if;
  insert into public.reservation_deposits (hotel_id, reservation_id, payment_id, receipt_number, received_by)
  values (reservation_record.hotel_id, reservation_record.id, payment_id, deposit_receipt_number, auth.uid())
  returning id into deposit_id;
  perform public.log_activity(reservation_record.hotel_id, 'reservation.deposit_recorded', 'reservation_deposit', deposit_id,
    jsonb_build_object('reservation_id', reservation_record.id, 'payment_id', payment_id, 'amount_kobo', deposit_amount_kobo,
      'status', initial_status, 'receipt_number', deposit_receipt_number, 'cashier_shift_id', current_shift_id));
  return deposit_id;
end;
$$;

create or replace function public.verify_pending_payment(target_payment_id uuid, verification_note_value text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_payment public.payments;
  target_folio public.guest_folios;
  target_folio_id uuid;
  allocated_amount bigint;
  deposit_record public.reservation_deposits;
  reservation_record public.reservations;
  settled_deposits bigint;
  maximum_deposit bigint;
  issued_receipt_number text;
begin
  select * into target_payment from public.payments where id = target_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if not public.has_hotel_permission(target_payment.hotel_id, 'payments.verify') then raise exception 'Not authorised to verify payments'; end if;
  if target_payment.status <> 'pending_verification' then raise exception 'Only pending payments can be verified'; end if;
  if nullif(trim(verification_note_value), '') is null then raise exception 'A verification note is required'; end if;

  select pa.folio_id, pa.amount_kobo into target_folio_id, allocated_amount
  from public.payment_allocations pa
  where pa.payment_id = target_payment.id
  for update;

  if found then
    select * into target_folio from public.guest_folios where id = target_folio_id for update;
    if target_folio.status <> 'open' then raise exception 'Only payments on an open folio can be verified'; end if;
    if public.folio_balance(target_folio.id) < allocated_amount then raise exception 'Payment exceeds the current outstanding folio balance and cannot be verified'; end if;
    issued_receipt_number := public.next_document_number(target_payment.hotel_id, 'RCP');
    insert into public.receipts (hotel_id, receipt_number, folio_id, payment_id, issued_by)
    values (target_payment.hotel_id, issued_receipt_number, target_folio.id, target_payment.id, auth.uid());
  else
    select * into deposit_record from public.reservation_deposits where payment_id = target_payment.id for update;
    if not found then raise exception 'Pending payment is not linked to a folio or reservation deposit'; end if;
    select * into reservation_record from public.reservations where id = deposit_record.reservation_id for update;
    if reservation_record.status not in ('pending', 'confirmed') then raise exception 'Verify this reservation deposit before check-in'; end if;
    maximum_deposit := reservation_record.agreed_rate_kobo * (reservation_record.check_out_date - reservation_record.check_in_date);
    select coalesce(sum(p.amount_kobo), 0) into settled_deposits
    from public.reservation_deposits rd join public.payments p on p.id = rd.payment_id
    where rd.reservation_id = reservation_record.id and p.status = 'completed';
    if settled_deposits + target_payment.amount_kobo > maximum_deposit then raise exception 'Verified deposit would exceed the reserved room value'; end if;
    issued_receipt_number := public.next_document_number(target_payment.hotel_id, 'RCP');
    update public.reservation_deposits set receipt_number = issued_receipt_number where id = deposit_record.id;
  end if;

  update public.payments
  set status = 'completed', verified_at = now(), verified_by = auth.uid(), verification_note = trim(verification_note_value)
  where id = target_payment.id;
  perform public.log_activity(target_payment.hotel_id, 'payment.verified', 'payment', target_payment.id,
    jsonb_build_object('receipt_number', issued_receipt_number, 'verification_note', trim(verification_note_value)));
end;
$$;

create or replace function public.reject_pending_payment(target_payment_id uuid, rejection_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare target_payment public.payments;
begin
  select * into target_payment from public.payments where id = target_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if not public.has_hotel_permission(target_payment.hotel_id, 'payments.verify') then raise exception 'Not authorised to reject payments'; end if;
  if target_payment.status <> 'pending_verification' then raise exception 'Only pending payments can be rejected'; end if;
  if nullif(trim(rejection_reason), '') is null then raise exception 'A rejection reason is required'; end if;
  update public.payments
  set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = trim(rejection_reason)
  where id = target_payment.id;
  perform public.log_activity(target_payment.hotel_id, 'payment.verification_rejected', 'payment', target_payment.id,
    jsonb_build_object('reason', trim(rejection_reason)));
end;
$$;

create or replace function public.get_pending_payment_verifications(target_hotel_id uuid)
returns table (
  payment_id uuid,
  payment_number text,
  amount_kobo bigint,
  payment_method_name text,
  reference text,
  received_at timestamptz,
  source text,
  folio_number text,
  reservation_number text,
  guest_name text
)
language sql
stable
security definer set search_path = public
as $$
  select p.id, p.payment_number, p.amount_kobo, pm.name, p.reference, p.received_at,
    case when pa.id is not null then 'folio payment' else 'reservation deposit' end,
    gf.folio_number, r.reservation_number, g.full_name
  from public.payments p
  join public.payment_methods pm on pm.id = p.payment_method_id
  left join public.payment_allocations pa on pa.payment_id = p.id
  left join public.guest_folios gf on gf.id = pa.folio_id
  left join public.stays s on s.id = gf.stay_id
  left join public.guests folio_guest on folio_guest.id = s.guest_id
  left join public.reservation_deposits rd on rd.payment_id = p.id
  left join public.reservations r on r.id = rd.reservation_id
  left join public.guests deposit_guest on deposit_guest.id = r.guest_id
  cross join lateral (select coalesce(folio_guest.full_name, deposit_guest.full_name) as full_name) g
  where p.hotel_id = target_hotel_id
    and p.status = 'pending_verification'
    and public.has_hotel_permission(target_hotel_id, 'payments.verify')
  order by p.received_at;
$$;

create or replace function public.check_in_reservation(target_reservation_id uuid, check_in_on date default current_date)
returns uuid language plpgsql security definer set search_path = public as $$
declare reservation_record public.reservations; target_room public.rooms; new_stay_id uuid; new_folio_id uuid; new_folio_number text;
begin
  select * into reservation_record from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(reservation_record.hotel_id, 'stays.check_in') then raise exception 'Not authorised to check in guests'; end if;
  if reservation_record.status not in ('pending', 'confirmed') then raise exception 'Only pending or confirmed reservations can be checked in'; end if;
  if reservation_record.room_id is null then raise exception 'Assign a room before check-in'; end if;
  if check_in_on < reservation_record.check_in_date or check_in_on >= reservation_record.check_out_date then raise exception 'Check-in date is outside the reservation dates'; end if;
  if exists (
    select 1 from public.reservation_deposits rd join public.payments p on p.id = rd.payment_id
    where rd.reservation_id = reservation_record.id and p.status = 'pending_verification'
  ) then raise exception 'Verify or reject all pending reservation deposits before check-in'; end if;

  select * into target_room from public.rooms where id = reservation_record.room_id and hotel_id = reservation_record.hotel_id for update;
  if not found or not target_room.active or target_room.blocked_at is not null then raise exception 'Assigned room is not available'; end if;
  if target_room.turnover_status <> 'clean' then raise exception 'Assigned room is awaiting housekeeping turnover'; end if;
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

revoke all on function public.provision_payment_verification_permissions(uuid), public.handle_hotel_payment_verification_permission_provisioning() from public, anon, authenticated;
revoke all on function public.verify_pending_payment(uuid, text), public.reject_pending_payment(uuid, text), public.get_pending_payment_verifications(uuid) from public, anon;
grant execute on function public.record_folio_payment(uuid, uuid, bigint, text), public.record_reservation_deposit(uuid, uuid, bigint, text), public.verify_pending_payment(uuid, text), public.reject_pending_payment(uuid, text), public.get_pending_payment_verifications(uuid), public.check_in_reservation(uuid, date) to authenticated;
