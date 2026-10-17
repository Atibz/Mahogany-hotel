\set ON_ERROR_STOP on

begin;

-- Create a temporary local GM so this rollback test works after a clean reset.
insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  'e9ff7c70-1ef8-4ef2-afa5-d7a1a7350707', 'authenticated', 'authenticated',
  'stay-extension-rollback@test.invalid', '', now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Stay extension rollback test GM"}', now(), now()
);
insert into public.user_roles (profile_id, role_id)
select 'e9ff7c70-1ef8-4ef2-afa5-d7a1a7350707', id
from public.roles
where hotel_id = '00000000-0000-4000-8000-000000000001'
  and code = 'general_manager';

insert into public.stays (
  id, hotel_id, guest_id, room_id, actual_check_in_date,
  expected_check_out_date, agreed_rate_kobo, checked_in_by, notes
) values (
  'f2000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000103',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001'),
  public.hotel_business_date('00000000-0000-4000-8000-000000000001') + 1,
  4500000,
  'e9ff7c70-1ef8-4ef2-afa5-d7a1a7350707',
  'Rollback-only stay extension test'
);

insert into public.stay_rate_periods (
  stay_id, effective_from, rate_kobo, reason, approved_by
) values (
  'f2000000-0000-4000-8000-000000000001',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001'),
  4500000,
  'Initial test rate',
  'e9ff7c70-1ef8-4ef2-afa5-d7a1a7350707'
);

select set_config(
  'request.jwt.claim.sub',
  'e9ff7c70-1ef8-4ef2-afa5-d7a1a7350707',
  true
);
set local role authenticated;

-- A future booking may start on the current guest's scheduled checkout date,
-- but that booking must then prevent the guest from extending into it.
do $$
declare
  hotel_id_value uuid := '00000000-0000-4000-8000-000000000001';
  room_id_value uuid := '20000000-0000-4000-8000-000000000103';
  room_type_id_value uuid;
  business_date_value date;
  competing_reservation_id uuid;
begin
  business_date_value := public.hotel_business_date(hotel_id_value);
  select room_type_id into strict room_type_id_value
  from public.rooms where id = room_id_value;

  if exists (
    select 1 from public.search_available_rooms(
      hotel_id_value, room_type_id_value,
      business_date_value, business_date_value + 1
    ) available where available.id = room_id_value
  ) then
    raise exception 'An in-house room must not be offered for same-business-day arrival';
  end if;

  if not exists (
    select 1 from public.search_available_rooms(
      hotel_id_value, room_type_id_value,
      business_date_value + 1, business_date_value + 2
    ) available where available.id = room_id_value
  ) then
    raise exception 'Checkout-date arrival should be offered as a future room booking';
  end if;

  competing_reservation_id := public.create_reservation(
    hotel_id_value,
    '30000000-0000-4000-8000-000000000001'::uuid,
    room_type_id_value,
    room_id_value,
    business_date_value + 1,
    business_date_value + 2,
    4500000::bigint,
    1::smallint,
    0::smallint,
    0::bigint,
    'TEST ONLY',
    'Checkout-date availability regression test'
  );

  begin
    perform public.extend_in_house_stay(
      'f2000000-0000-4000-8000-000000000001',
      business_date_value + 3,
      'TEST ONLY: must conflict with checkout-date reservation',
      null
    );
    raise exception 'Stay extension unexpectedly overlapped a confirmed reservation';
  exception when raise_exception then
    if sqlerrm <> 'The room has a conflicting reservation during the extension' then
      raise;
    end if;
  end;

  perform public.cancel_reservation(competing_reservation_id, 'TEST ONLY: rollback test cleanup');
end;
$$;

select public.extend_in_house_stay(
  'f2000000-0000-4000-8000-000000000001',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001') + 3,
  'Guest requested two more nights',
  null
) as preserved_rate_extension_id;

select public.extend_in_house_stay(
  'f2000000-0000-4000-8000-000000000001',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001') + 4,
  'Guest requested one additional night at the approved extension rate',
  5000000
) as changed_rate_extension_id;

do $$
declare
  tested_stay public.stays;
begin
  select * into strict tested_stay
  from public.stays
  where id = 'f2000000-0000-4000-8000-000000000001';

  if tested_stay.expected_check_out_date <>
     public.hotel_business_date('00000000-0000-4000-8000-000000000001') + 4 then
    raise exception 'Extended checkout-date assertion failed';
  end if;

  if tested_stay.actual_check_in_at is null then
    raise exception 'Exact check-in timestamp assertion failed';
  end if;

  if (select count(*) from public.stay_extensions where stay_id = tested_stay.id) <> 2 then
    raise exception 'Extension-history assertion failed';
  end if;

  if not exists (
    select 1 from public.stay_rate_periods
    where stay_id = tested_stay.id
      and effective_from =
        public.hotel_business_date('00000000-0000-4000-8000-000000000001') + 3
      and rate_kobo = 5000000
  ) then
    raise exception 'Future extension-rate assertion failed';
  end if;

  if not exists (
    select 1 from public.stay_rate_periods
    where stay_id = tested_stay.id
      and effective_from =
        public.hotel_business_date('00000000-0000-4000-8000-000000000001')
      and effective_to =
        public.hotel_business_date('00000000-0000-4000-8000-000000000001') + 2
      and rate_kobo = 4500000
  ) then
    raise exception 'Historical-rate preservation assertion failed';
  end if;

  if (select count(*) from public.activity_logs where action = 'stay.extended'
      and metadata ->> 'stay_id' = tested_stay.id::text) <> 2 then
    raise exception 'Extension-audit assertion failed';
  end if;
end;
$$;

select 'PASS: stay extension, availability, history, future rate and audit verified' as result;

rollback;

select count(*) as persisted_test_stays
from public.stays
where id = 'f2000000-0000-4000-8000-000000000001';
