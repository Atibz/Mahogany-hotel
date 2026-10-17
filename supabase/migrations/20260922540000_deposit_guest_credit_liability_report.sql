-- Current liability reporting does not decide whether a cancelled/no-show
-- deposit is refundable or forfeited. Those deposits remain visible as an
-- action-required liability until hotel policy is confirmed and applied.

create or replace function public.get_deposit_guest_credit_liabilities(target_hotel_id uuid)
returns table (
  liability_type text,
  document_number text,
  guest_name text,
  source_status text,
  liability_status text,
  payment_method_name text,
  reference text,
  amount_kobo bigint,
  recorded_at timestamptz
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'finance_reports.read') then
    raise exception 'Not authorised to view finance reports';
  end if;

  return query
  with deposit_refunds as (
    select pr.payment_id, sum(pr.amount_kobo)::bigint as refunded_kobo
    from public.payment_refunds pr
    where pr.hotel_id = target_hotel_id
    group by pr.payment_id
  ), unallocated_deposits as (
    select
      'reservation_deposit'::text as liability_type,
      r.reservation_number as document_number,
      g.full_name as guest_name,
      r.status::text as source_status,
      case
        when p.status = 'pending_verification' then 'pending_verification'
        when r.status in ('cancelled', 'no_show') then 'action_required'
        else 'held'
      end as liability_status,
      pm.name as payment_method_name,
      p.reference,
      (p.amount_kobo - coalesce(dr.refunded_kobo, 0))::bigint as amount_kobo,
      rd.received_at as recorded_at
    from public.reservation_deposits rd
    join public.reservations r on r.id = rd.reservation_id
    join public.guests g on g.id = r.guest_id
    join public.payments p on p.id = rd.payment_id
    join public.payment_methods pm on pm.id = p.payment_method_id
    left join deposit_refunds dr on dr.payment_id = p.id
    where rd.hotel_id = target_hotel_id
      and p.status in ('completed', 'refunded', 'pending_verification')
      and not exists (
        select 1 from public.payment_allocations pa where pa.payment_id = p.id
      )
      and p.amount_kobo - coalesce(dr.refunded_kobo, 0) > 0
  ), guest_credits as (
    select
      'guest_credit'::text as liability_type,
      gf.folio_number as document_number,
      g.full_name as guest_name,
      gf.status::text as source_status,
      'credit_balance'::text as liability_status,
      null::text as payment_method_name,
      null::text as reference,
      (-public.folio_balance(gf.id))::bigint as amount_kobo,
      gf.opened_at as recorded_at
    from public.guest_folios gf
    join public.stays s on s.id = gf.stay_id
    join public.guests g on g.id = s.guest_id
    where gf.hotel_id = target_hotel_id
      and public.folio_balance(gf.id) < 0
  )
  select liabilities.*
  from (
    select * from unallocated_deposits
    union all
    select * from guest_credits
  ) liabilities
  order by liabilities.liability_status, liabilities.recorded_at desc,
    liabilities.document_number;
end;
$$;

revoke all on function public.get_deposit_guest_credit_liabilities(uuid) from public, anon;
grant execute on function public.get_deposit_guest_credit_liabilities(uuid) to authenticated;
