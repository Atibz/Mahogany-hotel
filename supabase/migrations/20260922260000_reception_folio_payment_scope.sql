-- Reception may serve a selected guest folio without receiving hotel-wide
-- payment, receipt, invoice, or night-audit access.

create or replace function public.get_folio_payment_history(target_folio_id uuid)
returns table (
  payment_id uuid,
  payment_number text,
  amount_kobo bigint,
  allocated_amount_kobo bigint,
  status public.payment_status,
  reference text,
  received_at timestamptz,
  payment_method_name text,
  receipt_number text,
  receipt_voided_at timestamptz,
  refunds jsonb
)
language plpgsql
security definer set search_path = public
as $$
declare target_hotel_id uuid;
begin
  select hotel_id into target_hotel_id from public.guest_folios where id = target_folio_id;
  if target_hotel_id is null then raise exception 'Folio not found'; end if;
  if not public.has_hotel_permission(target_hotel_id, 'folios.read') then raise exception 'Not authorised to view this folio'; end if;

  return query
  select
    p.id, p.payment_number, p.amount_kobo, pa.amount_kobo, p.status, p.reference, p.received_at,
    pm.name, r.receipt_number, r.voided_at,
    coalesce(jsonb_agg(jsonb_build_object(
      'id', pr.id, 'refund_number', pr.refund_number, 'amount_kobo', pr.amount_kobo,
      'reason', pr.reason, 'refunded_at', pr.refunded_at
    ) order by pr.refunded_at) filter (where pr.id is not null), '[]'::jsonb)
  from public.payment_allocations pa
  join public.payments p on p.id = pa.payment_id
  join public.payment_methods pm on pm.id = p.payment_method_id
  left join public.receipts r on r.payment_id = p.id
  left join public.payment_refunds pr on pr.payment_id = p.id
  where pa.folio_id = target_folio_id
  group by p.id, pa.amount_kobo, pm.name, r.receipt_number, r.voided_at
  order by max(pa.created_at) desc;
end;
$$;

create or replace function public.enforce_standard_role_separation(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  delete from public.role_permissions rp
  using public.roles r, public.permissions p
  where rp.role_id = r.id and rp.permission_id = p.id
    and r.hotel_id = target_hotel_id
    and (
      (r.code = 'receptionist' and p.code in ('payments.read', 'receipts.read', 'invoices.read', 'night_audit.run'))
      or (r.code = 'cashier' and p.code = 'night_audit.run')
    );
$$;

select public.enforce_standard_role_separation(id) from public.hotels;

create or replace function public.handle_hotel_role_separation_enforcement()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.enforce_standard_role_separation(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzz_hotel_role_separation on public.hotels;
create trigger zzzzzz_hotel_role_separation
after insert on public.hotels
for each row execute function public.handle_hotel_role_separation_enforcement();

revoke all on function public.get_folio_payment_history(uuid) from public, anon;
revoke all on function public.enforce_standard_role_separation(uuid), public.handle_hotel_role_separation_enforcement() from public, anon, authenticated;
grant execute on function public.get_folio_payment_history(uuid) to authenticated;
