-- Enforce payment allocation integrity and distinguish payment receipts from checkout invoices.

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  invoice_number text not null,
  folio_id uuid not null unique references public.guest_folios(id) on delete restrict,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  issued_by uuid references public.profiles(id) on delete set null,
  issued_at timestamptz not null default now(),
  unique (hotel_id, invoice_number)
);

create index invoices_hotel_issued_idx on public.invoices(hotel_id, issued_at desc);

create or replace function public.validate_payment_allocation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  target_payment_id uuid := coalesce(new.payment_id, old.payment_id);
  payment_amount bigint;
  allocation_total bigint;
  payment_hotel_id uuid;
  allocation_hotel_id uuid;
begin
  select amount_kobo, hotel_id into payment_amount, payment_hotel_id
  from public.payments where id = target_payment_id for update;
  if payment_amount is null then raise exception 'Payment not found for allocation'; end if;

  if tg_op <> 'DELETE' then
    select hotel_id into allocation_hotel_id from public.guest_folios where id = new.folio_id;
    if allocation_hotel_id is distinct from payment_hotel_id then
      raise exception 'Payment and folio must belong to the same hotel';
    end if;
  end if;

  select coalesce(sum(amount_kobo), 0) into allocation_total
  from public.payment_allocations where payment_id = target_payment_id;
  if allocation_total > payment_amount then
    raise exception 'Payment allocations cannot exceed the payment amount';
  end if;
  return null;
end;
$$;

create constraint trigger payment_allocation_integrity
after insert or update or delete on public.payment_allocations
deferrable initially immediate
for each row execute function public.validate_payment_allocation();

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
  receipt_number text;
  target_balance bigint;
  requires_payment_reference boolean;
begin
  select * into target_folio from public.guest_folios where id = target_folio_id for update;
  if not found then raise exception 'Folio not found'; end if;
  if not public.has_hotel_permission(target_folio.hotel_id, 'payments.create') then
    raise exception 'Not authorised to record payments';
  end if;
  if target_folio.status <> 'open' then raise exception 'Only open folios can receive payments'; end if;
  if payment_amount_kobo <= 0 then raise exception 'Payment amount must be greater than zero'; end if;

  select requires_reference into requires_payment_reference
  from public.payment_methods
  where id = target_payment_method_id and hotel_id = target_folio.hotel_id and active;
  if not found then raise exception 'Payment method is not available'; end if;
  if requires_payment_reference and nullif(trim(payment_reference), '') is null then
    raise exception 'A reference is required for this payment method';
  end if;

  target_balance := public.folio_balance(target_folio_id);
  if payment_amount_kobo > target_balance then raise exception 'Payment cannot exceed the folio balance'; end if;

  payment_number := public.next_document_number(target_folio.hotel_id, 'PAY');
  insert into public.payments (hotel_id, payment_number, payment_method_id, amount_kobo, reference, received_by)
  values (target_folio.hotel_id, payment_number, target_payment_method_id, payment_amount_kobo, nullif(trim(payment_reference), ''), auth.uid())
  returning id into payment_id;

  insert into public.payment_allocations (payment_id, folio_id, amount_kobo)
  values (payment_id, target_folio_id, payment_amount_kobo);

  receipt_number := public.next_document_number(target_folio.hotel_id, 'RCP');
  insert into public.receipts (hotel_id, receipt_number, folio_id, payment_id, issued_by)
  values (target_folio.hotel_id, receipt_number, target_folio_id, payment_id, auth.uid());

  perform public.log_activity(target_folio.hotel_id, 'payment.created', 'payment', payment_id,
    jsonb_build_object('folio_id', target_folio_id, 'amount_kobo', payment_amount_kobo, 'receipt_number', receipt_number));
  return payment_id;
end;
$$;

create or replace function public.checkout_stay(target_stay_id uuid, checkout_on date default null)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_stay public.stays;
  target_folio public.guest_folios;
  target_date date;
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
  if target_stay.status <> 'checked_in' then raise exception 'Only active stays can be checked out'; end if;
  checkout_on := coalesce(checkout_on, public.hotel_business_date(target_stay.hotel_id));
  if checkout_on < target_stay.actual_check_in_date or checkout_on > target_stay.expected_check_out_date then
    raise exception 'Checkout date is outside the stay dates';
  end if;

  select * into target_folio from public.guest_folios where stay_id = target_stay.id and status = 'open' for update;
  if not found then raise exception 'Open folio not found'; end if;

  target_date := target_stay.actual_check_in_date;
  while target_date < checkout_on loop
    perform public.post_room_night(target_stay.id, target_date);
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
    'checkout_date', checkout_on,
    'charges', coalesce((select jsonb_agg(jsonb_build_object(
      'id', fi.id, 'description', fi.description, 'service_date', fi.service_date,
      'base_amount_kobo', fi.base_amount_kobo, 'tax_amount_kobo', fi.tax_amount_kobo,
      'service_charge_amount_kobo', fi.service_charge_amount_kobo,
      'total_amount_kobo', fi.total_amount_kobo, 'status', fi.status
    ) order by fi.posted_at) from public.folio_items fi where fi.folio_id = target_folio.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object(
      'payment_id', p.id, 'payment_number', p.payment_number, 'amount_kobo', pa.amount_kobo,
      'method_id', p.payment_method_id, 'reference', p.reference, 'received_at', p.received_at
    ) order by p.received_at) from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where pa.folio_id = target_folio.id), '[]'::jsonb),
    'final_balance_kobo', target_balance
  ) into invoice_snapshot;

  update public.stays set status = 'checked_out', actual_check_out_date = checkout_on, checked_out_by = auth.uid() where id = target_stay.id;
  update public.reservations set status = 'checked_out', updated_by = auth.uid() where id = target_stay.reservation_id;
  update public.guest_folios set status = 'closed', closed_at = now(), closed_by = auth.uid() where id = target_folio.id;

  invoice_number := public.next_document_number(target_stay.hotel_id, 'INV');
  insert into public.invoices (hotel_id, invoice_number, folio_id, snapshot, issued_by)
  values (target_stay.hotel_id, invoice_number, target_folio.id, invoice_snapshot, auth.uid())
  returning id into invoice_id;

  perform public.log_activity(target_stay.hotel_id, 'stay.checked_out', 'stay', target_stay.id,
    jsonb_build_object('folio_id', target_folio.id, 'invoice_id', invoice_id, 'invoice_number', invoice_number));
  return invoice_id;
end;
$$;

insert into public.permissions (code, name, description)
values ('invoices.read', 'View invoices', 'View final folio invoices.')
on conflict (code) do nothing;

create or replace function public.provision_invoice_read_permission(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.code = 'invoices.read'
  where r.hotel_id = target_hotel_id
    and r.code in ('general_manager', 'receptionist', 'cashier', 'accountant')
  on conflict do nothing;
$$;

select public.provision_hotel_roles(id) from public.hotels;
select public.provision_invoice_read_permission(id) from public.hotels;

create or replace function public.handle_hotel_invoice_permission_provisioning()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_invoice_read_permission(new.id);
  return new;
end;
$$;

drop trigger if exists zzz_hotel_invoice_permission_provisioned on public.hotels;
create trigger zzz_hotel_invoice_permission_provisioned
after insert on public.hotels
for each row execute function public.handle_hotel_invoice_permission_provisioning();

revoke all on function public.validate_payment_allocation() from public;
revoke all on function public.provision_invoice_read_permission(uuid), public.handle_hotel_invoice_permission_provisioning() from public;
revoke all on function public.record_folio_payment(uuid, uuid, bigint, text), public.checkout_stay(uuid, date) from public;
grant execute on function public.record_folio_payment(uuid, uuid, bigint, text), public.checkout_stay(uuid, date) to authenticated;
grant select on public.invoices to authenticated;
alter table public.invoices enable row level security;
create policy invoices_read on public.invoices for select to authenticated
using (public.has_hotel_permission(hotel_id, 'invoices.read'));
