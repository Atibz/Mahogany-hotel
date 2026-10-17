-- Paid POS order corrections are separate approved ledger events. Original
-- order lines, payments, and internal payment acknowledgements remain intact.

alter table public.finance_approval_requests
  drop constraint if exists finance_approval_requests_action_type_check;
alter table public.finance_approval_requests
  add constraint finance_approval_requests_action_type_check
  check (action_type in (
    'void_payment', 'refund_payment', 'folio_adjustment', 'reverse_folio_item',
    'reservation_discount', 'company_credit_note', 'company_payment_refund',
    'pos_payment_refund', 'pos_order_line_correction'
  ));

create table public.pos_order_line_corrections (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  outlet_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  approval_request_id uuid not null unique references public.finance_approval_requests(id) on delete restrict,
  correction_number text not null,
  order_number_snapshot text not null,
  outlet_name_snapshot text not null,
  department_code_snapshot text not null,
  line_name_snapshot text not null,
  amount_delta_kobo bigint not null check (amount_delta_kobo <> 0),
  description text not null check (length(trim(description)) > 0),
  reason text not null check (length(trim(reason)) > 0),
  corrected_by uuid references public.profiles(id) on delete set null,
  corrected_at timestamptz not null default now(),
  unique (hotel_id, correction_number),
  foreign key (order_id, hotel_id, outlet_id)
    references public.pos_orders(id, hotel_id, outlet_id) on delete restrict,
  foreign key (order_line_id, hotel_id, outlet_id)
    references public.pos_order_lines(id, hotel_id, outlet_id) on delete restrict
);

create index pos_order_line_corrections_order_idx
  on public.pos_order_line_corrections(order_id, corrected_at desc);
revoke all on public.pos_order_line_corrections from public, anon, authenticated;
grant select on public.pos_order_line_corrections to authenticated;
alter table public.pos_order_line_corrections enable row level security;
create policy pos_order_line_corrections_read on public.pos_order_line_corrections
  for select to authenticated
  using (public.has_pos_outlet_permission(hotel_id, outlet_id, 'read'));

-- Keep the existing totals contract used by payment collection, while using
-- approved corrections in the effective sale total.
create or replace function public.pos_order_totals(target_order_id uuid)
returns table(gross_total_kobo bigint, completed_kobo bigint, pending_kobo bigint)
language sql stable security definer set search_path = public as $$
  select
    (coalesce((select sum(l.line_total_kobo) from public.pos_order_lines l where l.order_id = target_order_id), 0)
      + coalesce((select sum(c.amount_delta_kobo) from public.pos_order_line_corrections c where c.order_id = target_order_id), 0))::bigint,
    coalesce((select sum(p.amount_kobo) from public.pos_order_payments p where p.order_id = target_order_id and p.status = 'completed'), 0)::bigint,
    coalesce((select sum(p.amount_kobo) from public.pos_order_payments p where p.order_id = target_order_id and p.status = 'pending_verification'), 0)::bigint
$$;

create or replace function public.request_pos_order_line_correction(
  target_order_id uuid,
  target_order_line_id uuid,
  amount_delta_value_kobo bigint,
  description_value text,
  reason_value text
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  order_record public.pos_orders;
  line_record public.pos_order_lines;
  current_total bigint;
  reserved_delta numeric;
  reserved_line_delta numeric;
  existing_line_delta bigint;
  refund_total bigint;
  request_id uuid;
begin
  select * into order_record from public.pos_orders where id = target_order_id for update;
  if not found or order_record.status = 'voided' then raise exception 'Choose a valid, non-voided POS order'; end if;
  if not public.has_pos_outlet_permission(order_record.hotel_id, order_record.outlet_id, 'read') then
    raise exception 'Not authorised to review this POS outlet order';
  end if;
  if not public.has_hotel_permission(order_record.hotel_id, 'finance_approvals.request')
      and not public.has_pos_outlet_permission(order_record.hotel_id, order_record.outlet_id, 'create') then
    raise exception 'Not authorised to request a POS line correction';
  end if;
  if not exists (select 1 from public.pos_order_payments p
      where p.order_id = order_record.id and p.status = 'completed') then
    raise exception 'A paid order is required before requesting a line correction';
  end if;
  if amount_delta_value_kobo is null or amount_delta_value_kobo = 0 then
    raise exception 'Correction amount must be non-zero';
  end if;
  if nullif(trim(description_value), '') is null or nullif(trim(reason_value), '') is null then
    raise exception 'A correction description and reason are required';
  end if;
  select * into line_record from public.pos_order_lines
   where id = target_order_line_id and order_id = order_record.id
   for update;
  if not found then raise exception 'Choose a line from the selected order'; end if;

  select gross_total_kobo into current_total from public.pos_order_totals(order_record.id);
  update public.finance_approval_requests
    set status = 'expired'
    where action_type = 'pos_order_line_correction'
      and target_entity_id = order_record.id
      and status in ('pending', 'approved') and expires_at <= now();
  select coalesce(sum((payload->>'amount_delta_kobo')::numeric), 0) into reserved_delta
    from public.finance_approval_requests
    where action_type = 'pos_order_line_correction'
      and target_entity_id = order_record.id
      and status in ('pending', 'approved') and expires_at > now();
  select coalesce(sum(amount_kobo), 0) into refund_total
    from public.pos_order_refunds where order_id = order_record.id;
  select coalesce(sum(amount_delta_kobo), 0) into existing_line_delta
    from public.pos_order_line_corrections where order_line_id = line_record.id;
  select coalesce(sum((payload->>'amount_delta_kobo')::numeric), 0) into reserved_line_delta
    from public.finance_approval_requests
    where action_type = 'pos_order_line_correction'
      and target_entity_id = order_record.id
      and payload->>'order_line_id' = line_record.id::text
      and status in ('pending', 'approved') and expires_at > now();
  if line_record.line_total_kobo::numeric + existing_line_delta + reserved_line_delta + amount_delta_value_kobo < 0 then
    raise exception 'A line correction cannot reduce that line below zero';
  end if;
  if current_total::numeric + reserved_delta + amount_delta_value_kobo < refund_total then
    raise exception 'Correction would reduce the sale below refunds already recorded';
  end if;
  if current_total::numeric + reserved_delta + amount_delta_value_kobo < 0 then
    raise exception 'Corrected POS sale cannot be negative';
  end if;

  insert into public.finance_approval_requests (
    hotel_id, action_type, target_entity_type, target_entity_id, payload, reason, requested_by
  ) values (
    order_record.hotel_id, 'pos_order_line_correction', 'pos_order', order_record.id,
    jsonb_build_object(
      'order_id', order_record.id,
      'order_line_id', line_record.id,
      'line_name', line_record.item_name_snapshot,
      'amount_delta_kobo', amount_delta_value_kobo,
      'description', trim(description_value)
    ), trim(reason_value), auth.uid()
  ) returning id into request_id;
  perform public.log_activity(order_record.hotel_id, 'pos.line_correction_requested',
    'finance_approval_request', request_id,
    jsonb_build_object('order_id', order_record.id, 'order_line_id', line_record.id,
      'amount_delta_kobo', amount_delta_value_kobo, 'outlet_id', order_record.outlet_id));
  return request_id;
end;
$$;

create or replace function public.execute_approved_pos_order_line_correction(target_request_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  request_record public.finance_approval_requests;
  order_record public.pos_orders;
  line_record public.pos_order_lines;
  amount_delta bigint;
  other_reserved_delta numeric;
  other_reserved_line_delta numeric;
  existing_line_delta bigint;
  current_total bigint;
  refund_total bigint;
  payment_total bigint;
  correction_number_value text;
begin
  select * into request_record from public.finance_approval_requests
    where id = target_request_id for update;
  if not found or request_record.action_type <> 'pos_order_line_correction' then
    raise exception 'POS line-correction request not found';
  end if;
  if not public.has_hotel_permission(request_record.hotel_id, 'finance_approvals.approve') then
    raise exception 'Not authorised to execute a POS line correction';
  end if;
  if request_record.decided_by <> auth.uid() then
    raise exception 'Only the independent approver may execute this POS line correction';
  end if;
  if request_record.status <> 'approved' then raise exception 'Only an approved correction can be executed'; end if;
  if request_record.expires_at <= now() then raise exception 'This POS line-correction approval has expired'; end if;

  select * into order_record from public.pos_orders
    where id = (request_record.payload->>'order_id')::uuid for update;
  if not found or order_record.hotel_id <> request_record.hotel_id or order_record.status = 'voided' then
    raise exception 'Original POS order is unavailable';
  end if;
  if not public.has_pos_outlet_permission(order_record.hotel_id, order_record.outlet_id, 'read') then
    raise exception 'Not authorised to execute a correction for this POS outlet';
  end if;
  select * into line_record from public.pos_order_lines
    where id = (request_record.payload->>'order_line_id')::uuid
      and order_id = order_record.id for update;
  if not found then raise exception 'Original POS order line is unavailable'; end if;
  amount_delta := (request_record.payload->>'amount_delta_kobo')::bigint;
  if amount_delta is null or amount_delta = 0 then raise exception 'Approved correction amount is invalid'; end if;

  select gross_total_kobo into current_total from public.pos_order_totals(order_record.id);
  select coalesce(sum((payload->>'amount_delta_kobo')::numeric), 0) into other_reserved_delta
    from public.finance_approval_requests
    where action_type = 'pos_order_line_correction'
      and target_entity_id = order_record.id and id <> request_record.id
      and status in ('pending', 'approved') and expires_at > now();
  select coalesce(sum(amount_kobo), 0) into refund_total
    from public.pos_order_refunds where order_id = order_record.id;
  select coalesce(sum(amount_delta_kobo), 0) into existing_line_delta
    from public.pos_order_line_corrections where order_line_id = line_record.id;
  select coalesce(sum((payload->>'amount_delta_kobo')::numeric), 0) into other_reserved_line_delta
    from public.finance_approval_requests
    where action_type = 'pos_order_line_correction'
      and target_entity_id = order_record.id and id <> request_record.id
      and payload->>'order_line_id' = line_record.id::text
      and status in ('pending', 'approved') and expires_at > now();
  if line_record.line_total_kobo::numeric + existing_line_delta + amount_delta + other_reserved_line_delta < 0 then
    raise exception 'A line correction cannot reduce that line below zero';
  end if;
  if current_total::numeric + amount_delta + other_reserved_delta < refund_total
      or current_total::numeric + amount_delta + other_reserved_delta < 0 then
    raise exception 'Correction would make the order balance invalid';
  end if;

  correction_number_value := public.next_document_number(order_record.hotel_id, 'PCC');
  insert into public.pos_order_line_corrections (
    hotel_id, outlet_id, order_id, order_line_id, approval_request_id, correction_number,
    order_number_snapshot, outlet_name_snapshot, department_code_snapshot,
    line_name_snapshot, amount_delta_kobo, description, reason, corrected_by
  ) values (
    order_record.hotel_id, order_record.outlet_id, order_record.id, line_record.id,
    request_record.id, correction_number_value, order_record.order_number,
    order_record.outlet_name_snapshot, order_record.department_code_snapshot,
    line_record.item_name_snapshot, amount_delta,
    trim(request_record.payload->>'description'), request_record.reason, auth.uid()
  );

  select coalesce(sum(p.amount_kobo) filter (where p.status = 'completed'), 0)
    into payment_total from public.pos_order_payments p where p.order_id = order_record.id;
  select coalesce(sum(r.amount_kobo), 0) into refund_total
    from public.pos_order_refunds r where r.order_id = order_record.id;
  select gross_total_kobo into current_total from public.pos_order_totals(order_record.id);
  if payment_total - refund_total >= current_total then
    update public.pos_orders set status = 'settled', settled_at = coalesce(settled_at, now()) where id = order_record.id;
  else
    update public.pos_orders set status = 'open', settled_at = null where id = order_record.id;
  end if;
  perform public.log_activity(order_record.hotel_id, 'pos.line_correction_recorded',
    'pos_order_line_correction', request_record.id,
    jsonb_build_object('correction_number', correction_number_value, 'order_id', order_record.id,
      'order_line_id', line_record.id, 'amount_delta_kobo', amount_delta,
      'outlet_id', order_record.outlet_id, 'approval_request_id', request_record.id));
end;
$$;

-- Replace the line-based aggregate in the existing report with the adjusted
-- order total helper. Keep its established outlet access predicates intact.
do $$
declare
  function_oid oid;
  definition text;
  old_text text := 'coalesce(sum(l.line_total_kobo),0)::bigint gross';
  new_text text := '(select t.gross_total_kobo from public.pos_order_totals(o.id) t)::bigint gross';
begin
  function_oid := to_regprocedure('public.get_restaurant_pos_sales_report(uuid,date,date)');
  if function_oid is null then raise exception 'POS sales report function is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  if position(new_text in definition) = 0 then
    if position(old_text in definition) = 0 then raise exception 'Expected POS sales total expression was not found'; end if;
    definition := replace(definition, old_text, new_text);
    execute definition;
  end if;

  function_oid := to_regprocedure('public.execute_finance_approval(uuid)');
  if function_oid is null then raise exception 'Finance approval executor is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  old_text := 'when ''pos_payment_refund'' then perform public.execute_approved_pos_payment_refund(r.id);';
  new_text := old_text || E'\n    when ''pos_order_line_correction'' then perform public.execute_approved_pos_order_line_correction(r.id);';
  if position('execute_approved_pos_order_line_correction(r.id)' in definition) = 0 then
    if position(old_text in definition) = 0 then raise exception 'Expected POS refund executor branch was not found'; end if;
    execute replace(definition, old_text, new_text);
  end if;

  function_oid := to_regprocedure('public.get_finance_approval_register(uuid,date,date)');
  if function_oid is null then raise exception 'Finance approval register is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  old_text := '      when ''business_receivable'' then (select ar.receivable_number from public.business_account_receivables ar';
  new_text := '      when ''pos_order'' then (select o.order_number from public.pos_orders o where o.id = far.target_entity_id)' || E'\n      ' || old_text;
  if position(old_text in definition) > 0 and position('when ''pos_order'' then' in definition) = 0 then
    definition := replace(definition, old_text, new_text);
  end if;
  old_text := '      when ''company_payment_refund'' then (far.payload->>''amount_kobo'')::bigint';
  new_text := old_text || E'\n      when ''pos_order_line_correction'' then abs((far.payload->>''amount_delta_kobo'')::bigint)';
  if position(old_text in definition) > 0 and position('when ''pos_order_line_correction'' then' in definition) = 0 then
    definition := replace(definition, old_text, new_text);
  end if;
  old_text := '    when far.action_type = ''company_payment_refund'' then ''Refund of company credit balance''';
  new_text := old_text || E'\n    when far.action_type = ''pos_order_line_correction'' then ''Restaurant/bar POS line correction''';
  if position(old_text in definition) > 0 and position('when far.action_type = ''pos_order_line_correction'' then' in definition) = 0 then
    definition := replace(definition, old_text, new_text);
  end if;
  execute definition;
end;
$$;

-- A recorded refund must never exceed customer credit on the corrected sale.
-- Serialize all refunds for an order on the order row, including requests on
-- different tenders, and count active approval reservations.
do $$
declare
  function_oid oid;
  definition text;
  old_text text;
  new_text text;
begin
  function_oid := to_regprocedure('public.request_pos_payment_refund(uuid,bigint,uuid,text,text)');
  if function_oid is null then raise exception 'POS refund requester is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  old_text := '  reserved_amount bigint;' || E'\n  request_id uuid;';
  new_text := '  reserved_amount bigint;' || E'\n'
    || '  order_total bigint;' || E'\n'
    || '  order_paid bigint;' || E'\n'
    || '  order_refunded bigint;' || E'\n'
    || '  order_reserved bigint;' || E'\n  request_id uuid;';
  if position('order_reserved bigint;' in definition) = 0 then
    if position(old_text in definition) = 0 then raise exception 'POS refund requester declarations changed unexpectedly'; end if;
    definition := replace(definition, old_text, new_text);
  end if;
  old_text := '  if not found then raise exception ''POS payment not found''; end if;';
  new_text := old_text || E'\n'
    || '  perform 1 from public.pos_orders where id = payment_record.order_id for update;';
  if position('perform 1 from public.pos_orders where id = payment_record.order_id for update;' in definition) = 0 then
    if position(old_text in definition) = 0 then raise exception 'POS refund payment lock was not found'; end if;
    definition := replace(definition, old_text, new_text);
  end if;
  old_text := '  if refund_amount_kobo > payment_record.amount_kobo - already_refunded - reserved_amount then' || E'\n'
    || '    raise exception ''Refund exceeds the remaining refundable POS payment amount'';' || E'\n'
    || '  end if;';
  new_text := old_text || E'\n'
    || '  select gross_total_kobo into order_total from public.pos_order_totals(payment_record.order_id);' || E'\n'
    || '  select coalesce(sum(amount_kobo), 0) into order_paid from public.pos_order_payments' || E'\n'
    || '    where order_id = payment_record.order_id and status = ''completed'';' || E'\n'
    || '  select coalesce(sum(amount_kobo), 0) into order_refunded from public.pos_order_refunds' || E'\n'
    || '    where order_id = payment_record.order_id;' || E'\n'
    || '  select coalesce(sum((far.payload->>''amount_kobo'')::bigint), 0) into order_reserved' || E'\n'
    || '    from public.finance_approval_requests far' || E'\n'
    || '    join public.pos_order_payments p on p.id = far.target_entity_id' || E'\n'
    || '    where far.action_type = ''pos_payment_refund'' and p.order_id = payment_record.order_id' || E'\n'
    || '      and far.status in (''pending'', ''approved'') and far.expires_at > now();' || E'\n'
    || '  if refund_amount_kobo > order_paid - order_total - order_refunded - order_reserved then' || E'\n'
    || '    raise exception ''Refund exceeds the available customer credit for this POS order'';' || E'\n'
    || '  end if;';
  if position('Refund exceeds the available customer credit for this POS order' in definition) = 0 then
    if position(old_text in definition) = 0 then raise exception 'POS refund limit check was not found'; end if;
    definition := replace(definition, old_text, new_text);
  end if;
  execute definition;

  function_oid := to_regprocedure('public.execute_approved_pos_payment_refund(uuid)');
  if function_oid is null then raise exception 'POS refund executor is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  old_text := '  shift_id uuid;' || E'\n  refund_number_value text;';
  new_text := '  shift_id uuid;' || E'\n'
    || '  order_total bigint;' || E'\n'
    || '  order_paid bigint;' || E'\n'
    || '  order_refunded bigint;' || E'\n'
    || '  order_reserved bigint;' || E'\n  refund_number_value text;';
  if position('order_reserved bigint;' in definition) = 0 then
    if position(old_text in definition) = 0 then raise exception 'POS refund executor declarations changed unexpectedly'; end if;
    definition := replace(definition, old_text, new_text);
  end if;
  old_text := '  if payment_record.status <> ''completed'' then raise exception ''Only completed POS payments can be refunded''; end if;';
  new_text := old_text || E'\n'
    || '  select * into order_record from public.pos_orders where id = payment_record.order_id for update;';
  if position('select * into order_record from public.pos_orders where id = payment_record.order_id for update;' in definition) = 0 then
    if position(old_text in definition) = 0 then raise exception 'POS refund executor order lock was not found'; end if;
    definition := replace(definition, old_text, new_text);
  end if;
  old_text := '    raise exception ''The approved amount exceeds the payment’s remaining refundable balance'';' || E'\n  end if;';
  new_text := old_text || E'\n'
    || '  select gross_total_kobo into order_total from public.pos_order_totals(payment_record.order_id);' || E'\n'
    || '  select coalesce(sum(amount_kobo), 0) into order_paid from public.pos_order_payments' || E'\n'
    || '    where order_id = payment_record.order_id and status = ''completed'';' || E'\n'
    || '  select coalesce(sum(amount_kobo), 0) into order_refunded from public.pos_order_refunds' || E'\n'
    || '    where order_id = payment_record.order_id;' || E'\n'
    || '  select coalesce(sum((far.payload->>''amount_kobo'')::bigint), 0) into order_reserved' || E'\n'
    || '    from public.finance_approval_requests far' || E'\n'
    || '    join public.pos_order_payments p on p.id = far.target_entity_id' || E'\n'
    || '    where far.action_type = ''pos_payment_refund'' and p.order_id = payment_record.order_id' || E'\n'
    || '      and far.id <> request_record.id' || E'\n'
    || '      and far.status in (''pending'', ''approved'') and far.expires_at > now();' || E'\n'
    || '  if amount_value > order_paid - order_total - order_refunded - order_reserved then' || E'\n'
    || '    raise exception ''Approved refund exceeds available customer credit for this POS order'';' || E'\n'
    || '  end if;';
  if position('Approved refund exceeds available customer credit for this POS order' in definition) = 0 then
    if position(old_text in definition) = 0 then raise exception 'POS refund execution limit was not found'; end if;
    definition := replace(definition, old_text, new_text);
  end if;
  execute definition;
end;
$$;

revoke all on function public.request_pos_order_line_correction(uuid,uuid,bigint,text,text),
  public.execute_approved_pos_order_line_correction(uuid) from public, anon;
grant execute on function public.request_pos_order_line_correction(uuid,uuid,bigint,text,text) to authenticated;
revoke all on function public.execute_approved_pos_order_line_correction(uuid) from public, anon, authenticated;
