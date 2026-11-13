-- Keep earlier business-date observations available for later independent review.
create function public.get_daily_operational_spot_checks(target_hotel_id uuid, date_value date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb; current_date_value date; selected_date date; historical_checks jsonb;
begin
  -- The one-argument function enforces hotel-scoped read permission and supplies current target labels.
  result := public.get_daily_operational_spot_checks(target_hotel_id);
  current_date_value := (result->>'business_date')::date;
  selected_date := coalesce(date_value, current_date_value);
  if selected_date > current_date_value then raise exception 'Future physical checks are unavailable'; end if;
  select coalesce(jsonb_agg(to_jsonb(c) order by c.submitted_at desc), '[]'::jsonb)
    into historical_checks from public.daily_operational_spot_checks c
    where c.hotel_id = target_hotel_id and c.business_date = selected_date;
  return jsonb_set(jsonb_set(result || jsonb_build_object('current_business_date', current_date_value),
    '{business_date}', to_jsonb(selected_date)), '{checks}', historical_checks);
end; $$;

revoke all on function public.get_daily_operational_spot_checks(uuid, date) from public, anon;
grant execute on function public.get_daily_operational_spot_checks(uuid, date) to authenticated;
