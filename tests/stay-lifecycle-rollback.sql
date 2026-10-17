\set ON_ERROR_STOP on

-- Local-only full stay lifecycle test. Reception creates/checks in a guest,
-- Accountant independently approves night audit, Reception executes it,
-- Cashier collects and hands over payment, GM reviews/closes the business day,
-- and Reception completes departure. All fixtures and date changes roll back.
begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('66000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'stay-lifecycle-accountant-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Stay lifecycle Accountant"}', now(), now()),
  ('66000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'stay-lifecycle-reception-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Stay lifecycle Reception"}', now(), now()),
  ('66000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'stay-lifecycle-cashier-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Stay lifecycle Cashier"}', now(), now()),
  ('66000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'stay-lifecycle-gm-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Stay lifecycle GM"}', now(), now()),
  ('66000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'stay-lifecycle-other-reception-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Stay lifecycle other Reception"}', now(), now());

insert into public.user_roles (profile_id, role_id)
select fixture.profile_id, r.id
from (values
  ('66000000-0000-4000-8000-000000000001'::uuid, 'accountant'::text),
  ('66000000-0000-4000-8000-000000000002'::uuid, 'receptionist'::text),
  ('66000000-0000-4000-8000-000000000003'::uuid, 'cashier'::text),
  ('66000000-0000-4000-8000-000000000004'::uuid, 'general_manager'::text),
  ('66000000-0000-4000-8000-000000000006'::uuid, 'receptionist'::text)
) fixture(profile_id, role_code)
join public.roles r
  on r.hotel_id = '00000000-0000-4000-8000-000000000001'
 and r.code = fixture.role_code;

insert into public.guests (
  id, hotel_id, full_name, phone, email, created_by, updated_by
) values (
  '66000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000001',
  'Stay lifecycle rollback guest', '+2348000000066',
  'stay-lifecycle-guest-rollback@test.invalid',
  '66000000-0000-4000-8000-000000000002',
  '66000000-0000-4000-8000-000000000002'
);

set local role authenticated;

do $$
declare
  hotel_id_value uuid := '00000000-0000-4000-8000-000000000001';
  business_date_value date := public.hotel_business_date('00000000-0000-4000-8000-000000000001');
  guest_id_value uuid := '66000000-0000-4000-8000-000000000005';
  room_type_id_value uuid := '10000000-0000-4000-8000-000000000003';
  room_id_value uuid := '20000000-0000-4000-8000-000000000302';
  receptionist_id uuid := '66000000-0000-4000-8000-000000000002';
  cashier_id uuid := '66000000-0000-4000-8000-000000000003';
  accountant_id uuid := '66000000-0000-4000-8000-000000000001';
  manager_id uuid := '66000000-0000-4000-8000-000000000004';
  reservation_id_value uuid;
  stay_id_value uuid;
  folio_id_value uuid;
  shift_id_value uuid;
  payment_id_value uuid;
  invoice_id_value uuid;
  cash_method_id uuid;
  balance_value bigint;
  expected_cash_value bigint;
  reviewed_shift public.cashier_shifts%rowtype;
begin
  perform set_config('request.jwt.claim.sub', receptionist_id::text, true);

  if exists (
    select 1 from public.search_available_rooms(
      hotel_id_value, room_type_id_value,
      business_date_value, business_date_value + 1
    ) available where available.id = room_id_value
  ) is false then
    raise exception 'Rollback test room is not available for the test stay';
  end if;

  perform set_config('request.jwt.claim.sub', receptionist_id::text, true);
  reservation_id_value := public.create_reservation(
    hotel_id_value, guest_id_value, room_type_id_value, room_id_value,
    business_date_value, business_date_value + 1, 9500000::bigint,
    2::smallint, 0::smallint, 0::bigint,
    'ROLLBACK TEST', 'Full stay lifecycle rollback fixture'
  );
  stay_id_value := public.check_in_reservation(reservation_id_value, business_date_value);

  perform set_config('request.jwt.claim.sub', accountant_id::text, true);
  perform public.approve_current_business_date_night_audit(hotel_id_value);

  perform set_config('request.jwt.claim.sub', receptionist_id::text, true);
  if public.run_current_business_date_night_audit(hotel_id_value) <> 1 then
    raise exception 'Night audit did not create exactly one room-night charge';
  end if;

  select id into strict folio_id_value
  from public.guest_folios where stay_id = stay_id_value and status = 'open';
  balance_value := public.folio_balance(folio_id_value);
  if balance_value <= 0 then raise exception 'Night audit left no folio balance to settle'; end if;
  if (select balance_kobo from public.get_folio_balances(hotel_id_value, array[folio_id_value])) is distinct from balance_value then
    raise exception 'Batched folio balance disagrees with the authoritative folio balance';
  end if;
  if exists (select 1 from public.get_folio_balances(hotel_id_value, array['66000000-0000-4000-8000-000000000099'::uuid])) then
    raise exception 'Batched folio balance returned an unrelated folio';
  end if;

  -- Checkout must not proceed while the folio remains unpaid. The failed RPC
  -- runs in a subtransaction so any attempted checkout effects are discarded.
  begin
    perform public.complete_departure_checkout(
      stay_id_value, true, true, true, true,
      'Unpaid checkout must be rejected in rollback test'
    );
    raise exception 'Checkout unexpectedly completed with an unpaid folio';
  exception when raise_exception then
    if sqlerrm not like 'Folio must be fully settled before checkout.%' then raise; end if;
  end;

  if not exists (
    select 1 from public.stays where id = stay_id_value and status = 'checked_in'
  ) or not exists (
    select 1 from public.guest_folios where id = folio_id_value and status = 'open'
  ) then
    raise exception 'Rejected unpaid checkout changed the stay or folio';
  end if;

  perform set_config('request.jwt.claim.sub', cashier_id::text, true);
  shift_id_value := public.open_cashier_shift(hotel_id_value, 0);
  select id into strict cash_method_id
  from public.payment_methods
  where hotel_id = hotel_id_value and code = 'cash' and active;
  payment_id_value := public.record_folio_payment(
    folio_id_value, cash_method_id, balance_value,
    'STAY-LIFECYCLE-ROLLBACK-CASH'
  );

  if public.folio_balance(folio_id_value) <> 0 then
    raise exception 'Cash payment did not fully settle the folio';
  end if;
  if (select count(*) from public.receipts where payment_id = payment_id_value) <> 1 then
    raise exception 'Cash payment did not issue exactly one receipt';
  end if;

  select expected_cash_kobo into strict expected_cash_value
  from public.current_cashier_shift(hotel_id_value)
  where id = shift_id_value;
  perform public.close_cashier_shift(
    shift_id_value, expected_cash_value, null,
    'STAY-LIFECYCLE-ROLLBACK-HANDOVER'
  );

  perform set_config('request.jwt.claim.sub', manager_id::text, true);
  perform public.review_cashier_shift(
    shift_id_value, 'Rollback test: payment handover reviewed'
  );
  perform public.close_current_business_day(hotel_id_value);

  if public.hotel_business_date(hotel_id_value) <> business_date_value + 1 then
    raise exception 'Business date did not advance after successful close';
  end if;

  perform set_config('request.jwt.claim.sub', receptionist_id::text, true);
  invoice_id_value := public.complete_departure_checkout(
    stay_id_value, true, true, true, true,
    'Rollback test: guest departed after settlement'
  );

  if not exists (
    select 1 from public.get_checkout_invoice(invoice_id_value) invoice_record
    where invoice_record.snapshot ->> 'final_balance_kobo' = '0'
  ) then
    raise exception 'Checkout invoice is missing or not settled';
  end if;

  perform set_config('request.jwt.claim.sub', '66000000-0000-4000-8000-000000000006', true);
  begin
    perform 1 from public.get_checkout_invoice(invoice_id_value);
    raise exception 'A different Reception user unexpectedly viewed this invoice';
  exception when raise_exception then
    if sqlerrm <> 'Not authorised to view this invoice' then raise; end if;
  end;
end;
$$;

reset role;

do $$
declare
  fixture_guest_id uuid := '66000000-0000-4000-8000-000000000005';
  fixture_room_id uuid := '20000000-0000-4000-8000-000000000302';
  fixture_hotel_id uuid := '00000000-0000-4000-8000-000000000001';
  fixture_stay_id uuid;
  fixture_reservation_id uuid;
  fixture_folio_id uuid;
  fixture_payment_id uuid;
  fixture_expected_cash bigint;
  fixture_business_date date := public.hotel_business_date('00000000-0000-4000-8000-000000000001') - 1;
  fixture_shift public.cashier_shifts%rowtype;
begin
  select id into strict fixture_stay_id from public.stays where guest_id = fixture_guest_id;
  select id into strict fixture_reservation_id from public.reservations where guest_id = fixture_guest_id;
  select id into strict fixture_folio_id from public.guest_folios where stay_id = fixture_stay_id;
  select id into strict fixture_payment_id from public.payments where reference = 'STAY-LIFECYCLE-ROLLBACK-CASH';

  if not exists (
    select 1 from public.stays
    where id = fixture_stay_id and status = 'checked_out'
      and actual_check_out_date = fixture_business_date + 1
      and checked_out_by = '66000000-0000-4000-8000-000000000002'
  ) then raise exception 'Reception did not complete checkout on the scheduled date'; end if;
  if not exists (select 1 from public.reservations where id = fixture_reservation_id and status = 'checked_out') then
    raise exception 'Checkout did not update the linked reservation status';
  end if;
  if not exists (select 1 from public.guest_folios where id = fixture_folio_id and status = 'closed') then
    raise exception 'Checkout did not close the settled folio';
  end if;
  if not exists (select 1 from public.rooms where id = fixture_room_id and turnover_status = 'dirty')
     or not exists (select 1 from public.room_turnover_tasks where stay_id = fixture_stay_id and room_id = fixture_room_id and status = 'open') then
    raise exception 'Checkout did not create the expected dirty-room turnover task';
  end if;
  if not exists (
    select 1 from public.night_audit_approvals
    where hotel_id = fixture_hotel_id and business_date = fixture_business_date
      and approved_by = '66000000-0000-4000-8000-000000000001'
      and executed_by = '66000000-0000-4000-8000-000000000002' and executed_at is not null
  ) then raise exception 'Independent night-audit approval and execution were not retained'; end if;
  select * into strict fixture_shift from public.cashier_shifts where handover_reference = 'STAY-LIFECYCLE-ROLLBACK-HANDOVER';
  fixture_expected_cash := public.cashier_shift_expected_cash(fixture_shift.id);
  if fixture_shift.status <> 'closed'
     or fixture_shift.expected_cash_kobo <> fixture_expected_cash
     or fixture_shift.declared_cash_kobo <> fixture_expected_cash
     or fixture_shift.reviewed_by <> '66000000-0000-4000-8000-000000000004'
     or fixture_shift.reviewed_at is null then
    raise exception 'Cashier shift reconciliation/review was not retained: %', to_jsonb(fixture_shift);
  end if;
  if (select count(*) from public.room_night_posts where stay_id = fixture_stay_id) <> 1 then
    raise exception 'Expected one idempotent room-night post for the stay';
  end if;
  if (select count(*) from public.receipts where payment_id = fixture_payment_id) <> 1 then
    raise exception 'Receipt count changed during checkout';
  end if;
end $$;

select 'PASS: reservation check-in, approved night audit, folio payment/receipt, shift handover, business-day close, Reception checkout, invoice, and turnover verified' as result;

rollback;

do $$ begin
  if exists (select 1 from auth.users where email like 'stay-lifecycle-%-rollback@test.invalid')
     or exists (select 1 from public.guests where id = '66000000-0000-4000-8000-000000000005')
     or exists (select 1 from public.reservations where notes like '%Full stay lifecycle rollback fixture%')
     or exists (select 1 from public.stays where guest_id = '66000000-0000-4000-8000-000000000005')
     or exists (select 1 from public.cashier_shifts where handover_reference = 'STAY-LIFECYCLE-ROLLBACK-HANDOVER')
     or exists (
       select 1 from public.receipts receipt
       join public.payments payment on payment.id = receipt.payment_id
       where payment.reference = 'STAY-LIFECYCLE-ROLLBACK-CASH'
     ) then
    raise exception 'Stay lifecycle rollback left test fixtures behind';
  end if;
end $$;
