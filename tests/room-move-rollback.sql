\set ON_ERROR_STOP on

begin;

-- Create a temporary local GM so this rollback test works after a clean reset.
insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  'e9ff7c70-1ef8-4ef2-afa5-d7a1a7350707', 'authenticated', 'authenticated',
  'room-move-rollback@test.invalid', '', now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Room move rollback test GM"}', now(), now()
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
  'f1000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000101',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001'),
  public.hotel_business_date('00000000-0000-4000-8000-000000000001') + 1,
  4500000,
  'e9ff7c70-1ef8-4ef2-afa5-d7a1a7350707',
  'Rollback-only room move test'
);

insert into public.stay_rate_periods (
  stay_id, effective_from, rate_kobo, reason, approved_by
) values (
  'f1000000-0000-4000-8000-000000000001',
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

select public.move_in_house_guest(
  'f1000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000103',
  'Rollback-only operational verification'
) as move_id;

do $$
declare
  tested_stay public.stays;
  tested_move public.stay_room_moves;
begin
  select * into strict tested_stay
  from public.stays
  where id = 'f1000000-0000-4000-8000-000000000001';

  if tested_stay.room_id <> '20000000-0000-4000-8000-000000000103'
     or tested_stay.agreed_rate_kobo <> 4500000 then
    raise exception 'Stay room/rate assertion failed';
  end if;

  select * into strict tested_move
  from public.stay_room_moves
  where stay_id = tested_stay.id;

  if tested_move.from_room_id <> '20000000-0000-4000-8000-000000000101'
     or tested_move.to_room_id <> tested_stay.room_id
     or tested_move.preserved_rate_kobo <> 4500000 then
    raise exception 'Move history assertion failed';
  end if;

  if not exists (
    select 1 from public.rooms
    where id = '20000000-0000-4000-8000-000000000101'
      and turnover_status = 'dirty'
  ) then
    raise exception 'Source-room dirty assertion failed';
  end if;

  if not exists (
    select 1 from public.room_turnover_tasks
    where stay_id = tested_stay.id
      and room_id = tested_move.from_room_id
      and status = 'open'
  ) then
    raise exception 'Turnover-task assertion failed';
  end if;

  if not exists (
    select 1 from public.activity_logs
    where action = 'stay.room_moved'
      and entity_id = tested_move.id
  ) then
    raise exception 'Audit assertion failed';
  end if;
end;
$$;

select 'PASS: room move behavior and audit evidence verified' as result;

rollback;

select count(*) as persisted_test_stays
from public.stays
where id = 'f1000000-0000-4000-8000-000000000001';
