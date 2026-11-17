\set ON_ERROR_STOP on

-- Local-only test for accountant self-review and independent GM review.
-- All data changes are contained in one transaction and rolled back at the end.
begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '64000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'expense-submit-rollback@test.invalid', '', now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Expense submitter test"}', now(), now()
  ),
  (
    '64000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'expense-review-rollback@test.invalid', '', now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Expense reviewer test GM"}', now(), now()
  );

insert into public.user_roles (profile_id, role_id)
select fixtures.profile_id, r.id
from (values
  ('64000000-0000-4000-8000-000000000001'::uuid, 'accountant'::text),
  ('64000000-0000-4000-8000-000000000002'::uuid, 'general_manager'::text)
) as fixtures(profile_id, role_code)
join public.roles r
  on r.hotel_id = '00000000-0000-4000-8000-000000000001'
 and r.code = fixtures.role_code;

select set_config(
  'request.jwt.claim.sub', '64000000-0000-4000-8000-000000000001', true
);
set local role authenticated;

select public.submit_operating_expense(
  '00000000-0000-4000-8000-000000000001',
  'hotel', 'Test supplies', 'Rollback-only expense approval test',
  'Test supplier', 125000, 'Bank transfer', 'EXP-APPROVAL-ROLLBACK-ACCOUNTANT',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001', now())
);

do $$
declare submitted_expense public.operating_expenses;
begin
  select * into strict submitted_expense from public.operating_expenses
  where evidence_reference = 'EXP-APPROVAL-ROLLBACK-ACCOUNTANT';
  if submitted_expense.status <> 'pending_review'
     or submitted_expense.submitted_by <> auth.uid()
     or submitted_expense.amount_kobo <> 125000 then
    raise exception 'Expense submission did not create the expected pending record';
  end if;

  perform public.review_operating_expense(
    submitted_expense.id, 'approved', 'Receipt reference checked by accountant'
  );
  if not exists (select 1 from public.operating_expenses
    where id = submitted_expense.id and status = 'approved'
      and reviewed_by = submitted_by) then
    raise exception 'Accountant self-review was not recorded';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub', '64000000-0000-4000-8000-000000000002', true
);

select public.submit_operating_expense(
  '00000000-0000-4000-8000-000000000001',
  'hotel', 'Test supplies', 'Rollback-only self-review guard test',
  'Test supplier', 50000, 'Cash', 'EXP-APPROVAL-ROLLBACK-GM',
  public.hotel_business_date('00000000-0000-4000-8000-000000000001', now())
);

do $$
declare
  accountant_expense public.operating_expenses;
  gm_expense public.operating_expenses;
begin
  select * into strict accountant_expense from public.operating_expenses
  where evidence_reference = 'EXP-APPROVAL-ROLLBACK-ACCOUNTANT';
  select * into strict gm_expense from public.operating_expenses
  where evidence_reference = 'EXP-APPROVAL-ROLLBACK-GM';

  begin
    perform public.review_operating_expense(
      gm_expense.id, 'approved', 'GM self-approval attempt'
    );
    raise exception 'Submitter unexpectedly self-approved their expense';
  exception when others then
    if sqlerrm not like '%Only the accountant may review their own expense%' then
      raise;
    end if;
  end;

  begin
    perform public.review_operating_expense(gm_expense.id, 'approved', '  ');
    raise exception 'Expense unexpectedly accepted a blank review note';
  exception when others then
    if sqlerrm not like '%A review note of at least 3 characters is required%' then
      raise;
    end if;
  end;

  if not exists (
    select 1 from public.operating_expenses
    where id = accountant_expense.id
      and status = 'approved'
      and review_note = 'Receipt reference checked by accountant'
      and submitted_by = reviewed_by
  ) then
    raise exception 'Accountant self-review evidence was not preserved';
  end if;
end;
$$;

do $$
declare
  report_row record;
  source_totals record;
begin
  select * into strict report_row
  from public.get_operating_expense_summary(
    '00000000-0000-4000-8000-000000000001',
    public.hotel_business_date('00000000-0000-4000-8000-000000000001', now()),
    public.hotel_business_date('00000000-0000-4000-8000-000000000001', now())
  )
  where department = 'hotel';

  select
    coalesce(sum(amount_kobo) filter (where status = 'approved'), 0)::bigint as approved,
    coalesce(sum(amount_kobo) filter (where status = 'pending_review'), 0)::bigint as pending,
    count(*) filter (where status = 'approved') as approved_count,
    count(*) filter (where status = 'pending_review') as pending_count,
    count(*) filter (where status = 'rejected') as rejected_count
  into source_totals
  from public.operating_expenses
  where hotel_id = '00000000-0000-4000-8000-000000000001'
    and department = 'hotel'
    and incurred_on = public.hotel_business_date(
      '00000000-0000-4000-8000-000000000001', now()
    );

  if report_row.approved_amount_kobo <> source_totals.approved
     or report_row.pending_amount_kobo <> source_totals.pending
     or report_row.approved_count <> source_totals.approved_count
     or report_row.pending_count <> source_totals.pending_count
     or report_row.rejected_count <> source_totals.rejected_count then
    raise exception 'Expense summary does not reconcile to incurred-date records';
  end if;
end;
$$;

select 'PASS: paid-expense submission, independent GM review, note validation, and incurred-date summary verified' as result;

rollback;

do $$ begin
  if exists (
    select 1 from auth.users where email in (
      'expense-submit-rollback@test.invalid',
      'expense-review-rollback@test.invalid'
    )
  ) or exists (
    select 1 from public.operating_expenses where evidence_reference in (
      'EXP-APPROVAL-ROLLBACK-ACCOUNTANT',
      'EXP-APPROVAL-ROLLBACK-GM'
    )
  ) then
    raise exception 'Operating-expense rollback left test fixtures behind';
  end if;
end $$;
