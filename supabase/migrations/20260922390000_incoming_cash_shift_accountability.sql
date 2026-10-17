-- Physical cash must enter an open shift irrespective of the recipient's role.
-- Non-cash methods remain receivable by authorised operational staff.

create or replace function public.record_folio_payment(
  target_folio_id uuid,
  target_payment_method_id uuid,
  payment_amount_kobo bigint,
  payment_reference text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  target_folio public.guest_folios;
  payment_id uuid;
  payment_number text;
  receipt_number text;
  target_balance bigint;
  payment_requires_reference boolean;
  payment_method_code text;
  current_shift_id uuid;
begin
  select * into target_folio from public.guest_folios where id = target_folio_id for update;
  if not found then raise exception 'Folio not found'; end if;
  if not public.has_hotel_permission(target_folio.hotel_id, 'payments.create') then raise exception 'Not authorised to record payments'; end if;
  if target_folio.status <> 'open' then raise exception 'Only open folios can receive payments'; end if;
  if payment_amount_kobo <= 0 then raise exception 'Payment amount must be greater than zero'; end if;
  select pm.requires_reference, pm.code into payment_requires_reference, payment_method_code
  from public.payment_methods pm where pm.id = target_payment_method_id and pm.hotel_id = target_folio.hotel_id and pm.active;
  if not found then raise exception 'Payment method is not available'; end if;
  if payment_requires_reference and nullif(trim(payment_reference), '') is null then raise exception 'A reference is required for this payment method'; end if;
  if payment_method_code = 'cash' then
    if not public.has_hotel_permission(target_folio.hotel_id, 'cashier_shifts.open') then raise exception 'Only a cashier, general manager, or owner with an open shift may receive cash'; end if;
    select id into current_shift_id from public.cashier_shifts
    where hotel_id = target_folio.hotel_id and opened_by = auth.uid() and status = 'open'
    for update;
    if current_shift_id is null then raise exception 'Open a cashier shift before receiving cash'; end if;
  end if;
  target_balance := public.folio_balance(target_folio_id);
  if payment_amount_kobo > target_balance then raise exception 'Payment cannot exceed the folio balance'; end if;
  payment_number := public.next_document_number(target_folio.hotel_id, 'PAY');
  insert into public.payments (hotel_id, payment_number, payment_method_id, amount_kobo, reference, received_by, cashier_shift_id)
  values (target_folio.hotel_id, payment_number, target_payment_method_id, payment_amount_kobo, nullif(trim(payment_reference), ''), auth.uid(), current_shift_id)
  returning id into payment_id;
  insert into public.payment_allocations (payment_id, folio_id, amount_kobo) values (payment_id, target_folio_id, payment_amount_kobo);
  receipt_number := public.next_document_number(target_folio.hotel_id, 'RCP');
  insert into public.receipts (hotel_id, receipt_number, folio_id, payment_id, issued_by) values (target_folio.hotel_id, receipt_number, target_folio_id, payment_id, auth.uid());
  perform public.log_activity(target_folio.hotel_id, 'payment.created', 'payment', payment_id,
    jsonb_build_object('folio_id', target_folio_id, 'amount_kobo', payment_amount_kobo, 'receipt_number', receipt_number, 'cashier_shift_id', current_shift_id));
  return payment_id;
end;
$$;

create or replace function public.record_reservation_deposit(
  target_reservation_id uuid,
  target_payment_method_id uuid,
  deposit_amount_kobo bigint,
  payment_reference text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  reservation_record public.reservations;
  payment_id uuid;
  deposit_id uuid;
  payment_number text;
  deposit_receipt_number text;
  payment_requires_reference boolean;
  payment_method_code text;
  current_shift_id uuid;
  maximum_deposit bigint;
  already_received bigint;
begin
  select * into reservation_record from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(reservation_record.hotel_id, 'deposits.create') then raise exception 'Not authorised to receive reservation deposits'; end if;
  if reservation_record.status not in ('pending', 'confirmed') then raise exception 'Deposits may only be received before check-in'; end if;
  if deposit_amount_kobo <= 0 then raise exception 'Deposit must be greater than zero'; end if;
  select pm.requires_reference, pm.code into payment_requires_reference, payment_method_code
  from public.payment_methods pm where pm.id = target_payment_method_id and pm.hotel_id = reservation_record.hotel_id and pm.active;
  if not found then raise exception 'Payment method is not available'; end if;
  if payment_requires_reference and nullif(trim(payment_reference), '') is null then raise exception 'A reference is required for this payment method'; end if;
  maximum_deposit := reservation_record.agreed_rate_kobo * (reservation_record.check_out_date - reservation_record.check_in_date);
  select coalesce(sum(p.amount_kobo), 0) into already_received
  from public.reservation_deposits rd join public.payments p on p.id = rd.payment_id
  where rd.reservation_id = reservation_record.id and p.status = 'completed';
  if already_received + deposit_amount_kobo > maximum_deposit then raise exception 'Deposit cannot exceed the reserved room value'; end if;
  if payment_method_code = 'cash' then
    if not public.has_hotel_permission(reservation_record.hotel_id, 'cashier_shifts.open') then raise exception 'Only a cashier, general manager, or owner with an open shift may receive cash'; end if;
    select id into current_shift_id from public.cashier_shifts
    where hotel_id = reservation_record.hotel_id and opened_by = auth.uid() and status = 'open'
    for update;
    if current_shift_id is null then raise exception 'Open a cashier shift before receiving cash'; end if;
  end if;
  payment_number := public.next_document_number(reservation_record.hotel_id, 'PAY');
  insert into public.payments (hotel_id, payment_number, payment_method_id, amount_kobo, reference, received_by, cashier_shift_id)
  values (reservation_record.hotel_id, payment_number, target_payment_method_id, deposit_amount_kobo, nullif(trim(payment_reference), ''), auth.uid(), current_shift_id)
  returning id into payment_id;
  deposit_receipt_number := public.next_document_number(reservation_record.hotel_id, 'RCP');
  insert into public.reservation_deposits (hotel_id, reservation_id, payment_id, receipt_number, received_by)
  values (reservation_record.hotel_id, reservation_record.id, payment_id, deposit_receipt_number, auth.uid()) returning id into deposit_id;
  perform public.log_activity(reservation_record.hotel_id, 'reservation.deposit_received', 'reservation_deposit', deposit_id,
    jsonb_build_object('reservation_id', reservation_record.id, 'payment_id', payment_id, 'amount_kobo', deposit_amount_kobo,
      'receipt_number', deposit_receipt_number, 'cashier_shift_id', current_shift_id));
  return deposit_id;
end;
$$;

revoke all on function public.record_folio_payment(uuid, uuid, bigint, text), public.record_reservation_deposit(uuid, uuid, bigint, text) from public, anon;
grant execute on function public.record_folio_payment(uuid, uuid, bigint, text), public.record_reservation_deposit(uuid, uuid, bigint, text) to authenticated;
