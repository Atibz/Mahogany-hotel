-- Fix the deposit workflow's ambiguous PL/pgSQL reference discovered by db lint.
-- Refunded deposits do not count toward the amount currently held for a reservation.

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
  current_shift_id uuid;
  maximum_deposit bigint;
  already_received bigint;
begin
  select * into reservation_record from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(reservation_record.hotel_id, 'deposits.create') then raise exception 'Not authorised to receive reservation deposits'; end if;
  if reservation_record.status not in ('pending', 'confirmed') then raise exception 'Deposits may only be received before check-in'; end if;
  if deposit_amount_kobo <= 0 then raise exception 'Deposit must be greater than zero'; end if;

  select pm.requires_reference into payment_requires_reference
  from public.payment_methods pm
  where pm.id = target_payment_method_id and pm.hotel_id = reservation_record.hotel_id and pm.active;
  if not found then raise exception 'Payment method is not available'; end if;
  if payment_requires_reference and nullif(trim(payment_reference), '') is null then raise exception 'A reference is required for this payment method'; end if;

  maximum_deposit := reservation_record.agreed_rate_kobo * (reservation_record.check_out_date - reservation_record.check_in_date);
  select coalesce(sum(p.amount_kobo), 0) into already_received
  from public.reservation_deposits rd
  join public.payments p on p.id = rd.payment_id
  where rd.reservation_id = reservation_record.id and p.status = 'completed';
  if already_received + deposit_amount_kobo > maximum_deposit then raise exception 'Deposit cannot exceed the reserved room value'; end if;

  if exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.profile_id = auth.uid() and r.hotel_id = reservation_record.hotel_id and r.code = 'cashier' and r.active
  ) then
    select id into current_shift_id
    from public.cashier_shifts
    where hotel_id = reservation_record.hotel_id and opened_by = auth.uid() and status = 'open'
    for update;
    if current_shift_id is null then raise exception 'Open a cashier shift before receiving a deposit'; end if;
  end if;

  payment_number := public.next_document_number(reservation_record.hotel_id, 'PAY');
  insert into public.payments (hotel_id, payment_number, payment_method_id, amount_kobo, reference, received_by, cashier_shift_id)
  values (reservation_record.hotel_id, payment_number, target_payment_method_id, deposit_amount_kobo,
    nullif(trim(payment_reference), ''), auth.uid(), current_shift_id)
  returning id into payment_id;
  deposit_receipt_number := public.next_document_number(reservation_record.hotel_id, 'RCP');
  insert into public.reservation_deposits (hotel_id, reservation_id, payment_id, receipt_number, received_by)
  values (reservation_record.hotel_id, reservation_record.id, payment_id, deposit_receipt_number, auth.uid())
  returning id into deposit_id;
  perform public.log_activity(reservation_record.hotel_id, 'reservation.deposit_received', 'reservation_deposit', deposit_id,
    jsonb_build_object('reservation_id', reservation_record.id, 'payment_id', payment_id,
      'amount_kobo', deposit_amount_kobo, 'receipt_number', deposit_receipt_number));
  return deposit_id;
end;
$$;

revoke all on function public.record_reservation_deposit(uuid, uuid, bigint, text) from public, anon;
grant execute on function public.record_reservation_deposit(uuid, uuid, bigint, text) to authenticated;
