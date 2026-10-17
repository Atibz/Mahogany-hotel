-- Append-only controls for payment corrections and folio charge corrections.
-- No financial event is deleted or silently edited.

alter table public.receipts
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references public.profiles(id) on delete set null,
  add column if not exists void_reason text;

create table if not exists public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  refund_number text not null,
  payment_id uuid not null references public.payments(id) on delete restrict,
  folio_id uuid not null references public.guest_folios(id) on delete restrict,
  amount_kobo bigint not null check (amount_kobo > 0),
  reference text,
  reason text not null check (length(trim(reason)) > 0),
  refunded_by uuid references public.profiles(id) on delete set null,
  refunded_at timestamptz not null default now(),
  unique (hotel_id, refund_number)
);

create index if not exists payment_refunds_folio_refunded_idx on public.payment_refunds(folio_id, refunded_at desc);
create index if not exists payment_refunds_payment_idx on public.payment_refunds(payment_id);

-- The initial foundation constraint prevented a posted reversal from pointing
-- to the immutable item it reverses. Replace it with an explicit link rule.
do $$
declare target_constraint text;
begin
  select conname into target_constraint
  from pg_constraint
  where conrelid = 'public.folio_items'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%reversal_of_item_id%'
  limit 1;
  if target_constraint is not null then
    execute format('alter table public.folio_items drop constraint %I', target_constraint);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.folio_items'::regclass
      and conname = 'folio_items_reversal_link_check'
  ) then
    alter table public.folio_items
      add constraint folio_items_reversal_link_check check (
        (item_type = 'reversal' and reversal_of_item_id is not null)
        or (item_type <> 'reversal' and reversal_of_item_id is null)
      );
  end if;
end;
$$;

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
               where pa.folio_id = target_folio_id and p.status in ('completed', 'refunded')), 0)
    + coalesce((select sum(pr.amount_kobo)
               from public.payment_refunds pr
               where pr.folio_id = target_folio_id), 0)
  from public.folio_items fi
  where fi.folio_id = target_folio_id;
$$;

create or replace function public.void_folio_payment(target_payment_id uuid, void_reason_value text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_payment public.payments;
  target_folio public.guest_folios;
begin
  select * into target_payment from public.payments where id = target_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  select gf.* into target_folio
  from public.payment_allocations pa join public.guest_folios gf on gf.id = pa.folio_id
  where pa.payment_id = target_payment_id
  for update;
  if not found then raise exception 'Payment allocation not found'; end if;
  if not public.has_hotel_permission(target_payment.hotel_id, 'payments.void') then raise exception 'Not authorised to void payments'; end if;
  if target_payment.status <> 'completed' then raise exception 'Only completed payments can be voided'; end if;
  if target_folio.status <> 'open' then raise exception 'Only payments on an open folio can be voided'; end if;
  if exists (select 1 from public.payment_refunds where payment_id = target_payment.id) then raise exception 'A refunded payment cannot be voided'; end if;
  if nullif(trim(void_reason_value), '') is null then raise exception 'A void reason is required'; end if;

  update public.payments
  set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = trim(void_reason_value)
  where id = target_payment.id;
  update public.receipts
  set voided_at = now(), voided_by = auth.uid(), void_reason = trim(void_reason_value)
  where payment_id = target_payment.id and voided_at is null;

  perform public.log_activity(target_payment.hotel_id, 'payment.voided', 'payment', target_payment.id,
    jsonb_build_object('folio_id', target_folio.id, 'amount_kobo', target_payment.amount_kobo, 'reason', trim(void_reason_value)));
end;
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

  select coalesce(sum(amount_kobo), 0) into refunded_total
  from public.payment_refunds where payment_id = target_payment.id;
  if refunded_total + refund_amount_kobo > target_payment.amount_kobo then
    raise exception 'Refund cannot exceed the original payment amount';
  end if;

  refund_number := public.next_document_number(target_payment.hotel_id, 'RFN');
  insert into public.payment_refunds (hotel_id, refund_number, payment_id, folio_id, amount_kobo, reference, reason, refunded_by)
  values (target_payment.hotel_id, refund_number, target_payment.id, target_folio.id, refund_amount_kobo,
    nullif(trim(refund_reference), ''), trim(refund_reason_value), auth.uid())
  returning id into refund_id;

  if refunded_total + refund_amount_kobo = target_payment.amount_kobo then
    update public.payments set status = 'refunded' where id = target_payment.id;
  end if;

  perform public.log_activity(target_payment.hotel_id, 'payment.refunded', 'payment_refund', refund_id,
    jsonb_build_object('payment_id', target_payment.id, 'folio_id', target_folio.id,
      'amount_kobo', refund_amount_kobo, 'refund_number', refund_number, 'reason', trim(refund_reason_value)));
  return refund_id;
end;
$$;

create or replace function public.create_folio_adjustment(
  target_folio_id uuid,
  adjustment_amount_kobo bigint,
  adjustment_description text,
  adjustment_reason text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare target_folio public.guest_folios; adjustment_id uuid;
begin
  select * into target_folio from public.guest_folios where id = target_folio_id for update;
  if not found then raise exception 'Folio not found'; end if;
  if not public.has_hotel_permission(target_folio.hotel_id, 'folios.adjust') then raise exception 'Not authorised to adjust folios'; end if;
  if target_folio.status <> 'open' then raise exception 'Only open folios can be adjusted'; end if;
  if adjustment_amount_kobo = 0 then raise exception 'Adjustment amount cannot be zero'; end if;
  if nullif(trim(adjustment_description), '') is null or nullif(trim(adjustment_reason), '') is null then raise exception 'An adjustment description and reason are required'; end if;

  insert into public.folio_items (hotel_id, folio_id, item_type, description, department_code, base_amount_kobo, tax_amount_kobo, total_amount_kobo, reference_type, reason, posted_by)
  values (target_folio.hotel_id, target_folio.id, 'adjustment', trim(adjustment_description), 'finance', adjustment_amount_kobo, 0, adjustment_amount_kobo, 'manual_adjustment', trim(adjustment_reason), auth.uid())
  returning id into adjustment_id;
  perform public.log_activity(target_folio.hotel_id, 'folio.adjusted', 'folio_item', adjustment_id,
    jsonb_build_object('folio_id', target_folio.id, 'amount_kobo', adjustment_amount_kobo, 'reason', trim(adjustment_reason)));
  return adjustment_id;
end;
$$;

create or replace function public.reverse_folio_item(target_folio_item_id uuid, reversal_reason text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare original_item public.folio_items; target_folio public.guest_folios; reversal_id uuid;
begin
  select * into original_item from public.folio_items where id = target_folio_item_id for update;
  if not found then raise exception 'Folio item not found'; end if;
  select * into target_folio from public.guest_folios where id = original_item.folio_id for update;
  if not public.has_hotel_permission(original_item.hotel_id, 'folios.reverse') then raise exception 'Not authorised to reverse folio charges'; end if;
  if target_folio.status <> 'open' then raise exception 'Only open folios can receive a reversal'; end if;
  if original_item.status <> 'posted' or original_item.item_type = 'reversal' then raise exception 'Only an active original folio item can be reversed'; end if;
  if exists (select 1 from public.folio_items where reversal_of_item_id = original_item.id) then raise exception 'This folio item has already been reversed'; end if;
  if nullif(trim(reversal_reason), '') is null then raise exception 'A reversal reason is required'; end if;

  insert into public.folio_items (hotel_id, folio_id, item_type, description, department_code, service_date,
    base_amount_kobo, tax_amount_kobo, service_charge_amount_kobo, total_amount_kobo, tax_snapshot,
    reference_type, reference_id, reversal_of_item_id, reason, posted_by)
  values (original_item.hotel_id, original_item.folio_id, 'reversal', 'Reversal: ' || original_item.description,
    original_item.department_code, original_item.service_date, -original_item.base_amount_kobo,
    -original_item.tax_amount_kobo, -original_item.service_charge_amount_kobo, -original_item.total_amount_kobo,
    original_item.tax_snapshot, 'folio_item_reversal', original_item.id, original_item.id, trim(reversal_reason), auth.uid())
  returning id into reversal_id;
  perform public.log_activity(original_item.hotel_id, 'folio.item_reversed', 'folio_item', reversal_id,
    jsonb_build_object('folio_id', original_item.folio_id, 'reversal_of_item_id', original_item.id, 'reason', trim(reversal_reason)));
  return reversal_id;
end;
$$;

insert into public.permissions (code, name, description) values
  ('payments.void', 'Void unfinalised payments', 'Void a completed payment on an open folio with a reason.'),
  ('payments.refund', 'Refund payments', 'Record an approved payment refund with a reason.'),
  ('folios.adjust', 'Adjust folios', 'Create a reasoned manual folio adjustment.'),
  ('folios.reverse', 'Reverse folio charges', 'Create a linked reversal for a posted folio item.')
on conflict (code) do nothing;

create or replace function public.provision_financial_control_permissions(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.code in ('payments.void', 'payments.refund', 'folios.adjust', 'folios.reverse')
  where r.hotel_id = target_hotel_id
    and (
      (r.code = 'cashier' and p.code = 'payments.void')
      or (r.code in ('general_manager', 'accountant') and p.code in ('payments.void', 'payments.refund', 'folios.adjust', 'folios.reverse'))
    )
  on conflict do nothing;
$$;

select public.provision_financial_control_permissions(id) from public.hotels;

create or replace function public.handle_hotel_financial_control_permission_provisioning()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_financial_control_permissions(new.id);
  return new;
end;
$$;

drop trigger if exists zzzz_hotel_financial_control_permissions on public.hotels;
create trigger zzzz_hotel_financial_control_permissions
after insert on public.hotels
for each row execute function public.handle_hotel_financial_control_permission_provisioning();

revoke all on public.payment_refunds from public, anon, authenticated;
grant select on public.payment_refunds to authenticated;
alter table public.payment_refunds enable row level security;
drop policy if exists payment_refunds_read on public.payment_refunds;
create policy payment_refunds_read on public.payment_refunds for select to authenticated
using (public.has_hotel_permission(hotel_id, 'payments.read'));

revoke all on function public.void_folio_payment(uuid, text), public.refund_folio_payment(uuid, bigint, text, text), public.create_folio_adjustment(uuid, bigint, text, text), public.reverse_folio_item(uuid, text), public.provision_financial_control_permissions(uuid), public.handle_hotel_financial_control_permission_provisioning() from public;
grant execute on function public.void_folio_payment(uuid, text), public.refund_folio_payment(uuid, bigint, text, text), public.create_folio_adjustment(uuid, bigint, text, text), public.reverse_folio_item(uuid, text) to authenticated;
