-- Corrections to closed company invoices are separate, approved documents.
-- A credit note reduces the company debt; a later refund clears any resulting credit.

alter table public.business_account_receivables drop constraint if exists business_account_receivables_status_check;
alter table public.business_account_receivables add constraint business_account_receivables_status_check
  check (status in ('open', 'partially_settled', 'settled', 'credit_balance', 'voided'));

create table public.business_account_credit_notes (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  credit_note_number text not null,
  receivable_id uuid not null references public.business_account_receivables(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  approval_request_id uuid not null unique references public.finance_approval_requests(id) on delete restrict,
  amount_kobo bigint not null check (amount_kobo > 0),
  reason text not null check (length(trim(reason)) > 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  issued_by uuid references public.profiles(id) on delete set null,
  issued_at timestamptz not null default now(),
  unique (hotel_id, credit_note_number)
);
create index business_credit_notes_receivable_idx on public.business_account_credit_notes(receivable_id, issued_at);
alter table public.business_account_credit_notes enable row level security;
revoke all on public.business_account_credit_notes from public, anon, authenticated;
grant select on public.business_account_credit_notes to authenticated;
create policy business_credit_notes_read on public.business_account_credit_notes for select to authenticated
using (public.has_hotel_permission(hotel_id, 'receivables.read'));

alter table public.payment_refunds add column if not exists business_receivable_id uuid
  references public.business_account_receivables(id) on delete restrict;
alter table public.payment_refunds alter column folio_id drop not null;
alter table public.payment_refunds add constraint payment_refunds_target_check check (
  (folio_id is not null and business_receivable_id is null)
  or (folio_id is null and business_receivable_id is not null)
);
create index business_payment_refunds_receivable_idx on public.payment_refunds(business_receivable_id, refunded_at)
where business_receivable_id is not null;
drop policy if exists payment_refunds_read on public.payment_refunds;
create policy payment_refunds_read on public.payment_refunds for select to authenticated using (
  (folio_id is not null and public.has_hotel_permission(hotel_id, 'payments.read'))
  or (business_receivable_id is not null and public.has_hotel_permission(hotel_id, 'receivables.read'))
);

alter table public.finance_approval_requests drop constraint if exists finance_approval_requests_action_type_check;
alter table public.finance_approval_requests add constraint finance_approval_requests_action_type_check
check (action_type in ('void_payment', 'refund_payment', 'folio_adjustment', 'reverse_folio_item',
  'reservation_discount', 'company_credit_note', 'company_payment_refund'));

create or replace function public.business_receivable_signed_balance(target_receivable_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select (
    coalesce((select sum(a.amount_kobo) from public.business_account_receivable_allocations a
      where a.receivable_id = target_receivable_id), 0)
    - coalesce((select sum(cn.amount_kobo) from public.business_account_credit_notes cn
      where cn.receivable_id = target_receivable_id), 0)
    - coalesce((select sum(rp.amount_kobo) from public.business_account_receivable_payments rp
      join public.payments p on p.id = rp.payment_id
      where rp.receivable_id = target_receivable_id and p.status in ('completed', 'refunded')), 0)
    + coalesce((select sum(pr.amount_kobo) from public.payment_refunds pr
      where pr.business_receivable_id = target_receivable_id), 0)
  )::bigint;
$$;

create or replace function public.business_receivable_outstanding(target_receivable_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select greatest(public.business_receivable_signed_balance(target_receivable_id), 0);
$$;

create or replace function public.refresh_business_receivable_status(target_receivable_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare adjusted_principal bigint; balance bigint;
begin
  select coalesce(sum(a.amount_kobo), 0) into adjusted_principal
  from public.business_account_receivable_allocations a where a.receivable_id = target_receivable_id;
  adjusted_principal := adjusted_principal - coalesce((select sum(cn.amount_kobo)
    from public.business_account_credit_notes cn where cn.receivable_id = target_receivable_id), 0);
  balance := public.business_receivable_signed_balance(target_receivable_id);
  update public.business_account_receivables set status = case
    when balance < 0 then 'credit_balance'
    when balance = 0 then 'settled'
    when balance < adjusted_principal then 'partially_settled'
    else 'open' end
  where id = target_receivable_id and status <> 'voided';
end;
$$;

-- Direct execution is intentionally not granted to browser users.
create or replace function public.issue_approved_business_credit_note(target_request_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare req public.finance_approval_requests; ar public.business_account_receivables;
  principal bigint; credited bigint; pending bigint; amount_value bigint;
  note_id uuid; note_number text; invoice_number text; account_name text;
begin
  select * into req from public.finance_approval_requests where id = target_request_id for update;
  if not found or req.action_type <> 'company_credit_note' or req.status <> 'approved'
    or req.decided_by is distinct from auth.uid() then raise exception 'An independently approved credit-note request is required'; end if;
  select * into ar from public.business_account_receivables where id = req.target_entity_id for update;
  if not found or ar.hotel_id <> req.hotel_id or ar.invoice_id is null or ar.status = 'voided' then
    raise exception 'A checked-out company invoice is required'; end if;
  amount_value := (req.payload->>'amount_kobo')::bigint;
  if amount_value is null or amount_value <= 0 then raise exception 'Credit amount must be positive'; end if;
  select coalesce(sum(amount_kobo), 0) into principal from public.business_account_receivable_allocations where receivable_id = ar.id;
  select coalesce(sum(amount_kobo), 0) into credited from public.business_account_credit_notes where receivable_id = ar.id;
  if amount_value > principal - credited then raise exception 'Credit note exceeds the remaining invoiced company amount'; end if;
  select coalesce(sum(rp.amount_kobo), 0) into pending from public.business_account_receivable_payments rp
    join public.payments p on p.id = rp.payment_id
    where rp.receivable_id = ar.id and p.status = 'pending_verification';
  if pending > 0 then raise exception 'Resolve pending company payments before issuing a credit note'; end if;
  select i.invoice_number into invoice_number from public.invoices i where i.id = ar.invoice_id;
  select coalesce(ba.trading_name, ba.legal_name) into account_name from public.business_accounts ba where ba.id = ar.business_account_id;
  note_number := public.next_document_number(ar.hotel_id, 'CN');
  insert into public.business_account_credit_notes
    (hotel_id, credit_note_number, receivable_id, invoice_id, approval_request_id, amount_kobo, reason, snapshot, issued_by)
  values (ar.hotel_id, note_number, ar.id, ar.invoice_id, req.id, amount_value, req.reason,
    jsonb_build_object('credit_note_number', note_number, 'original_invoice_number', invoice_number,
      'receivable_number', ar.receivable_number, 'business_account_id', ar.business_account_id,
      'account_name', account_name, 'amount_kobo', amount_value, 'reason', req.reason,
      'approval_request_id', req.id, 'issued_at', now()), auth.uid())
  returning id into note_id;
  perform public.refresh_business_receivable_status(ar.id);
  perform public.log_activity(ar.hotel_id, 'receivable.credit_note_issued', 'business_account_credit_note', note_id,
    jsonb_build_object('approval_request_id', req.id, 'receivable_id', ar.id,
      'credit_note_number', note_number, 'amount_kobo', amount_value, 'reason', req.reason));
  return note_id;
end;
$$;

create or replace function public.refund_approved_company_payment(target_request_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare req public.finance_approval_requests; payment_record public.payments;
  link_record public.business_account_receivable_payments; ar public.business_account_receivables;
  amount_value bigint; already_refunded bigint; refund_id uuid; refund_number text;
  method_code text; payout_shift_id uuid; payout_reference text;
begin
  select * into req from public.finance_approval_requests where id = target_request_id for update;
  if not found or req.action_type <> 'company_payment_refund' or req.status <> 'approved'
    or req.decided_by is distinct from auth.uid() then raise exception 'An independently approved company refund request is required'; end if;
  select * into payment_record from public.payments where id = req.target_entity_id for update;
  if not found then raise exception 'Company payment not found'; end if;
  select * into link_record from public.business_account_receivable_payments where payment_id = payment_record.id;
  if not found or payment_record.hotel_id <> req.hotel_id or payment_record.status not in ('completed', 'refunded') then
    raise exception 'A completed company payment is required'; end if;
  select * into ar from public.business_account_receivables where id = link_record.receivable_id for update;
  if not found or ar.hotel_id <> req.hotel_id or link_record.hotel_id <> req.hotel_id then
    raise exception 'Company payment does not belong to this hotel'; end if;
  amount_value := (req.payload->>'amount_kobo')::bigint;
  payout_reference := nullif(trim(req.payload->>'reference'), '');
  if amount_value is null or amount_value <= 0 then raise exception 'Refund amount must be positive'; end if;
  if ar.invoice_id is null or ar.status = 'voided' then raise exception 'This company invoice cannot be refunded'; end if;
  if amount_value > greatest(-public.business_receivable_signed_balance(ar.id), 0) then
    raise exception 'Refund exceeds the available company credit balance'; end if;
  select coalesce(sum(pr.amount_kobo), 0) into already_refunded from public.payment_refunds pr where pr.payment_id = payment_record.id;
  if already_refunded + amount_value > link_record.amount_kobo then raise exception 'Refund exceeds the original company payment'; end if;
  select pm.code into method_code from public.payment_methods pm where pm.id = payment_record.payment_method_id;
  if method_code = 'cash' then
    if not public.has_hotel_permission(ar.hotel_id, 'cashier_shifts.open') then
      raise exception 'An authorised cashier shift is required for a cash refund'; end if;
    select cs.id into payout_shift_id from public.cashier_shifts cs
      where cs.hotel_id = ar.hotel_id and cs.opened_by = auth.uid() and cs.status = 'open' for update;
    if payout_shift_id is null then raise exception 'Open a cashier shift before paying a cash refund'; end if;
  elsif payout_reference is null then
    raise exception 'A payout reference is required for a non-cash refund';
  end if;
  refund_number := public.next_document_number(ar.hotel_id, 'RFN');
  insert into public.payment_refunds
    (hotel_id, refund_number, payment_id, folio_id, business_receivable_id, amount_kobo,
      reference, reason, refunded_by, cashier_shift_id)
  values (ar.hotel_id, refund_number, payment_record.id, null, ar.id, amount_value,
    payout_reference, req.reason, auth.uid(), payout_shift_id)
  returning id into refund_id;
  if already_refunded + amount_value = link_record.amount_kobo then
    update public.payments set status = 'refunded' where id = payment_record.id;
  end if;
  perform public.refresh_business_receivable_status(ar.id);
  perform public.log_activity(ar.hotel_id, 'receivable.payment_refunded', 'payment_refund', refund_id,
    jsonb_build_object('approval_request_id', req.id, 'payment_id', payment_record.id,
      'receivable_id', ar.id, 'refund_number', refund_number, 'amount_kobo', amount_value,
      'reason', req.reason, 'cashier_shift_id', payout_shift_id));
  return refund_id;
end;
$$;

create or replace function public.request_business_credit_note(
  target_receivable_id uuid, credit_amount_kobo bigint, request_reason text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare ar public.business_account_receivables; principal bigint; credited bigint; requested bigint; request_id uuid;
begin
  select * into ar from public.business_account_receivables where id = target_receivable_id for update;
  if not found or ar.invoice_id is null or ar.status = 'voided' then
    raise exception 'A checked-out company invoice is required'; end if;
  if not public.has_hotel_permission(ar.hotel_id, 'finance_approvals.request')
    or not public.has_hotel_permission(ar.hotel_id, 'receivables.read') then
    raise exception 'Not authorised to request a company credit note'; end if;
  if credit_amount_kobo is null or credit_amount_kobo <= 0 then raise exception 'Credit amount must be positive'; end if;
  if nullif(trim(request_reason), '') is null then raise exception 'A credit-note reason is required'; end if;
  select coalesce(sum(amount_kobo), 0) into principal from public.business_account_receivable_allocations where receivable_id = ar.id;
  select coalesce(sum(amount_kobo), 0) into credited from public.business_account_credit_notes where receivable_id = ar.id;
  select coalesce(sum((far.payload->>'amount_kobo')::bigint), 0) into requested
  from public.finance_approval_requests far where far.action_type = 'company_credit_note'
    and far.target_entity_id = ar.id and far.status in ('pending', 'approved');
  if credit_amount_kobo > principal - credited - requested then
    raise exception 'Credit request exceeds the remaining uncredited company invoice amount'; end if;
  insert into public.finance_approval_requests
    (hotel_id, action_type, target_entity_type, target_entity_id, payload, reason, requested_by)
  values (ar.hotel_id, 'company_credit_note', 'business_receivable', ar.id,
    jsonb_build_object('amount_kobo', credit_amount_kobo, 'invoice_id', ar.invoice_id),
    trim(request_reason), auth.uid()) returning id into request_id;
  perform public.log_activity(ar.hotel_id, 'receivable.credit_note_requested', 'finance_approval_request', request_id,
    jsonb_build_object('receivable_id', ar.id, 'invoice_id', ar.invoice_id, 'amount_kobo', credit_amount_kobo));
  return request_id;
end;
$$;

create or replace function public.request_business_payment_refund(
  target_payment_id uuid, refund_amount_kobo bigint, request_reason text, payout_reference text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare p public.payments; rp public.business_account_receivable_payments;
  ar public.business_account_receivables; already_refunded bigint; requested bigint;
  request_id uuid; method_code text;
begin
  select * into p from public.payments where id = target_payment_id for update;
  if not found then raise exception 'Company payment not found'; end if;
  select * into rp from public.business_account_receivable_payments where payment_id = p.id;
  if not found or p.status not in ('completed', 'refunded') then raise exception 'A completed company payment is required'; end if;
  select * into ar from public.business_account_receivables where id = rp.receivable_id for update;
  if not found or ar.hotel_id <> p.hotel_id or rp.hotel_id <> p.hotel_id then
    raise exception 'Company payment does not belong to this hotel'; end if;
  if not public.has_hotel_permission(ar.hotel_id, 'receivables.settle')
    or not public.has_hotel_permission(ar.hotel_id, 'finance_approvals.request') then
    raise exception 'Not authorised to request a company payment refund'; end if;
  if ar.invoice_id is null or ar.status = 'voided' then raise exception 'This company invoice cannot be refunded'; end if;
  if refund_amount_kobo is null or refund_amount_kobo <= 0 then raise exception 'Refund amount must be positive'; end if;
  if nullif(trim(request_reason), '') is null then raise exception 'A refund reason is required'; end if;
  select pm.code into method_code from public.payment_methods pm where pm.id = p.payment_method_id;
  if method_code <> 'cash' and nullif(trim(payout_reference), '') is null then
    raise exception 'A payout reference is required for a non-cash refund'; end if;
  select coalesce(sum(pr.amount_kobo), 0) into already_refunded from public.payment_refunds pr where pr.payment_id = p.id;
  select coalesce(sum((far.payload->>'amount_kobo')::bigint), 0) into requested
    from public.finance_approval_requests far where far.action_type = 'company_payment_refund'
      and far.target_entity_id = p.id and far.status in ('pending', 'approved');
  if refund_amount_kobo > rp.amount_kobo - already_refunded - requested then
    raise exception 'Refund request exceeds the refundable amount of this payment'; end if;
  if refund_amount_kobo > greatest(-public.business_receivable_signed_balance(ar.id), 0) then
    raise exception 'Refund request exceeds the available company credit balance'; end if;
  insert into public.finance_approval_requests
    (hotel_id, action_type, target_entity_type, target_entity_id, payload, reason, requested_by)
  values (ar.hotel_id, 'company_payment_refund', 'payment', p.id,
    jsonb_build_object('amount_kobo', refund_amount_kobo, 'reference', nullif(trim(payout_reference), ''),
      'receivable_id', ar.id), trim(request_reason), auth.uid()) returning id into request_id;
  perform public.log_activity(ar.hotel_id, 'receivable.refund_requested', 'finance_approval_request', request_id,
    jsonb_build_object('payment_id', p.id, 'receivable_id', ar.id, 'amount_kobo', refund_amount_kobo));
  return request_id;
end;
$$;

create or replace function public.execute_finance_approval(target_request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.finance_approval_requests;
begin
  select * into r from public.finance_approval_requests where id = target_request_id for update;
  if not found then raise exception 'Financial approval request not found'; end if;
  if not public.has_hotel_permission(r.hotel_id, 'finance_approvals.approve') then raise exception 'Not authorised to execute financial corrections'; end if;
  if r.decided_by <> auth.uid() then raise exception 'Only the independent approver may execute this correction'; end if;
  if r.expires_at <= now() then raise exception 'This request has expired'; end if;
  if r.status <> 'approved' then raise exception 'Only an approved request can be executed'; end if;
  case r.action_type
    when 'void_payment' then perform public.void_folio_payment((r.payload->>'payment_id')::uuid, r.reason);
    when 'refund_payment' then perform public.refund_folio_payment((r.payload->>'payment_id')::uuid, (r.payload->>'amount_kobo')::bigint, r.reason, r.payload->>'reference');
    when 'folio_adjustment' then perform public.create_folio_adjustment((r.payload->>'folio_id')::uuid, (r.payload->>'amount_kobo')::bigint, r.payload->>'description', r.reason);
    when 'reverse_folio_item' then perform public.reverse_folio_item((r.payload->>'folio_item_id')::uuid, r.reason);
    when 'reservation_discount' then perform public.apply_approved_reservation_discount(r.id);
    when 'company_credit_note' then perform public.issue_approved_business_credit_note(r.id);
    when 'company_payment_refund' then perform public.refund_approved_company_payment(r.id);
    else raise exception 'Unsupported financial approval action';
  end case;
  update public.finance_approval_requests set status = 'executed', executed_by = auth.uid(), executed_at = now() where id = r.id;
  perform public.log_activity(r.hotel_id, 'finance_approval.executed', 'finance_approval_request', r.id,
    jsonb_build_object('action_type', r.action_type));
end;
$$;

create or replace function public.get_business_credit_positions(target_hotel_id uuid)
returns table (
  receivable_id uuid, receivable_number text, business_account_id uuid,
  account_name text, invoice_number text, credit_kobo bigint
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'receivables.read') then
    raise exception 'Not authorised to view company credits'; end if;
  return query select ar.id, ar.receivable_number, ba.id,
    coalesce(ba.trading_name, ba.legal_name), i.invoice_number,
    greatest(-public.business_receivable_signed_balance(ar.id), 0)::bigint
  from public.business_account_receivables ar
  join public.business_accounts ba on ba.id = ar.business_account_id
  join public.invoices i on i.id = ar.invoice_id
  where ar.hotel_id = target_hotel_id and ar.status <> 'voided'
    and public.business_receivable_signed_balance(ar.id) < 0
  order by ar.created_at;
end;
$$;

create or replace function public.get_business_credit_notes(target_hotel_id uuid)
returns table (
  credit_note_id uuid, credit_note_number text, receivable_id uuid,
  receivable_number text, account_name text, invoice_number text,
  amount_kobo bigint, reason text, issued_at timestamptz, snapshot jsonb
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'receivables.read') then
    raise exception 'Not authorised to view company credit notes'; end if;
  return query select cn.id, cn.credit_note_number, ar.id, ar.receivable_number,
    coalesce(ba.trading_name, ba.legal_name), i.invoice_number,
    cn.amount_kobo, cn.reason, cn.issued_at, cn.snapshot
  from public.business_account_credit_notes cn
  join public.business_account_receivables ar on ar.id = cn.receivable_id
  join public.business_accounts ba on ba.id = ar.business_account_id
  join public.invoices i on i.id = cn.invoice_id
  where cn.hotel_id = target_hotel_id order by cn.issued_at desc, cn.id desc;
end;
$$;

create or replace function public.get_business_account_statement(
  target_business_account_id uuid,
  target_from_date date default null,
  target_to_date date default null
)
returns table (
  entry_id uuid, entry_type text, occurred_at timestamptz, document_number text,
  related_document text, reference text, debit_kobo bigint,
  credit_kobo bigint, running_balance_kobo bigint
)
language plpgsql stable security definer set search_path = public as $$
declare target_account public.business_accounts;
begin
  select * into target_account from public.business_accounts where id = target_business_account_id;
  if not found then raise exception 'Business account not found'; end if;
  if not public.has_hotel_permission(target_account.hotel_id, 'receivables.read') then
    raise exception 'Not authorised to view this company statement'; end if;
  if target_from_date is not null and target_to_date is not null and target_from_date > target_to_date then
    raise exception 'Statement start date cannot be after end date'; end if;

  return query
  with entries as (
    select a.id as entry_id, 'receivable'::text as entry_type, a.allocated_at as occurred_at,
      ar.receivable_number as document_number, coalesce(i.invoice_number, gf.folio_number) as related_document,
      a.reason as reference, a.amount_kobo::bigint as debit_kobo, 0::bigint as credit_kobo
    from public.business_account_receivable_allocations a
    join public.business_account_receivables ar on ar.id = a.receivable_id
    join public.guest_folios gf on gf.id = ar.folio_id
    left join public.invoices i on i.id = ar.invoice_id
    where ar.business_account_id = target_account.id and ar.status <> 'voided'
    union all
    select cn.id, 'credit_note'::text, cn.issued_at, cn.credit_note_number,
      i.invoice_number, cn.reason, 0::bigint, cn.amount_kobo::bigint
    from public.business_account_credit_notes cn
    join public.business_account_receivables ar on ar.id = cn.receivable_id
    join public.invoices i on i.id = cn.invoice_id
    where ar.business_account_id = target_account.id
    union all
    select rp.id, 'payment'::text, p.received_at, p.payment_number,
      ar.receivable_number, p.reference, 0::bigint, rp.amount_kobo::bigint
    from public.business_account_receivable_payments rp
    join public.business_account_receivables ar on ar.id = rp.receivable_id
    join public.payments p on p.id = rp.payment_id
    where ar.business_account_id = target_account.id and p.status in ('completed', 'refunded')
    union all
    select pr.id, 'refund'::text, pr.refunded_at, pr.refund_number,
      ar.receivable_number, pr.reference, pr.amount_kobo::bigint, 0::bigint
    from public.payment_refunds pr
    join public.business_account_receivables ar on ar.id = pr.business_receivable_id
    where ar.business_account_id = target_account.id
  ), balanced as (
    select e.*, sum(e.debit_kobo - e.credit_kobo) over
      (order by e.occurred_at, e.entry_id rows unbounded preceding)::bigint as running_balance_kobo
    from entries e
  )
  select b.entry_id, b.entry_type, b.occurred_at, b.document_number, b.related_document,
    b.reference, b.debit_kobo, b.credit_kobo, b.running_balance_kobo
  from balanced b
  where (target_from_date is null or b.occurred_at::date >= target_from_date)
    and (target_to_date is null or b.occurred_at::date <= target_to_date)
  order by b.occurred_at, b.entry_id;
end;
$$;

create or replace function public.get_finance_approval_register(
  target_hotel_id uuid, target_from_date date default null, target_to_date date default null
)
returns table (
  request_id uuid, action_type text, status text, target_document text,
  amount_kobo bigint, reference text, description text, reason text,
  requested_by_name text, requested_at timestamptz, expires_at timestamptz,
  decided_by_name text, decided_at timestamptz, decision_note text,
  executed_by_name text, executed_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare hotel_timezone text; from_date date; to_date date;
begin
  if not public.has_hotel_permission(target_hotel_id, 'finance_approvals.read') then
    raise exception 'Not authorised to view the finance approval register'; end if;
  select h.timezone into hotel_timezone from public.hotels h where h.id = target_hotel_id;
  if hotel_timezone is null then raise exception 'Hotel not found'; end if;
  to_date := coalesce(target_to_date, public.hotel_business_date(target_hotel_id));
  from_date := coalesce(target_from_date, to_date - 89);
  if from_date > to_date then raise exception 'Report start date must not be after the end date'; end if;

  return query select far.id, far.action_type, far.status,
    case far.target_entity_type
      when 'payment' then (select p.payment_number from public.payments p where p.id = far.target_entity_id)
      when 'folio' then (select gf.folio_number from public.guest_folios gf where gf.id = far.target_entity_id)
      when 'folio_item' then (select gf.folio_number || ' / ' || fi.description from public.folio_items fi
        join public.guest_folios gf on gf.id = fi.folio_id where fi.id = far.target_entity_id)
      when 'reservation' then (select r.reservation_number from public.reservations r where r.id = far.target_entity_id)
      when 'business_receivable' then (select ar.receivable_number from public.business_account_receivables ar
        where ar.id = far.target_entity_id)
    end,
    case far.action_type
      when 'refund_payment' then (far.payload->>'amount_kobo')::bigint
      when 'company_payment_refund' then (far.payload->>'amount_kobo')::bigint
      when 'company_credit_note' then (far.payload->>'amount_kobo')::bigint
      when 'folio_adjustment' then abs((far.payload->>'amount_kobo')::bigint)
      when 'void_payment' then (select p.amount_kobo from public.payments p where p.id = far.target_entity_id)
      when 'reverse_folio_item' then (select abs(fi.total_amount_kobo) from public.folio_items fi where fi.id = far.target_entity_id)
      when 'reservation_discount' then (far.payload->>'standard_rate_kobo')::bigint - (far.payload->>'requested_rate_kobo')::bigint
    end,
    coalesce(far.payload->>'reference', (select p.reference from public.payments p
      where p.id = far.target_entity_id and far.target_entity_type = 'payment')),
    case when far.action_type = 'reservation_discount' then
      'Exceptional nightly discount ' || trim(to_char((far.payload->>'discount_basis_points')::numeric / 100, 'FM999990.00')) || '%'
    when far.action_type = 'company_credit_note' then 'Company invoice credit note'
    when far.action_type = 'company_payment_refund' then 'Refund of company credit balance'
    else coalesce(far.payload->>'description', (select fi.description from public.folio_items fi
      where fi.id = far.target_entity_id and far.target_entity_type = 'folio_item')) end,
    far.reason, requester.full_name, far.requested_at, far.expires_at,
    approver.full_name, far.decided_at, far.decision_note,
    executor.full_name, far.executed_at
  from public.finance_approval_requests far
  left join public.profiles requester on requester.id = far.requested_by
  left join public.profiles approver on approver.id = far.decided_by
  left join public.profiles executor on executor.id = far.executed_by
  where far.hotel_id = target_hotel_id
    and (far.requested_at at time zone hotel_timezone)::date between from_date and to_date
  order by far.requested_at desc limit 500;
end;
$$;

revoke all on function public.business_receivable_signed_balance(uuid),
  public.issue_approved_business_credit_note(uuid),
  public.refund_approved_company_payment(uuid) from public, anon, authenticated;
revoke all on function public.request_business_credit_note(uuid, bigint, text),
  public.request_business_payment_refund(uuid, bigint, text, text),
  public.get_business_credit_positions(uuid), public.get_business_credit_notes(uuid) from public, anon;
grant execute on function public.request_business_credit_note(uuid, bigint, text),
  public.request_business_payment_refund(uuid, bigint, text, text),
  public.get_business_credit_positions(uuid), public.get_business_credit_notes(uuid) to authenticated;
