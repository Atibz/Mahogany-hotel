-- An active overstay may check out on the current business date. Ensure every
-- occupied night before checkout exists before testing the final folio balance.

create or replace function public.checkout_stay(target_stay_id uuid, checkout_on date default null)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_stay public.stays;
  target_folio public.guest_folios;
  target_date date;
  current_business_date date;
  target_balance bigint;
  invoice_id uuid;
  invoice_number text;
  invoice_snapshot jsonb;
begin
  select * into target_stay from public.stays where id = target_stay_id for update;
  if not found then raise exception 'Stay not found'; end if;
  if not public.has_hotel_permission(target_stay.hotel_id, 'stays.checkout') then
    raise exception 'Not authorised to check out guests';
  end if;
  if target_stay.status <> 'checked_in' then
    raise exception 'Only active stays can be checked out';
  end if;

  current_business_date := public.hotel_business_date(target_stay.hotel_id);
  checkout_on := coalesce(checkout_on, current_business_date);
  if checkout_on < target_stay.actual_check_in_date
     or checkout_on > current_business_date then
    raise exception 'Checkout date is outside the occupied stay period';
  end if;

  select * into target_folio
  from public.guest_folios
  where stay_id = target_stay.id and status = 'open'
  for update;
  if not found then raise exception 'Open folio not found'; end if;

  target_date := target_stay.actual_check_in_date;
  while target_date < checkout_on loop
    perform public.post_occupied_room_night_for_audit(target_stay.id, target_date);
    target_date := target_date + 1;
  end loop;

  target_balance := public.folio_balance(target_folio.id);
  if target_balance <> 0 then
    raise exception 'Folio must be fully settled before checkout. Balance: % kobo', target_balance;
  end if;

  select jsonb_build_object(
    'folio_number', target_folio.folio_number,
    'stay_id', target_stay.id,
    'guest_id', target_stay.guest_id,
    'room_id', target_stay.room_id,
    'scheduled_checkout_date', target_stay.expected_check_out_date,
    'checkout_date', checkout_on,
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', fi.id,
        'description', fi.description,
        'service_date', fi.service_date,
        'base_amount_kobo', fi.base_amount_kobo,
        'tax_amount_kobo', fi.tax_amount_kobo,
        'service_charge_amount_kobo', fi.service_charge_amount_kobo,
        'total_amount_kobo', fi.total_amount_kobo,
        'status', fi.status
      ) order by fi.posted_at)
      from public.folio_items fi where fi.folio_id = target_folio.id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'payment_id', p.id,
        'payment_number', p.payment_number,
        'amount_kobo', pa.amount_kobo,
        'method_id', p.payment_method_id,
        'reference', p.reference,
        'received_at', p.received_at
      ) order by p.received_at)
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id
      where pa.folio_id = target_folio.id
    ), '[]'::jsonb),
    'final_balance_kobo', target_balance
  ) into invoice_snapshot;

  update public.stays
  set status = 'checked_out', actual_check_out_date = checkout_on,
      checked_out_by = auth.uid()
  where id = target_stay.id;
  update public.reservations
  set status = 'checked_out', updated_by = auth.uid()
  where id = target_stay.reservation_id;
  update public.guest_folios
  set status = 'closed', closed_at = now(), closed_by = auth.uid()
  where id = target_folio.id;
  update public.rooms
  set turnover_status = 'dirty', turnover_updated_at = now(), updated_at = now()
  where id = target_stay.room_id;
  insert into public.room_turnover_tasks (hotel_id, room_id, stay_id)
  values (target_stay.hotel_id, target_stay.room_id, target_stay.id);

  invoice_number := public.next_document_number(target_stay.hotel_id, 'INV');
  insert into public.invoices (hotel_id, invoice_number, folio_id, snapshot, issued_by)
  values (target_stay.hotel_id, invoice_number, target_folio.id, invoice_snapshot, auth.uid())
  returning id into invoice_id;

  perform public.log_activity(
    target_stay.hotel_id,
    'stay.checked_out',
    'stay',
    target_stay.id,
    jsonb_build_object(
      'folio_id', target_folio.id,
      'invoice_id', invoice_id,
      'invoice_number', invoice_number,
      'room_id', target_stay.room_id,
      'scheduled_checkout_date', target_stay.expected_check_out_date,
      'actual_checkout_date', checkout_on,
      'was_overstay', checkout_on > target_stay.expected_check_out_date,
      'room_turnover_status', 'dirty'
    )
  );
  return invoice_id;
end;
$$;

revoke all on function public.checkout_stay(uuid, date) from public, anon;
grant execute on function public.checkout_stay(uuid, date) to authenticated;

