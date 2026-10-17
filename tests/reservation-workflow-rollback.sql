\set ON_ERROR_STOP on

-- Local-only reservation lifecycle integration test. A temporary GM creates,
-- amends, and cancels a reservation; conflicting dates must be rejected. The
-- transaction is rolled back so no reservation or Auth fixture is retained.
begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '64000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'reservation-workflow-rollback@test.invalid', '', now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Reservation workflow rollback test GM"}', now(), now()
);

insert into public.user_roles (profile_id, role_id)
select '64000000-0000-4000-8000-000000000001', id
from public.roles
where hotel_id = '00000000-0000-4000-8000-000000000001'
  and code = 'general_manager';

select set_config(
  'request.jwt.claim.sub', '64000000-0000-4000-8000-000000000001', true
);
set local role authenticated;

do $$
declare
  hotel_id_value uuid := '00000000-0000-4000-8000-000000000001';
  guest_id_value uuid := '30000000-0000-4000-8000-000000000004';
  room_type_id_value uuid := '10000000-0000-4000-8000-000000000003';
  room_id_value uuid := '20000000-0000-4000-8000-000000000302';
  reservation_id_value uuid;
begin
  if not exists (
    select 1 from public.search_available_rooms(
      hotel_id_value, room_type_id_value, date '2040-01-01', date '2040-01-03'
    ) available where available.id = room_id_value
  ) then
    raise exception 'Test room should be available before reservation creation';
  end if;

  reservation_id_value := public.create_reservation(
    hotel_id_value, guest_id_value, room_type_id_value, room_id_value,
    date '2040-01-01', date '2040-01-03', 9500000::bigint,
    2::smallint, 0::smallint, 0::bigint,
    'ROLLBACK TEST', 'Reservation lifecycle rollback fixture'
  );

  if exists (
    select 1 from public.search_available_rooms(
      hotel_id_value, room_type_id_value, date '2040-01-02', date '2040-01-04'
    ) available where available.id = room_id_value
  ) then
    raise exception 'Availability search offered a room for overlapping dates';
  end if;

  begin
    perform public.create_reservation(
      hotel_id_value, guest_id_value, room_type_id_value, room_id_value,
      date '2040-01-02', date '2040-01-04', 9500000::bigint,
      1::smallint, 0::smallint, 0::bigint,
      'ROLLBACK TEST', 'Overlapping fixture must be rejected'
    );
    raise exception 'Overlapping reservation was unexpectedly accepted';
  exception when raise_exception then
    if sqlerrm <> 'The room is already reserved for part of those dates' then raise; end if;
  end;

  perform public.amend_reservation(
    reservation_id_value, room_type_id_value, room_id_value,
    date '2040-01-03', date '2040-01-05', 9500000::bigint,
    'Rollback test: guest changed arrival dates'
  );

  if not exists (
    select 1 from public.reservations
    where id = reservation_id_value
      and check_in_date = date '2040-01-03'
      and check_out_date = date '2040-01-05'
      and agreed_rate_kobo = 9500000
      and status = 'confirmed'
  ) then
    raise exception 'Reservation amendment did not persist expected values';
  end if;

  perform public.cancel_reservation(
    reservation_id_value, 'Rollback test: lifecycle completed'
  );

  if not exists (
    select 1 from public.reservations
    where id = reservation_id_value and status = 'cancelled'
      and notes like '%[Cancelled] Rollback test: lifecycle completed%'
  ) then
    raise exception 'Cancellation status or reason was not retained';
  end if;

  if (select count(*) from public.activity_logs
      where entity_id = reservation_id_value
        and action in ('reservation.created', 'reservation.amended', 'reservation.cancelled')) <> 3 then
    raise exception 'Expected create, amend, and cancel audit events';
  end if;

  if not exists (
    select 1 from public.search_available_rooms(
      hotel_id_value, room_type_id_value, date '2040-01-03', date '2040-01-05'
    ) available where available.id = room_id_value
  ) then
    raise exception 'Cancelled reservation did not release the room dates';
  end if;
end;
$$;

select 'PASS: reservation availability, create, overlap rejection, amend, cancel, audit, and release verified' as result;

rollback;

do $$ begin
  if exists (
       select 1 from auth.users
       where email = 'reservation-workflow-rollback@test.invalid'
     ) or exists (
       select 1 from public.reservations
       where notes like '%Reservation lifecycle rollback fixture%'
     ) then
    raise exception 'Reservation workflow rollback left test fixtures behind';
  end if;
end $$;
