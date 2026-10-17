-- Decision-focused management dashboard. Earned revenue, cash movement, and
-- future booked revenue remain separate so management is not shown misleading
-- totals assembled from all open folios.

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
    coalesce((select sum(cs.variance_kobo) from public.cashier_shifts cs
      where cs.hotel_id = target_hotel_id and cs.business_date = report_date
        and cs.status = 'closed'), 0)::bigint;
end;
$$;

create or replace function public.get_management_dashboard_trend(
  target_hotel_id uuid,
  target_days integer default 7
)
returns table (
  business_date date,
  active_room_count bigint,
  occupied_room_count bigint,
  occupancy_basis_points integer,
  arrivals bigint,
  departures bigint,
  no_shows bigint,
  room_revenue_kobo bigint,
  total_revenue_kobo bigint,
  net_collected_kobo bigint,
  refunds_kobo bigint,
  voided_kobo bigint,
  approved_discount_kobo bigint,
  cash_variance_kobo bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  current_business_date date := public.hotel_business_date(target_hotel_id);
  hotel_timezone text;
  day_count integer := least(greatest(coalesce(target_days, 7), 2), 31);
begin
  if not public.has_hotel_permission(target_hotel_id, 'night_audit.read')
     or not public.has_hotel_permission(target_hotel_id, 'finance_reports.read') then
    raise exception 'Not authorised to view management trends';
  end if;
  select h.timezone into hotel_timezone from public.hotels h where h.id = target_hotel_id;
  if hotel_timezone is null then raise exception 'Hotel not found'; end if;

  return query
  with dates as (
    select generate_series(
      current_business_date - (day_count - 1),
      current_business_date,
      interval '1 day'
    )::date as report_date
  ), daily as (
    select
      d.report_date,
      (select count(*) from public.rooms r
        where r.hotel_id = target_hotel_id and r.active) as active_rooms,
      case when d.report_date = current_business_date then
        (select count(*) from public.stays s
          where s.hotel_id = target_hotel_id and s.status = 'checked_in')
      else
        (select count(distinct rnp.stay_id) from public.room_night_posts rnp
          where rnp.hotel_id = target_hotel_id and rnp.service_date = d.report_date)
      end as occupied_rooms,
      (select count(*) from public.stays s
        where s.hotel_id = target_hotel_id and s.actual_check_in_date = d.report_date) as arrival_count,
      (select count(*) from public.stays s
        where s.hotel_id = target_hotel_id and s.actual_check_out_date = d.report_date) as departure_count,
      (select count(*) from public.reservations r
        where r.hotel_id = target_hotel_id and r.check_in_date = d.report_date
          and r.status = 'no_show') as no_show_count,
      coalesce((select sum(fi.total_amount_kobo) from public.folio_items fi
        where fi.hotel_id = target_hotel_id and fi.status = 'posted'
          and fi.item_type = 'room_charge'
          and coalesce(fi.service_date, (fi.posted_at at time zone hotel_timezone)::date) = d.report_date), 0)::bigint as room_revenue,
      coalesce((select sum(fi.total_amount_kobo) from public.folio_items fi
        where fi.hotel_id = target_hotel_id and fi.status = 'posted'
          and case when fi.item_type in ('adjustment', 'reversal')
            then (fi.posted_at at time zone hotel_timezone)::date
            else coalesce(fi.service_date, (fi.posted_at at time zone hotel_timezone)::date)
          end = d.report_date), 0)::bigint as total_revenue,
      coalesce((select sum(p.amount_kobo) from public.payments p
        where p.hotel_id = target_hotel_id and p.status in ('completed', 'refunded')
          and public.hotel_business_date(target_hotel_id, p.received_at) = d.report_date), 0)::bigint
        - coalesce((select sum(pr.amount_kobo) from public.payment_refunds pr
          where pr.hotel_id = target_hotel_id
            and public.hotel_business_date(target_hotel_id, pr.refunded_at) = d.report_date), 0)::bigint as net_collected,
      coalesce((select sum(pr.amount_kobo) from public.payment_refunds pr
        where pr.hotel_id = target_hotel_id
          and public.hotel_business_date(target_hotel_id, pr.refunded_at) = d.report_date), 0)::bigint as refunds,
      coalesce((select sum(p.amount_kobo) from public.payments p
        where p.hotel_id = target_hotel_id and p.status = 'voided'
          and public.hotel_business_date(target_hotel_id, p.voided_at) = d.report_date), 0)::bigint as voided,
      coalesce((select sum(
        ((far.payload ->> 'standard_rate_kobo')::bigint
          - (far.payload ->> 'requested_rate_kobo')::bigint)
        * greatest(r.check_out_date - r.check_in_date, 1)
      ) from public.finance_approval_requests far
        join public.reservations r on r.id = far.target_entity_id
        where far.hotel_id = target_hotel_id
          and far.action_type = 'reservation_discount'
          and far.status = 'executed'
          and public.hotel_business_date(target_hotel_id, far.executed_at) = d.report_date), 0)::bigint as approved_discount,
      coalesce((select sum(cs.variance_kobo) from public.cashier_shifts cs
        where cs.hotel_id = target_hotel_id and cs.business_date = d.report_date
          and cs.status = 'closed'), 0)::bigint as cash_variance
    from dates d
  )
  select
    daily.report_date,
    daily.active_rooms,
    daily.occupied_rooms,
    case when daily.active_rooms = 0 then 0
      else round(daily.occupied_rooms::numeric * 10000 / daily.active_rooms)::integer end,
    daily.arrival_count,
    daily.departure_count,
    daily.no_show_count,
    daily.room_revenue,
    daily.total_revenue,
    daily.net_collected,
    daily.refunds,
    daily.voided,
    daily.approved_discount,
    daily.cash_variance
  from daily
  order by daily.report_date;
end;
$$;

revoke all on function public.get_management_dashboard_snapshot(uuid),
  public.get_management_dashboard_trend(uuid, integer)
from public, anon;
grant execute on function public.get_management_dashboard_snapshot(uuid),
  public.get_management_dashboard_trend(uuid, integer)
to authenticated;
