-- Final folio preparation is an explicit, idempotent step. It commits any
-- missing occupied room nights before Reception collects the final payment.

create or replace function public.prepare_departure_folio(target_stay_id uuid)
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare
  target_stay public.stays;
  target_folio_id uuid;
  date_to_post date;
  through_date date;
  created_count integer := 0;
  post_result record;
  final_balance bigint;
begin
  select * into target_stay from public.stays where id = target_stay_id for update;
  if not found then raise exception 'Stay not found'; end if;
  if not public.has_hotel_permission(target_stay.hotel_id, 'departures.checkout') then
    raise exception 'Not authorised to prepare a departure folio';
  end if;
  if target_stay.status <> 'checked_in' then
    raise exception 'Only an active stay can be prepared for checkout';
  end if;

  select gf.id into target_folio_id
  from public.guest_folios gf
  where gf.stay_id = target_stay.id and gf.status = 'open'
  for update;
  if target_folio_id is null then raise exception 'Open folio not found'; end if;

  through_date := public.hotel_business_date(target_stay.hotel_id);
  date_to_post := target_stay.actual_check_in_date;
  while date_to_post <= through_date loop
    select * into post_result
    from public.post_occupied_room_night_for_audit(target_stay.id, date_to_post);
    if post_result.created then created_count := created_count + 1; end if;
    date_to_post := date_to_post + 1;
  end loop;

  final_balance := public.folio_balance(target_folio_id);
  perform public.log_activity(
    target_stay.hotel_id,
    'stay.departure_folio_prepared',
    'stay',
    target_stay.id,
    jsonb_build_object(
      'folio_id', target_folio_id,
      'through_business_date', through_date,
      'room_nights_created', created_count,
      'balance_kobo', final_balance
    )
  );
  return final_balance;
end;
$$;

revoke all on function public.prepare_departure_folio(uuid) from public, anon;
grant execute on function public.prepare_departure_folio(uuid) to authenticated;

