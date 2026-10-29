-- Internal cash/settlement reconciliation. These records document evidence only;
-- they never initiate payments, change cashier counts, or post accounting journals.
create table public.internal_funding_accounts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id),
  department text not null check (department in ('hotel', 'restaurant', 'bar')),
  payment_method_id uuid not null references public.payment_methods(id),
  name text not null check (length(trim(name)) between 3 and 120),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (hotel_id, department, payment_method_id)
);

create table public.internal_expense_funding (
  expense_id uuid primary key references public.operating_expenses(id),
  hotel_id uuid not null references public.hotels(id),
  account_id uuid not null references public.internal_funding_accounts(id),
  paid_on date not null,
  evidence_reference text not null check (length(trim(evidence_reference)) between 3 and 500),
  recorded_by uuid not null references public.profiles(id),
  recorded_at timestamptz not null default now()
);

create table public.internal_fund_movements (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id),
  account_id uuid not null references public.internal_funding_accounts(id),
  business_date date not null,
  amount_kobo bigint not null check (amount_kobo <> 0 and abs(amount_kobo::numeric) <= 9007199254740991),
  evidence_reference text not null check (length(trim(evidence_reference)) between 3 and 500),
  reason text not null check (length(trim(reason)) between 3 and 500),
  recorded_by uuid not null references public.profiles(id),
  recorded_at timestamptz not null default now()
);

create table public.internal_daily_reconciliations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id),
  business_date date not null,
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  source_snapshot jsonb not null,
  declarations jsonb not null check (jsonb_typeof(declarations) = 'array'),
  exception_note text not null,
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  previous_approved_id uuid references public.internal_daily_reconciliations(id),
  check ((status = 'submitted' and reviewed_by is null and reviewed_at is null and review_note is null)
    or (status in ('approved', 'rejected') and reviewed_by is not null and reviewed_by <> submitted_by
      and reviewed_at is not null and length(trim(review_note)) >= 3))
);
create unique index internal_reconciliation_one_active_day on public.internal_daily_reconciliations(hotel_id, business_date)
  where status = 'submitted';
create index internal_reconciliation_history on public.internal_daily_reconciliations(hotel_id, business_date, submitted_at desc);
create index internal_movements_date on public.internal_fund_movements(hotel_id, business_date);
create index internal_expense_paid_date on public.internal_expense_funding(hotel_id, paid_on);

-- Reuse finance read/submit/review capabilities, including the existing owner bypass.
create function public.assert_internal_finance_access(target_hotel_id uuid, capability text default 'read')
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null
    or not public.has_hotel_permission(target_hotel_id, 'payments.read')
    or not public.has_hotel_permission(target_hotel_id, 'pos.sales.read')
    or not public.has_hotel_permission(target_hotel_id, 'expenses.read')
    or (capability = 'submit' and not public.has_hotel_permission(target_hotel_id, 'expenses.submit'))
    or (capability = 'review' and not public.has_hotel_permission(target_hotel_id, 'expenses.review'))
    or capability not in ('read', 'submit', 'review') then
    raise exception 'Not authorised for internal reconciliation';
  end if;
end; $$;

alter table public.internal_funding_accounts enable row level security;
alter table public.internal_expense_funding enable row level security;
alter table public.internal_fund_movements enable row level security;
alter table public.internal_daily_reconciliations enable row level security;
revoke all on public.internal_funding_accounts, public.internal_expense_funding,
  public.internal_fund_movements, public.internal_daily_reconciliations from public, anon, authenticated;
-- All reads and writes go through checked RPCs, including snapshot reads.

create function public.create_internal_funding_account(
  target_hotel_id uuid, department_value text, method_id uuid, name_value text
) returns uuid language plpgsql security definer set search_path = public as $$
declare result_id uuid;
begin
  perform public.assert_internal_finance_access(target_hotel_id, 'submit');
  perform 1 from public.hotels where id = target_hotel_id for update;
  if not exists (select 1 from public.payment_methods where id = method_id and hotel_id = target_hotel_id) then
    raise exception 'Choose a payment method belonging to this hotel';
  end if;
  insert into public.internal_funding_accounts(hotel_id, department, payment_method_id, name, created_by)
    values (target_hotel_id, department_value, method_id, trim(name_value), auth.uid()) returning id into result_id;
  perform public.log_activity(target_hotel_id, 'internal_reconciliation.account_created', 'internal_funding_account', result_id,
    jsonb_build_object('department', department_value, 'payment_method_id', method_id, 'name', trim(name_value)));
  return result_id;
end; $$;

create function public.record_internal_expense_funding(
  target_expense_id uuid, target_account_id uuid, paid_on_value date, reference_value text
) returns void language plpgsql security definer set search_path = public as $$
declare e public.operating_expenses; a public.internal_funding_accounts; old_date date;
begin
  select * into strict e from public.operating_expenses where id = target_expense_id;
  perform public.assert_internal_finance_access(e.hotel_id, 'submit');
  perform 1 from public.hotels where id = e.hotel_id for update;
  select * into strict a from public.internal_funding_accounts where id = target_account_id;
  if a.hotel_id <> e.hotel_id or a.department <> e.department then
    raise exception 'Expense funding must stay within its hotel and business line';
  end if;
  if paid_on_value is null or paid_on_value > public.hotel_business_date(e.hotel_id, now()) then
    raise exception 'Choose a payment business date on or before the current business date';
  end if;
  select paid_on into old_date from public.internal_expense_funding where expense_id = e.id;
  if exists (select 1 from public.internal_daily_reconciliations where hotel_id = e.hotel_id
    and business_date in (paid_on_value, old_date) and status = 'submitted') then
    raise exception 'Reject the pending reconciliation before changing funding';
  end if;
  insert into public.internal_expense_funding(expense_id, hotel_id, account_id, paid_on, evidence_reference, recorded_by)
    values (e.id, e.hotel_id, a.id, paid_on_value, trim(reference_value), auth.uid())
    on conflict (expense_id) do update set account_id = excluded.account_id, paid_on = excluded.paid_on,
      evidence_reference = excluded.evidence_reference, recorded_by = excluded.recorded_by, recorded_at = now();
  perform public.log_activity(e.hotel_id, 'internal_reconciliation.expense_funded', 'operating_expense', e.id,
    jsonb_build_object('account_id', a.id, 'paid_on', paid_on_value, 'previous_paid_on', old_date, 'evidence_reference', trim(reference_value)));
end; $$;

create function public.record_internal_fund_movement(
  target_account_id uuid, date_value date, amount_value_kobo bigint, reference_value text, reason_value text
) returns uuid language plpgsql security definer set search_path = public as $$
declare a public.internal_funding_accounts; result_id uuid;
begin
  select * into strict a from public.internal_funding_accounts where id = target_account_id;
  perform public.assert_internal_finance_access(a.hotel_id, 'submit');
  perform 1 from public.hotels where id = a.hotel_id for update;
  if date_value is null or date_value > public.hotel_business_date(a.hotel_id, now()) then raise exception 'Invalid movement business date'; end if;
  if exists (select 1 from public.internal_daily_reconciliations where hotel_id = a.hotel_id and business_date = date_value
    and status = 'submitted') then raise exception 'Reject the pending reconciliation before documenting another movement'; end if;
  insert into public.internal_fund_movements(hotel_id, account_id, business_date, amount_kobo, evidence_reference, reason, recorded_by)
    values (a.hotel_id, a.id, date_value, amount_value_kobo, trim(reference_value), trim(reason_value), auth.uid()) returning id into result_id;
  perform public.log_activity(a.hotel_id, 'internal_reconciliation.movement_recorded', 'internal_fund_movement', result_id,
    jsonb_build_object('account_id', a.id, 'business_date', date_value, 'amount_kobo', amount_value_kobo, 'evidence_reference', trim(reference_value), 'reason', trim(reason_value)));
  return result_id;
end; $$;

-- A single, deterministic source dataset drives totals, drill-down, and approval
-- freshness checks. Refunds are attributed to the payout date and method.
create function public.build_internal_reconciliation_source(target_hotel_id uuid, date_value date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  perform public.assert_internal_finance_access(target_hotel_id);
  if date_value is null or date_value > public.hotel_business_date(target_hotel_id, now()) then raise exception 'Invalid reconciliation business date'; end if;
  with events as (
    select p.id, 'payment'::text as kind, 'hotel'::text as department, p.payment_method_id,
      p.payment_number as reference, p.reference as evidence, p.amount_kobo, p.status::text as status, p.received_at as occurred_at
    from public.payments p where p.hotel_id = target_hotel_id and public.hotel_business_date(target_hotel_id, p.received_at) = date_value
    union all
    select r.id, 'refund', 'hotel', p.payment_method_id, r.refund_number, r.reference, r.amount_kobo, 'completed', r.refunded_at
    from public.payment_refunds r join public.payments p on p.id = r.payment_id and p.hotel_id = r.hotel_id
    where r.hotel_id = target_hotel_id and public.hotel_business_date(target_hotel_id, r.refunded_at) = date_value
    union all
    select p.id, 'payment', o.outlet_type::text, p.payment_method_id, p.payment_number, p.reference, p.amount_kobo, p.status, p.received_at
    from public.pos_order_payments p join public.pos_outlets o on o.id = p.outlet_id and o.hotel_id = p.hotel_id
    where p.hotel_id = target_hotel_id and o.outlet_type in ('restaurant', 'bar') and public.hotel_business_date(target_hotel_id, p.received_at) = date_value
    union all
    select r.id, 'refund', o.outlet_type::text, r.payment_method_id, r.refund_number, r.reference, r.amount_kobo, 'completed', r.refunded_at
    from public.pos_order_refunds r join public.pos_outlets o on o.id = r.outlet_id and o.hotel_id = r.hotel_id
    where r.hotel_id = target_hotel_id and o.outlet_type in ('restaurant', 'bar') and public.hotel_business_date(target_hotel_id, r.refunded_at) = date_value
  ), accounts as (
    select a.*, pm.name as method_name, pm.code as method_code,
      coalesce((select sum(e.amount_kobo) from events e where e.department = a.department and e.payment_method_id = a.payment_method_id
        and e.kind = 'payment' and e.status in ('completed', 'refunded')), 0)::bigint as collections_kobo,
      coalesce((select sum(e.amount_kobo) from events e where e.department = a.department and e.payment_method_id = a.payment_method_id
        and e.kind = 'refund'), 0)::bigint as refunds_kobo,
      coalesce((select sum(e.amount_kobo) from public.internal_expense_funding f join public.operating_expenses e on e.id = f.expense_id
        where f.account_id = a.id and f.hotel_id = target_hotel_id and f.paid_on = date_value), 0)::bigint as expenses_kobo,
      coalesce((select sum(m.amount_kobo) from public.internal_fund_movements m where m.account_id = a.id
        and m.hotel_id = target_hotel_id and m.business_date = date_value), 0)::bigint as movements_kobo,
      (select (d ->> 'closing_kobo')::bigint from public.internal_daily_reconciliations r
        cross join lateral jsonb_array_elements(r.declarations) d
        where r.hotel_id = target_hotel_id and r.business_date = date_value - 1 and r.status = 'approved'
          and d ->> 'account_id' = a.id::text order by r.submitted_at desc, r.id limit 1) as previous_closing_kobo
    from public.internal_funding_accounts a join public.payment_methods pm on pm.id = a.payment_method_id and pm.hotel_id = a.hotel_id
    where a.hotel_id = target_hotel_id
  ), expenses as (
    select e.id, e.expense_number, e.department, e.amount_kobo, e.status, e.description, e.payee, e.incurred_on,
      e.paid_via, e.evidence_reference, e.review_note, e.reviewed_by, f.account_id, f.paid_on, f.evidence_reference as funding_reference
    from public.operating_expenses e left join public.internal_expense_funding f on f.expense_id = e.id and f.hotel_id = e.hotel_id
    where e.hotel_id = target_hotel_id and (f.paid_on = date_value or (f.expense_id is null and e.incurred_on <= date_value))
  ), shifts as (
    select s.id, 'hotel'::text as department, s.shift_number, s.business_date, s.status, s.opening_float_kobo,
      s.expected_cash_kobo, s.declared_cash_kobo, s.variance_kobo, s.variance_reason, s.handover_reference, s.reviewed_at
    from public.cashier_shifts s where s.hotel_id = target_hotel_id and (s.business_date = date_value or (s.status = 'open' and s.business_date <= date_value))
    union all
    select s.id, o.outlet_type::text, s.shift_number, s.business_date, s.status, s.opening_float_kobo,
      s.expected_cash_kobo, s.declared_cash_kobo, s.variance_kobo, s.variance_reason, null::text, null::timestamptz
    from public.pos_cashier_shifts s join public.pos_outlets o on o.id = s.outlet_id and o.hotel_id = s.hotel_id
    where s.hotel_id = target_hotel_id and o.outlet_type in ('restaurant', 'bar')
      and (s.business_date = date_value or (s.status = 'open' and s.business_date <= date_value))
  ) select jsonb_build_object(
    'business_date', date_value,
    'accounts', coalesce((select jsonb_agg(to_jsonb(a) order by a.department, a.id) from accounts a), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.kind, e.id) from events e), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from expenses e), '[]'::jsonb),
    'movements', coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from public.internal_fund_movements m
      where m.hotel_id = target_hotel_id and m.business_date = date_value), '[]'::jsonb),
    'shifts', coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from shifts s), '[]'::jsonb),
    'blockers', jsonb_build_object(
      'pending_payments', (select count(*) from events where status = 'pending_verification'),
      'unmapped_payments', (select count(*) from events e where e.status <> 'voided' and not exists
        (select 1 from accounts a where a.department = e.department and a.payment_method_id = e.payment_method_id)),
      'unfunded_expenses', (select count(*) from expenses where account_id is null),
      'pending_expenses', (select count(*) from expenses where status = 'pending_review'),
      'open_shifts', (select count(*) from shifts where status = 'open'),
      'unreviewed_hotel_shifts', (select count(*) from shifts where department = 'hotel' and status = 'closed' and reviewed_at is null)
    )
  ) into result;
  if exists (select 1 from jsonb_array_elements((result -> 'accounts') || (result -> 'events') || (result -> 'expenses')
      || (result -> 'movements') || (result -> 'shifts')) a,
    lateral jsonb_each(a) n where right(n.key, 5) = '_kobo'
      and abs((nullif(n.value, 'null'::jsonb)::text)::numeric) > 9007199254740991) then
    raise exception 'Reconciliation amounts exceed supported precision';
  end if;
  return result;
end; $$;

create function public.get_internal_daily_reconciliation(target_hotel_id uuid, date_value date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_internal_finance_access(target_hotel_id);
  date_value := coalesce(date_value, public.hotel_business_date(target_hotel_id, now()));
  return jsonb_build_object(
    'current_business_date', public.hotel_business_date(target_hotel_id, now()),
    'source', public.build_internal_reconciliation_source(target_hotel_id, date_value),
    'history', coalesce((select jsonb_agg(to_jsonb(r) order by r.submitted_at desc, r.id) from public.internal_daily_reconciliations r
      where r.hotel_id = target_hotel_id and r.business_date = date_value), '[]'::jsonb),
    'payment_methods', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.display_order, p.id)
      from public.payment_methods p where p.hotel_id = target_hotel_id), '[]'::jsonb)
  );
end; $$;

create function public.submit_internal_daily_reconciliation(
  target_hotel_id uuid, date_value date, declarations_value jsonb, exception_note_value text, expected_source_value jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare source_data jsonb; a jsonb; d jsonb; normalized jsonb := '[]'::jsonb; result_id uuid;
  opening_value bigint; closing_value bigint; expected_value bigint; variance_value bigint; previous_approval public.internal_daily_reconciliations;
begin
  perform public.assert_internal_finance_access(target_hotel_id, 'submit');
  perform 1 from public.hotels where id = target_hotel_id for update;
  source_data := public.build_internal_reconciliation_source(target_hotel_id, date_value);
  if expected_source_value is distinct from source_data then raise exception 'Source records changed. Refresh and check the figures before submitting'; end if;
  select * into previous_approval from public.internal_daily_reconciliations where hotel_id = target_hotel_id
    and business_date = date_value and status = 'approved' order by submitted_at desc, id limit 1;
  if found then
    if coalesce(length(trim(exception_note_value)), 0) < 3 then raise exception 'Explain the correction to the previous approved reconciliation'; end if;
  end if;
  if length(exception_note_value) > 2000 then raise exception 'Exception notes must be at most 2000 characters'; end if;
  if exists (select 1 from jsonb_each_text(source_data -> 'blockers') b where b.value::bigint > 0) then
    raise exception 'Resolve all reconciliation blockers before submitting';
  end if;
  if declarations_value is null or jsonb_typeof(declarations_value) <> 'array' then raise exception 'Account declarations are required'; end if;
  if jsonb_array_length(source_data -> 'accounts') = 0 then raise exception 'Configure at least one funding account'; end if;
  if jsonb_array_length(declarations_value) <> jsonb_array_length(source_data -> 'accounts') then
    raise exception 'Declare every funding account exactly once';
  end if;
  if exists (select 1 from jsonb_array_elements(source_data -> 'expenses') e where e ->> 'status' = 'rejected')
    and coalesce(length(trim(exception_note_value)), 0) < 3 then raise exception 'Explain rejected paid expenses before submitting'; end if;
  for a in select value from jsonb_array_elements(source_data -> 'accounts') loop
    if (select count(*) from jsonb_array_elements(declarations_value) x where x ->> 'account_id' = a ->> 'id') <> 1 then
      raise exception 'Declare every funding account exactly once';
    end if;
    select x into d from jsonb_array_elements(declarations_value) x where x ->> 'account_id' = a ->> 'id';
    if coalesce(d ->> 'opening_kobo', '') !~ '^[0-9]{1,16}$' or coalesce(d ->> 'closing_kobo', '') !~ '^[0-9]{1,16}$'
      or coalesce(length(trim(d ->> 'evidence_reference')), 0) < 3 or length(d ->> 'evidence_reference') > 500 then
      raise exception 'Enter whole kobo amounts and cash-count or bank-statement evidence for every account';
    end if;
    opening_value := (d ->> 'opening_kobo')::bigint;
    closing_value := (d ->> 'closing_kobo')::bigint;
    if greatest(opening_value, closing_value) > 9007199254740991 then raise exception 'Amount exceeds supported precision'; end if;
    if a ->> 'previous_closing_kobo' is not null and opening_value <> (a ->> 'previous_closing_kobo')::bigint then
      raise exception 'Opening balance must match the previous approved closing balance';
    end if;
    expected_value := opening_value + (a ->> 'collections_kobo')::bigint - (a ->> 'refunds_kobo')::bigint
      - (a ->> 'expenses_kobo')::bigint + (a ->> 'movements_kobo')::bigint;
    variance_value := closing_value - expected_value;
    if greatest(abs(expected_value::numeric), abs(variance_value::numeric)) > 9007199254740991 then raise exception 'Amount exceeds supported precision'; end if;
    if variance_value <> 0 and coalesce(length(trim(d ->> 'variance_note')), 0) < 3 then raise exception 'Explain every cash or settlement variance'; end if;
    if length(d ->> 'variance_note') > 500 then raise exception 'Variance notes must be at most 500 characters'; end if;
    normalized := normalized || jsonb_build_array(jsonb_build_object('account_id', a ->> 'id', 'opening_kobo', opening_value,
      'closing_kobo', closing_value, 'expected_kobo', expected_value, 'variance_kobo', variance_value,
      'evidence_reference', trim(d ->> 'evidence_reference'), 'variance_note', coalesce(trim(d ->> 'variance_note'), '')));
  end loop;
  if previous_approval.id is not null and previous_approval.source_snapshot = source_data and previous_approval.declarations = normalized then
    raise exception 'These figures and source records are already approved';
  end if;
  insert into public.internal_daily_reconciliations(hotel_id, business_date, source_snapshot, declarations, exception_note, submitted_by, previous_approved_id)
    values (target_hotel_id, date_value, source_data, normalized, coalesce(trim(exception_note_value), ''), auth.uid(), previous_approval.id) returning id into result_id;
  perform public.log_activity(target_hotel_id, 'internal_reconciliation.submitted', 'internal_daily_reconciliation', result_id,
    jsonb_build_object('business_date', date_value));
  return result_id;
end; $$;

create function public.review_internal_daily_reconciliation(target_id uuid, decision_value text, note_value text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.internal_daily_reconciliations;
begin
  select * into strict r from public.internal_daily_reconciliations where id = target_id;
  perform public.assert_internal_finance_access(r.hotel_id, 'review');
  perform 1 from public.hotels where id = r.hotel_id for update;
  select * into strict r from public.internal_daily_reconciliations where id = target_id for update;
  if r.status <> 'submitted' then raise exception 'Only submitted reconciliations can be reviewed'; end if;
  if r.submitted_by = auth.uid() then raise exception 'The submitter cannot review their own reconciliation'; end if;
  if decision_value is null or decision_value not in ('approved', 'rejected') or coalesce(length(trim(note_value)), 0) < 3 or length(note_value) > 2000 then
    raise exception 'Choose approve or reject and provide a review note';
  end if;
  if decision_value = 'approved' and r.source_snapshot is distinct from public.build_internal_reconciliation_source(r.hotel_id, r.business_date) then
    raise exception 'Source records changed. Reject this submission and prepare a new reconciliation';
  end if;
  update public.internal_daily_reconciliations set status = decision_value, reviewed_by = auth.uid(), reviewed_at = now(), review_note = trim(note_value)
    where id = r.id;
  perform public.log_activity(r.hotel_id, 'internal_reconciliation.' || decision_value, 'internal_daily_reconciliation', r.id,
    jsonb_build_object('business_date', r.business_date, 'review_note', trim(note_value)));
end; $$;

-- Helpers remain private, even though their callers are SECURITY DEFINER.
revoke all on function public.assert_internal_finance_access(uuid, text), public.build_internal_reconciliation_source(uuid, date) from public, anon, authenticated;
revoke all on function public.create_internal_funding_account(uuid, text, uuid, text),
  public.record_internal_expense_funding(uuid, uuid, date, text), public.record_internal_fund_movement(uuid, date, bigint, text, text),
  public.get_internal_daily_reconciliation(uuid, date), public.submit_internal_daily_reconciliation(uuid, date, jsonb, text, jsonb),
  public.review_internal_daily_reconciliation(uuid, text, text) from public, anon;
grant execute on function public.create_internal_funding_account(uuid, text, uuid, text),
  public.record_internal_expense_funding(uuid, uuid, date, text), public.record_internal_fund_movement(uuid, date, bigint, text, text),
  public.get_internal_daily_reconciliation(uuid, date), public.submit_internal_daily_reconciliation(uuid, date, jsonb, text, jsonb),
  public.review_internal_daily_reconciliation(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
