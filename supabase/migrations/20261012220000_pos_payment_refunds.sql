-- POS refunds are recorded as separate, append-only events. The original sale,
-- receipt, hotel payment ledger, and guest folio remain unchanged.

alter table public.finance_approval_requests drop constraint if exists finance_approval_requests_action_type_check;
alter table public.finance_approval_requests add constraint finance_approval_requests_action_type_check
  check (action_type in (
    'void_payment', 'refund_payment', 'folio_adjustment', 'reverse_folio_item',
    'reservation_discount', 'company_credit_note', 'company_payment_refund',
    'pos_payment_refund'
  ));

alter table public.pos_cashier_shifts
  add constraint pos_cashier_shifts_id_scope_unique unique (id, hotel_id, outlet_id);

create table public.pos_order_refunds (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  outlet_id uuid not null,
  order_id uuid not null,
  payment_id uuid not null,
  approval_request_id uuid not null unique references public.finance_approval_requests(id) on delete restrict,
  refund_number text not null,
  order_number_snapshot text not null,
  outlet_name_snapshot text not null,
  department_code_snapshot text not null,
  payment_number_snapshot text not null,
  amount_kobo bigint not null check (amount_kobo > 0),
  payment_method_id uuid not null references public.payment_methods(id) on delete restrict,
  payment_method_name_snapshot text not null,
  reference text,
  reason text not null check (length(trim(reason)) > 0),
  cashier_shift_id uuid,
  refunded_by uuid references public.profiles(id) on delete set null,
  refunded_at timestamptz not null default now(),
  unique (hotel_id, refund_number),
  foreign key (order_id, hotel_id, outlet_id)
    references public.pos_orders(id, hotel_id, outlet_id) on delete restrict,
  foreign key (payment_id, hotel_id, outlet_id)
    references public.pos_order_payments(id, hotel_id, outlet_id) on delete restrict,
  foreign key (cashier_shift_id, hotel_id, outlet_id)
    references public.pos_cashier_shifts(id, hotel_id, outlet_id) on delete restrict
);

create index pos_order_refunds_order_idx on public.pos_order_refunds(order_id, refunded_at desc);
create index pos_order_refunds_payment_idx on public.pos_order_refunds(payment_id, refunded_at desc);
revoke all on public.pos_order_refunds from public, anon, authenticated;
grant select on public.pos_order_refunds to authenticated;
alter table public.pos_order_refunds enable row level security;
create policy pos_order_refunds_read on public.pos_order_refunds
  for select to authenticated
  using (public.has_pos_outlet_permission(hotel_id, outlet_id, 'read'));

create or replace function public.request_pos_payment_refund(
  target_payment_id uuid,
  refund_amount_kobo bigint,
  refund_method_id uuid,
  refund_reference text,
  refund_reason text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  payment_record public.pos_order_payments;
  method_record public.payment_methods;
  already_refunded bigint;
  reserved_amount bigint;
  request_id uuid;
begin
  select * into payment_record
  from public.pos_order_payments
  where id = target_payment_id
  for update;
  if not found then raise exception 'POS payment not found'; end if;
  if not public.has_hotel_permission(payment_record.hotel_id, 'finance_approvals.request') then
    raise exception 'Not authorised to request a POS refund';
  end if;
  if payment_record.status <> 'completed' then raise exception 'Only completed POS payments can be refunded'; end if;
  if refund_amount_kobo is null or refund_amount_kobo <= 0 then raise exception 'Refund amount must be greater than zero'; end if;
  if nullif(trim(refund_reason), '') is null then raise exception 'A refund reason is required'; end if;

  select * into method_record
  from public.payment_methods
  where id = refund_method_id and hotel_id = payment_record.hotel_id and active;
  if not found then raise exception 'Choose an active refund method'; end if;
  if method_record.code <> 'cash' and nullif(trim(refund_reference), '') is null then
    raise exception 'A reference is required for non-cash POS refunds';
  end if;

  select coalesce(sum(amount_kobo), 0) into already_refunded
  from public.pos_order_refunds where payment_id = payment_record.id;
  update public.finance_approval_requests
  set status = 'expired'
  where action_type = 'pos_payment_refund'
    and target_entity_id = payment_record.id
    and status in ('pending', 'approved')
    and expires_at <= now();
  select coalesce(sum((payload->>'amount_kobo')::bigint), 0) into reserved_amount
  from public.finance_approval_requests
  where action_type = 'pos_payment_refund'
    and target_entity_id = payment_record.id
    and status in ('pending', 'approved')
    and expires_at > now();
  if refund_amount_kobo > payment_record.amount_kobo - already_refunded - reserved_amount then
    raise exception 'Refund exceeds the remaining refundable POS payment amount';
  end if;

  insert into public.finance_approval_requests (
    hotel_id, action_type, target_entity_type, target_entity_id, payload, reason, requested_by
  ) values (
    payment_record.hotel_id, 'pos_payment_refund', 'pos_payment', payment_record.id,
    jsonb_build_object(
      'payment_id', payment_record.id,
      'order_id', payment_record.order_id,
      'amount_kobo', refund_amount_kobo,
      'refund_method_id', method_record.id,
      'refund_method_name', method_record.name,
      'reference', nullif(trim(refund_reference), '')
    ), trim(refund_reason), auth.uid()
  ) returning id into request_id;

  perform public.log_activity(payment_record.hotel_id, 'pos.refund_requested', 'finance_approval_request', request_id,
    jsonb_build_object('payment_id', payment_record.id, 'amount_kobo', refund_amount_kobo,
      'outlet_id', payment_record.outlet_id));
  return request_id;
end;
$$;

create or replace function public.execute_approved_pos_payment_refund(target_request_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  request_record public.finance_approval_requests;
  payment_record public.pos_order_payments;
  order_record public.pos_orders;
  method_record public.payment_methods;
  amount_value bigint;
  refunded_total bigint;
  shift_id uuid;
  refund_number_value text;
begin
  select * into request_record
  from public.finance_approval_requests where id = target_request_id for update;
  if not found or request_record.action_type <> 'pos_payment_refund' then
    raise exception 'POS refund approval request not found';
  end if;
  if not public.has_hotel_permission(request_record.hotel_id, 'finance_approvals.approve') then
    raise exception 'Not authorised to execute a POS refund';
  end if;
  if request_record.decided_by <> auth.uid() then raise exception 'Only the independent approver may execute this POS refund'; end if;
  if request_record.status <> 'approved' then raise exception 'Only an approved POS refund request can be executed'; end if;
  if request_record.expires_at <= now() then raise exception 'This POS refund approval has expired'; end if;

  select * into payment_record
  from public.pos_order_payments
  where id = (request_record.payload->>'payment_id')::uuid
  for update;
  if not found or payment_record.hotel_id <> request_record.hotel_id then raise exception 'Original POS payment not found'; end if;
  if payment_record.status <> 'completed' then raise exception 'Only completed POS payments can be refunded'; end if;
  select coalesce(sum(amount_kobo), 0) into refunded_total
  from public.pos_order_refunds where payment_id = payment_record.id;
  amount_value := (request_record.payload->>'amount_kobo')::bigint;
  if amount_value is null or amount_value <= 0 or amount_value > payment_record.amount_kobo - refunded_total then
    raise exception 'The approved amount exceeds the payment’s remaining refundable balance';
  end if;

  select * into method_record
  from public.payment_methods
  where id = (request_record.payload->>'refund_method_id')::uuid
    and hotel_id = request_record.hotel_id and active;
  if not found then raise exception 'The approved refund method is no longer active'; end if;
  if method_record.code <> 'cash' and nullif(trim(request_record.payload->>'reference'), '') is null then
    raise exception 'A non-cash refund reference is required';
  end if;
  if method_record.code = 'cash' then
    select id into shift_id
    from public.pos_cashier_shifts
    where hotel_id = payment_record.hotel_id and outlet_id = payment_record.outlet_id
      and opened_by = auth.uid() and status = 'open'
    for update;
    if shift_id is null then raise exception 'Open your outlet cash shift before recording a cash refund'; end if;
  end if;

  select * into order_record from public.pos_orders where id = payment_record.order_id;
  if not found then raise exception 'Original POS order not found'; end if;
  refund_number_value := public.next_document_number(payment_record.hotel_id, 'PFR');
  insert into public.pos_order_refunds (
    hotel_id, outlet_id, order_id, payment_id, approval_request_id, refund_number,
    order_number_snapshot, outlet_name_snapshot, department_code_snapshot,
    payment_number_snapshot, amount_kobo, payment_method_id, payment_method_name_snapshot,
    reference, reason, cashier_shift_id, refunded_by
  ) values (
    payment_record.hotel_id, payment_record.outlet_id, payment_record.order_id, payment_record.id,
    request_record.id, refund_number_value, order_record.order_number, order_record.outlet_name_snapshot,
    order_record.department_code_snapshot, payment_record.payment_number, amount_value,
    method_record.id, method_record.name, nullif(trim(request_record.payload->>'reference'), ''),
    request_record.reason, shift_id, auth.uid()
  );
  update public.finance_approval_requests
  set status = 'executed', executed_by = auth.uid(), executed_at = now()
  where id = request_record.id;
  perform public.log_activity(payment_record.hotel_id, 'pos.refund_recorded', 'pos_order_refund', request_record.id,
    jsonb_build_object('refund_number', refund_number_value, 'payment_id', payment_record.id,
      'order_id', payment_record.order_id, 'outlet_id', payment_record.outlet_id,
      'amount_kobo', amount_value, 'payment_method', method_record.name,
      'cashier_shift_id', shift_id, 'approval_request_id', request_record.id));
end;
$$;

create or replace function public.get_pos_refund_sales_summary(
  target_hotel_id uuid,
  from_date date,
  to_date date
)
returns table (
  business_date date,
  outlet_id uuid,
  outlet_name text,
  department_code text,
  payments_received_kobo bigint,
  refunds_kobo bigint,
  net_collected_kobo bigint
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not public.can_view_pos_hotel(target_hotel_id) then
    raise exception 'Not authorised to view POS refund summaries';
  end if;
  if from_date is null or to_date is null or from_date > to_date or to_date - from_date > 92 then
    raise exception 'Choose a valid report period of up to 93 days';
  end if;
  return query
  with event_flows as (
    select public.hotel_business_date(p.hotel_id, p.received_at) as business_date,
      p.outlet_id, o.outlet_name_snapshot as outlet_name, o.department_code_snapshot as department_code,
      p.amount_kobo::bigint as payments_received_kobo, 0::bigint as refunds_kobo
    from public.pos_order_payments p
    join public.pos_orders o on o.id = p.order_id
    where p.hotel_id = target_hotel_id and p.status = 'completed'
      and public.hotel_business_date(p.hotel_id, p.received_at) between from_date and to_date
      and public.has_pos_outlet_permission(p.hotel_id, p.outlet_id, 'read')
    union all
    select public.hotel_business_date(r.hotel_id, r.refunded_at), r.outlet_id,
      r.outlet_name_snapshot, r.department_code_snapshot,
      0::bigint, r.amount_kobo::bigint
    from public.pos_order_refunds r
    where r.hotel_id = target_hotel_id
      and public.hotel_business_date(r.hotel_id, r.refunded_at) between from_date and to_date
      and public.has_pos_outlet_permission(r.hotel_id, r.outlet_id, 'read')
  )
  select f.business_date, f.outlet_id, max(f.outlet_name), max(f.department_code),
    sum(f.payments_received_kobo)::bigint, sum(f.refunds_kobo)::bigint,
    (sum(f.payments_received_kobo) - sum(f.refunds_kobo))::bigint
  from event_flows f
  group by f.business_date, f.outlet_id
  order by f.business_date desc, f.outlet_name;
end;
$$;

-- Keep the generic approval queue/register. Extend its existing controlled
-- executor and report projection for this POS-specific approved correction.
do $$
declare
  function_oid oid;
  definition text;
  old_text text;
  new_text text;
begin
  function_oid := to_regprocedure('public.execute_finance_approval(uuid)');
  if function_oid is null then raise exception 'Finance approval executor is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  old_text := 'when ''company_payment_refund'' then perform public.refund_approved_company_payment(r.id);';
  new_text := old_text || E'\n    when ''pos_payment_refund'' then perform public.execute_approved_pos_payment_refund(r.id);';
  if position(old_text in definition) = 0 then
    if position('execute_approved_pos_payment_refund(r.id)' in definition) = 0 then
      raise exception 'Expected company refund executor branch was not found';
    end if;
  else
    execute replace(definition, old_text, new_text);
  end if;

  function_oid := to_regprocedure('public.get_finance_approval_register(uuid,date,date)');
  if function_oid is null then raise exception 'Finance approval register is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  old_text := 'when ''business_receivable'' then (select ar.receivable_number from public.business_account_receivables ar';
  new_text := 'when ''pos_payment'' then (select p.payment_number from public.pos_order_payments p where p.id = far.target_entity_id)' || E'\n      ' || old_text;
  if position(old_text in definition) > 0 and position('when ''pos_payment'' then' in definition) = 0 then
    execute replace(definition, old_text, new_text);
  end if;
  definition := pg_get_functiondef(function_oid);
  old_text := 'when ''company_payment_refund'' then (far.payload->>''amount_kobo'')::bigint';
  new_text := old_text || E'\n      when ''pos_payment_refund'' then (far.payload->>''amount_kobo'')::bigint';
  if position(old_text in definition) > 0 and position('when ''pos_payment_refund'' then' in definition) = 0 then
    execute replace(definition, old_text, new_text);
  end if;
  definition := pg_get_functiondef(function_oid);
  old_text := 'when far.action_type = ''company_payment_refund'' then ''Refund of company credit balance''';
  new_text := old_text || E'\n    when far.action_type = ''pos_payment_refund'' then ''Restaurant/bar POS payment refund''';
  if position(old_text in definition) > 0 and position('when far.action_type = ''pos_payment_refund'' then' in definition) = 0 then
    execute replace(definition, old_text, new_text);
  end if;
end;
$$;

-- Cash refunds reduce the physical cash the cashier should declare for the
-- same outlet shift; the original incoming payment stays untouched.
do $$
declare
  function_oid oid;
  definition text;
  old_text text;
  new_text text;
begin
  function_oid := to_regprocedure('public.close_pos_cashier_shift(uuid,bigint,text)');
  if function_oid is null then raise exception 'POS cashier shift close function is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  old_text := 's.opening_float_kobo+coalesce(sum(p.amount_kobo),0)';
  new_text := old_text || '-coalesce((select sum(pr.amount_kobo) from public.pos_order_refunds pr where pr.cashier_shift_id=s.id),0)';
  if position(old_text in definition) > 0 and position('public.pos_order_refunds pr where pr.cashier_shift_id=s.id' in definition) = 0 then
    execute replace(definition, old_text, new_text);
  elsif position(old_text in definition) = 0 and position('public.pos_order_refunds pr where pr.cashier_shift_id=s.id' in definition) = 0 then
    raise exception 'Expected POS shift cash calculation was not found';
  end if;
end;
$$;

revoke all on function public.request_pos_payment_refund(uuid,bigint,uuid,text,text),
  public.execute_approved_pos_payment_refund(uuid),
  public.get_pos_refund_sales_summary(uuid,date,date) from public, anon;
grant execute on function public.request_pos_payment_refund(uuid,bigint,uuid,text,text) to authenticated;
grant execute on function public.get_pos_refund_sales_summary(uuid,date,date) to authenticated;
revoke all on function public.execute_approved_pos_payment_refund(uuid) from public, anon, authenticated;
