-- Controlled full/partial company settlement using the main payment ledger.

alter table public.receipts add column if not exists business_receivable_id uuid
  references public.business_account_receivables(id) on delete restrict;
alter table public.receipts alter column folio_id drop not null;
alter table public.receipts drop constraint if exists receipts_target_check;
alter table public.receipts add constraint receipts_target_check check (
  (folio_id is not null and business_receivable_id is null)
  or (folio_id is null and business_receivable_id is not null)
);

create table public.business_account_receivable_payments (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  receivable_id uuid not null references public.business_account_receivables(id) on delete restrict,
  payment_id uuid not null unique references public.payments(id) on delete restrict,
  amount_kobo bigint not null check (amount_kobo > 0),
  recorded_by uuid references public.profiles(id) on delete set null,
  recorded_at timestamptz not null default now()
);
create index business_receivable_payments_receivable_idx on public.business_account_receivable_payments(receivable_id, recorded_at);
alter table public.business_account_receivable_payments enable row level security;
revoke all on public.business_account_receivable_payments from public, anon, authenticated;
grant select on public.business_account_receivable_payments to authenticated;
create policy business_receivable_payments_read on public.business_account_receivable_payments for select to authenticated
using (public.has_hotel_permission(hotel_id, 'receivables.read'));

create or replace function public.business_receivable_outstanding(target_receivable_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select greatest(
    coalesce((select sum(a.amount_kobo) from public.business_account_receivable_allocations a where a.receivable_id = target_receivable_id), 0)
    - coalesce((select sum(rp.amount_kobo) from public.business_account_receivable_payments rp
                join public.payments p on p.id = rp.payment_id
                where rp.receivable_id = target_receivable_id and p.status in ('completed', 'refunded')), 0)
    + coalesce((select sum(pr.amount_kobo) from public.business_account_receivable_payments rp
                join public.payment_refunds pr on pr.payment_id = rp.payment_id
                where rp.receivable_id = target_receivable_id), 0), 0)::bigint;
$$;

create or replace function public.refresh_business_receivable_status(target_receivable_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare principal bigint; outstanding bigint;
begin
  select coalesce(sum(amount_kobo), 0) into principal from public.business_account_receivable_allocations where receivable_id = target_receivable_id;
  outstanding := public.business_receivable_outstanding(target_receivable_id);
  update public.business_account_receivables set status = case
    when outstanding = 0 then 'settled'
    when outstanding < principal then 'partially_settled'
    else 'open' end
  where id = target_receivable_id and status <> 'voided';
end;
$$;

create or replace function public.get_business_receivables(target_hotel_id uuid)
returns table (
  receivable_id uuid, receivable_number text, account_number text, account_name text,
  invoice_number text, folio_number text, principal_kobo bigint, outstanding_kobo bigint,
  due_date date, days_overdue integer, status text, created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'receivables.read') then raise exception 'Not authorised to view receivables'; end if;
  return query select bar.id, bar.receivable_number, ba.account_number, coalesce(ba.trading_name, ba.legal_name),
    i.invoice_number, gf.folio_number,
    coalesce((select sum(a.amount_kobo) from public.business_account_receivable_allocations a where a.receivable_id = bar.id), 0)::bigint,
    public.business_receivable_outstanding(bar.id),
    bar.due_date, greatest(public.hotel_business_date(target_hotel_id) - bar.due_date, 0), bar.status, bar.created_at
  from public.business_account_receivables bar
  join public.business_accounts ba on ba.id = bar.business_account_id
  join public.guest_folios gf on gf.id = bar.folio_id
  left join public.invoices i on i.id = bar.invoice_id
  where bar.hotel_id = target_hotel_id order by bar.due_date, bar.created_at;
end;
$$;

create or replace function public.record_business_receivable_payment(
  target_receivable_id uuid, target_payment_method_id uuid,
  payment_amount_kobo bigint, payment_reference text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  target_receivable public.business_account_receivables; method_record public.payment_methods;
  outstanding bigint; pending_total bigint; payment_id uuid; payment_number text;
  initial_status public.payment_status; current_shift_id uuid; receipt_number text;
begin
  select * into target_receivable from public.business_account_receivables where id = target_receivable_id for update;
  if not found then raise exception 'Business receivable not found'; end if;
  if not public.has_hotel_permission(target_receivable.hotel_id, 'receivables.settle') then raise exception 'Not authorised to settle company receivables'; end if;
  if target_receivable.status in ('settled', 'voided') then raise exception 'This receivable is not open for settlement'; end if;
  if payment_amount_kobo <= 0 then raise exception 'Payment amount must be greater than zero'; end if;
  select * into method_record from public.payment_methods where id = target_payment_method_id and hotel_id = target_receivable.hotel_id and active;
  if not found then raise exception 'Payment method is not available'; end if;
  if method_record.requires_reference and nullif(trim(payment_reference), '') is null then raise exception 'A reference is required for this payment method'; end if;
  if method_record.code = 'cash' and method_record.requires_verification then raise exception 'Cash cannot require verification'; end if;
  if method_record.code = 'cash' then
    if not public.has_hotel_permission(target_receivable.hotel_id, 'cashier_shifts.open') then raise exception 'Open an authorised cashier shift before receiving company cash'; end if;
    select id into current_shift_id from public.cashier_shifts
    where hotel_id = target_receivable.hotel_id and opened_by = auth.uid() and status = 'open' for update;
    if current_shift_id is null then raise exception 'Open a cashier shift before receiving cash'; end if;
  end if;
  outstanding := public.business_receivable_outstanding(target_receivable.id);
  select coalesce(sum(rp.amount_kobo), 0) into pending_total
  from public.business_account_receivable_payments rp join public.payments p on p.id = rp.payment_id
  where rp.receivable_id = target_receivable.id and p.status = 'pending_verification';
  if payment_amount_kobo > outstanding - pending_total then raise exception 'Payment exceeds the remaining company balance, including pending payments'; end if;
  initial_status := case when method_record.requires_verification then 'pending_verification'::public.payment_status else 'completed'::public.payment_status end;
  payment_number := public.next_document_number(target_receivable.hotel_id, 'PAY');
  insert into public.payments (hotel_id, payment_number, payment_method_id, amount_kobo, reference, status, received_by, cashier_shift_id)
  values (target_receivable.hotel_id, payment_number, method_record.id, payment_amount_kobo, nullif(trim(payment_reference), ''), initial_status, auth.uid(), current_shift_id)
  returning id into payment_id;
  insert into public.business_account_receivable_payments (hotel_id, receivable_id, payment_id, amount_kobo, recorded_by)
  values (target_receivable.hotel_id, target_receivable.id, payment_id, payment_amount_kobo, auth.uid());
  if initial_status = 'completed' then
    receipt_number := public.next_document_number(target_receivable.hotel_id, 'RCP');
    insert into public.receipts (hotel_id, receipt_number, folio_id, business_receivable_id, payment_id, issued_by)
    values (target_receivable.hotel_id, receipt_number, null, target_receivable.id, payment_id, auth.uid());
    perform public.refresh_business_receivable_status(target_receivable.id);
  end if;
  perform public.log_activity(target_receivable.hotel_id, 'receivable.payment_recorded', 'business_account_receivable', target_receivable.id,
    jsonb_build_object('payment_id', payment_id, 'payment_number', payment_number, 'amount_kobo', payment_amount_kobo,
      'status', initial_status, 'receipt_number', receipt_number));
  return payment_id;
end;
$$;

create or replace function public.verify_business_receivable_payment(target_payment_id uuid, verification_note_value text)
returns void language plpgsql security definer set search_path = public as $$
declare target_payment public.payments; link_record public.business_account_receivable_payments; receipt_number text; pending_other bigint;
begin
  select * into target_payment from public.payments where id = target_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  select * into link_record from public.business_account_receivable_payments where payment_id = target_payment.id for update;
  if not found then raise exception 'Payment is not linked to a business receivable'; end if;
  if not public.has_hotel_permission(target_payment.hotel_id, 'payments.verify') then raise exception 'Not authorised to verify payments'; end if;
  if target_payment.status <> 'pending_verification' then raise exception 'Only pending payments can be verified'; end if;
  if nullif(trim(verification_note_value), '') is null then raise exception 'A verification note is required'; end if;
  select coalesce(sum(rp.amount_kobo), 0) into pending_other
  from public.business_account_receivable_payments rp join public.payments p on p.id = rp.payment_id
  where rp.receivable_id = link_record.receivable_id and p.status = 'pending_verification' and p.id <> target_payment.id;
  if target_payment.amount_kobo > public.business_receivable_outstanding(link_record.receivable_id) - pending_other then
    raise exception 'Verified payment would exceed the remaining company balance';
  end if;
  receipt_number := public.next_document_number(target_payment.hotel_id, 'RCP');
  insert into public.receipts (hotel_id, receipt_number, folio_id, business_receivable_id, payment_id, issued_by)
  values (target_payment.hotel_id, receipt_number, null, link_record.receivable_id, target_payment.id, auth.uid());
  update public.payments set status = 'completed', verified_at = now(), verified_by = auth.uid(), verification_note = trim(verification_note_value)
  where id = target_payment.id;
  perform public.refresh_business_receivable_status(link_record.receivable_id);
  perform public.log_activity(target_payment.hotel_id, 'receivable.payment_verified', 'business_account_receivable', link_record.receivable_id,
    jsonb_build_object('payment_id', target_payment.id, 'receipt_number', receipt_number, 'verification_note', trim(verification_note_value)));
end;
$$;

create or replace function public.reject_business_receivable_payment(target_payment_id uuid, rejection_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare target_payment public.payments; link_record public.business_account_receivable_payments;
begin
  select * into target_payment from public.payments where id = target_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  select * into link_record from public.business_account_receivable_payments where payment_id = target_payment.id;
  if not found then raise exception 'Payment is not linked to a business receivable'; end if;
  if not public.has_hotel_permission(target_payment.hotel_id, 'payments.verify') then raise exception 'Not authorised to reject payments'; end if;
  if target_payment.status <> 'pending_verification' then raise exception 'Only pending payments can be rejected'; end if;
  if nullif(trim(rejection_reason), '') is null then raise exception 'A rejection reason is required'; end if;
  update public.payments set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = trim(rejection_reason) where id = target_payment.id;
  perform public.log_activity(target_payment.hotel_id, 'receivable.payment_rejected', 'business_account_receivable', link_record.receivable_id,
    jsonb_build_object('payment_id', target_payment.id, 'reason', trim(rejection_reason)));
end;
$$;

create or replace function public.get_business_receivable_payments(target_hotel_id uuid)
returns table (
  payment_id uuid, receivable_id uuid, receivable_number text, account_name text,
  payment_number text, payment_method_name text, amount_kobo bigint, reference text,
  status public.payment_status, received_at timestamptz, receipt_number text
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'receivables.read') then raise exception 'Not authorised to view receivable payments'; end if;
  return query select p.id, bar.id, bar.receivable_number, coalesce(ba.trading_name, ba.legal_name),
    p.payment_number, pm.name, rp.amount_kobo, p.reference, p.status, p.received_at, r.receipt_number
  from public.business_account_receivable_payments rp
  join public.business_account_receivables bar on bar.id = rp.receivable_id
  join public.business_accounts ba on ba.id = bar.business_account_id
  join public.payments p on p.id = rp.payment_id
  join public.payment_methods pm on pm.id = p.payment_method_id
  left join public.receipts r on r.payment_id = p.id
  where rp.hotel_id = target_hotel_id order by p.received_at desc;
end;
$$;

revoke all on function public.business_receivable_outstanding(uuid), public.refresh_business_receivable_status(uuid),
  public.record_business_receivable_payment(uuid, uuid, bigint, text), public.verify_business_receivable_payment(uuid, text),
  public.reject_business_receivable_payment(uuid, text), public.get_business_receivable_payments(uuid) from public, anon;
grant execute on function public.record_business_receivable_payment(uuid, uuid, bigint, text),
  public.verify_business_receivable_payment(uuid, text), public.reject_business_receivable_payment(uuid, text),
  public.get_business_receivable_payments(uuid), public.get_business_receivables(uuid) to authenticated;
