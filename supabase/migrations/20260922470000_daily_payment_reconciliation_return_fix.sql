-- PostgreSQL SUM returns numeric in this report expression. Cast the public
-- function outputs to the declared bigint contract used by the application.

create or replace function public.get_daily_payment_reconciliation(target_hotel_id uuid, target_business_date date default null)
returns table (payment_method_name text, settled_kobo bigint, pending_verification_kobo bigint, refunded_kobo bigint, voided_kobo bigint, net_collected_kobo bigint)
language plpgsql stable security definer set search_path = public as $$
declare report_date date := coalesce(target_business_date, public.hotel_business_date(target_hotel_id));
begin
  if not public.has_hotel_permission(target_hotel_id, 'payments.read') then raise exception 'Not authorised to view payment reconciliation'; end if;
  return query
  with payment_totals as (
    select pm.id, pm.name,
      coalesce(sum(p.amount_kobo) filter (where p.status in ('completed', 'refunded')), 0) as settled,
      coalesce(sum(p.amount_kobo) filter (where p.status = 'pending_verification'), 0) as pending,
      coalesce(sum(p.amount_kobo) filter (where p.status = 'voided'), 0) as voided
    from public.payment_methods pm left join public.payments p on p.payment_method_id = pm.id and public.hotel_business_date(target_hotel_id, p.received_at) = report_date
    where pm.hotel_id = target_hotel_id group by pm.id, pm.name
  ), refund_totals as (
    select p.payment_method_id, coalesce(sum(pr.amount_kobo), 0) as refunded
    from public.payment_refunds pr join public.payments p on p.id = pr.payment_id
    where p.hotel_id = target_hotel_id and public.hotel_business_date(target_hotel_id, pr.refunded_at) = report_date group by p.payment_method_id
  )
  select pt.name, pt.settled::bigint, pt.pending::bigint, coalesce(rt.refunded, 0)::bigint, pt.voided::bigint,
    (pt.settled - coalesce(rt.refunded, 0))::bigint
  from payment_totals pt left join refund_totals rt on rt.payment_method_id = pt.id order by pt.name;
end; $$;

revoke all on function public.get_daily_payment_reconciliation(uuid, date) from public, anon;
grant execute on function public.get_daily_payment_reconciliation(uuid, date) to authenticated;
