-- Capture exact operational timestamps for new stay movements. Historical rows
-- remain null because their exact clock times cannot be reconstructed safely.

alter table public.stays
  add column if not exists actual_check_in_at timestamptz,
  add column if not exists actual_check_out_at timestamptz;

create index if not exists stays_hotel_check_in_at_idx
  on public.stays(hotel_id, actual_check_in_at desc)
  where actual_check_in_at is not null;
create index if not exists stays_hotel_check_out_at_idx
  on public.stays(hotel_id, actual_check_out_at desc)
  where actual_check_out_at is not null;

create or replace function public.capture_and_enforce_stay_times()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  hotel_timezone text;
  settings_record public.hotel_settings;
  local_moment timestamp;
  reservation_check_in_date date;
  is_early_check_in boolean := false;
  is_late_checkout boolean := false;
begin
  select h.timezone into hotel_timezone
  from public.hotels h
  where h.id = new.hotel_id;
  select * into settings_record
  from public.hotel_settings hs
  where hs.hotel_id = new.hotel_id;

  if hotel_timezone is null or settings_record.hotel_id is null then
    raise exception 'Hotel settings not found';
  end if;

  if tg_op = 'INSERT' and new.status = 'checked_in' then
    new.actual_check_in_at := coalesce(new.actual_check_in_at, now());
    local_moment := new.actual_check_in_at at time zone hotel_timezone;

    if new.reservation_id is not null then
      select check_in_date into reservation_check_in_date
      from public.reservations
      where id = new.reservation_id;

      is_early_check_in := reservation_check_in_date = local_moment::date
        and settings_record.standard_check_in_time is not null
        and local_moment::time < settings_record.standard_check_in_time;
    end if;

    if is_early_check_in then
      if settings_record.early_check_in_policy in ('disabled', 'manager_override')
         and not public.has_hotel_permission(new.hotel_id, 'settings.manage') then
        raise exception 'Early check-in requires Owner or GM approval';
      end if;

      perform public.log_activity(
        new.hotel_id,
        'stay.early_check_in_recorded',
        'stay',
        new.id,
        jsonb_build_object(
          'actual_check_in_at', new.actual_check_in_at,
          'standard_check_in_time', settings_record.standard_check_in_time,
          'policy', settings_record.early_check_in_policy,
          'approved_by', case
            when public.has_hotel_permission(new.hotel_id, 'settings.manage') then auth.uid()
            else null
          end
        )
      );
    end if;
  end if;

  if tg_op = 'UPDATE'
     and old.status = 'checked_in'
     and new.status = 'checked_out' then
    new.actual_check_out_at := coalesce(new.actual_check_out_at, now());
    local_moment := new.actual_check_out_at at time zone hotel_timezone;
    is_late_checkout := new.actual_check_out_date = old.expected_check_out_date
      and settings_record.standard_check_out_time is not null
      and local_moment::time > settings_record.standard_check_out_time;

    if is_late_checkout then
      if settings_record.late_checkout_policy in ('disabled', 'manager_override')
         and not public.has_hotel_permission(new.hotel_id, 'settings.manage') then
        raise exception 'Late checkout requires Owner or GM approval';
      end if;

      perform public.log_activity(
        new.hotel_id,
        'stay.late_checkout_recorded',
        'stay',
        new.id,
        jsonb_build_object(
          'actual_check_out_at', new.actual_check_out_at,
          'standard_check_out_time', settings_record.standard_check_out_time,
          'policy', settings_record.late_checkout_policy,
          'approved_by', case
            when public.has_hotel_permission(new.hotel_id, 'settings.manage') then auth.uid()
            else null
          end
        )
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists capture_and_enforce_stay_times on public.stays;
create trigger capture_and_enforce_stay_times
before insert or update of status, actual_check_out_date on public.stays
for each row execute function public.capture_and_enforce_stay_times();

revoke all on function public.capture_and_enforce_stay_times()
from public, anon, authenticated;
