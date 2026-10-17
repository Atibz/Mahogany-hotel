\set ON_ERROR_STOP on

-- Local-only operational test for checkout -> housekeeping -> next check-in.
-- The checkout is same-business-day so no room night is posted; this isolates
-- and verifies the room lifecycle. All fixtures are removed by rollback.
begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '63000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'checkout-turnover-rollback@test.invalid', '', now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Checkout turnover test GM"}', now(), now()
);
insert into public.user_roles (profile_id, role_id)
select '63000000-0000-4000-8000-000000000001', id
from public.roles
where hotel_id = '00000000-0000-4000-8000-000000000001'
  and code = 'general_manager';

insert into public.stays (
  id, hotel_id, guest_id, room_id, actual_check_in_date,
  expected_check_out_date, agreed_rate_kobo, checked_in_by, notes
) values (
  'f3000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000203',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001'),
  public.hotel_business_date('00000000-0000-4000-8000-000000000001') + 1,
  6500000, '63000000-0000-4000-8000-000000000001',
  'Rollback-only checkout and turnover cycle'
);
insert into public.stay_rate_periods (stay_id, effective_from, rate_kobo, reason, approved_by)
values (
  'f3000000-0000-4000-8000-000000000001',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001'),
  6500000, 'Initial test rate', '63000000-0000-4000-8000-000000000001'
);
insert into public.guest_folios (hotel_id, stay_id, folio_number)
values (
  '00000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000001',
  'FOL-ROLLBACK-CHECKOUT-CYCLE'
);

select set_config(
  'request.jwt.claim.sub', '63000000-0000-4000-8000-000000000001', true
);
set local role authenticated;

select public.complete_departure_checkout(
  'f3000000-0000-4000-8000-000000000001', true, true, true, true,
  'Rollback-only checkout test'
) as invoice_id;

do $$
declare
  checked_out_stay public.stays;
  turnover_task public.room_turnover_tasks;
  test_invoice public.invoices;
begin
  select * into strict checked_out_stay from public.stays
  where id = 'f3000000-0000-4000-8000-000000000001';
  if checked_out_stay.status <> 'checked_out' then
    raise exception 'Checkout did not close the stay';
  end if;

  if not exists (
    select 1 from public.room_board
    where id = checked_out_stay.room_id and status = 'dirty'
  ) then
    raise exception 'Checkout did not mark the room dirty';
  end if;

  select * into strict turnover_task from public.room_turnover_tasks
  where stay_id = checked_out_stay.id and status = 'open';
  select * into strict test_invoice from public.invoices
  where folio_id = (select id from public.guest_folios where stay_id = checked_out_stay.id);
  if test_invoice.snapshot ->> 'final_balance_kobo' <> '0' then
    raise exception 'Checkout invoice snapshot is not settled';
  end if;

  perform public.complete_room_turnover(checked_out_stay.room_id, 'Rollback-only cleaning verification');

  if not exists (
    select 1 from public.room_turnover_tasks
    where id = turnover_task.id and status = 'completed' and completed_by = auth.uid()
  ) or not exists (
    select 1 from public.rooms
    where id = checked_out_stay.room_id and turnover_status = 'clean'
  ) then
    raise exception 'Housekeeping did not complete the turnover';
  end if;
end;
$$;

select public.create_walk_in_stay(
  '00000000-0000-4000-8000-000000000001',
  'Rollback Cycle Guest', null, null,
  '20000000-0000-4000-8000-000000000203',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001'),
  public.hotel_business_date('00000000-0000-4000-8000-000000000001') + 1,
  6500000
) as next_stay_id;

do $$
begin
  if not exists (
    select 1 from public.room_board
    where id = '20000000-0000-4000-8000-000000000203' and status = 'occupied'
  ) then
    raise exception 'The clean room could not be checked in to';
  end if;
  if (select count(*) from public.stays where room_id = '20000000-0000-4000-8000-000000000203' and status = 'checked_in') <> 1 then
    raise exception 'Expected exactly one active stay after check-in';
  end if;
  if (select count(*) from public.room_turnover_tasks where stay_id = 'f3000000-0000-4000-8000-000000000001' and status = 'completed') <> 1 then
    raise exception 'Completed turnover history was not retained';
  end if;
end;
$$;

select 'PASS: checkout dirties room, housekeeping releases it, and next check-in succeeds' as result;

rollback;

do $$ begin
  if exists (select 1 from auth.users where email = 'checkout-turnover-rollback@test.invalid')
     or exists (select 1 from public.stays where id = 'f3000000-0000-4000-8000-000000000001')
     or exists (select 1 from public.guests where full_name = 'Rollback Cycle Guest')
     or exists (select 1 from public.invoices where snapshot ->> 'folio_number' = 'FOL-ROLLBACK-CHECKOUT-CYCLE') then
    raise exception 'Checkout/turnover rollback left test fixtures behind';
  end if;
end $$;
