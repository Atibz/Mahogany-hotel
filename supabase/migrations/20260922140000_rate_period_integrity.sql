-- Keep hotel business dates and rate periods consistent with the nightly-posting ledger.

create or replace function public.hotel_business_date(target_hotel_id uuid, moment timestamptz default now())
returns date
language sql
stable
security definer set search_path = public
as $$
  select (local_moment::date - case when local_moment::time < hs.business_day_cutoff_time then 1 else 0 end)
  from public.hotels h
  join public.hotel_settings hs on hs.hotel_id = h.id
  cross join lateral (select moment at time zone h.timezone as local_moment) local
  where h.id = target_hotel_id;
$$;

alter table public.stay_rate_periods
add constraint stay_rate_periods_no_overlap
exclude using gist (
  stay_id with =,
  daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
);

create or replace function public.change_stay_rate(
  target_stay_id uuid,
  effective_from_date date,
  new_rate_kobo bigint,
  change_reason text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_stay public.stays;
  previous_period_id uuid;
  previous_tax_snapshot jsonb;
  successor_start_date date;
  last_posted_date date;
  new_period_id uuid;
begin
  select * into target_stay from public.stays where id = target_stay_id for update;
  if not found then raise exception 'Stay not found'; end if;
  if not public.has_hotel_permission(target_stay.hotel_id, 'stays.rate_change') then
    raise exception 'Only management can approve stay rate changes';
  end if;
  if target_stay.status <> 'checked_in' then raise exception 'Only active stays can receive a rate change'; end if;
  if effective_from_date < public.hotel_business_date(target_stay.hotel_id) then
    raise exception 'A rate change cannot take effect before the current hotel business date';
  end if;
  if effective_from_date >= target_stay.expected_check_out_date then
    raise exception 'New rate must start before checkout';
  end if;
  if new_rate_kobo < 0 then raise exception 'Rate cannot be negative'; end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for a rate change'; end if;

  select max(service_date) into last_posted_date
  from public.room_night_posts
  where stay_id = target_stay_id;
  if last_posted_date is not null and effective_from_date <= last_posted_date then
    raise exception 'A rate change cannot alter a night that has already posted';
  end if;

  select id, tax_rule_snapshot into previous_period_id, previous_tax_snapshot
  from public.stay_rate_periods
  where stay_id = target_stay_id
    and effective_from <= effective_from_date
    and (effective_to is null or effective_to >= effective_from_date)
  order by effective_from desc
  limit 1
  for update;
  if previous_period_id is null then raise exception 'No existing rate period covers this date'; end if;

  select min(effective_from) into successor_start_date
  from public.stay_rate_periods
  where stay_id = target_stay_id and effective_from > effective_from_date;

  update public.stay_rate_periods
  set effective_to = effective_from_date - 1
  where id = previous_period_id;

  insert into public.stay_rate_periods (
    stay_id, effective_from, effective_to, rate_kobo, tax_rule_snapshot, reason, approved_by
  ) values (
    target_stay_id, effective_from_date,
    case when successor_start_date is null then null else successor_start_date - 1 end,
    new_rate_kobo, coalesce(previous_tax_snapshot, '[]'::jsonb), trim(change_reason), auth.uid()
  ) returning id into new_period_id;

  perform public.log_activity(target_stay.hotel_id, 'stay.rate_changed', 'stay', target_stay_id,
    jsonb_build_object(
      'effective_from', effective_from_date,
      'new_rate_kobo', new_rate_kobo,
      'last_posted_date', last_posted_date,
      'approved_by', auth.uid(),
      'reason', trim(change_reason)
    )
  );
  return new_period_id;
end;
$$;

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
    when exists (select 1 from public.stays s where s.room_id = r.id and s.status = 'checked_in') then 'occupied'
    when exists (
      select 1 from public.reservations rv
      where rv.room_id = r.id
        and rv.status in ('pending', 'confirmed')
        and daterange(rv.check_in_date, rv.check_out_date, '[)') @> public.hotel_business_date(r.hotel_id)
    ) then 'reserved'
    else 'available'
  end as status,
  rt.size_sqft,
  rt.capacity
from public.rooms r
join public.room_types rt on rt.id = r.room_type_id;

alter view public.room_board set (security_invoker = true);

revoke all on function public.hotel_business_date(uuid, timestamptz) from public;
grant execute on function public.hotel_business_date(uuid, timestamptz) to authenticated;
revoke all on function public.change_stay_rate(uuid, date, bigint, text) from public;
grant execute on function public.change_stay_rate(uuid, date, bigint, text) to authenticated;
