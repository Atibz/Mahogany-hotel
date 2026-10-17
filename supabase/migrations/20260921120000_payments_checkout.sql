-- Reception settlement: payments, folio allocations, checkout, and receipts.
-- Payment records remain separate from folio charges and revenue.

create type public.payment_status as enum ('completed', 'voided', 'refunded');

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  payment_number text not null,
  payment_method_id uuid not null references public.payment_methods(id) on delete restrict,
  amount_kobo bigint not null check (amount_kobo > 0),
  reference text,
  status public.payment_status not null default 'completed',
  received_by uuid references public.profiles(id) on delete set null,
  received_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references public.profiles(id) on delete set null,
  void_reason text,
  created_at timestamptz not null default now(),
  unique (hotel_id, payment_number),
  check (status <> 'voided' or (voided_at is not null and void_reason is not null))
);

create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  folio_id uuid not null references public.guest_folios(id) on delete restrict,
  amount_kobo bigint not null check (amount_kobo > 0),
  created_at timestamptz not null default now(),
  unique (payment_id, folio_id)
);

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  receipt_number text not null,
  folio_id uuid not null references public.guest_folios(id) on delete restrict,
  payment_id uuid not null unique references public.payments(id) on delete restrict,
  issued_by uuid references public.profiles(id) on delete set null,
  issued_at timestamptz not null default now(),
  unique (hotel_id, receipt_number)
);

create index payments_hotel_received_idx on public.payments(hotel_id, received_at desc);
create index payment_allocations_folio_idx on public.payment_allocations(folio_id, created_at desc);
create index receipts_folio_idx on public.receipts(folio_id, issued_at desc);

insert into public.permissions (code, name, description)
values
  ('payments.read', 'View payments', 'View payments and payment allocations.'),
  ('payments.create', 'Record payments', 'Record completed guest payments.'),
  ('stays.checkout', 'Check out guests', 'Settle folios and check out guests.'),
  ('receipts.read', 'View receipts', 'View issued receipts.')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.hotel_id = '00000000-0000-4000-8000-000000000001'
  and r.code in ('general_manager', 'receptionist', 'cashier')
  and p.code in ('payments.read', 'payments.create', 'stays.checkout', 'receipts.read', 'night_audit.run')
on conflict do nothing;

create or replace function public.folio_balance(target_folio_id uuid)
returns bigint
language sql
stable
security definer set search_path = public
as $$
  select coalesce(sum(case when fi.status = 'posted' then fi.total_amount_kobo else 0 end), 0)
    - coalesce((select sum(pa.amount_kobo)
               from public.payment_allocations pa
               join public.payments p on p.id = pa.payment_id
               where pa.folio_id = target_folio_id and p.status = 'completed'), 0)
  from public.folio_items fi
  where fi.folio_id = target_folio_id;
$$;

create or replace function public.record_folio_payment(
  target_folio_id uuid,
  target_payment_method_id uuid,
  payment_amount_kobo bigint,
  payment_reference text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_folio public.guest_folios;
  payment_id uuid;
  payment_number text;
  target_balance bigint;
begin
  select * into target_folio from public.guest_folios where id = target_folio_id for update;
  if not found then raise exception 'Folio not found'; end if;
  if not public.has_hotel_permission(target_folio.hotel_id, 'payments.create') then
    raise exception 'Not authorised to record payments';
  end if;
  if target_folio.status <> 'open' then raise exception 'Only open folios can receive payments'; end if;
  if payment_amount_kobo <= 0 then raise exception 'Payment amount must be greater than zero'; end if;
  if not exists (select 1 from public.payment_methods where id = target_payment_method_id and hotel_id = target_folio.hotel_id and active) then
    raise exception 'Payment method is not available';
  end if;

  target_balance := public.folio_balance(target_folio_id);
  if payment_amount_kobo > target_balance then raise exception 'Payment cannot exceed the folio balance'; end if;

  payment_number := public.next_document_number(target_folio.hotel_id, 'PAY');
  insert into public.payments (hotel_id, payment_number, payment_method_id, amount_kobo, reference, received_by)
  values (target_folio.hotel_id, payment_number, target_payment_method_id, payment_amount_kobo, nullif(trim(payment_reference), ''), auth.uid())
  returning id into payment_id;

  insert into public.payment_allocations (payment_id, folio_id, amount_kobo)
  values (payment_id, target_folio_id, payment_amount_kobo);

  perform public.log_activity(target_folio.hotel_id, 'payment.created', 'payment', payment_id,
    jsonb_build_object('folio_id', target_folio_id, 'amount_kobo', payment_amount_kobo));
  return payment_id;
end;
$$;

create or replace function public.checkout_stay(target_stay_id uuid, checkout_on date default current_date)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_stay public.stays;
  target_folio public.guest_folios;
  target_date date;
  target_balance bigint;
  payment_id uuid;
  receipt_id uuid;
  receipt_number text;
begin
  select * into target_stay from public.stays where id = target_stay_id for update;
  if not found then raise exception 'Stay not found'; end if;
  if not public.has_hotel_permission(target_stay.hotel_id, 'stays.checkout') then
    raise exception 'Not authorised to check out guests';
  end if;
  if target_stay.status <> 'checked_in' then raise exception 'Only active stays can be checked out'; end if;
  if checkout_on < target_stay.actual_check_in_date or checkout_on > target_stay.expected_check_out_date then
    raise exception 'Checkout date is outside the stay dates';
  end if;

  select * into target_folio from public.guest_folios where stay_id = target_stay.id and status = 'open' for update;
  if not found then raise exception 'Open folio not found'; end if;

  -- Post every eligible night before calculating the final amount due.
  target_date := target_stay.actual_check_in_date;
  while target_date < checkout_on loop
    perform public.post_room_night(target_stay.id, target_date);
    target_date := target_date + 1;
  end loop;

  target_balance := public.folio_balance(target_folio.id);
  if target_balance <> 0 then
    raise exception 'Folio must be fully settled before checkout. Balance: % kobo', target_balance;
  end if;

  update public.stays
  set status = 'checked_out', actual_check_out_date = checkout_on, checked_out_by = auth.uid()
  where id = target_stay.id;

  update public.reservations
  set status = 'checked_out', updated_by = auth.uid()
  where id = target_stay.reservation_id;

  update public.guest_folios
  set status = 'closed', closed_at = now(), closed_by = auth.uid()
  where id = target_folio.id;

  receipt_number := public.next_document_number(target_stay.hotel_id, 'RCP');
  insert into public.receipts (hotel_id, receipt_number, folio_id, payment_id, issued_by)
  select target_stay.hotel_id, receipt_number, target_folio.id, pa.payment_id, auth.uid()
  from public.payment_allocations pa
  join public.payments p on p.id = pa.payment_id
  where pa.folio_id = target_folio.id and p.status = 'completed'
  order by p.received_at desc limit 1
  returning id into receipt_id;

  if receipt_id is null then
    raise exception 'A completed payment is required before checkout';
  end if;

  perform public.log_activity(target_stay.hotel_id, 'stay.checked_out', 'stay', target_stay.id,
    jsonb_build_object('folio_id', target_folio.id, 'receipt_id', receipt_id));
  return receipt_id;
end;
$$;

revoke all on public.payments, public.payment_allocations, public.receipts from public, anon, authenticated;
revoke all on function public.folio_balance(uuid), public.record_folio_payment(uuid, uuid, bigint, text), public.checkout_stay(uuid, date) from public;
grant select on public.payments, public.payment_allocations, public.receipts to authenticated;
grant execute on function public.folio_balance(uuid), public.record_folio_payment(uuid, uuid, bigint, text), public.checkout_stay(uuid, date) to authenticated;

alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.receipts enable row level security;

create policy payments_read on public.payments for select to authenticated
using (public.has_hotel_permission(hotel_id, 'payments.read'));
create policy payment_allocations_read on public.payment_allocations for select to authenticated
using (exists (select 1 from public.guest_folios gf where gf.id = folio_id and public.has_hotel_permission(gf.hotel_id, 'payments.read')));
create policy receipts_read on public.receipts for select to authenticated
using (public.has_hotel_permission(hotel_id, 'receipts.read'));
