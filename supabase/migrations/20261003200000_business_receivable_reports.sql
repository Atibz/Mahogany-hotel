-- Read-only debtor ageing and company statements for Owner, GM, and Accountant.

create or replace function public.get_business_receivable_ageing(
  target_hotel_id uuid,
  target_as_of_date date default null
)
returns table (
  business_account_id uuid,
  account_number text,
  account_name text,
  current_kobo bigint,
  days_1_30_kobo bigint,
  days_31_60_kobo bigint,
  days_61_90_kobo bigint,
  over_90_days_kobo bigint,
  total_outstanding_kobo bigint
)
language plpgsql stable security definer set search_path = public as $$
declare as_of_date date := coalesce(target_as_of_date, public.hotel_business_date(target_hotel_id));
begin
  if not public.has_hotel_permission(target_hotel_id, 'receivables.read') then
    raise exception 'Not authorised to view debtor ageing';
  end if;

  return query
  select
    ba.id,
    ba.account_number,
    coalesce(ba.trading_name, ba.legal_name),
    coalesce(sum(o.outstanding_kobo) filter (where bar.due_date >= as_of_date), 0)::bigint,
    coalesce(sum(o.outstanding_kobo) filter (where as_of_date - bar.due_date between 1 and 30), 0)::bigint,
    coalesce(sum(o.outstanding_kobo) filter (where as_of_date - bar.due_date between 31 and 60), 0)::bigint,
    coalesce(sum(o.outstanding_kobo) filter (where as_of_date - bar.due_date between 61 and 90), 0)::bigint,
    coalesce(sum(o.outstanding_kobo) filter (where as_of_date - bar.due_date > 90), 0)::bigint,
    coalesce(sum(o.outstanding_kobo), 0)::bigint
  from public.business_accounts ba
  join public.business_account_receivables bar on bar.business_account_id = ba.id and bar.status <> 'voided'
  cross join lateral (select public.business_receivable_outstanding(bar.id) as outstanding_kobo) o
  where ba.hotel_id = target_hotel_id and o.outstanding_kobo > 0
  group by ba.id, ba.account_number, ba.trading_name, ba.legal_name
  order by coalesce(sum(o.outstanding_kobo), 0) desc, coalesce(ba.trading_name, ba.legal_name);
end;
$$;

create or replace function public.get_business_account_statement(
  target_business_account_id uuid,
  target_from_date date default null,
  target_to_date date default null
)
returns table (
  entry_id uuid,
  entry_type text,
  occurred_at timestamptz,
  document_number text,
  related_document text,
  reference text,
  debit_kobo bigint,
  credit_kobo bigint,
  running_balance_kobo bigint
)
language plpgsql stable security definer set search_path = public as $$
declare target_account public.business_accounts;
begin
  select * into target_account from public.business_accounts where id = target_business_account_id;
  if not found then raise exception 'Business account not found'; end if;
  if not public.has_hotel_permission(target_account.hotel_id, 'receivables.read') then
    raise exception 'Not authorised to view this company statement';
  end if;
  if target_from_date is not null and target_to_date is not null and target_from_date > target_to_date then
    raise exception 'Statement start date cannot be after end date';
  end if;

  return query
  with entries as (
    select
      a.id as entry_id,
      'receivable'::text as entry_type,
      a.allocated_at as occurred_at,
      bar.receivable_number as document_number,
      coalesce(i.invoice_number, gf.folio_number) as related_document,
      a.reason as reference,
      a.amount_kobo::bigint as debit_kobo,
      0::bigint as credit_kobo
    from public.business_account_receivable_allocations a
    join public.business_account_receivables bar on bar.id = a.receivable_id
    join public.guest_folios gf on gf.id = bar.folio_id
    left join public.invoices i on i.id = bar.invoice_id
    where bar.business_account_id = target_account.id and bar.status <> 'voided'

    union all

    select
      rp.id,
      'payment'::text,
      p.received_at,
      p.payment_number,
      bar.receivable_number,
      p.reference,
      0::bigint,
      rp.amount_kobo::bigint
    from public.business_account_receivable_payments rp
    join public.business_account_receivables bar on bar.id = rp.receivable_id
    join public.payments p on p.id = rp.payment_id
    where bar.business_account_id = target_account.id and p.status in ('completed', 'refunded')

    union all

    select
      pr.id,
      'refund'::text,
      pr.refunded_at,
      pr.refund_number,
      bar.receivable_number,
      pr.reference,
      pr.amount_kobo::bigint,
      0::bigint
    from public.business_account_receivable_payments rp
    join public.business_account_receivables bar on bar.id = rp.receivable_id
    join public.payment_refunds pr on pr.payment_id = rp.payment_id
    where bar.business_account_id = target_account.id
  ), balanced as (
    select e.*,
      sum(e.debit_kobo - e.credit_kobo) over (order by e.occurred_at, e.entry_id rows unbounded preceding)::bigint as running_balance_kobo
    from entries e
  )
  select
    b.entry_id, b.entry_type, b.occurred_at, b.document_number, b.related_document,
    b.reference, b.debit_kobo, b.credit_kobo, b.running_balance_kobo
  from balanced b
  where (target_from_date is null or b.occurred_at::date >= target_from_date)
    and (target_to_date is null or b.occurred_at::date <= target_to_date)
  order by b.occurred_at, b.entry_id;
end;
$$;

revoke all on function public.get_business_receivable_ageing(uuid, date),
  public.get_business_account_statement(uuid, date, date) from public, anon;
grant execute on function public.get_business_receivable_ageing(uuid, date),
  public.get_business_account_statement(uuid, date, date) to authenticated;
