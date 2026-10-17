-- Configurable operational policy. Defaults are conservative and create no fees.

alter table public.hotel_settings
  add column if not exists early_check_in_policy text not null default 'manager_override'
    check (early_check_in_policy in ('disabled', 'manager_override', 'allow_no_charge')),
  add column if not exists late_checkout_policy text not null default 'manager_override'
    check (late_checkout_policy in ('disabled', 'manager_override', 'allow_no_charge')),
  add column if not exists early_departure_policy text not null default 'manager_review'
    check (early_departure_policy in ('manager_review', 'allow_no_penalty')),
  add column if not exists extra_night_policy text not null default 'standard_stay_rate'
    check (extra_night_policy in ('standard_stay_rate', 'manager_rate_approval')),
  add column if not exists stay_policy_notes text;

create or replace function public.update_stay_lifecycle_policy(
  target_hotel_id uuid,
  check_in_time_value time,
  check_out_time_value time,
  early_check_in_policy_value text,
  late_checkout_policy_value text,
  early_departure_policy_value text,
  extra_night_policy_value text,
  policy_notes_value text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'settings.manage') then
    raise exception 'Not authorised to manage hotel policy';
  end if;
  if check_in_time_value is null or check_out_time_value is null then
    raise exception 'Standard check-in and checkout times are required';
  end if;
  if early_check_in_policy_value not in ('disabled', 'manager_override', 'allow_no_charge') then
    raise exception 'Invalid early check-in policy';
  end if;
  if late_checkout_policy_value not in ('disabled', 'manager_override', 'allow_no_charge') then
    raise exception 'Invalid late checkout policy';
  end if;
  if early_departure_policy_value not in ('manager_review', 'allow_no_penalty') then
    raise exception 'Invalid early-departure policy';
  end if;
  if extra_night_policy_value not in ('standard_stay_rate', 'manager_rate_approval') then
    raise exception 'Invalid extra-night policy';
  end if;

  update public.hotel_settings
  set standard_check_in_time = check_in_time_value,
      standard_check_out_time = check_out_time_value,
      early_check_in_policy = early_check_in_policy_value,
      late_checkout_policy = late_checkout_policy_value,
      early_departure_policy = early_departure_policy_value,
      extra_night_policy = extra_night_policy_value,
      stay_policy_notes = nullif(trim(policy_notes_value), '')
  where hotel_id = target_hotel_id;

  if not found then raise exception 'Hotel settings not found'; end if;

  perform public.log_activity(
    target_hotel_id,
    'settings.stay_lifecycle_policy_updated',
    'hotel_settings',
    target_hotel_id,
    jsonb_build_object(
      'standard_check_in_time', check_in_time_value,
      'standard_check_out_time', check_out_time_value,
      'early_check_in_policy', early_check_in_policy_value,
      'late_checkout_policy', late_checkout_policy_value,
      'early_departure_policy', early_departure_policy_value,
      'extra_night_policy', extra_night_policy_value,
      'notes', nullif(trim(policy_notes_value), '')
    )
  );
end;
$$;

revoke all on function public.update_stay_lifecycle_policy(
  uuid, time, time, text, text, text, text, text
) from public, anon;
grant execute on function public.update_stay_lifecycle_policy(
  uuid, time, time, text, text, text, text, text
) to authenticated;
