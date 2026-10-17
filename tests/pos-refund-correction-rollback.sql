\set ON_ERROR_STOP on

-- Local-only POS refund/correction lifecycle test. Uses an isolated outlet and
-- transaction, and rolls all fixture records back at the end.
begin;

create temporary table pos_correction_test_ids (
  outlet_id uuid,
  item_id uuid,
  order_id uuid,
  order_line_id uuid,
  payment_id uuid,
  correction_request_id uuid,
  refund_request_id uuid,
  restaurant_shift_id uuid,
  gm_refund_shift_id uuid
) on commit drop;
insert into pos_correction_test_ids default values;

create temporary table pos_correction_test_hotel_ledger_counts on commit drop as
select
  (select count(*) from public.payments) as payments,
  (select count(*) from public.payment_allocations) as allocations,
  (select count(*) from public.receipts) as receipts,
  (select count(*) from public.guest_folios) as folios;

grant select, update on pos_correction_test_ids to authenticated;
grant select on pos_correction_test_hotel_ledger_counts to authenticated;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('67000000-0000-4000-8000-000000000011', 'authenticated', 'authenticated', 'pos-correction-gm@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"POS correction test GM"}', now(), now()),
  ('67000000-0000-4000-8000-000000000012', 'authenticated', 'authenticated', 'pos-correction-restaurant@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"POS correction test restaurant cashier"}', now(), now()),
  ('67000000-0000-4000-8000-000000000013', 'authenticated', 'authenticated', 'pos-correction-accountant@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"POS correction test accountant"}', now(), now());

insert into public.user_roles (profile_id, role_id)
select fixture.profile_id, r.id
from (values
  ('67000000-0000-4000-8000-000000000011'::uuid, 'general_manager'::text),
  ('67000000-0000-4000-8000-000000000012'::uuid, 'restaurant_staff'::text),
  ('67000000-0000-4000-8000-000000000013'::uuid, 'accountant'::text)
) as fixture(profile_id, role_code)
join public.roles r
  on r.hotel_id = '00000000-0000-4000-8000-000000000001'
 and r.code = fixture.role_code;

set local role authenticated;
select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000011', true);

do $$
declare
  hotel_id constant uuid := '00000000-0000-4000-8000-000000000001';
  new_outlet_id uuid;
  new_category_id uuid;
  new_item_id uuid;
begin
  new_outlet_id := public.create_pos_outlet(hotel_id, 'rollback_pos_correction', 'Rollback POS Correction', 'restaurant', 'restaurant');
  new_category_id := public.create_pos_menu_category(new_outlet_id, 'rollback_correction_menu', 'Rollback Correction Menu');
  new_item_id := public.create_pos_menu_item(new_outlet_id, new_category_id, 'rollback_correction_item', 'Rollback Correction Item', null, 1, 2500000);
  update pos_correction_test_ids set outlet_id=new_outlet_id, item_id=new_item_id;
end;
$$;

select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000012', true);
do $$
declare
  ids pos_correction_test_ids%rowtype;
  shift_id uuid;
  new_order_id uuid;
  new_line_id uuid;
  new_payment_id uuid;
  cash_method_id uuid;
  new_correction_request_id uuid;
begin
  select * into strict ids from pos_correction_test_ids;
  select id into strict cash_method_id from public.payment_methods
    where hotel_id='00000000-0000-4000-8000-000000000001' and code='cash' and active;
  shift_id := public.open_pos_cashier_shift(ids.outlet_id, 0);
  new_order_id := public.create_restaurant_pos_order(ids.outlet_id, 'takeaway', null, 'Rollback correction test');
  perform public.add_restaurant_pos_order_item_with_modifiers(new_order_id, ids.item_id, 1::smallint, '{}'::uuid[]);
  select l.id into strict new_line_id from public.pos_order_lines l where l.order_id=new_order_id;
  new_payment_id := public.record_restaurant_pos_payment(new_order_id, cash_method_id, 2500000, null);
  new_correction_request_id := public.request_pos_order_line_correction(
    new_order_id, new_line_id, -500000, 'Correct test item price', 'Rollback-only overcharge correction'
  );
  update pos_correction_test_ids set order_id=new_order_id, order_line_id=new_line_id,
    payment_id=new_payment_id, correction_request_id=new_correction_request_id, restaurant_shift_id=shift_id;
end;
$$;

-- Only a different finance approver may approve and execute the request.
select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000011', true);
do $$
declare ids pos_correction_test_ids%rowtype;
begin
  select * into strict ids from pos_correction_test_ids;
  begin
    perform public.execute_finance_approval(ids.correction_request_id);
    raise exception 'A pending correction was unexpectedly executable';
  exception when others then
    if sqlerrm not like '%Only an approved request can be executed%' then raise; end if;
  end;
  perform public.decide_finance_approval(ids.correction_request_id, true, 'Verified against rollback test order');
  perform public.execute_finance_approval(ids.correction_request_id);
end;
$$;

-- Use the local database owner only for assertions on internal ledger helpers
-- that are intentionally not executable by authenticated application users.
reset role;
do $$
declare
  ids pos_correction_test_ids%rowtype;
  totals record;
  correction_count integer;
begin
  select * into strict ids from pos_correction_test_ids;
  select * into strict totals from public.pos_order_totals(ids.order_id);
  select count(*) into correction_count from public.pos_order_line_corrections where order_id=ids.order_id;
  if totals.gross_total_kobo <> 2000000 or totals.completed_kobo <> 2500000 or totals.pending_kobo <> 0 then
    raise exception 'Approved correction totals mismatch: gross %, completed %, pending %', totals.gross_total_kobo, totals.completed_kobo, totals.pending_kobo;
  end if;
  if correction_count <> 1 or not exists (
    select 1 from public.pos_order_line_corrections where order_id=ids.order_id
      and order_line_id=ids.order_line_id and amount_delta_kobo=-500000
      and reason='Rollback-only overcharge correction'
  ) then raise exception 'Correction was not stored as a single reasoned append-only record'; end if;
  if not exists (select 1 from public.pos_order_lines where id=ids.order_line_id and line_total_kobo=2500000) then
    raise exception 'The original paid order line was changed';
  end if;
  if not exists (select 1 from public.finance_approval_requests where id=ids.correction_request_id
      and status='executed' and requested_by <> decided_by and decided_by=executed_by) then
    raise exception 'Independent correction approval/execution evidence is missing';
  end if;
end;
$$;

-- Accountant requests the available customer-credit payout; GM approves and
-- records it in the outlet POS ledger without mutating hotel payment records.
set local role authenticated;
select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000013', true);
do $$
declare
  ids pos_correction_test_ids%rowtype;
  cash_method_id uuid;
  new_refund_request_id uuid;
  denied boolean := false;
begin
  select * into strict ids from pos_correction_test_ids;
  select id into strict cash_method_id from public.payment_methods
    where hotel_id='00000000-0000-4000-8000-000000000001' and code='cash' and active;
  begin
    perform public.request_pos_payment_refund(
      ids.payment_id, 500001, cash_method_id, null, 'Rollback-only over-refund attempt'
    );
  exception when others then
    denied := true;
    if sqlerrm not like '%Refund exceeds the available customer credit for this POS order%' then raise; end if;
  end;
  if not denied then raise exception 'POS refund request exceeded the available customer credit'; end if;
  new_refund_request_id := public.request_pos_payment_refund(
    ids.payment_id, 500000, cash_method_id, null, 'Rollback-only customer-credit refund'
  );
  update pos_correction_test_ids set refund_request_id=new_refund_request_id;
end;
$$;

select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000011', true);
do $$
declare
  ids pos_correction_test_ids%rowtype;
  refund_shift_id uuid;
begin
  select * into strict ids from pos_correction_test_ids;
  perform public.decide_finance_approval(ids.refund_request_id, true, 'Verified available POS customer credit');
  refund_shift_id := public.open_pos_cashier_shift(ids.outlet_id, 0);
  perform public.execute_finance_approval(ids.refund_request_id);
  update pos_correction_test_ids set gm_refund_shift_id=refund_shift_id;
end;
$$;

select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000011', true);
do $$
declare
  ids pos_correction_test_ids%rowtype;
  report_row record;
  refund_count integer;
  hotel_business_day date;
begin
  select * into strict ids from pos_correction_test_ids;
  select count(*) into refund_count from public.pos_order_refunds
    where payment_id=ids.payment_id and order_id=ids.order_id;
  if refund_count <> 1 or not exists (
    select 1 from public.pos_order_refunds where payment_id=ids.payment_id and order_id=ids.order_id
      and amount_kobo=500000 and cashier_shift_id=ids.gm_refund_shift_id
      and reason='Rollback-only customer-credit refund'
  ) then raise exception 'Approved refund was not recorded exactly once against the approver shift'; end if;
  if not exists (select 1 from public.pos_order_payments where id=ids.payment_id and status='completed' and amount_kobo=2500000) then
    raise exception 'Original POS payment was changed by its refund';
  end if;
  hotel_business_day := public.hotel_business_date('00000000-0000-4000-8000-000000000001', now());
  select * into strict report_row from public.get_pos_refund_sales_summary(
    '00000000-0000-4000-8000-000000000001', hotel_business_day, hotel_business_day
  ) where outlet_id=ids.outlet_id;
  if report_row.payments_received_kobo <> 2500000 or report_row.refunds_kobo <> 500000 or report_row.net_collected_kobo <> 2000000 then
    raise exception 'Refund summary does not reconcile: payments %, refunds %, net %', report_row.payments_received_kobo, report_row.refunds_kobo, report_row.net_collected_kobo;
  end if;
  if exists (
    select 1 from pos_correction_test_hotel_ledger_counts c
    where c.payments <> (select count(*) from public.payments)
       or c.allocations <> (select count(*) from public.payment_allocations)
       or c.receipts <> (select count(*) from public.receipts)
       or c.folios <> (select count(*) from public.guest_folios)
  ) then raise exception 'POS correction/refund changed the hotel payment or folio ledger'; end if;
end;
$$;

select 'PASS: POS paid-line correction, independent approval, customer-credit refund, outlet-shift attribution, report reconciliation, and hotel-ledger separation verified' as result;
rollback;

do $$ begin
  if exists (select 1 from auth.users where email in (
      'pos-correction-gm@test.invalid', 'pos-correction-restaurant@test.invalid', 'pos-correction-accountant@test.invalid'
    )) or exists (select 1 from public.pos_outlets where code='rollback_pos_correction') then
    raise exception 'POS refund/correction rollback left test fixtures behind';
  end if;
end $$;
