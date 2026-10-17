-- Management attention must not net one cashier shortage against another
-- cashier overage. Report the total absolute discrepancy for the business day.

create or replace function public.get_management_dashboard_snapshot(target_hotel_id uuid)
returns table (
  business_date date,
  outstanding_folio_kobo bigint,
  guest_credit_kobo bigint,
  held_deposit_kobo bigint,
  future_booked_room_revenue_kobo bigint,
  pending_finance_approvals bigint,
  refunds_today_count bigint,
  refunds_today_kobo bigint,
  voids_today_count bigint,
  voids_today_kobo bigint,
  cash_variance_today_kobo bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  report_date date := public.hotel_business_date(target_hotel_id);
begin
  if not public.has_hotel_permission(target_hotel_id, 'night_audit.read')
     or not public.has_hotel_permission(target_hotel_id, 'finance_reports.read') then
    raise exception 'Not authorised to view the management dashboard';
  end if;

  return query
  with folio_balances as (
    select public.folio_balance(gf.id) as balance_kobo
    from public.guest_folios gf
    where gf.hotel_id = target_hotel_id and gf.status = 'open'
  ), deposit_refunds as (
    select pr.payment_id, sum(pr.amount_kobo)::bigint as refunded_kobo
    from public.payment_refunds pr
    where pr.hotel_id = target_hotel_id
    group by pr.payment_id
  )
  select
    report_date,
    coalesce((select sum(greatest(fb.balance_kobo, 0)) from folio_balances fb), 0)::bigint,
    coalesce((select sum(greatest(-fb.balance_kobo, 0)) from folio_balances fb), 0)::bigint,
    coalesce((
      select sum(p.amount_kobo - coalesce(dr.refunded_kobo, 0))
      from public.reservation_deposits rd
      join public.payments p on p.id = rd.payment_id
      left join deposit_refunds dr on dr.payment_id = p.id
      where rd.hotel_id = target_hotel_id
        and p.status in ('completed', 'refunded')
        and not exists (
          select 1 from public.payment_allocations pa where pa.payment_id = p.id
        )
        and p.amount_kobo - coalesce(dr.refunded_kobo, 0) > 0
    ), 0)::bigint,
    coalesce((
      select sum(r.agreed_rate_kobo * (r.check_out_date - r.check_in_date))
      from public.reservations r
      where r.hotel_id = target_hotel_id
        and r.status in ('pending', 'confirmed')
        and r.check_in_date >= report_date
    ), 0)::bigint,
    (select count(*) from public.finance_approval_requests far
      where far.hotel_id = target_hotel_id and far.status in ('pending', 'approved')),
    (select count(*) from public.payment_refunds pr
      where pr.hotel_id = target_hotel_id
        and public.hotel_business_date(target_hotel_id, pr.refunded_at) = report_date),
    coalesce((select sum(pr.amount_kobo) from public.payment_refunds pr
      where pr.hotel_id = target_hotel_id
        and public.hotel_business_date(target_hotel_id, pr.refunded_at) = report_date), 0)::bigint,
    (select count(*) from public.payments p
      where p.hotel_id = target_hotel_id and p.status = 'voided'
        and public.hotel_business_date(target_hotel_id, p.voided_at) = report_date),
    coalesce((select sum(p.amount_kobo) from public.payments p
      where p.hotel_id = target_hotel_id and p.status = 'voided'
        and public.hotel_business_date(target_hotel_id, p.voided_at) = report_date), 0)::bigint,
    coalesce((select sum(abs(cs.variance_kobo)) from public.cashier_shifts cs
      where cs.hotel_id = target_hotel_id and cs.business_date = report_date
        and cs.status = 'closed'), 0)::bigint;
end;
$$;

revoke all on function public.get_management_dashboard_snapshot(uuid) from public, anon;
grant execute on function public.get_management_dashboard_snapshot(uuid) to authenticated;
