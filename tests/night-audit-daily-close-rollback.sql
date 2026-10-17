\set ON_ERROR_STOP on

-- Local-only test for approved room-night posting and the immutable daily close.
-- The close snapshot must retain the posted revenue and closed cashier shift.
-- All fixtures and business-date changes are rolled back at the end.
begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('65000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'night-audit-approver-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Night audit accountant"}', now(), now()),
  ('65000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'night-audit-runner-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Night audit receptionist"}', now(), now()),
  ('65000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'night-audit-manager-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Night audit test GM"}', now(), now()),
  ('65000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'night-audit-cashier-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Night audit test cashier"}', now(), now());

insert into public.user_roles (profile_id, role_id)
select fixtures.profile_id, r.id
from (values
  ('65000000-0000-4000-8000-000000000001'::uuid, 'accountant'::text),
  ('65000000-0000-4000-8000-000000000002'::uuid, 'receptionist'::text),
  ('65000000-0000-4000-8000-000000000003'::uuid, 'general_manager'::text),
  ('65000000-0000-4000-8000-000000000004'::uuid, 'cashier'::text)
) as fixtures(profile_id, role_code)
join public.roles r
  on r.hotel_id = '00000000-0000-4000-8000-000000000001'
 and r.code = fixtures.role_code;

insert into public.guests (id, hotel_id, full_name, created_by, updated_by)
values (
  '65000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000001',
  'Night audit rollback guest',
  '65000000-0000-4000-8000-000000000002',
  '65000000-0000-4000-8000-000000000002'
);

insert into public.stays (
  id, hotel_id, guest_id, room_id, actual_check_in_date,
  expected_check_out_date, agreed_rate_kobo, checked_in_by, notes
) values (
  '65000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000005',
  '20000000-0000-4000-8000-000000000103',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001'),
  public.hotel_business_date('00000000-0000-4000-8000-000000000001') + 1,
  4500000,
  '65000000-0000-4000-8000-000000000002',
  'Rollback-only night audit and daily close test'
);

insert into public.stay_rate_periods (stay_id, effective_from, rate_kobo, reason, approved_by)
values (
  '65000000-0000-4000-8000-000000000006',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001'),
  4500000, 'Initial rollback test rate', '65000000-0000-4000-8000-000000000003'
);

insert into public.guest_folios (hotel_id, stay_id, folio_number)
values (
  '00000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000006',
  'FOL-ROLLBACK-NIGHT-AUDIT-CLOSE'
);

select set_config('request.jwt.claim.sub', '65000000-0000-4000-8000-000000000004', true);
set local role authenticated;
select public.open_cashier_shift('00000000-0000-4000-8000-000000000001', 50000);

select set_config('request.jwt.claim.sub', '65000000-0000-4000-8000-000000000001', true);
select public.approve_current_business_date_night_audit('00000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', '65000000-0000-4000-8000-000000000002', true);
select public.run_current_business_date_night_audit('00000000-0000-4000-8000-000000000001');

do $$
begin
  if not exists (
    select 1 from public.night_audit_approvals
    where hotel_id = '00000000-0000-4000-8000-000000000001'
      and business_date = public.hotel_business_date('00000000-0000-4000-8000-000000000001')
      and approved_by = '65000000-0000-4000-8000-000000000001'
      and executed_by = '65000000-0000-4000-8000-000000000002'
      and executed_at is not null
  ) then
    raise exception 'Night audit did not retain independent approval and execution actors';
  end if;
  if (select count(*) from public.room_night_posts where stay_id = '65000000-0000-4000-8000-000000000006') <> 1 then
    raise exception 'Night audit did not post exactly one room night';
  end if;
  if not exists (
    select 1 from public.folio_items fi
    join public.room_night_posts rnp on rnp.folio_item_id = fi.id
    where rnp.stay_id = '65000000-0000-4000-8000-000000000006'
      and fi.status = 'posted' and fi.total_amount_kobo > 0
  ) then
    raise exception 'Room-night revenue was not posted to the folio';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '65000000-0000-4000-8000-000000000003', true);

do $$
begin
  begin
    perform public.close_current_business_day('00000000-0000-4000-8000-000000000001');
    raise exception 'Business day unexpectedly closed with an open cashier shift';
  exception when others then
    if sqlerrm not like '%Close every cashier shift before business-day close%' then
      raise;
    end if;
  end;
end;
$$;

select public.close_cashier_shift(
  (select id from public.cashier_shifts
   where opened_by = '65000000-0000-4000-8000-000000000004' and status = 'open'),
  50000, null, 'ROLLBACK-BANK-HANDOVER'
);

select public.acknowledge_night_audit_exception(
  '00000000-0000-4000-8000-000000000001',
  'unsettled_open_folios',
  'Rollback test: review the posted room charge'
);

select public.close_current_business_day('00000000-0000-4000-8000-000000000001');

do $$
declare
  report_row record;
  close_date date := public.hotel_business_date('00000000-0000-4000-8000-000000000001') - 1;
  cashier_snapshot jsonb;
begin
  select * into strict report_row
  from public.get_business_day_close_report(
    '00000000-0000-4000-8000-000000000001', close_date
  );

  if not report_row.is_closed
     or report_row.report -> 'night_audit' ->> 'status' <> 'completed'
     or (report_row.report -> 'night_audit' ->> 'posts_created')::integer <> 1 then
    raise exception 'Closed report does not preserve the completed night-audit result';
  end if;
  if jsonb_array_length(report_row.report -> 'revenue_by_department') = 0 then
    raise exception 'Closed report omitted the posted room revenue';
  end if;

  cashier_snapshot := report_row.report -> 'cashier_shifts';
  if jsonb_array_length(cashier_snapshot) <> 1
     or cashier_snapshot -> 0 ->> 'status' <> 'closed'
     or cashier_snapshot -> 0 ->> 'handover_reference' <> 'ROLLBACK-BANK-HANDOVER' then
    raise exception 'Closed report omitted the reconciled cashier shift';
  end if;
  if public.hotel_business_date('00000000-0000-4000-8000-000000000001') <> close_date + 1 then
    raise exception 'Business date did not advance after close';
  end if;
end;
$$;

select 'PASS: approval, independent posting, cashier-shift close blocker, immutable report, and business-date advance verified' as result;

rollback;

do $$ begin
  if exists (select 1 from auth.users where email like 'night-audit-%-rollback@test.invalid')
     or exists (select 1 from public.guests where id = '65000000-0000-4000-8000-000000000005')
     or exists (select 1 from public.stays where id = '65000000-0000-4000-8000-000000000006')
     or exists (select 1 from public.room_night_posts where stay_id = '65000000-0000-4000-8000-000000000006')
     or exists (select 1 from public.guest_folios where folio_number = 'FOL-ROLLBACK-NIGHT-AUDIT-CLOSE')
     or exists (select 1 from public.night_audit_approvals where approved_by = '65000000-0000-4000-8000-000000000001' or executed_by = '65000000-0000-4000-8000-000000000002')
     or exists (select 1 from public.night_audit_acknowledgements where acknowledged_by = '65000000-0000-4000-8000-000000000003')
     or exists (select 1 from public.cashier_shifts where opened_by = '65000000-0000-4000-8000-000000000004')
     or exists (select 1 from public.business_day_closes where closed_by = '65000000-0000-4000-8000-000000000003') then
    raise exception 'Night-audit/daily-close rollback left test fixtures behind';
  end if;
end $$;
