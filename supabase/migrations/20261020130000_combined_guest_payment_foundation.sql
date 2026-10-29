-- Exceptional single hotel collection for a folio and separate POS businesses.
-- No outlet tender or tax invoice is created. This is intentionally not exposed
-- in the UI until the correction and reporting paths are verified.

create table public.combined_guest_payments (
  payment_id uuid primary key references public.payments(id) on delete restrict,
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  folio_id uuid not null references public.guest_folios(id) on delete restrict,
  payment_method_id uuid not null references public.payment_methods(id) on delete restrict,
  external_reference text not null check (length(trim(external_reference)) between 3 and 200),
  hotel_amount_kobo bigint not null check (hotel_amount_kobo > 0),
  reason text not null check (length(trim(reason)) between 10 and 500),
  verbal_approver_name text not null check (length(trim(verbal_approver_name)) between 3 and 120),
  verbal_approved_at timestamptz not null,
  collected_by uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  review_status text not null default 'awaiting_accountant'
    check (review_status in ('awaiting_accountant', 'confirmed', 'disputed')),
  reviewed_by uuid references public.profiles(id) on delete restrict,
  reviewed_at timestamptz,
  review_note text,
  unique (hotel_id, payment_method_id, external_reference),
  check ((review_status = 'awaiting_accountant' and reviewed_by is null and reviewed_at is null and review_note is null)
    or (review_status <> 'awaiting_accountant' and reviewed_by is not null and reviewed_at is not null
      and length(trim(review_note)) >= 3 and reviewed_by <> collected_by))
);

create table public.combined_guest_payment_orders (
  payment_id uuid not null references public.combined_guest_payments(payment_id) on delete restrict,
  hotel_id uuid not null,
  order_id uuid not null,
  outlet_id uuid not null,
  outlet_name_snapshot text not null,
  amount_kobo bigint not null check (amount_kobo > 0),
  primary key (payment_id, order_id),
  foreign key (order_id, hotel_id, outlet_id)
    references public.pos_orders(id, hotel_id, outlet_id) on delete restrict
);
create index combined_guest_payment_orders_order_idx on public.combined_guest_payment_orders(order_id);
create index combined_guest_payments_review_idx on public.combined_guest_payments(hotel_id, review_status, recorded_at);

revoke all on public.combined_guest_payments, public.combined_guest_payment_orders from public, anon, authenticated;
alter table public.combined_guest_payments enable row level security;
alter table public.combined_guest_payment_orders enable row level security;

-- The POS balance now includes the portion paid once into the hotel account.
-- Outlet cash/payment reports continue to count only real outlet tenders.
create or replace function public.pos_order_totals(target_order_id uuid)
returns table(gross_total_kobo bigint, completed_kobo bigint, pending_kobo bigint)
language sql stable security definer set search_path = public as $$
  select
    (coalesce((select sum(l.line_total_kobo) from public.pos_order_lines l where l.order_id = target_order_id), 0)
      + coalesce((select sum(c.amount_delta_kobo) from public.pos_order_line_corrections c where c.order_id = target_order_id), 0))::bigint,
    (coalesce((select sum(p.amount_kobo) from public.pos_order_payments p
      where p.order_id = target_order_id and p.status = 'completed'), 0)
      + coalesce((select sum(c.amount_kobo) from public.combined_guest_payment_orders c
        join public.payments p on p.id = c.payment_id
        where c.order_id = target_order_id and p.status = 'completed'), 0))::bigint,
    (coalesce((select sum(p.amount_kobo) from public.pos_order_payments p
      where p.order_id = target_order_id and p.status = 'pending_verification'), 0)
      + coalesce((select sum(c.amount_kobo) from public.combined_guest_payment_orders c
        join public.payments p on p.id = c.payment_id
        where c.order_id = target_order_id and p.status = 'pending_verification'), 0))::bigint
$$;

-- Keep outlet tender collections separate from order settlement by hotel.
create or replace function public.get_restaurant_pos_sales_report(target_hotel_id uuid, from_date date, to_date date)
returns table(business_date date, outlet_id uuid, outlet_name text, department_code text,
  settled_orders bigint, gross_sales_kobo bigint, collected_kobo bigint,
  pending_kobo bigint, open_balance_kobo bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_view_pos_hotel(target_hotel_id) then
    raise exception 'Not authorised to view POS reports';
  end if;
  if from_date is null or to_date is null or from_date > to_date or to_date - from_date > 92 then
    raise exception 'Choose a valid report period of up to 93 days';
  end if;
  return query with orders as (
    select o.id, o.business_date, o.outlet_id, o.outlet_name_snapshot,
      o.department_code_snapshot, o.status, t.gross_total_kobo,
      t.completed_kobo, t.pending_kobo,
      coalesce((select sum(p.amount_kobo) from public.pos_order_payments p
        where p.order_id = o.id and p.status = 'completed'), 0)::bigint as outlet_collected
    from public.pos_orders o cross join lateral public.pos_order_totals(o.id) t
    where o.hotel_id = target_hotel_id and o.business_date between from_date and to_date
      and o.status <> 'voided' and public.has_pos_outlet_permission(o.hotel_id, o.outlet_id, 'read')
  )
  select o.business_date, o.outlet_id, o.outlet_name_snapshot, o.department_code_snapshot,
    count(*) filter (where o.status = 'settled')::bigint,
    coalesce(sum(o.gross_total_kobo), 0)::bigint,
    coalesce(sum(o.outlet_collected), 0)::bigint,
    coalesce(sum(o.pending_kobo), 0)::bigint,
    coalesce(sum(greatest(o.gross_total_kobo - o.completed_kobo, 0)), 0)::bigint
  from orders o group by o.business_date, o.outlet_id, o.outlet_name_snapshot,
    o.department_code_snapshot order by o.business_date desc, o.outlet_name_snapshot;
end; $$;

create function public.get_pos_hotel_collected_allocations(target_hotel_id uuid, target_order_ids uuid[])
returns table(order_id uuid, payment_number text, amount_kobo bigint,
  status public.payment_status, received_at timestamptz, reference text)
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(array_length(target_order_ids, 1), 0) > 100 then
    raise exception 'Too many orders requested';
  end if;
  return query select a.order_id, p.payment_number, a.amount_kobo, p.status,
      p.received_at, p.reference
    from public.combined_guest_payment_orders a
    join public.payments p on p.id = a.payment_id
    where a.hotel_id = target_hotel_id and a.order_id = any(target_order_ids)
      and public.has_pos_outlet_permission(a.hotel_id, a.outlet_id, 'read')
    order by p.received_at desc;
end; $$;

create function public.record_combined_guest_payment(
  target_folio_id uuid, target_payment_method_id uuid, hotel_amount_kobo bigint,
  outlet_allocations jsonb, payment_reference text, verbal_approver_name_value text,
  exception_reason text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  folio_record public.guest_folios;
  method_record public.payment_methods;
  order_record public.pos_orders;
  order_amount bigint;
  order_id_value uuid;
  order_entry jsonb;
  order_total bigint := 0;
  available_folio bigint;
  pending_folio bigint;
  totals record;
  payment_id_value uuid;
  shift_id uuid;
  payment_status_value public.payment_status;
  selected_orders uuid[] := '{}'::uuid[];
begin
  select * into folio_record from public.guest_folios where id = target_folio_id for update;
  if not found or folio_record.status <> 'open' then raise exception 'Choose an open hotel folio'; end if;
  if not public.has_hotel_permission(folio_record.hotel_id, 'payments.create') then
    raise exception 'Not authorised to collect a hotel payment';
  end if;
  if hotel_amount_kobo is null or hotel_amount_kobo <= 0 or hotel_amount_kobo > 9007199254740991 then
    raise exception 'Choose a positive hotel portion';
  end if;
  if outlet_allocations is null or jsonb_typeof(outlet_allocations) <> 'array'
      or jsonb_array_length(outlet_allocations) = 0 or jsonb_array_length(outlet_allocations) > 10 then
    raise exception 'Select one to ten outlet orders';
  end if;
  if coalesce(length(trim(verbal_approver_name_value)), 0) < 3
      or length(trim(verbal_approver_name_value)) > 120 then
    raise exception 'Record the accountant who approved the exception by phone';
  end if;
  if coalesce(length(trim(exception_reason)), 0) < 10 or length(trim(exception_reason)) > 500 then
    raise exception 'Explain why the guest needs one combined payment';
  end if;
  select * into method_record from public.payment_methods
    where id = target_payment_method_id and hotel_id = folio_record.hotel_id and active;
  if not found then raise exception 'Choose an active hotel payment method'; end if;
  if coalesce(length(trim(payment_reference)), 0) < 3 or length(trim(payment_reference)) > 200 then
    raise exception 'A unique collection reference is required for this exception';
  end if;
  if method_record.code = 'cash' and method_record.requires_verification then
    raise exception 'Cash cannot require payment verification';
  end if;
  if nullif(trim(payment_reference), '') is not null and exists (
    select 1 from public.payments p where p.hotel_id = folio_record.hotel_id
      and p.payment_method_id = method_record.id and p.reference = trim(payment_reference)
      and p.status <> 'voided') then
    raise exception 'This payment reference has already been recorded';
  end if;
  available_folio := public.folio_balance(folio_record.id);
  select coalesce(sum(pa.amount_kobo), 0) into pending_folio
    from public.payment_allocations pa join public.payments p on p.id = pa.payment_id
    where pa.folio_id = folio_record.id and p.status = 'pending_verification';
  if hotel_amount_kobo > available_folio - pending_folio then
    raise exception 'Hotel portion exceeds the remaining folio balance';
  end if;
  for order_entry in select value from jsonb_array_elements(outlet_allocations) order by value ->> 'order_id' loop
    if coalesce(order_entry ->> 'order_id', '') !~ '^[0-9a-fA-F-]{36}$'
      or coalesce(order_entry ->> 'amount_kobo', '') !~ '^[1-9][0-9]{0,15}$' then
      raise exception 'Invalid outlet allocation';
    end if;
    order_id_value := (order_entry ->> 'order_id')::uuid;
    order_amount := (order_entry ->> 'amount_kobo')::bigint;
    if order_id_value = any(selected_orders) then
      raise exception 'An outlet order cannot appear twice';
    end if;
    selected_orders := array_append(selected_orders, order_id_value);
    -- Locking the order serialises this with ordinary POS tender recording.
    select * into order_record from public.pos_orders where id = order_id_value for update;
    if not found or order_record.hotel_id <> folio_record.hotel_id or order_record.status <> 'open' then
      raise exception 'Choose an open outlet order from this hotel';
    end if;
    select * into totals from public.pos_order_totals(order_record.id);
    if totals.gross_total_kobo <= 0 or order_amount > totals.gross_total_kobo - totals.completed_kobo - totals.pending_kobo then
      raise exception 'Outlet portion exceeds the remaining order balance';
    end if;
    order_total := order_total + order_amount;
    if hotel_amount_kobo::numeric + order_total > 9007199254740991 then
      raise exception 'Combined payment exceeds supported precision';
    end if;
  end loop;
  if method_record.code = 'cash' then
    if not public.has_hotel_permission(folio_record.hotel_id, 'cashier_shifts.open') then
      raise exception 'Only an authorised hotel cashier may receive cash';
    end if;
    select id into shift_id from public.cashier_shifts
      where hotel_id = folio_record.hotel_id and opened_by = auth.uid() and status = 'open' for update;
    if shift_id is null then raise exception 'Open your hotel cashier shift before receiving cash'; end if;
  end if;
  payment_status_value := case when method_record.requires_verification
    then 'pending_verification'::public.payment_status else 'completed'::public.payment_status end;
  insert into public.payments(hotel_id, payment_number, payment_method_id, amount_kobo,
    reference, status, received_by, cashier_shift_id)
  values(folio_record.hotel_id, public.next_document_number(folio_record.hotel_id, 'PAY'),
    method_record.id, hotel_amount_kobo + order_total, nullif(trim(payment_reference), ''),
    payment_status_value, auth.uid(), shift_id) returning id into payment_id_value;
  insert into public.payment_allocations(payment_id, folio_id, amount_kobo)
    values(payment_id_value, folio_record.id, hotel_amount_kobo);
  insert into public.combined_guest_payments(payment_id, hotel_id, folio_id, payment_method_id,
    external_reference,
    hotel_amount_kobo, reason, verbal_approver_name, verbal_approved_at, collected_by)
  values(payment_id_value, folio_record.hotel_id, folio_record.id, method_record.id,
    nullif(trim(payment_reference), ''),
    hotel_amount_kobo, trim(exception_reason), trim(verbal_approver_name_value), now(), auth.uid());
  for order_entry in select value from jsonb_array_elements(outlet_allocations) loop
    order_id_value := (order_entry ->> 'order_id')::uuid;
    order_amount := (order_entry ->> 'amount_kobo')::bigint;
    select * into order_record from public.pos_orders where id = order_id_value;
    insert into public.combined_guest_payment_orders(payment_id, hotel_id, order_id,
      outlet_id, outlet_name_snapshot, amount_kobo)
    values(payment_id_value, folio_record.hotel_id, order_record.id,
      order_record.outlet_id, order_record.outlet_name_snapshot, order_amount);
    if payment_status_value = 'completed' then
      select * into totals from public.pos_order_totals(order_record.id);
      if totals.completed_kobo >= totals.gross_total_kobo then
        update public.pos_orders set status = 'settled', settled_at = now() where id = order_record.id;
      end if;
    end if;
  end loop;
  perform public.log_activity(folio_record.hotel_id, 'payment.combined_collected', 'payment', payment_id_value,
    jsonb_build_object('folio_id', folio_record.id, 'hotel_amount_kobo', hotel_amount_kobo,
      'outlet_amount_kobo', order_total, 'status', payment_status_value,
      'verbal_approver_name', trim(verbal_approver_name_value)));
  return payment_id_value;
end; $$;

-- Protect the shared collection against ordinary folio-only corrections and
-- accidental hotel-only receipts. A dedicated split-aware correction follows.
create function public.guard_combined_guest_payment_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.combined_guest_payments c where c.payment_id = new.id)
      and old.status = 'completed' and new.status in ('voided', 'refunded')
      and current_setting('app.combined_refund_id', true) is distinct from new.id::text then
    raise exception 'Combined payments require a split-aware correction';
  end if;
  return new;
end; $$;
create trigger guard_combined_guest_payment_change before update of status on public.payments
  for each row execute function public.guard_combined_guest_payment_change();

create function public.guard_combined_guest_payment_refund()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.combined_guest_payments c where c.payment_id = new.payment_id)
      and current_setting('app.combined_refund_id', true) is distinct from new.payment_id::text then
    raise exception 'Combined payments require a split-aware refund';
  end if;
  return new;
end; $$;
create trigger guard_combined_guest_payment_refund before insert on public.payment_refunds
  for each row execute function public.guard_combined_guest_payment_refund();

create function public.guard_combined_guest_payment_receipt()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.combined_guest_payments c where c.payment_id = new.payment_id) then
    raise exception 'Use the combined payment acknowledgement, not a hotel-only receipt';
  end if;
  return new;
end; $$;
create trigger guard_combined_guest_payment_receipt before insert on public.receipts
  for each row execute function public.guard_combined_guest_payment_receipt();

-- Existing POS correction calculations are based on outlet tenders. Do not
-- let them silently recalculate a shared collection as an outlet payment.
create function public.guard_combined_pos_line_correction()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.combined_guest_payment_orders a
      join public.payments p on p.id = a.payment_id
      where a.order_id = new.order_id and p.status in ('completed', 'pending_verification')) then
    raise exception 'A hotel-collected combined order needs a dedicated full-payment correction; do not edit its POS lines';
  end if;
  return new;
end; $$;
create trigger guard_combined_pos_line_correction before insert on public.pos_order_line_corrections
  for each row execute function public.guard_combined_pos_line_correction();

alter function public.request_pos_order_line_correction(uuid,uuid,bigint,text,text)
  rename to request_pos_order_line_correction_without_combined;
revoke all on function public.request_pos_order_line_correction_without_combined(uuid,uuid,bigint,text,text)
  from public, anon, authenticated;
create function public.request_pos_order_line_correction(
  target_order_id uuid, target_order_line_id uuid, amount_delta_value_kobo bigint,
  description_value text, reason_value text
) returns uuid language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.combined_guest_payment_orders a
      join public.payments p on p.id = a.payment_id
      where a.order_id = target_order_id and p.status in ('completed', 'pending_verification')) then
    raise exception 'A hotel-collected combined order needs a dedicated full-payment correction; do not edit its POS lines';
  end if;
  return public.request_pos_order_line_correction_without_combined(target_order_id,
    target_order_line_id, amount_delta_value_kobo, description_value, reason_value);
end; $$;

-- A full refund is one hotel-account payout. Only the original hotel portion
-- returns to the folio; the outlet order portions become unpaid again.
create or replace function public.folio_balance(target_folio_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when fi.status = 'posted' then fi.total_amount_kobo else 0 end), 0)
    - coalesce((select sum(pa.amount_kobo) from public.payment_allocations pa
        join public.payments p on p.id = pa.payment_id
        where pa.folio_id = target_folio_id and p.status in ('completed', 'refunded')), 0)
    + coalesce((select sum(coalesce(c.hotel_amount_kobo, pr.amount_kobo))
        from public.payment_refunds pr
        left join public.combined_guest_payments c on c.payment_id = pr.payment_id
        where pr.folio_id = target_folio_id), 0)
    - coalesce((select sum(bara.amount_kobo) from public.business_account_receivable_allocations bara
        join public.business_account_receivables bar on bar.id = bara.receivable_id
        where bara.folio_id = target_folio_id and bar.status <> 'voided'), 0)
  from public.folio_items fi where fi.folio_id = target_folio_id;
$$;

-- Preserve the established verification path for ordinary folios and deposits.
-- Combined payments need to verify both their folio and outlet allocations
-- without creating a hotel receipt for the full external collection.
alter function public.verify_pending_payment(uuid, text) rename to verify_standard_pending_payment;
revoke all on function public.verify_standard_pending_payment(uuid, text) from public, anon, authenticated;

create function public.verify_pending_payment(target_payment_id uuid, verification_note_value text)
returns void language plpgsql security definer set search_path = public as $$
declare
  payment_record public.payments;
  combined_record public.combined_guest_payments;
  folio_record public.guest_folios;
  order_record public.pos_orders;
  order_link public.combined_guest_payment_orders;
  totals record;
begin
  select * into combined_record from public.combined_guest_payments where payment_id = target_payment_id;
  if not found then
    perform public.verify_standard_pending_payment(target_payment_id, verification_note_value);
    return;
  end if;
  select * into payment_record from public.payments where id = target_payment_id for update;
  if payment_record.status <> 'pending_verification' then raise exception 'Only pending payments can be verified'; end if;
  if not public.has_hotel_permission(payment_record.hotel_id, 'payments.verify') then
    raise exception 'Not authorised to verify payments';
  end if;
  if coalesce(length(trim(verification_note_value)), 0) < 3 then
    raise exception 'A verification note is required';
  end if;
  select * into folio_record from public.guest_folios where id = combined_record.folio_id for update;
  if folio_record.status <> 'open' or public.folio_balance(folio_record.id) < combined_record.hotel_amount_kobo then
    raise exception 'Folio is closed or its balance no longer covers this payment';
  end if;
  for order_link in select * from public.combined_guest_payment_orders
    where payment_id = target_payment_id order by order_id loop
    select * into order_record from public.pos_orders where id = order_link.order_id for update;
    if order_record.status <> 'open' then raise exception 'The linked outlet order is no longer open'; end if;
    select * into totals from public.pos_order_totals(order_record.id);
    if totals.completed_kobo + totals.pending_kobo > totals.gross_total_kobo then
      raise exception 'The linked outlet order no longer covers its pending payment';
    end if;
  end loop;
  update public.payments set status = 'completed', verified_at = now(),
    verified_by = auth.uid(), verification_note = trim(verification_note_value)
    where id = payment_record.id;
  for order_link in select * from public.combined_guest_payment_orders
    where payment_id = target_payment_id order by order_id loop
    select * into totals from public.pos_order_totals(order_link.order_id);
    if totals.completed_kobo >= totals.gross_total_kobo then
      update public.pos_orders set status = 'settled', settled_at = now()
        where id = order_link.order_id;
    end if;
  end loop;
  perform public.log_activity(payment_record.hotel_id, 'payment.combined_verified', 'payment', payment_record.id,
    jsonb_build_object('verification_note', trim(verification_note_value)));
end; $$;

create function public.get_combined_guest_payment_candidates(target_folio_id uuid, requested_order_numbers text[])
returns table(order_id uuid, order_number text, outlet_id uuid, outlet_name text,
  outlet_type text, balance_kobo bigint)
language plpgsql stable security definer set search_path = public as $$
declare folio_record public.guest_folios;
begin
  select * into folio_record from public.guest_folios where id = target_folio_id;
  if not found or not public.has_hotel_permission(folio_record.hotel_id, 'payments.create') then
    raise exception 'Not authorised to prepare this payment';
  end if;
  if coalesce(array_length(requested_order_numbers, 1), 0) not between 1 and 10
      or exists(select 1 from unnest(requested_order_numbers) n where length(trim(n)) not between 5 and 80) then
    raise exception 'Enter one to ten exact outlet order numbers';
  end if;
  return query select o.id, o.order_number, o.outlet_id, outlet.name, outlet.outlet_type,
      (t.gross_total_kobo - t.completed_kobo - t.pending_kobo)::bigint
    from public.pos_orders o join public.pos_outlets outlet on outlet.id = o.outlet_id
    cross join lateral public.pos_order_totals(o.id) t
    where o.hotel_id = folio_record.hotel_id and o.status = 'open'
      and o.order_number = any(requested_order_numbers)
      and outlet.outlet_type in ('restaurant', 'bar')
      and t.gross_total_kobo > t.completed_kobo + t.pending_kobo
    order by o.created_at desc limit 10;
end; $$;

create function public.get_combined_guest_payments(target_hotel_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'payments.read')
      and not public.has_hotel_permission(target_hotel_id, 'payments.create') then
    raise exception 'Not authorised to view combined payments';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'payment_id', c.payment_id, 'payment_number', p.payment_number,
    'received_at', p.received_at, 'status', p.status, 'reference', p.reference,
    'amount_kobo', p.amount_kobo, 'hotel_amount_kobo', c.hotel_amount_kobo,
    'folio_id', c.folio_id, 'folio_number', f.folio_number,
    'reason', c.reason, 'verbal_approver_name', c.verbal_approver_name,
    'review_status', c.review_status, 'review_note', c.review_note,
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
      'order_id', a.order_id, 'order_number', o.order_number,
      'outlet_name', a.outlet_name_snapshot, 'amount_kobo', a.amount_kobo)
      order by o.order_number) from public.combined_guest_payment_orders a
      join public.pos_orders o on o.id = a.order_id where a.payment_id = c.payment_id), '[]'::jsonb)
  ) order by p.received_at desc) from public.combined_guest_payments c
    join public.payments p on p.id = c.payment_id
    join public.guest_folios f on f.id = c.folio_id
    where c.hotel_id = target_hotel_id
      and (c.collected_by = auth.uid() or public.has_hotel_permission(target_hotel_id, 'payments.read'))), '[]'::jsonb);
end; $$;

create function public.review_combined_guest_payment(target_payment_id uuid, decision_value text, note_value text)
returns void language plpgsql security definer set search_path = public as $$
declare record_value public.combined_guest_payments; payment_record public.payments;
begin
  select * into record_value from public.combined_guest_payments where payment_id = target_payment_id for update;
  if not found then raise exception 'Combined payment not found'; end if;
  if not exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.profile_id = auth.uid() and r.hotel_id = record_value.hotel_id and r.code = 'accountant') then
    raise exception 'Only the accountant may confirm a phone-approved combined payment';
  end if;
  if record_value.collected_by = auth.uid() then
    raise exception 'The collector cannot confirm their own verbal approval claim';
  end if;
  if record_value.review_status <> 'awaiting_accountant' then
    raise exception 'This combined payment has already been reviewed';
  end if;
  if decision_value not in ('confirmed', 'disputed')
      or coalesce(length(trim(note_value)), 0) < 3 or length(trim(note_value)) > 2000 then
    raise exception 'Choose confirm or dispute and provide a review note';
  end if;
  select * into payment_record from public.payments where id = target_payment_id;
  if payment_record.status not in ('completed', 'pending_verification') then
    raise exception 'Only an active combined collection can be reviewed';
  end if;
  update public.combined_guest_payments set review_status = decision_value,
    reviewed_by = auth.uid(), reviewed_at = now(), review_note = trim(note_value)
    where payment_id = target_payment_id;
  perform public.log_activity(record_value.hotel_id, 'payment.combined_' || decision_value,
    'payment', target_payment_id, jsonb_build_object('review_note', trim(note_value)));
end; $$;

alter table public.finance_approval_requests
  drop constraint if exists finance_approval_requests_action_type_check;
alter table public.finance_approval_requests
  add constraint finance_approval_requests_action_type_check
  check (action_type in (
    'void_payment', 'refund_payment', 'folio_adjustment', 'reverse_folio_item',
    'reservation_discount', 'company_credit_note', 'company_payment_refund',
    'pos_payment_refund', 'pos_order_line_correction', 'combined_payment_refund'
  ));

create function public.request_combined_guest_payment_refund(
  target_payment_id uuid, reason_value text, payout_reference text
) returns uuid language plpgsql security definer set search_path = public as $$
declare c public.combined_guest_payments; p public.payments; f public.guest_folios;
  request_id uuid; method_code text;
begin
  select * into c from public.combined_guest_payments where payment_id = target_payment_id;
  if not found then raise exception 'Combined payment not found'; end if;
  if not public.has_hotel_permission(c.hotel_id, 'finance_approvals.request')
      or not public.has_hotel_permission(c.hotel_id, 'payments.refund') then
    raise exception 'Not authorised to request this refund';
  end if;
  select * into p from public.payments where id = c.payment_id for update;
  select * into f from public.guest_folios where id = c.folio_id for update;
  if p.status <> 'completed' or f.status <> 'open' then
    raise exception 'A completed payment on an open folio is required';
  end if;
  if coalesce(length(trim(reason_value)), 0) < 10 then
    raise exception 'Give a reason for the full combined-payment refund';
  end if;
  if exists (select 1 from public.payment_refunds where payment_id = p.id)
    or exists (select 1 from public.finance_approval_requests
      where action_type = 'combined_payment_refund' and target_entity_id = p.id
        and status in ('pending', 'approved') and expires_at > now()) then
    raise exception 'A refund already exists or awaits approval';
  end if;
  select code into method_code from public.payment_methods where id = p.payment_method_id;
  if method_code <> 'cash' and nullif(trim(payout_reference), '') is null then
    raise exception 'A payout reference is required for non-cash refunds';
  end if;
  insert into public.finance_approval_requests(hotel_id, action_type, target_entity_type,
    target_entity_id, payload, reason, requested_by)
  values(c.hotel_id, 'combined_payment_refund', 'payment', p.id,
    jsonb_build_object('payment_id', p.id, 'amount_kobo', p.amount_kobo,
      'reference', nullif(trim(payout_reference), '')), trim(reason_value), auth.uid())
  returning id into request_id;
  perform public.log_activity(c.hotel_id, 'payment.combined_refund_requested',
    'finance_approval_request', request_id,
    jsonb_build_object('payment_id', p.id, 'amount_kobo', p.amount_kobo));
  return request_id;
end; $$;

-- Keep the Owner/GM approval register informative for the full external
-- refund, not merely the hotel folio portion.
do $$
declare definition text; target_oid oid;
begin
  target_oid := to_regprocedure('public.get_finance_approval_register(uuid,date,date)');
  if target_oid is null then raise exception 'Finance approval register is missing'; end if;
  definition := pg_get_functiondef(target_oid);
  if position('when ''combined_payment_refund'' then' in definition) = 0 then
    if position('when ''refund_payment'' then (far.payload->>''amount_kobo'')::bigint' in definition) = 0
        or position('when far.action_type = ''company_payment_refund'' then ''Refund of company credit balance''' in definition) = 0 then
      raise exception 'Finance approval register structure changed; review combined refund display';
    end if;
    definition := replace(definition,
      'when ''refund_payment'' then (far.payload->>''amount_kobo'')::bigint',
      'when ''combined_payment_refund'' then (far.payload->>''amount_kobo'')::bigint' || E'\n      ' ||
        'when ''refund_payment'' then (far.payload->>''amount_kobo'')::bigint');
    definition := replace(definition,
      'when far.action_type = ''company_payment_refund'' then ''Refund of company credit balance''',
      'when far.action_type = ''combined_payment_refund'' then ''Full exceptional combined-payment refund''' || E'\n    ' ||
        'when far.action_type = ''company_payment_refund'' then ''Refund of company credit balance''');
    execute definition;
  end if;
end $$;

create function public.execute_approved_combined_guest_refund(target_request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.finance_approval_requests; c public.combined_guest_payments;
  p public.payments; f public.guest_folios; shift_id uuid; method_code text;
  refund_id uuid; refund_number_value text; order_link public.combined_guest_payment_orders;
  totals record;
begin
  select * into r from public.finance_approval_requests where id = target_request_id for update;
  if not found or r.action_type <> 'combined_payment_refund' or r.status <> 'approved'
      or r.expires_at <= now() then raise exception 'Approved combined refund not found'; end if;
  if not public.has_hotel_permission(r.hotel_id, 'finance_approvals.approve')
      or r.decided_by <> auth.uid() or r.requested_by = auth.uid() then
    raise exception 'Only the independent approver may execute the refund';
  end if;
  select * into c from public.combined_guest_payments where payment_id = r.target_entity_id;
  select * into p from public.payments where id = c.payment_id for update;
  select * into f from public.guest_folios where id = c.folio_id for update;
  if c.hotel_id <> r.hotel_id or p.status <> 'completed' or f.status <> 'open'
      or exists (select 1 from public.payment_refunds where payment_id = p.id) then
    raise exception 'The original combined payment is no longer refundable';
  end if;
  for order_link in select * from public.combined_guest_payment_orders
      where payment_id = p.id order by order_id loop
    perform 1 from public.pos_orders where id = order_link.order_id for update;
  end loop;
  select code into method_code from public.payment_methods where id = p.payment_method_id;
  if method_code = 'cash' then
    if not public.has_hotel_permission(p.hotel_id, 'cashier_shifts.open') then
      raise exception 'An authorised hotel cash shift is required for the payout';
    end if;
    select id into shift_id from public.cashier_shifts
      where hotel_id = p.hotel_id and opened_by = auth.uid() and status = 'open' for update;
    if shift_id is null then raise exception 'Open a hotel cash shift before this refund'; end if;
  elsif nullif(trim(r.payload ->> 'reference'), '') is null then
    raise exception 'A payout reference is required';
  end if;
  if (r.payload ->> 'amount_kobo')::bigint <> p.amount_kobo then
    raise exception 'A combined payment refund must reverse the full external collection';
  end if;
  refund_number_value := public.next_document_number(p.hotel_id, 'RFN');
  perform set_config('app.combined_refund_id', p.id::text, true);
  insert into public.payment_refunds(hotel_id, refund_number, payment_id,
    folio_id, amount_kobo, reference, reason, refunded_by, cashier_shift_id)
  values(p.hotel_id, refund_number_value, p.id, f.id, p.amount_kobo,
    nullif(trim(r.payload ->> 'reference'), ''), r.reason, auth.uid(), shift_id)
  returning id into refund_id;
  update public.payments set status = 'refunded' where id = p.id;
  perform set_config('app.combined_refund_id', '', true);
  for order_link in select * from public.combined_guest_payment_orders
      where payment_id = p.id order by order_id loop
    select * into totals from public.pos_order_totals(order_link.order_id);
    if totals.completed_kobo < totals.gross_total_kobo then
      update public.pos_orders set status = 'open', settled_at = null
        where id = order_link.order_id;
    end if;
  end loop;
  perform public.log_activity(p.hotel_id, 'payment.combined_refunded', 'payment_refund', refund_id,
    jsonb_build_object('payment_id', p.id, 'amount_kobo', p.amount_kobo,
      'hotel_amount_kobo', c.hotel_amount_kobo, 'refund_number', refund_number_value,
      'approval_request_id', r.id));
end; $$;

alter function public.execute_finance_approval(uuid) rename to execute_existing_finance_approval;
revoke all on function public.execute_existing_finance_approval(uuid) from public, anon, authenticated;
create function public.execute_finance_approval(target_request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare action_value text;
begin
  select action_type into action_value from public.finance_approval_requests where id = target_request_id;
  if action_value = 'combined_payment_refund' then
    perform public.execute_approved_combined_guest_refund(target_request_id);
    update public.finance_approval_requests set status = 'executed',
      executed_by = auth.uid(), executed_at = now() where id = target_request_id;
    perform public.log_activity((select hotel_id from public.finance_approval_requests where id = target_request_id),
      'finance_approval.executed', 'finance_approval_request', target_request_id,
      jsonb_build_object('action_type', action_value));
  else
    perform public.execute_existing_finance_approval(target_request_id);
  end if;
end; $$;

drop function public.get_folio_payment_history(uuid);
create function public.get_folio_payment_history(target_folio_id uuid)
returns table (
  payment_id uuid, payment_number text, amount_kobo bigint,
  allocated_amount_kobo bigint, status public.payment_status, reference text,
  received_at timestamptz, payment_method_name text, receipt_number text,
  receipt_issued_at timestamptz, receipt_voided_at timestamptz, void_reason text,
  guest_name text, room_number text, refunds jsonb, is_combined boolean
) language plpgsql security definer set search_path = public as $$
declare target_hotel_id uuid;
begin
  select hotel_id into target_hotel_id from public.guest_folios where id = target_folio_id;
  if target_hotel_id is null then raise exception 'Folio not found'; end if;
  if not public.has_hotel_permission(target_hotel_id, 'folios.read') then
    raise exception 'Not authorised to view this folio';
  end if;
  return query
  select p.id, p.payment_number, p.amount_kobo, pa.amount_kobo, p.status,
    p.reference, p.received_at, pm.name, r.receipt_number, r.issued_at,
    r.voided_at, p.void_reason, g.full_name, rm.room_number,
    coalesce(jsonb_agg(jsonb_build_object('id', pr.id,
      'refund_number', pr.refund_number,
      'amount_kobo', coalesce(c.hotel_amount_kobo, pr.amount_kobo),
      'reason', pr.reason, 'refunded_at', pr.refunded_at)
      order by pr.refunded_at) filter (where pr.id is not null), '[]'::jsonb),
    c.payment_id is not null
  from public.payment_allocations pa
  join public.payments p on p.id = pa.payment_id
  join public.payment_methods pm on pm.id = p.payment_method_id
  join public.guest_folios gf on gf.id = pa.folio_id
  join public.stays s on s.id = gf.stay_id
  join public.guests g on g.id = s.guest_id
  left join public.rooms rm on rm.id = s.room_id
  left join public.receipts r on r.payment_id = p.id
  left join public.payment_refunds pr on pr.payment_id = p.id
  left join public.combined_guest_payments c on c.payment_id = p.id
  where pa.folio_id = target_folio_id
  group by p.id, pa.amount_kobo, pm.name, r.receipt_number, r.issued_at,
    r.voided_at, g.full_name, rm.room_number, c.payment_id
  order by max(pa.created_at) desc;
end; $$;

revoke all on function public.record_combined_guest_payment(uuid,uuid,bigint,jsonb,text,text,text),
  public.verify_pending_payment(uuid,text),
  public.get_combined_guest_payment_candidates(uuid,text[]),
  public.get_combined_guest_payments(uuid),
  public.get_restaurant_pos_sales_report(uuid,date,date),
  public.get_pos_hotel_collected_allocations(uuid,uuid[]),
  public.review_combined_guest_payment(uuid,text,text),
  public.request_combined_guest_payment_refund(uuid,text,text),
  public.execute_approved_combined_guest_refund(uuid),
  public.execute_finance_approval(uuid),
  public.get_folio_payment_history(uuid),
  public.guard_combined_guest_payment_change(), public.guard_combined_guest_payment_refund(),
  public.guard_combined_guest_payment_receipt(), public.guard_combined_pos_line_correction() from public, anon, authenticated;
revoke all on function public.request_pos_order_line_correction(uuid,uuid,bigint,text,text)
  from public, anon, authenticated;
grant execute on function public.request_pos_order_line_correction(uuid,uuid,bigint,text,text)
  to authenticated;
grant execute on function public.record_combined_guest_payment(uuid,uuid,bigint,jsonb,text,text,text),
  public.verify_pending_payment(uuid,text), public.get_combined_guest_payment_candidates(uuid,text[]),
  public.get_combined_guest_payments(uuid), public.review_combined_guest_payment(uuid,text,text),
  public.get_restaurant_pos_sales_report(uuid,date,date),
  public.get_pos_hotel_collected_allocations(uuid,uuid[]) to authenticated;
grant execute on function public.request_combined_guest_payment_refund(uuid,text,text),
  public.execute_finance_approval(uuid), public.get_folio_payment_history(uuid) to authenticated;
