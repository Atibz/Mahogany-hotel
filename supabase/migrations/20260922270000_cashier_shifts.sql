-- Cashiers are accountable for one open shift at a time. Payments received by
-- a cashier are linked to that shift; no cash total is editable by the client.

create table public.cashier_shifts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  shift_number text not null,
  business_date date not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  opening_float_kobo bigint not null default 0 check (opening_float_kobo >= 0),
  expected_cash_kobo bigint,
  declared_cash_kobo bigint,
  variance_kobo bigint,
  variance_reason text,
  opened_by uuid not null references public.profiles(id) on delete restrict,
  opened_at timestamptz not null default now(),
  closed_by uuid references public.profiles(id) on delete restrict,
  closed_at timestamptz,
  check ((status = 'open' and closed_at is null and declared_cash_kobo is null and variance_kobo is null)
    or (status = 'closed' and closed_at is not null and closed_by is not null and declared_cash_kobo is not null and expected_cash_kobo is not null and variance_kobo is not null)),
  check (variance_kobo = 0 or nullif(trim(variance_reason), '') is not null),
  unique (hotel_id, shift_number)
);

create unique index cashier_shifts_one_open_per_cashier_idx
  on public.cashier_shifts(hotel_id, opened_by) where status = 'open';
create index cashier_shifts_hotel_opened_idx on public.cashier_shifts(hotel_id, opened_at desc);

alter table public.payments add column cashier_shift_id uuid references public.cashier_shifts(id) on delete restrict;
create index payments_cashier_shift_idx on public.payments(cashier_shift_id) where cashier_shift_id is not null;

insert into public.permissions (code, name, description) values
  ('cashier_shifts.open', 'Open cashier shift', 'Open a personal cashier shift and declare its opening float.'),
  ('cashier_shifts.close', 'Close cashier shift', 'Close a personal cashier shift with a declared cash count.'),
  ('cashier_shifts.read', 'View cashier shifts', 'View all cashier shifts and their reconciliation results.'),
  ('cashier_shifts.manage', 'Manage cashier shifts', 'Close another cashier’s shift when authorised.')
on conflict (code) do nothing;

create or replace function public.provision_cashier_shift_permissions(target_hotel_id uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r join public.permissions p on (
    (r.code = 'cashier' and p.code in ('cashier_shifts.open', 'cashier_shifts.close'))
    or (r.code = 'general_manager' and p.code in ('cashier_shifts.open', 'cashier_shifts.close', 'cashier_shifts.read', 'cashier_shifts.manage'))
    or (r.code = 'accountant' and p.code = 'cashier_shifts.read')
  )
  where r.hotel_id = target_hotel_id
  on conflict do nothing;
$$;

select public.provision_cashier_shift_permissions(id) from public.hotels;

create or replace function public.handle_hotel_cashier_shift_permission_provisioning()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.provision_cashier_shift_permissions(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzzz_hotel_cashier_shift_permissions on public.hotels;
create trigger zzzzzzz_hotel_cashier_shift_permissions after insert on public.hotels
for each row execute function public.handle_hotel_cashier_shift_permission_provisioning();

create or replace function public.cashier_shift_expected_cash(target_cashier_shift_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select cs.opening_float_kobo
    + coalesce((select sum(p.amount_kobo)
      from public.payments p join public.payment_methods pm on pm.id = p.payment_method_id
      where p.cashier_shift_id = cs.id and pm.code = 'cash' and p.status = 'completed'), 0)
    - coalesce((select sum(pr.amount_kobo)
      from public.payment_refunds pr join public.payments p on p.id = pr.payment_id
      join public.payment_methods pm on pm.id = p.payment_method_id
      where p.cashier_shift_id = cs.id and pm.code = 'cash'), 0)
  from public.cashier_shifts cs where cs.id = target_cashier_shift_id;
$$;

create or replace function public.open_cashier_shift(target_hotel_id uuid, opening_float_value_kobo bigint)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_shift_id uuid; new_shift_number text;
begin
  if auth.uid() is null or not public.has_hotel_permission(target_hotel_id, 'cashier_shifts.open') then raise exception 'Not authorised to open a cashier shift'; end if;
  if opening_float_value_kobo < 0 then raise exception 'Opening float cannot be negative'; end if;
  if exists (select 1 from public.cashier_shifts where hotel_id = target_hotel_id and opened_by = auth.uid() and status = 'open') then raise exception 'You already have an open cashier shift'; end if;
  new_shift_number := public.next_document_number(target_hotel_id, 'CSH');
  insert into public.cashier_shifts (hotel_id, shift_number, business_date, opening_float_kobo, opened_by)
  values (target_hotel_id, new_shift_number, public.hotel_business_date(target_hotel_id), opening_float_value_kobo, auth.uid())
  returning id into new_shift_id;
  perform public.log_activity(target_hotel_id, 'cashier_shift.opened', 'cashier_shift', new_shift_id, jsonb_build_object('shift_number', new_shift_number, 'opening_float_kobo', opening_float_value_kobo));
  return new_shift_id;
end;
$$;

create or replace function public.close_cashier_shift(target_cashier_shift_id uuid, declared_cash_value_kobo bigint, variance_reason_value text default null)
returns void language plpgsql security definer set search_path = public as $$
declare target_shift public.cashier_shifts; calculated_expected bigint; calculated_variance bigint; can_manage boolean;
begin
  select * into target_shift from public.cashier_shifts where id = target_cashier_shift_id for update;
  if not found then raise exception 'Cashier shift not found'; end if;
  if auth.uid() is null or not public.has_hotel_permission(target_shift.hotel_id, 'cashier_shifts.close') then raise exception 'Not authorised to close a cashier shift'; end if;
  can_manage := public.has_hotel_permission(target_shift.hotel_id, 'cashier_shifts.manage');
  if target_shift.opened_by <> auth.uid() and not can_manage then raise exception 'You may only close your own cashier shift'; end if;
  if target_shift.status <> 'open' then raise exception 'This cashier shift is already closed'; end if;
  if declared_cash_value_kobo < 0 then raise exception 'Declared cash cannot be negative'; end if;
  calculated_expected := public.cashier_shift_expected_cash(target_shift.id);
  calculated_variance := declared_cash_value_kobo - calculated_expected;
  if calculated_variance <> 0 and nullif(trim(variance_reason_value), '') is null then raise exception 'A reason is required when declared cash differs from expected cash'; end if;
  update public.cashier_shifts set status = 'closed', expected_cash_kobo = calculated_expected, declared_cash_kobo = declared_cash_value_kobo, variance_kobo = calculated_variance, variance_reason = nullif(trim(variance_reason_value), ''), closed_by = auth.uid(), closed_at = now() where id = target_shift.id;
  perform public.log_activity(target_shift.hotel_id, 'cashier_shift.closed', 'cashier_shift', target_shift.id, jsonb_build_object('expected_cash_kobo', calculated_expected, 'declared_cash_kobo', declared_cash_value_kobo, 'variance_kobo', calculated_variance, 'variance_reason', nullif(trim(variance_reason_value), '')));
end;
$$;

create or replace function public.current_cashier_shift(target_hotel_id uuid)
returns table (id uuid, shift_number text, opening_float_kobo bigint, expected_cash_kobo bigint, opened_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.has_hotel_permission(target_hotel_id, 'cashier_shifts.open') then raise exception 'Not authorised to view a cashier shift'; end if;
  return query select cs.id, cs.shift_number, cs.opening_float_kobo, public.cashier_shift_expected_cash(cs.id), cs.opened_at
  from public.cashier_shifts cs where cs.hotel_id = target_hotel_id and cs.opened_by = auth.uid() and cs.status = 'open';
end;
$$;

create or replace function public.record_folio_payment(target_folio_id uuid, target_payment_method_id uuid, payment_amount_kobo bigint, payment_reference text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare target_folio public.guest_folios; payment_id uuid; payment_number text; receipt_number text; target_balance bigint; requires_payment_reference boolean; current_shift_id uuid;
begin
  select * into target_folio from public.guest_folios where id = target_folio_id for update;
  if not found then raise exception 'Folio not found'; end if;
  if not public.has_hotel_permission(target_folio.hotel_id, 'payments.create') then raise exception 'Not authorised to record payments'; end if;
  if target_folio.status <> 'open' then raise exception 'Only open folios can receive payments'; end if;
  if payment_amount_kobo <= 0 then raise exception 'Payment amount must be greater than zero'; end if;
  select requires_reference into requires_payment_reference from public.payment_methods where id = target_payment_method_id and hotel_id = target_folio.hotel_id and active;
  if not found then raise exception 'Payment method is not available'; end if;
  if requires_payment_reference and nullif(trim(payment_reference), '') is null then raise exception 'A reference is required for this payment method'; end if;
  if exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.profile_id = auth.uid() and r.hotel_id = target_folio.hotel_id and r.code = 'cashier' and r.active) then
    select id into current_shift_id from public.cashier_shifts where hotel_id = target_folio.hotel_id and opened_by = auth.uid() and status = 'open' for update;
    if current_shift_id is null then raise exception 'Open a cashier shift before recording a payment'; end if;
  end if;
  target_balance := public.folio_balance(target_folio_id);
  if payment_amount_kobo > target_balance then raise exception 'Payment cannot exceed the folio balance'; end if;
  payment_number := public.next_document_number(target_folio.hotel_id, 'PAY');
  insert into public.payments (hotel_id, payment_number, payment_method_id, amount_kobo, reference, received_by, cashier_shift_id) values (target_folio.hotel_id, payment_number, target_payment_method_id, payment_amount_kobo, nullif(trim(payment_reference), ''), auth.uid(), current_shift_id) returning id into payment_id;
  insert into public.payment_allocations (payment_id, folio_id, amount_kobo) values (payment_id, target_folio_id, payment_amount_kobo);
  receipt_number := public.next_document_number(target_folio.hotel_id, 'RCP');
  insert into public.receipts (hotel_id, receipt_number, folio_id, payment_id, issued_by) values (target_folio.hotel_id, receipt_number, target_folio_id, payment_id, auth.uid());
  perform public.log_activity(target_folio.hotel_id, 'payment.created', 'payment', payment_id, jsonb_build_object('folio_id', target_folio_id, 'amount_kobo', payment_amount_kobo, 'receipt_number', receipt_number, 'cashier_shift_id', current_shift_id));
  return payment_id;
end;
$$;

revoke all on public.cashier_shifts from public, anon, authenticated;
grant select on public.cashier_shifts to authenticated;
alter table public.cashier_shifts enable row level security;
create policy cashier_shifts_read on public.cashier_shifts for select to authenticated using (opened_by = auth.uid() or public.has_hotel_permission(hotel_id, 'cashier_shifts.read'));

revoke all on function public.provision_cashier_shift_permissions(uuid), public.handle_hotel_cashier_shift_permission_provisioning(), public.cashier_shift_expected_cash(uuid) from public, anon, authenticated;
revoke all on function public.open_cashier_shift(uuid, bigint), public.close_cashier_shift(uuid, bigint, text), public.current_cashier_shift(uuid), public.record_folio_payment(uuid, uuid, bigint, text) from public, anon;
grant execute on function public.open_cashier_shift(uuid, bigint), public.close_cashier_shift(uuid, bigint, text), public.current_cashier_shift(uuid), public.record_folio_payment(uuid, uuid, bigint, text) to authenticated;
