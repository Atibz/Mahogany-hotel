-- A completed daily close advances the hotel's operating date immediately.
-- Timestamp classification remains based on the physical hotel calendar so
-- historical payments, refunds, and corrections cannot move between reports.

alter function public.hotel_business_date(uuid, timestamptz)
  rename to hotel_calendar_business_date;

create function public.hotel_business_date(
  target_hotel_id uuid,
  moment timestamptz
)
returns date
language sql
stable
security definer set search_path = public
as $$
  select public.hotel_calendar_business_date(target_hotel_id, moment);
$$;

create or replace function public.hotel_business_date(target_hotel_id uuid)
returns date
language sql
stable
security definer set search_path = public
as $$
  select greatest(
    public.hotel_business_date(target_hotel_id, now()),
    (
      select max(bdc.business_date) + 1
      from public.business_day_closes bdc
      where bdc.hotel_id = target_hotel_id
    )
  );
$$;

-- room_board was compiled before the exact one-argument overload existed.
-- Recreate it so its current-day reservation state follows the operating date.
create or replace view public.room_board as
select
  r.id,
  r.hotel_id,
  r.room_number,
  r.room_type_id,
  rt.name as room_type_name,
  coalesce(r.rate_override_kobo, rt.base_rate_kobo) as current_rate_kobo,
  case
    when not r.active or r.blocked_at is not null then 'blocked'
    when exists (
      select 1 from public.stays s
      where s.room_id = r.id and s.status = 'checked_in'
    ) then 'occupied'
    when r.turnover_status = 'dirty' then 'dirty'
    when exists (
      select 1 from public.reservations rv
      where rv.room_id = r.id
        and rv.status in ('pending', 'confirmed')
        and daterange(rv.check_in_date, rv.check_out_date, '[)')
          @> public.hotel_business_date(r.hotel_id)
    ) then 'reserved'
    else 'available'
  end as status,
  rt.size_sqft,
  rt.capacity,
  coalesce(
    r.blocked_reason,
    case when not r.active then 'Room is inactive' end,
    case when r.turnover_status = 'dirty' then 'Awaiting housekeeping turnover' end
  ) as blocked_reason,
  r.turnover_status,
  (r.maintenance_ticket_id is not null) as is_maintenance_out_of_service
from public.rooms r
join public.room_types rt on rt.id = r.room_type_id;

alter view public.room_board set (security_invoker = true);
grant select on public.room_board to authenticated;

-- A manually advanced operating date is not permission to post tomorrow's
-- room charges before that date is reached at the hotel's configured cutoff.
create or replace function public.run_current_business_date_night_audit(
  target_hotel_id uuid
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  operating_business_date date;
  calendar_business_date date;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required to run night audit';
  end if;
  if not public.has_hotel_permission(target_hotel_id, 'night_audit.run') then
    raise exception 'Not authorised to run night audit';
  end if;

  operating_business_date := public.hotel_business_date(target_hotel_id);
  calendar_business_date := public.hotel_business_date(target_hotel_id, now());

  if operating_business_date > calendar_business_date then
    raise exception 'The next business date has started, but its night audit is not due yet';
  end if;

  return public.run_nightly_room_posting(
    target_hotel_id,
    operating_business_date
  );
end;
$$;

-- The scheduler follows the real cutoff date. This prevents an early manual
-- close from causing the next date's audit to run during the same calendar day.
create or replace function public.run_due_scheduled_night_audits()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  hotel_record record;
  completed_count integer := 0;
begin
  for hotel_record in
    select
      h.id as hotel_id,
      public.hotel_business_date(h.id, now()) as business_date
    from public.hotels h
    join public.hotel_settings hs on hs.hotel_id = h.id
    where h.active
      and (now() at time zone h.timezone)::time >= hs.business_day_cutoff_time
    order by h.id
  loop
    if pg_try_advisory_xact_lock(
      hashtextextended(
        hotel_record.hotel_id::text || ':' || hotel_record.business_date::text,
        0
      )
    ) and not exists (
      select 1
      from public.nightly_posting_runs npr
      where npr.hotel_id = hotel_record.hotel_id
        and npr.service_date = hotel_record.business_date
        and npr.status = 'completed'
    ) then
      begin
        perform public.run_nightly_room_posting(
          hotel_record.hotel_id,
          hotel_record.business_date
        );
        completed_count := completed_count + 1;
      exception when others then
        insert into public.nightly_posting_runs (
          hotel_id,
          service_date,
          status,
          posts_created,
          started_at,
          finished_at,
          error_detail,
          initiated_by
        ) values (
          hotel_record.hotel_id,
          hotel_record.business_date,
          'failed',
          0,
          now(),
          now(),
          left(sqlerrm, 2000),
          null
        )
        on conflict (hotel_id, service_date) do update
        set status = 'failed',
            posts_created = 0,
            finished_at = now(),
            error_detail = excluded.error_detail,
            initiated_by = null;
      end;
    end if;
  end loop;

  return completed_count;
end;
$$;

revoke all on function public.hotel_business_date(uuid, timestamptz)
  from public, anon;
revoke all on function public.hotel_business_date(uuid)
  from public, anon;
revoke all on function public.hotel_calendar_business_date(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.hotel_business_date(uuid, timestamptz),
  public.hotel_business_date(uuid) to authenticated;

revoke all on function public.run_current_business_date_night_audit(uuid)
  from public, anon;
grant execute on function public.run_current_business_date_night_audit(uuid)
  to authenticated;

revoke all on function public.run_due_scheduled_night_audits()
  from public, anon, authenticated;
