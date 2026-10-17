-- Night audit must charge every night a guest actually remains checked in,
-- including nights after the planned checkout date. Missing historical nights
-- are caught up, while room_night_posts(stay_id, service_date) remains the
-- idempotency boundary that prevents double charging.

create or replace function public.post_occupied_room_night_for_audit(
  target_stay_id uuid,
  target_service_date date
)
returns table (night_post_id uuid, folio_item_id uuid, created boolean)
language plpgsql
security definer set search_path = public
as $$
declare
  target_stay public.stays;
  planned_checkout_date date;
begin
  select * into target_stay
  from public.stays
  where id = target_stay_id
  for update;

  if not found then raise exception 'Stay not found'; end if;
  if target_stay.status <> 'checked_in' then
    raise exception 'Only active stays may receive room-night charges';
  end if;
  if target_service_date < target_stay.actual_check_in_date
     or target_service_date > public.hotel_business_date(target_stay.hotel_id) then
    raise exception 'Service date is outside the occupied stay period';
  end if;

  planned_checkout_date := target_stay.expected_check_out_date;

  -- post_room_night historically used the planned checkout as its upper bound.
  -- Extend it only inside this locked transaction when posting a confirmed
  -- overstay night, then immediately restore the guest's planned departure so
  -- the overdue alert and operational record remain accurate.
  if target_service_date >= planned_checkout_date then
    update public.stays
    set expected_check_out_date = target_service_date + 1
    where id = target_stay.id;
  end if;

  return query
  select result.night_post_id, result.folio_item_id, result.created
  from public.post_room_night(target_stay.id, target_service_date) result;

  if target_service_date >= planned_checkout_date then
    update public.stays
    set expected_check_out_date = planned_checkout_date
    where id = target_stay.id;
  end if;
end;
$$;

create or replace function public.run_nightly_room_posting(
  target_hotel_id uuid,
  target_service_date date
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  stay_record record;
  date_to_post date;
  post_result record;
  created_count integer := 0;
begin
  if auth.uid() is not null
     and not public.has_hotel_permission(target_hotel_id, 'night_audit.run') then
    raise exception 'Not authorised to run nightly posting';
  end if;
  if target_service_date > public.hotel_business_date(target_hotel_id) then
    raise exception 'Night audit cannot post a future business date';
  end if;

  insert into public.nightly_posting_runs (hotel_id, service_date, initiated_by)
  values (target_hotel_id, target_service_date, auth.uid())
  on conflict (hotel_id, service_date) do update
  set status = 'running', started_at = now(), finished_at = null,
      posts_created = 0, error_detail = null;

  for stay_record in
    select s.id, s.actual_check_in_date
    from public.stays s
    where s.hotel_id = target_hotel_id
      and s.status = 'checked_in'
      and s.actual_check_in_date <= target_service_date
    order by s.actual_check_in_date, s.id
  loop
    date_to_post := stay_record.actual_check_in_date;
    while date_to_post <= target_service_date loop
      select * into post_result
      from public.post_occupied_room_night_for_audit(stay_record.id, date_to_post);
      if post_result.created then created_count := created_count + 1; end if;
      date_to_post := date_to_post + 1;
    end loop;
  end loop;

  update public.nightly_posting_runs
  set status = 'completed', posts_created = created_count, finished_at = now()
  where hotel_id = target_hotel_id and service_date = target_service_date;

  perform public.log_activity(
    target_hotel_id,
    'night_audit.completed',
    'nightly_posting_run',
    null,
    jsonb_build_object(
      'service_date', target_service_date,
      'room_nights_created', created_count,
      'includes_missing_night_catchup', true
    )
  );
  return created_count;
exception when others then
  update public.nightly_posting_runs
  set status = 'failed', error_detail = sqlerrm, finished_at = now()
  where hotel_id = target_hotel_id and service_date = target_service_date;
  raise;
end;
$$;

revoke all on function public.post_occupied_room_night_for_audit(uuid, date)
  from public, anon, authenticated;
