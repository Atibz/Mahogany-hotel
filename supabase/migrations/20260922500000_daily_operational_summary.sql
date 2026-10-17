-- A management-only summary for the current hotel business date. This is
-- read-only and distinguishes scheduled activity from completed activity.

create or replace function public.get_daily_operational_summary(target_hotel_id uuid)
returns table (
  business_date date,
  scheduled_arrivals bigint,
  checked_in_arrivals bigint,
  scheduled_departures bigint,
  checked_out_departures bigint,
  in_house_guests bigint,
  room_charge_posted_kobo bigint,
  night_audit_status text,
  night_audit_posts_created integer,
  night_audit_finished_at timestamptz
)
language plpgsql
stable
security definer set search_path = public
as $$
declare report_date date := public.hotel_business_date(target_hotel_id);
begin
  if not public.has_hotel_permission(target_hotel_id, 'night_audit.read') then
    raise exception 'Not authorised to view the daily operational summary';
  end if;

  return query
  select
    report_date,
    (select count(*) from public.reservations r
     where r.hotel_id = target_hotel_id and r.check_in_date = report_date
       and r.status in ('pending', 'confirmed')),
    (select count(*) from public.stays s
     where s.hotel_id = target_hotel_id and s.actual_check_in_date = report_date),
    (select count(*) from public.stays s
     where s.hotel_id = target_hotel_id and s.expected_check_out_date = report_date
       and s.status = 'checked_in'),
    (select count(*) from public.stays s
     where s.hotel_id = target_hotel_id and s.actual_check_out_date = report_date),
    (select count(*) from public.stays s
     where s.hotel_id = target_hotel_id and s.status = 'checked_in'),
    (select coalesce(sum(fi.total_amount_kobo), 0)::bigint
     from public.room_night_posts rnp
     join public.folio_items fi on fi.id = rnp.folio_item_id
     where rnp.hotel_id = target_hotel_id and rnp.service_date = report_date
       and fi.status = 'posted'),
    (select npr.status::text from public.nightly_posting_runs npr
     where npr.hotel_id = target_hotel_id and npr.service_date = report_date),
    (select npr.posts_created from public.nightly_posting_runs npr
     where npr.hotel_id = target_hotel_id and npr.service_date = report_date),
    (select npr.finished_at from public.nightly_posting_runs npr
     where npr.hotel_id = target_hotel_id and npr.service_date = report_date);
end;
$$;

revoke all on function public.get_daily_operational_summary(uuid) from public, anon;
grant execute on function public.get_daily_operational_summary(uuid) to authenticated;
