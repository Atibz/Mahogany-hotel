-- Daily posted-revenue reporting is separate from payment reconciliation.
-- Room charges follow their service date. Later adjustments and reversals
-- follow their hotel-local posting date so a closed revenue day is not
-- silently rewritten by a correction performed on a later day.

insert into public.permissions (code, name, description)
values ('finance_reports.read', 'View finance reports', 'View hotel-wide posted revenue and tax reports.')
on conflict (code) do nothing;

create or replace function public.provision_finance_report_permissions(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.code = 'finance_reports.read'
  where r.hotel_id = target_hotel_id
    and r.code in ('general_manager', 'accountant')
  on conflict do nothing;
$$;

select public.provision_finance_report_permissions(id) from public.hotels;

create or replace function public.handle_hotel_finance_report_permission_provisioning()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_finance_report_permissions(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzz_hotel_finance_report_permission on public.hotels;
create trigger zzzzzz_hotel_finance_report_permission
after insert on public.hotels
for each row execute function public.handle_hotel_finance_report_permission_provisioning();

create or replace function public.get_daily_revenue_by_department(
  target_hotel_id uuid,
  target_business_date date default null
)
returns table (
  report_date date,
  department_code text,
  item_count bigint,
  base_amount_kobo bigint,
  tax_amount_kobo bigint,
  service_charge_amount_kobo bigint,
  total_amount_kobo bigint
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  hotel_timezone text;
  report_date_value date;
begin
  if not public.has_hotel_permission(target_hotel_id, 'finance_reports.read') then
    raise exception 'Not authorised to view finance reports';
  end if;

  select h.timezone into hotel_timezone
  from public.hotels h where h.id = target_hotel_id;
  if hotel_timezone is null then raise exception 'Hotel not found'; end if;
  report_date_value := coalesce(target_business_date, public.hotel_business_date(target_hotel_id));

  return query
  select
    report_date_value,
    coalesce(nullif(trim(fi.department_code), ''), 'unassigned'),
    count(*),
    coalesce(sum(fi.base_amount_kobo), 0)::bigint,
    coalesce(sum(fi.tax_amount_kobo), 0)::bigint,
    coalesce(sum(fi.service_charge_amount_kobo), 0)::bigint,
    coalesce(sum(fi.total_amount_kobo), 0)::bigint
  from public.folio_items fi
  where fi.hotel_id = target_hotel_id
    and fi.status = 'posted'
    and case
      when fi.item_type in ('adjustment', 'reversal')
        then (fi.posted_at at time zone hotel_timezone)::date
      else coalesce(fi.service_date, (fi.posted_at at time zone hotel_timezone)::date)
    end = report_date_value
  group by coalesce(nullif(trim(fi.department_code), ''), 'unassigned')
  order by coalesce(sum(fi.total_amount_kobo), 0) desc,
    coalesce(nullif(trim(fi.department_code), ''), 'unassigned');
end;
$$;

create or replace function public.get_daily_tax_breakdown(
  target_hotel_id uuid,
  target_business_date date default null
)
returns table (
  report_date date,
  tax_code text,
  tax_name text,
  jurisdiction text,
  amount_kobo bigint
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  hotel_timezone text;
  report_date_value date;
begin
  if not public.has_hotel_permission(target_hotel_id, 'finance_reports.read') then
    raise exception 'Not authorised to view finance reports';
  end if;

  select h.timezone into hotel_timezone
  from public.hotels h where h.id = target_hotel_id;
  if hotel_timezone is null then raise exception 'Hotel not found'; end if;
  report_date_value := coalesce(target_business_date, public.hotel_business_date(target_hotel_id));

  return query
  with report_items as (
    select fi.*
    from public.folio_items fi
    where fi.hotel_id = target_hotel_id
      and fi.status = 'posted'
      and case
        when fi.item_type in ('adjustment', 'reversal')
          then (fi.posted_at at time zone hotel_timezone)::date
        else coalesce(fi.service_date, (fi.posted_at at time zone hotel_timezone)::date)
      end = report_date_value
  )
  select
    report_date_value,
    coalesce(nullif(snapshot.value->>'code', ''), 'unclassified'),
    coalesce(nullif(snapshot.value->>'name', ''), 'Unclassified tax'),
    nullif(snapshot.value->>'jurisdiction', ''),
    coalesce(sum(
      case
        when ri.tax_amount_kobo < 0 then -abs((snapshot.value->>'amount_kobo')::bigint)
        else (snapshot.value->>'amount_kobo')::bigint
      end
    ), 0)::bigint
  from report_items ri
  cross join lateral jsonb_array_elements(ri.tax_snapshot) snapshot(value)
  where snapshot.value ? 'amount_kobo'
  group by
    coalesce(nullif(snapshot.value->>'code', ''), 'unclassified'),
    coalesce(nullif(snapshot.value->>'name', ''), 'Unclassified tax'),
    nullif(snapshot.value->>'jurisdiction', '')
  order by
    coalesce(nullif(snapshot.value->>'name', ''), 'Unclassified tax'),
    coalesce(nullif(snapshot.value->>'code', ''), 'unclassified');
end;
$$;

revoke all on function public.get_daily_revenue_by_department(uuid, date),
  public.get_daily_tax_breakdown(uuid, date),
  public.provision_finance_report_permissions(uuid),
  public.handle_hotel_finance_report_permission_provisioning()
from public, anon;

grant execute on function public.get_daily_revenue_by_department(uuid, date),
  public.get_daily_tax_breakdown(uuid, date)
to authenticated;
