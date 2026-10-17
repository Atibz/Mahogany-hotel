\set ON_ERROR_STOP on

-- Local-only POS boundary integration test. Creates temporary restaurant/bar
-- catalog entries and cash sales, then rolls every change back.
begin;

create temporary table pos_test_ids (
  restaurant_outlet uuid,
  restaurant_item uuid,
  bar_outlet uuid,
  bar_item uuid,
  restaurant_order uuid,
  bar_order uuid
) on commit drop;
insert into pos_test_ids default values;

create temporary table pos_test_hotel_ledger_counts on commit drop as
select
  (select count(*) from public.payments) as payments,
  (select count(*) from public.payment_allocations) as allocations,
  (select count(*) from public.receipts) as receipts,
  (select count(*) from public.guest_folios) as folios;
grant select, update on pos_test_ids to authenticated;
grant select on pos_test_hotel_ledger_counts to authenticated;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('67000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pos-test-gm@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"POS test GM"}', now(), now()),
  ('67000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pos-test-restaurant@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"POS test restaurant cashier"}', now(), now()),
  ('67000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pos-test-bar@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"POS test bar cashier"}', now(), now());

insert into public.user_roles (profile_id, role_id)
select fixture.profile_id, r.id
from (values
  ('67000000-0000-4000-8000-000000000001'::uuid, 'general_manager'::text),
  ('67000000-0000-4000-8000-000000000002'::uuid, 'restaurant_staff'::text),
  ('67000000-0000-4000-8000-000000000003'::uuid, 'bar_staff'::text)
) as fixture(profile_id, role_code)
join public.roles r
  on r.hotel_id = '00000000-0000-4000-8000-000000000001'
 and r.code = fixture.role_code;

set local role authenticated;

-- GM provisions isolated outlet menus using the public catalog RPCs.
select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000001', true);
do $$
declare
  hotel_id constant uuid := '00000000-0000-4000-8000-000000000001';
  restaurant_id uuid;
  restaurant_category_id uuid;
  bar_id uuid;
  bar_category_id uuid;
  restaurant_item_id uuid;
  bar_item_id uuid;
begin
  restaurant_id := public.create_pos_outlet(hotel_id, 'rollback_restaurant', 'Rollback Restaurant', 'restaurant', 'restaurant');
  restaurant_category_id := public.create_pos_menu_category(restaurant_id, 'rollback_food', 'Rollback Food');
  restaurant_item_id := public.create_pos_menu_item(restaurant_id, restaurant_category_id, 'rollback_meal', 'Rollback Meal', null, 1, 2500000);
  bar_id := public.create_pos_outlet(hotel_id, 'rollback_bar', 'Rollback Bar', 'bar', 'bar');
  bar_category_id := public.create_pos_menu_category(bar_id, 'rollback_drinks', 'Rollback Drinks');
  bar_item_id := public.create_pos_menu_item(bar_id, bar_category_id, 'rollback_drink', 'Rollback Drink', null, 1, 900000);
  update pos_test_ids set restaurant_outlet=restaurant_id, restaurant_item=restaurant_item_id,
    bar_outlet=bar_id, bar_item=bar_item_id;
end;
$$;

-- Restaurant staff cannot start a bar order or see bar catalog/sales.
select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000002', true);
do $$
declare
  ids pos_test_ids%rowtype;
  denied boolean := false;
  denial_reason text;
  shift_id uuid;
  order_id uuid;
  pos_payment_id uuid;
begin
  select * into strict ids from pos_test_ids;
  if exists (select 1 from public.pos_outlets where id=ids.bar_outlet)
     or exists (select 1 from public.pos_orders where outlet_id=ids.bar_outlet) then
    raise exception 'Restaurant staff can read bar POS records';
  end if;
  begin
    perform public.create_restaurant_pos_order(ids.bar_outlet, 'takeaway', null, 'Boundary test');
  exception when others then denied := true; denial_reason := sqlerrm;
  end;
  if not denied then raise exception 'Restaurant staff created an order in the bar outlet'; end if;
  if position('Not authorised' in denial_reason)=0 then raise exception 'Restaurant/bar denial came from an unexpected error: %', denial_reason; end if;

  shift_id := public.open_pos_cashier_shift(ids.restaurant_outlet, 0);
  order_id := public.create_restaurant_pos_order(ids.restaurant_outlet, 'takeaway', null, 'Rollback POS guest');
  perform public.add_restaurant_pos_order_item_with_modifiers(order_id, ids.restaurant_item, 1::smallint, '{}'::uuid[]);
  pos_payment_id := public.record_restaurant_pos_payment(order_id, '8dae328b-1ee9-4df6-9032-388e4ffcd2f6', 2500000, null);
  if not exists (select 1 from public.pos_order_receipts r where r.payment_id=pos_payment_id and r.department_code_snapshot='restaurant') then
    raise exception 'Restaurant cash sale did not issue its outlet-specific receipt';
  end if;
  perform public.close_pos_cashier_shift(shift_id, 2500000, null);
  update pos_test_ids set restaurant_order=order_id;
end;
$$;

-- Bar staff cannot start a restaurant order or see restaurant records.
select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000003', true);
do $$
declare
  ids pos_test_ids%rowtype;
  denied boolean := false;
  denial_reason text;
  shift_id uuid;
  order_id uuid;
  pos_payment_id uuid;
begin
  select * into strict ids from pos_test_ids;
  if exists (select 1 from public.pos_outlets where id=ids.restaurant_outlet)
     or exists (select 1 from public.pos_orders where outlet_id=ids.restaurant_outlet) then
    raise exception 'Bar staff can read restaurant POS records';
  end if;
  begin
    perform public.create_restaurant_pos_order(ids.restaurant_outlet, 'takeaway', null, 'Boundary test');
  exception when others then denied := true; denial_reason := sqlerrm;
  end;
  if not denied then raise exception 'Bar staff created an order in the restaurant outlet'; end if;
  if position('Not authorised' in denial_reason)=0 then raise exception 'Bar/restaurant denial came from an unexpected error: %', denial_reason; end if;

  shift_id := public.open_pos_cashier_shift(ids.bar_outlet, 0);
  order_id := public.create_restaurant_pos_order(ids.bar_outlet, 'takeaway', null, 'Rollback POS guest');
  perform public.add_restaurant_pos_order_item_with_modifiers(order_id, ids.bar_item, 1::smallint, '{}'::uuid[]);
  pos_payment_id := public.record_restaurant_pos_payment(order_id, '8dae328b-1ee9-4df6-9032-388e4ffcd2f6', 900000, null);
  if not exists (select 1 from public.pos_order_receipts r where r.payment_id=pos_payment_id and r.department_code_snapshot='bar') then
    raise exception 'Bar cash sale did not issue its outlet-specific receipt';
  end if;
  perform public.close_pos_cashier_shift(shift_id, 900000, null);
  update pos_test_ids set bar_order=order_id;
end;
$$;

-- The only financial records created by these sales are in the separate POS
-- ledger; the hotel payments, allocations, folios, and receipts stay unchanged.
reset role;
do $$
begin
  if (select count(*) from public.pos_orders where id in
      (select restaurant_order from pos_test_ids union all select bar_order from pos_test_ids)) <> 2 then
    raise exception 'Expected exactly one restaurant order and one bar order';
  end if;
  if (select count(*) from public.pos_order_payments p join public.pos_orders o on o.id=p.order_id
      where o.id in (select restaurant_order from pos_test_ids union all select bar_order from pos_test_ids)
        and p.status='completed') <> 2 then
    raise exception 'Expected two completed POS tenders';
  end if;
  if (select count(*) from public.pos_order_receipts r join public.pos_orders o on o.id=r.order_id
      where o.id in (select restaurant_order from pos_test_ids union all select bar_order from pos_test_ids)) <> 2 then
    raise exception 'Expected two independent POS receipts';
  end if;
  if exists (
    select 1 from pos_test_hotel_ledger_counts c
    where c.payments <> (select count(*) from public.payments)
       or c.allocations <> (select count(*) from public.payment_allocations)
       or c.receipts <> (select count(*) from public.receipts)
       or c.folios <> (select count(*) from public.guest_folios)
  ) then
    raise exception 'A POS transaction changed the hotel folio/payment/receipt ledger';
  end if;
end;
$$;

rollback;

select 'PASS: restaurant and bar POS cash sales, outlet access isolation, separate POS receipts, and hotel-ledger separation verified; all fixtures rolled back' as result;
