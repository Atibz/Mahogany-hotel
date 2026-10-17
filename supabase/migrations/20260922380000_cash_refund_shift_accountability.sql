-- Cash paid out must reconcile against the shift that physically pays it,
-- rather than retroactively changing a previous cashier's closed shift.

alter table public.payment_refunds
  add column if not exists cashier_shift_id uuid references public.cashier_shifts(id) on delete restrict;
create index if not exists payment_refunds_cashier_shift_idx
  on public.payment_refunds(cashier_shift_id) where cashier_shift_id is not null;

create or replace function public.cashier_shift_expected_cash(target_cashier_shift_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select cs.opening_float_kobo
    + coalesce((select sum(p.amount_kobo)
      from public.payments p join public.payment_methods pm on pm.id = p.payment_method_id
      where p.cashier_shift_id = cs.id and pm.code = 'cash' and p.status in ('completed', 'refunded')), 0)
    - coalesce((select sum(pr.amount_kobo)
      from public.payment_refunds pr
      join public.payments p on p.id = pr.payment_id
      join public.payment_methods pm on pm.id = p.payment_method_id
      where pm.code = 'cash'
        and coalesce(pr.cashier_shift_id, p.cashier_shift_id) = cs.id), 0)
  from public.cashier_shifts cs where cs.id = target_cashier_shift_id;
$$;

create or replace function public.refund_folio_payment(
  target_payment_id uuid,
  refund_amount_kobo bigint,
  refund_reason_value text,
  refund_reference text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_payment public.payments;
  target_folio public.guest_folios;
  refunded_total bigint;
  refund_id uuid;
  refund_number text;
  payment_method_code text;
  payout_shift_id uuid;
begin
  select * into target_payment from public.payments where id = target_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  select gf.* into target_folio
  from public.payment_allocations pa join public.guest_folios gf on gf.id = pa.folio_id
  where pa.payment_id = target_payment_id
  for update;
  if not found then raise exception 'Payment allocation not found'; end if;
  if not public.has_hotel_permission(target_payment.hotel_id, 'payments.refund') then raise exception 'Not authorised to refund payments'; end if;
  if target_payment.status not in ('completed', 'refunded') then raise exception 'Only completed payments can be refunded'; end if;
  if target_folio.status <> 'open' then raise exception 'Refunds after checkout require an approved credit-note workflow'; end if;
  if refund_amount_kobo <= 0 then raise exception 'Refund amount must be greater than zero'; end if;
  if nullif(trim(refund_reason_value), '') is null then raise exception 'A refund reason is required'; end if;

  select pm.code into payment_method_code from public.payment_methods pm where pm.id = target_payment.payment_method_id;
  if not found then raise exception 'Payment method is not available'; end if;
  if payment_method_code = 'cash' then
    if not public.has_hotel_permission(target_payment.hotel_id, 'cashier_shifts.open') then
      raise exception 'Only a cashier, general manager, or owner with an open shift can pay a cash refund';
    end if;
    select id into payout_shift_id from public.cashier_shifts
    where hotel_id = target_payment.hotel_id and opened_by = auth.uid() and status = 'open'
    for update;
    if payout_shift_id is null then raise exception 'Open a cashier shift before paying a cash refund'; end if;
  end if;

  select coalesce(sum(amount_kobo), 0) into refunded_total from public.payment_refunds where payment_id = target_payment.id;
  if refunded_total + refund_amount_kobo > target_payment.amount_kobo then raise exception 'Refund cannot exceed the original payment amount'; end if;

  refund_number := public.next_document_number(target_payment.hotel_id, 'RFN');
  insert into public.payment_refunds (hotel_id, refund_number, payment_id, folio_id, amount_kobo, reference, reason, refunded_by, cashier_shift_id)
  values (target_payment.hotel_id, refund_number, target_payment.id, target_folio.id, refund_amount_kobo,
    nullif(trim(refund_reference), ''), trim(refund_reason_value), auth.uid(), payout_shift_id)
  returning id into refund_id;
  if refunded_total + refund_amount_kobo = target_payment.amount_kobo then update public.payments set status = 'refunded' where id = target_payment.id; end if;
  perform public.log_activity(target_payment.hotel_id, 'payment.refunded', 'payment_refund', refund_id,
    jsonb_build_object('payment_id', target_payment.id, 'folio_id', target_folio.id, 'amount_kobo', refund_amount_kobo,
      'refund_number', refund_number, 'reason', trim(refund_reason_value), 'cashier_shift_id', payout_shift_id));
  return refund_id;
end;
$$;

revoke all on function public.cashier_shift_expected_cash(uuid) from public, anon, authenticated;
revoke all on function public.refund_folio_payment(uuid, bigint, text, text) from public, anon;
grant execute on function public.refund_folio_payment(uuid, bigint, text, text) to authenticated;
