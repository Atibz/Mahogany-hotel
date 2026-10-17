-- Read-only internal balancing view. It compares actual collections and refunds
-- with recorded expenses while keeping Hotel, Restaurant, and Bar separate.
-- It does not post journals, move money, calculate tax, or label a difference profit.
create or replace function public.get_internal_collection_expense_summary(
  target_hotel_id uuid,
  from_date date,
  to_date date
)
returns table (
  department text,
  collections_received_kobo bigint,
  refunds_kobo bigint,
  net_collections_kobo bigint,
  recorded_expenses_kobo bigint,
  approved_expenses_kobo bigint,
  pending_review_expenses_kobo bigint,
  rejected_expenses_kobo bigint,
  expense_record_count bigint
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'payments.read')
    or not public.has_hotel_permission(target_hotel_id, 'expenses.read')
    or not public.has_hotel_permission(target_hotel_id, 'pos.sales.read') then
    raise exception 'Not authorised to view internal collection and expense summaries';
  end if;
  if from_date is null or to_date is null or from_date > to_date or to_date - from_date > 92 then
    raise exception 'Choose a valid report period of up to 93 days';
  end if;

  return query
  with departments(department) as (
    values ('hotel'::text), ('restaurant'::text), ('bar'::text)
  ), collection_events as (
    select 'hotel'::text as department, p.amount_kobo::bigint as received_kobo, 0::bigint as refunded_kobo
    from public.payments p
    where p.hotel_id = target_hotel_id
      and p.status in ('completed', 'refunded')
      and public.hotel_business_date(target_hotel_id, p.received_at) between from_date and to_date
    union all
    select 'hotel'::text, 0::bigint, pr.amount_kobo::bigint
    from public.payment_refunds pr
    join public.payments p on p.id = pr.payment_id
    where pr.hotel_id = target_hotel_id
      and p.hotel_id = pr.hotel_id
      and public.hotel_business_date(target_hotel_id, pr.refunded_at) between from_date and to_date
    union all
    select o.outlet_type::text, p.amount_kobo::bigint, 0::bigint
    from public.pos_order_payments p
    join public.pos_outlets o on o.id = p.outlet_id and o.hotel_id = p.hotel_id
    where p.hotel_id = target_hotel_id
      and p.status = 'completed'
      and o.outlet_type in ('restaurant', 'bar')
      and public.hotel_business_date(target_hotel_id, p.received_at) between from_date and to_date
    union all
    select o.outlet_type::text, 0::bigint, r.amount_kobo::bigint
    from public.pos_order_refunds r
    join public.pos_outlets o on o.id = r.outlet_id and o.hotel_id = r.hotel_id
    where r.hotel_id = target_hotel_id
      and o.outlet_type in ('restaurant', 'bar')
      and public.hotel_business_date(target_hotel_id, r.refunded_at) between from_date and to_date
  ), collection_totals as (
    select c.department, sum(c.received_kobo)::bigint as received_kobo,
      sum(c.refunded_kobo)::bigint as refunded_kobo
    from collection_events c
    group by c.department
  ), expense_totals as (
    select e.department,
      sum(e.amount_kobo)::bigint as recorded_kobo,
      coalesce(sum(e.amount_kobo) filter (where e.status = 'approved'), 0)::bigint as approved_kobo,
      coalesce(sum(e.amount_kobo) filter (where e.status = 'pending_review'), 0)::bigint as pending_kobo,
      coalesce(sum(e.amount_kobo) filter (where e.status = 'rejected'), 0)::bigint as rejected_kobo,
      count(*)::bigint as record_count
    from public.operating_expenses e
    where e.hotel_id = target_hotel_id and e.incurred_on between from_date and to_date
    group by e.department
  )
  select d.department,
    coalesce(c.received_kobo, 0)::bigint,
    coalesce(c.refunded_kobo, 0)::bigint,
    (coalesce(c.received_kobo, 0) - coalesce(c.refunded_kobo, 0))::bigint,
    coalesce(e.recorded_kobo, 0)::bigint,
    coalesce(e.approved_kobo, 0)::bigint,
    coalesce(e.pending_kobo, 0)::bigint,
    coalesce(e.rejected_kobo, 0)::bigint,
    coalesce(e.record_count, 0)::bigint
  from departments d
  left join collection_totals c on c.department = d.department
  left join expense_totals e on e.department = d.department
  order by case d.department when 'hotel' then 1 when 'restaurant' then 2 else 3 end;
end;
$$;

revoke all on function public.get_internal_collection_expense_summary(uuid, date, date) from public, anon;
grant execute on function public.get_internal_collection_expense_summary(uuid, date, date) to authenticated;
