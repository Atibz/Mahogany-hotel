\set ON_ERROR_STOP on

-- Local-only test for Storekeeper permissions and append-only stock movement.
-- All auth, catalog, supplier, and movement fixtures are rolled back.
begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('66000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'inventory-storekeeper-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Inventory Storekeeper"}', now(), now()),
  ('66000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'inventory-accountant-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Inventory Accountant"}', now(), now()),
  ('66000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'inventory-reception-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Inventory Receptionist"}', now(), now());

insert into public.user_roles (profile_id, role_id)
select fixtures.profile_id, r.id
from (values
  ('66000000-0000-4000-8000-000000000001'::uuid, 'storekeeper'::text),
  ('66000000-0000-4000-8000-000000000002'::uuid, 'accountant'::text),
  ('66000000-0000-4000-8000-000000000003'::uuid, 'receptionist'::text)
) as fixtures(profile_id, role_code)
join public.roles r
  on r.hotel_id = '00000000-0000-4000-8000-000000000001'
 and r.code = fixtures.role_code;

select set_config('request.jwt.claim.sub', '66000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select public.save_inventory_item(
  '00000000-0000-4000-8000-000000000001', null,
  'TEST-ROLLBACK-001', 'Rollback Test Linen', 'Housekeeping', 'piece', 2, true
);
select public.save_inventory_supplier(
  '00000000-0000-4000-8000-000000000001', null,
  'Rollback Test Supplier', 'Test Contact', null, null,
  'Temporary fixture only', true
);

select public.record_inventory_movement(
  '00000000-0000-4000-8000-000000000001',
  (select id from public.inventory_items where item_code = 'TEST-ROLLBACK-001'),
  'receipt', 12, 'main_store', null,
  (select id from public.inventory_suppliers where name = 'Rollback Test Supplier'),
  'INV-ROLLBACK-001', 'Test receipt entered for ledger verification'
);
select public.record_inventory_movement(
  '00000000-0000-4000-8000-000000000001',
  (select id from public.inventory_items where item_code = 'TEST-ROLLBACK-001'),
  'transfer', 5, 'main_store', 'restaurant', null,
  'TRF-ROLLBACK-001', 'Transfer stock for test verification'
);
select public.record_inventory_movement(
  '00000000-0000-4000-8000-000000000001',
  (select id from public.inventory_items where item_code = 'TEST-ROLLBACK-001'),
  'issue', 2, 'restaurant', null, null,
  'ISS-ROLLBACK-001', 'Issue stock for test verification'
);

do $$
declare
  balance_row record;
  movement_count integer;
begin
  select on_hand into strict balance_row
  from public.get_inventory_balances('00000000-0000-4000-8000-000000000001')
  where item_code = 'TEST-ROLLBACK-001' and location_code = 'main_store';
  if balance_row.on_hand <> 7 then
    raise exception 'Main Store balance should be 7 after receipt and transfer';
  end if;

  select on_hand into strict balance_row
  from public.get_inventory_balances('00000000-0000-4000-8000-000000000001')
  where item_code = 'TEST-ROLLBACK-001' and location_code = 'restaurant';
  if balance_row.on_hand <> 3 then
    raise exception 'Restaurant balance should be 3 after transfer and issue';
  end if;

  select count(*) into movement_count
  from public.inventory_movements m
  join public.inventory_items i on i.id = m.item_id
  where i.item_code = 'TEST-ROLLBACK-001';
  if movement_count <> 4 then
    raise exception 'Expected one receipt, two transfer legs, and one issue';
  end if;
  if (select count(distinct movement_group_id)
      from public.inventory_movements m
      join public.inventory_items i on i.id = m.item_id
      where i.item_code = 'TEST-ROLLBACK-001'
        and m.movement_type in ('transfer_in', 'transfer_out')) <> 1 then
    raise exception 'Transfer legs must share one movement group';
  end if;

  begin
    perform public.record_inventory_movement(
      '00000000-0000-4000-8000-000000000001',
      (select id from public.inventory_items where item_code = 'TEST-ROLLBACK-001'),
      'issue', 4, 'restaurant', null, null,
      'ISS-ROLLBACK-OVERDRAW', 'Attempt to issue more stock than available'
    );
    raise exception 'Inventory issue unexpectedly overdrawn the location';
  exception when others then
    if sqlerrm not like '%Insufficient stock at this location%' then
      raise;
    end if;
  end;

  begin
    perform public.save_inventory_item(
      '00000000-0000-4000-8000-000000000001',
      (select id from public.inventory_items where item_code = 'TEST-ROLLBACK-001'),
      'TEST-ROLLBACK-001', 'Rollback Test Linen', 'Housekeeping', 'case', 2, true
    );
    raise exception 'Base unit unexpectedly changed after stock movements';
  exception when others then
    if sqlerrm not like '%The base unit cannot change after stock movements exist%' then
      raise;
    end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '66000000-0000-4000-8000-000000000002', true);
do $$
begin
  begin
    perform public.get_inventory_balances('00000000-0000-4000-8000-000000000001');
    raise exception 'Accountant unexpectedly received inventory read access';
  exception when others then
    if sqlerrm not like '%Not authorised to view inventory%' then
      raise;
    end if;
  end;

  begin
    perform public.record_inventory_movement(
      '00000000-0000-4000-8000-000000000001',
      (select id from public.inventory_items where item_code = 'TEST-ROLLBACK-001'),
      'receipt', 1, 'main_store', null, null,
      'INV-ROLLBACK-UNAUTHORIZED', 'Attempt to bypass Storekeeper permission'
    );
    raise exception 'Accountant unexpectedly recorded an inventory movement';
  exception when others then
    if sqlerrm not like '%Not authorised to manage inventory%' then
      raise;
    end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '66000000-0000-4000-8000-000000000003', true);
do $$
begin
  begin
    perform public.get_inventory_balances('00000000-0000-4000-8000-000000000001');
    raise exception 'Receptionist unexpectedly received inventory read access';
  exception when others then
    if sqlerrm not like '%Not authorised to view inventory%' then
      raise;
    end if;
  end;
end;
$$;

select 'PASS: Storekeeper receipt/transfer/issue ledger, balance guards, unit integrity, and role restrictions verified' as result;

rollback;

do $$ begin
  if exists (select 1 from auth.users where email like 'inventory-%-rollback@test.invalid')
     or exists (select 1 from public.inventory_items where item_code = 'TEST-ROLLBACK-001')
     or exists (select 1 from public.inventory_suppliers where name = 'Rollback Test Supplier')
     or exists (
       select 1 from public.inventory_movements m
       join public.inventory_items i on i.id = m.item_id
       where i.item_code = 'TEST-ROLLBACK-001'
     ) then
    raise exception 'Inventory rollback left test fixtures behind';
  end if;
end $$;
