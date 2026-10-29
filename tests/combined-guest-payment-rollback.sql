\set ON_ERROR_STOP on
-- Run after the migration in the same transaction; the caller rolls back.

create temporary table combined_test_ids (
  folio_id uuid, restaurant_order_id uuid, bar_order_id uuid,
  payment_id uuid, refund_request_id uuid, cash_payment_id uuid
) on commit drop;
insert into combined_test_ids default values;
grant select, update on combined_test_ids to authenticated;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('68000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'combined-gm@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('68000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'combined-accountant@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('68000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'combined-store@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());

insert into public.user_roles(profile_id, role_id)
select fixture.profile_id, r.id from (values
  ('68000000-0000-4000-8000-000000000001'::uuid, 'general_manager'),
  ('68000000-0000-4000-8000-000000000002'::uuid, 'accountant'),
  ('68000000-0000-4000-8000-000000000003'::uuid, 'storekeeper')
) fixture(profile_id, role_code) join public.roles r on r.code = fixture.role_code
  and r.hotel_id = '00000000-0000-4000-8000-000000000001';

insert into public.stays(id, hotel_id, guest_id, room_id, actual_check_in_date,
  expected_check_out_date, agreed_rate_kobo, checked_in_by)
select '68000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000001', g.id, r.id,
  public.hotel_business_date('00000000-0000-4000-8000-000000000001'),
  public.hotel_business_date('00000000-0000-4000-8000-000000000001') + 1,
  5000000, '68000000-0000-4000-8000-000000000001'
from public.guests g cross join public.rooms r
where g.hotel_id = '00000000-0000-4000-8000-000000000001'
  and r.hotel_id = g.hotel_id order by g.id, r.id limit 1;
insert into public.guest_folios(id, hotel_id, stay_id, folio_number)
values('68000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000001',
  '68000000-0000-4000-8000-000000000004', 'FOL-ROLLBACK-COMBINED');
insert into public.folio_items(hotel_id, folio_id, item_type, description,
  department_code, base_amount_kobo, total_amount_kobo)
values('00000000-0000-4000-8000-000000000001',
  '68000000-0000-4000-8000-000000000005', 'other_charge',
  'Rollback-only hotel charge', 'rooms', 5000000, 5000000);
update combined_test_ids set folio_id='68000000-0000-4000-8000-000000000005';

set local role authenticated;
select set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000001', true);

do $$
declare
  hotel constant uuid := '00000000-0000-4000-8000-000000000001';
  restaurant uuid; bar uuid; category_id uuid; item_id uuid;
  restaurant_order uuid; bar_order uuid;
begin
  restaurant := public.create_pos_outlet(hotel, 'rollback_6393', '6393 Restaurant', 'restaurant', 'restaurant');
  bar := public.create_pos_outlet(hotel, 'rollback_gemini', 'Gemini Bar & Lounge', 'bar', 'bar');
  category_id := public.create_pos_menu_category(restaurant, 'rollback_meals', 'Meals');
  item_id := public.create_pos_menu_item(restaurant, category_id, 'rollback_meal', 'Meal', null, 1, 1000000);
  restaurant_order := public.create_restaurant_pos_order(restaurant, 'takeaway', null, 'Combined guest');
  perform public.add_restaurant_pos_order_item_with_modifiers(restaurant_order, item_id, 1::smallint, '{}'::uuid[]);
  category_id := public.create_pos_menu_category(bar, 'rollback_drinks', 'Drinks');
  item_id := public.create_pos_menu_item(bar, category_id, 'rollback_drink', 'Drink', null, 1, 2000000);
  bar_order := public.create_restaurant_pos_order(bar, 'takeaway', null, 'Combined guest');
  perform public.add_restaurant_pos_order_item_with_modifiers(bar_order, item_id, 1::smallint, '{}'::uuid[]);
  update combined_test_ids set restaurant_order_id=restaurant_order, bar_order_id=bar_order;
end $$;

do $$
declare ids combined_test_ids%rowtype; method_id uuid; new_payment_id uuid;
begin
  select * into strict ids from combined_test_ids;
  if (select count(*) from public.get_combined_guest_payment_candidates(ids.folio_id,
      array[(select order_number from public.pos_orders where id=ids.restaurant_order_id),
        (select order_number from public.pos_orders where id=ids.bar_order_id)])) <> 2 then
    raise exception 'Exact outlet order lookup failed';
  end if;
  select id into strict method_id from public.payment_methods where hotel_id='00000000-0000-4000-8000-000000000001' and code='bank_transfer';
  begin
    perform public.record_combined_guest_payment(ids.folio_id, method_id, 1000000,
      jsonb_build_array(jsonb_build_object('order_id', ids.restaurant_order_id, 'amount_kobo', 1000000),
        jsonb_build_object('order_id', ids.restaurant_order_id, 'amount_kobo', 1000000)),
      'ROLLBACK-DUPLICATE', 'Test Accountant', 'Guest asked for one payment');
    raise exception 'Duplicate order was accepted';
  exception when others then
    if sqlerrm not like '%An outlet order cannot appear twice%' then raise; end if;
  end;
  new_payment_id := public.record_combined_guest_payment(ids.folio_id, method_id, 1000000,
    jsonb_build_array(jsonb_build_object('order_id', ids.restaurant_order_id, 'amount_kobo', 1000000),
      jsonb_build_object('order_id', ids.bar_order_id, 'amount_kobo', 2000000)),
    'ROLLBACK-COMBINED-TRANSFER', 'Test Accountant', 'Guest asked for one payment');
  update combined_test_ids set payment_id=new_payment_id;
end $$;

reset role;
do $$
declare ids combined_test_ids%rowtype; t record;
begin
  select * into strict ids from combined_test_ids;
  if (select amount_kobo from public.payments where id=ids.payment_id) <> 4000000 then raise exception 'External collection total is wrong'; end if;
  if (select sum(amount_kobo) from public.payment_allocations where payment_id=ids.payment_id) <> 1000000 then raise exception 'Folio allocation is wrong'; end if;
  if (select count(*) from public.pos_order_payments where order_id in (ids.restaurant_order_id,ids.bar_order_id)) <> 0 then raise exception 'Duplicate outlet tender was created'; end if;
  if exists(select 1 from public.receipts where payment_id=ids.payment_id) then raise exception 'Hotel-only receipt was created'; end if;
  begin
    perform public.request_pos_order_line_correction(ids.restaurant_order_id,
      (select id from public.pos_order_lines where order_id=ids.restaurant_order_id limit 1),
      -100, 'Rollback correction', 'Test correction should be refused');
    raise exception 'POS correction was accepted against hotel-collected order';
  exception when others then
    if sqlerrm not like '%hotel-collected combined order%' then raise; end if;
  end;
  select * into t from public.pos_order_totals(ids.restaurant_order_id);
  if t.completed_kobo <> 0 or t.pending_kobo <> 1000000 then raise exception 'Restaurant pending allocation missing'; end if;
  select * into t from public.pos_order_totals(ids.bar_order_id);
  if t.completed_kobo <> 0 or t.pending_kobo <> 2000000 then raise exception 'Bar pending allocation missing'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000003', true);
do $$
declare ids combined_test_ids%rowtype;
begin
  select * into strict ids from combined_test_ids;
  begin
    perform public.verify_pending_payment(ids.payment_id, 'Unapproved verification');
    raise exception 'Storekeeper unexpectedly verified payment';
  exception when others then
    if sqlerrm not like '%Not authorised to verify payments%' then raise; end if;
  end;
end $$;

select set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000002', true);
do $$
declare ids combined_test_ids%rowtype;
begin
  select * into strict ids from combined_test_ids;
  perform public.verify_pending_payment(ids.payment_id, 'Bank statement confirms one transfer');
  perform public.review_combined_guest_payment(ids.payment_id, 'confirmed', 'Phone approval matched bank evidence');
end $$;

reset role;
do $$
declare ids combined_test_ids%rowtype; t record;
begin
  select * into strict ids from combined_test_ids;
  if public.folio_balance(ids.folio_id) <> 4000000 then raise exception 'Folio balance is wrong'; end if;
  select * into t from public.pos_order_totals(ids.restaurant_order_id);
  if t.completed_kobo <> 1000000 or t.pending_kobo <> 0 then raise exception 'Restaurant was not settled'; end if;
  select * into t from public.pos_order_totals(ids.bar_order_id);
  if t.completed_kobo <> 2000000 or t.pending_kobo <> 0 then raise exception 'Bar was not settled'; end if;
  if (select count(*) from public.pos_orders where id in (ids.restaurant_order_id, ids.bar_order_id) and status='settled') <> 2 then raise exception 'Outlet order status is wrong'; end if;
  if (select review_status from public.combined_guest_payments where payment_id=ids.payment_id) <> 'confirmed' then raise exception 'Accountant review missing'; end if;
  if exists(select 1 from public.receipts where payment_id=ids.payment_id) then raise exception 'Hotel-only receipt was created'; end if;
  if (select count(*) from public.pos_order_payments where order_id in (ids.restaurant_order_id, ids.bar_order_id)) <> 0 then
    raise exception 'Outlet tender was created after hotel verification';
  end if;
  if (select collected_kobo from public.get_restaurant_pos_sales_report(
      '00000000-0000-4000-8000-000000000001', public.hotel_business_date('00000000-0000-4000-8000-000000000001', now()),
      public.hotel_business_date('00000000-0000-4000-8000-000000000001', now()))
      where outlet_id=(select outlet_id from public.pos_orders where id=ids.restaurant_order_id)) <> 0 then
    raise exception 'Hotel collection leaked into outlet tender report';
  end if;
  if (select count(*) from public.get_pos_hotel_collected_allocations(
      '00000000-0000-4000-8000-000000000001', array[ids.restaurant_order_id,ids.bar_order_id])) <> 2 then
    raise exception 'POS cannot see hotel-side allocations';
  end if;
  begin
    update public.payments set status='voided', voided_at=now(), void_reason='Rollback test' where id=ids.payment_id;
    raise exception 'Combined payment was voided without split correction';
  exception when others then
    if sqlerrm not like '%Combined payments require a split-aware correction%' then raise; end if;
  end;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000002', true);
do $$
declare ids combined_test_ids%rowtype; source_data jsonb;
begin
  select * into strict ids from combined_test_ids;
  source_data := (public.get_internal_daily_reconciliation(
    '00000000-0000-4000-8000-000000000001',
    public.hotel_business_date('00000000-0000-4000-8000-000000000001', now())) -> 'source');
  if (source_data ->> 'hotel_collected_for_outlets_kobo')::bigint <> 3000000 then
    raise exception 'Hotel-held outlet allocation is missing from reconciliation';
  end if;
  if (source_data #>> '{blockers,unconfirmed_combined_payments}')::bigint <> 0 then
    raise exception 'Confirmed collection should not block reconciliation';
  end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000002', true);
do $$
declare ids combined_test_ids%rowtype; request_id uuid;
begin
  select * into strict ids from combined_test_ids;
  request_id := public.request_combined_guest_payment_refund(ids.payment_id,
    'Rollback test returns all guest money', 'ROLLBACK-PAYOUT-REF');
  update combined_test_ids set refund_request_id=request_id;
end $$;

select set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000001', true);
do $$
declare ids combined_test_ids%rowtype;
begin
  select * into strict ids from combined_test_ids;
  perform public.decide_finance_approval(ids.refund_request_id, true,
    'Independent full refund approved for rollback test');
  perform public.execute_finance_approval(ids.refund_request_id);
  if (select amount_kobo from public.get_finance_approval_register(
      '00000000-0000-4000-8000-000000000001', current_date - 10, current_date + 1)
      where request_id=ids.refund_request_id) <> 4000000 then
    raise exception 'GM approval register lost the full external refund amount';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000002', true);
do $$
declare ids combined_test_ids%rowtype;
begin
  select * into strict ids from combined_test_ids;
  if (select amount_kobo from public.get_finance_approval_register(
      '00000000-0000-4000-8000-000000000001', current_date - 10, current_date + 1)
      where request_id=ids.refund_request_id) <> 4000000 then
    raise exception 'Approval register lost the full external refund amount';
  end if;
end $$;

reset role;
do $$
declare ids combined_test_ids%rowtype; t record;
begin
  select * into strict ids from combined_test_ids;
  if (select status from public.payments where id=ids.payment_id) <> 'refunded' then raise exception 'Combined payment was not refunded'; end if;
  if (select amount_kobo from public.payment_refunds where payment_id=ids.payment_id) <> 4000000 then raise exception 'External refund amount is wrong'; end if;
  if public.folio_balance(ids.folio_id) <> 5000000 then raise exception 'Only the hotel portion should return to folio balance'; end if;
  select * into t from public.pos_order_totals(ids.restaurant_order_id);
  if t.completed_kobo <> 0 then raise exception 'Restaurant order remained paid after full refund'; end if;
  select * into t from public.pos_order_totals(ids.bar_order_id);
  if t.completed_kobo <> 0 then raise exception 'Bar order remained paid after full refund'; end if;
  if (select count(*) from public.pos_orders where id in (ids.restaurant_order_id, ids.bar_order_id) and status='open') <> 2 then raise exception 'Outlet orders did not reopen'; end if;
end $$;

-- Cash takes the hotel shift, settles the outlet orders immediately, and
-- remains a reconciliation blocker until the accountant confirms the call.
set local role authenticated;
select set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000001', true);
do $$
declare ids combined_test_ids%rowtype; cash_method uuid; cash_id uuid; shift_id uuid;
begin
  select * into strict ids from combined_test_ids;
  select id into strict cash_method from public.payment_methods
    where hotel_id='00000000-0000-4000-8000-000000000001' and code='cash';
  shift_id := public.open_cashier_shift('00000000-0000-4000-8000-000000000001', 0);
  cash_id := public.record_combined_guest_payment(ids.folio_id, cash_method, 1000000,
    jsonb_build_array(jsonb_build_object('order_id', ids.restaurant_order_id, 'amount_kobo', 1000000),
      jsonb_build_object('order_id', ids.bar_order_id, 'amount_kobo', 2000000)),
    'ROLLBACK-COMBINED-CASH', 'Test Accountant', 'Guest asked for one cash payment');
  update combined_test_ids set cash_payment_id = cash_id;
  if (select status from public.payments where id=cash_id) <> 'completed'
      or (select cashier_shift_id from public.payments where id=cash_id) <> shift_id then
    raise exception 'Cash collection did not settle into the hotel shift';
  end if;
  if (select count(*) from public.pos_orders where id in (ids.restaurant_order_id,ids.bar_order_id)
      and status='settled') <> 2 then
    raise exception 'Cash collection did not settle the outlet orders';
  end if;
end $$;
reset role;
do $$
declare shift_id uuid;
begin
  select cashier_shift_id into shift_id from public.payments
    where reference='ROLLBACK-COMBINED-CASH' and hotel_id='00000000-0000-4000-8000-000000000001';
  if public.cashier_shift_expected_cash(shift_id) <> 4000000 then
    raise exception 'Hotel shift omitted the outlet cash physically received';
  end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000002', true);
do $$
declare source_data jsonb;
begin
  source_data := (public.get_internal_daily_reconciliation(
    '00000000-0000-4000-8000-000000000001',
    public.hotel_business_date('00000000-0000-4000-8000-000000000001', now())) -> 'source');
  if (source_data #>> '{blockers,unconfirmed_combined_payments}')::bigint <> 1 then
    raise exception 'Unconfirmed cash exception did not block reconciliation';
  end if;
end $$;
reset role;

-- The hotel's later handoff to an independent outlet is evidence-only and
-- cannot exceed the guest-paid allocation or be used by other staff.
set local role authenticated;
select set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000003', true);
do $$
declare ids combined_test_ids%rowtype; cash_id uuid;
begin
  select * into strict ids from combined_test_ids;
  cash_id := ids.cash_payment_id;
  begin
    perform public.record_combined_guest_payment_settlement(cash_id, ids.restaurant_order_id,
      500000, 'ROLLBACK-TRANSFER-1', 'Storekeeper must be refused');
    raise exception 'Storekeeper recorded an outlet settlement';
  exception when others then
    if sqlerrm not like '%Only the accountant%' then raise; end if;
  end;
end $$;

select set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000002', true);
do $$
declare ids combined_test_ids%rowtype; cash_id uuid; summary jsonb; settlement_id uuid;
begin
  select * into strict ids from combined_test_ids;
  cash_id := ids.cash_payment_id;
  begin
    perform public.record_combined_guest_payment_settlement(cash_id, ids.restaurant_order_id,
      500000, 'ROLLBACK-TRANSFER-1', 'Cannot settle before confirming call');
    raise exception 'Unconfirmed phone approval allowed settlement';
  exception when others then
    if sqlerrm not like '%confirm the phone approval%' then raise; end if;
  end;
  perform public.review_combined_guest_payment(cash_id, 'confirmed', 'Phone call verified');
  settlement_id := public.record_combined_guest_payment_settlement(cash_id, ids.restaurant_order_id,
    500000, 'ROLLBACK-TRANSFER-1', 'Half passed to restaurant by transfer');
  summary := (select value from jsonb_array_elements(public.get_combined_guest_payments(
    '00000000-0000-4000-8000-000000000001')) value where value ->> 'payment_id' = cash_id::text);
  if not exists(select 1 from jsonb_array_elements(summary -> 'orders') entry
      where entry ->> 'order_id' = ids.restaurant_order_id::text
        and (entry ->> 'settled_kobo')::bigint = 500000) then
    raise exception 'Accountant settlement not visible in combined-payment register';
  end if;
  begin
    perform public.record_combined_guest_payment_settlement(cash_id, ids.restaurant_order_id,
      500001, 'ROLLBACK-TRANSFER-2', 'Exceeds remainder by one kobo');
    raise exception 'Over-settlement was accepted';
  exception when others then
    if sqlerrm not like '%exceeds the outlet amount%' then raise; end if;
  end;
  begin
    perform public.request_combined_guest_payment_refund(cash_id,
      'Guest refund after outlet has been paid', 'ROLLBACK-REFUND');
    raise exception 'Refund request accepted after outlet settlement';
  exception when others then
    if sqlerrm not like '%reverse it with the outlet%' then raise; end if;
  end;
  perform public.reverse_combined_guest_payment_settlement(settlement_id,
    'ROLLBACK-RETURN-1', 'Restaurant returned the amount to hotel');
  begin
    perform public.reverse_combined_guest_payment_settlement(settlement_id,
      'ROLLBACK-RETURN-2', 'Duplicate return must be rejected');
    raise exception 'Duplicate settlement reversal accepted';
  exception when unique_violation then null;
  end;
  summary := (select value from jsonb_array_elements(public.get_combined_guest_payments(
    '00000000-0000-4000-8000-000000000001')) value where value ->> 'payment_id' = cash_id::text);
  if not exists(select 1 from jsonb_array_elements(summary -> 'orders') entry
      where entry ->> 'order_id' = ids.restaurant_order_id::text
        and (entry ->> 'settled_kobo')::bigint = 0) then
    raise exception 'Reversed outlet settlement still counts as transferred';
  end if;
  perform public.request_combined_guest_payment_refund(cash_id,
    'Guest refund after outlet funds were returned', 'ROLLBACK-REFUND-AFTER-RETURN');
end $$;
reset role;
