-- Manual night audit always uses the hotel-controlled business date. The
-- underlying idempotent posting function remains an internal implementation.

create or replace function public.run_current_business_date_night_audit(target_hotel_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare current_business_date date;
begin
  if not public.has_hotel_permission(target_hotel_id, 'night_audit.run') then
    raise exception 'Not authorised to run nightly posting';
  end if;
  current_business_date := public.hotel_business_date(target_hotel_id);
  return public.run_nightly_room_posting(target_hotel_id, current_business_date);
end;
$$;

revoke all on function public.run_nightly_room_posting(uuid, date) from authenticated;
revoke all on function public.run_current_business_date_night_audit(uuid) from public, anon;
grant execute on function public.run_current_business_date_night_audit(uuid) to authenticated;
