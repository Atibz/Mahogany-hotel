\set ON_ERROR_STOP on

-- Local-only RBAC integration test. Run against the local Supabase database
-- with psql; every fixture is rolled back at the end.
begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('62000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'rbac-gm@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"RBAC test GM"}', now(), now()),
  ('62000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'rbac-accountant@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"RBAC test Accountant"}', now(), now()),
  ('62000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'rbac-storekeeper@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"RBAC test Storekeeper"}', now(), now()),
  ('62000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'rbac-reception@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"RBAC test Reception"}', now(), now()),
  ('62000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'rbac-owner@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"RBAC test Owner"}', now(), now());

insert into public.user_roles (profile_id, role_id)
select fixture.profile_id, role_record.id
from (values
  ('62000000-0000-4000-8000-000000000001'::uuid, 'general_manager'),
  ('62000000-0000-4000-8000-000000000002'::uuid, 'accountant'),
  ('62000000-0000-4000-8000-000000000003'::uuid, 'storekeeper'),
  ('62000000-0000-4000-8000-000000000004'::uuid, 'receptionist'),
  ('62000000-0000-4000-8000-000000000005'::uuid, 'owner')
) as fixture(profile_id, role_code)
join public.roles role_record
  on role_record.hotel_id = '00000000-0000-4000-8000-000000000001'
 and role_record.code = fixture.role_code;

insert into public.inventory_items (hotel_id, item_code, name, category, base_unit)
values ('00000000-0000-4000-8000-000000000001', 'RBAC-ACCESS-TEST', 'RBAC Access Test', 'Test', 'each');

insert into public.operating_expenses (
  hotel_id, expense_number, business_date, incurred_on, department,
  category, description, payee, amount_kobo, paid_via, submitted_by
)
values (
  '00000000-0000-4000-8000-000000000001', 'RBAC-EXP-TEST',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001'),
  current_date, 'hotel', 'Test', 'RBAC RLS test row', 'Test vendor', 100,
  'cash', '62000000-0000-4000-8000-000000000001'
);

set local role authenticated;

select set_config('request.jwt.claim.sub', '62000000-0000-4000-8000-000000000001', true);
do $$ begin
  if (select count(*) from public.inventory_items where item_code = 'RBAC-ACCESS-TEST') <> 1
     or (select count(*) from public.operating_expenses where expense_number = 'RBAC-EXP-TEST') <> 1
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'expenses.review')
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'pos.sales.create')
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'reservations.read')
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'reservations.create')
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'reservations.manage')
     or has_table_privilege(current_user, 'public.inventory_items', 'INSERT') then
    raise exception 'General Manager RBAC assertion failed';
  end if;
end $$;

-- Verify an allowed role can create a reservation through the guarded RPC.
select public.create_reservation(
  '00000000-0000-4000-8000-000000000001'::uuid,
  '30000000-0000-4000-8000-000000000001'::uuid,
  '10000000-0000-4000-8000-000000000001'::uuid,
  null::uuid,
  date '2040-01-01', date '2040-01-02', 4500000::bigint,
  1::smallint, 0::smallint, 0::bigint, 'RBAC TEST', 'Rollback-only GM reservation authorization test'
);

select set_config('request.jwt.claim.sub', '62000000-0000-4000-8000-000000000002', true);
do $$ begin
  if (select count(*) from public.inventory_items where item_code = 'RBAC-ACCESS-TEST') <> 0
     or (select count(*) from public.operating_expenses where expense_number = 'RBAC-EXP-TEST') <> 1
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'expenses.submit')
     or public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'expenses.review')
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'pos.sales.read')
     or public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'pos.sales.create')
     or public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'reservations.read')
     or public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'reservations.create')
     or public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'reservations.manage')
     or has_table_privilege(current_user, 'public.operating_expenses', 'INSERT') then
    raise exception 'Accountant RBAC assertion failed';
  end if;
end $$;

-- Verify the accountant cannot bypass the role matrix by calling the RPC.
do $$ begin
  begin
    perform public.create_reservation(
      '00000000-0000-4000-8000-000000000001'::uuid,
      '30000000-0000-4000-8000-000000000001'::uuid,
      '10000000-0000-4000-8000-000000000001'::uuid,
      null::uuid,
      date '2040-02-01', date '2040-02-02', 4500000::bigint,
      1::smallint, 0::smallint, 0::bigint, 'RBAC TEST', 'Must be rejected for accountant'
    );
    raise exception 'Accountant unexpectedly created a reservation';
  exception when raise_exception then
    if sqlerrm <> 'Not authorised to create reservations' then raise; end if;
  end;
end $$;

select set_config('request.jwt.claim.sub', '62000000-0000-4000-8000-000000000003', true);
do $$ begin
  if (select count(*) from public.inventory_items where item_code = 'RBAC-ACCESS-TEST') <> 1
     or (select count(*) from public.operating_expenses where expense_number = 'RBAC-EXP-TEST') <> 0
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'inventory.manage')
     or public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'reservations.read')
     or public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'reservations.create') then
    raise exception 'Storekeeper RBAC assertion failed';
  end if;
end $$;

do $$ begin
  begin
    perform public.get_folio_balances('00000000-0000-4000-8000-000000000001', array[]::uuid[]);
    raise exception 'Storekeeper unexpectedly read folio balances';
  exception when raise_exception then
    if sqlerrm <> 'Not authorised to view folio balances' then raise; end if;
  end;
end $$;

select set_config('request.jwt.claim.sub', '62000000-0000-4000-8000-000000000004', true);
do $$ begin
  if (select count(*) from public.inventory_items where item_code = 'RBAC-ACCESS-TEST') <> 0
     or (select count(*) from public.operating_expenses where expense_number = 'RBAC-EXP-TEST') <> 0
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'rooms.read')
     or public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'inventory.read')
     or public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'pos.sales.read')
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'reservations.read')
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'reservations.create')
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'reservations.manage')
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'stays.check_in') then
    raise exception 'Receptionist RBAC assertion failed';
  end if;
end $$;

-- Reception should also be able to use the same reservation-creation workflow.
select public.create_reservation(
  '00000000-0000-4000-8000-000000000001'::uuid,
  '30000000-0000-4000-8000-000000000001'::uuid,
  '10000000-0000-4000-8000-000000000001'::uuid,
  null::uuid,
  date '2040-03-01', date '2040-03-02', 4500000::bigint,
  1::smallint, 0::smallint, 0::bigint, 'RBAC TEST', 'Rollback-only receptionist reservation authorization test'
);

select set_config('request.jwt.claim.sub', '62000000-0000-4000-8000-000000000005', true);
do $$ begin
  if (select count(*) from public.inventory_items where item_code = 'RBAC-ACCESS-TEST') <> 1
     or (select count(*) from public.operating_expenses where expense_number = 'RBAC-EXP-TEST') <> 1
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'inventory.manage')
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'expenses.review')
     or not public.has_hotel_permission('00000000-0000-4000-8000-000000000001', 'reservations.create') then
    raise exception 'Owner RBAC assertion failed';
  end if;
end $$;

rollback;

do $$ begin
  if exists (select 1 from auth.users where email like 'rbac-%@test.invalid')
     or exists (select 1 from public.inventory_items where item_code = 'RBAC-ACCESS-TEST')
     or exists (select 1 from public.operating_expenses where expense_number = 'RBAC-EXP-TEST')
     or exists (select 1 from public.reservations where notes in (
       'Rollback-only GM reservation authorization test',
       'Rollback-only receptionist reservation authorization test'
     )) then
    raise exception 'RBAC rollback left test fixtures behind';
  end if;
end $$;

select 'PASS: role permissions, reservation RPC authorization, RLS visibility, write grants, and rollback verified' as result;
