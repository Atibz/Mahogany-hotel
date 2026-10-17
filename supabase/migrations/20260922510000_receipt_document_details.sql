-- Receipt presentation needs the immutable payment record plus its current
-- audit status. This expands the existing selected-folio read model only.

drop function if exists public.get_folio_payment_history(uuid);

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
  receipt_issued_at timestamptz,
  receipt_voided_at timestamptz,
  void_reason text,
  guest_name text,
  room_number text,
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
    pm.name, r.receipt_number, r.issued_at, r.voided_at, p.void_reason,
    g.full_name, rm.room_number,
    coalesce(jsonb_agg(jsonb_build_object(
      'id', pr.id, 'refund_number', pr.refund_number, 'amount_kobo', pr.amount_kobo,
      'reason', pr.reason, 'refunded_at', pr.refunded_at
    ) order by pr.refunded_at) filter (where pr.id is not null), '[]'::jsonb)
  from public.payment_allocations pa
  join public.payments p on p.id = pa.payment_id
  join public.payment_methods pm on pm.id = p.payment_method_id
  join public.guest_folios gf on gf.id = pa.folio_id
  join public.stays s on s.id = gf.stay_id
  join public.guests g on g.id = s.guest_id
  left join public.rooms rm on rm.id = s.room_id
  left join public.receipts r on r.payment_id = p.id
  left join public.payment_refunds pr on pr.payment_id = p.id
  where pa.folio_id = target_folio_id
  group by p.id, pa.amount_kobo, pm.name, r.receipt_number, r.issued_at, r.voided_at,
    g.full_name, rm.room_number
  order by max(pa.created_at) desc;
end;
$$;

revoke all on function public.get_folio_payment_history(uuid) from public, anon;
grant execute on function public.get_folio_payment_history(uuid) to authenticated;
