-- The accountant has GM-level operational permissions, without acquiring the
-- Owner role or the ability to run a night audit they may have approved.
-- Owner/MD account protection remains in the staff RPCs and Owner RLS policies.
-- Table RLS calls this helper on direct reads. It was removed from PUBLIC by
-- the anonymous-execution hardening migration but needs an authenticated grant.
grant execute on function public.has_hotel_access(uuid) to authenticated;

create or replace function public.mirror_gm_permissions_to_accountant(target_hotel_id uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.role_permissions (role_id, permission_id)
  select accountant.id, rp.permission_id
  from public.roles gm
  join public.role_permissions rp on rp.role_id = gm.id
  join public.permissions p on p.id = rp.permission_id
  join public.roles accountant on accountant.hotel_id = gm.hotel_id and accountant.code = 'accountant'
  where gm.hotel_id = target_hotel_id and gm.code = 'general_manager'
    and p.code <> 'night_audit.run'
  on conflict do nothing;
$$;

select public.mirror_gm_permissions_to_accountant(id) from public.hotels;

create or replace function public.mirror_new_gm_permission_to_accountant()
returns trigger language plpgsql security definer set search_path = public as $$
declare hotel_id_value uuid; permission_code text;
begin
  select r.hotel_id, p.code into hotel_id_value, permission_code
  from public.roles r join public.permissions p on p.id = new.permission_id
  where r.id = new.role_id and r.code = 'general_manager';
  if hotel_id_value is not null and permission_code <> 'night_audit.run' then
    perform public.mirror_gm_permissions_to_accountant(hotel_id_value);
  end if;
  return new;
end;
$$;

drop trigger if exists mirror_gm_permissions_to_accountant on public.role_permissions;
create trigger mirror_gm_permissions_to_accountant
after insert on public.role_permissions for each row
execute function public.mirror_new_gm_permission_to_accountant();

-- A later hotel/role provisioning call can also establish the same permissions.
create or replace function public.mirror_new_accountant_role_permissions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.code = 'accountant' then
    perform public.mirror_gm_permissions_to_accountant(new.hotel_id);
  end if;
  return new;
end;
$$;
drop trigger if exists mirror_new_accountant_role_permissions on public.roles;
create trigger mirror_new_accountant_role_permissions
after insert on public.roles for each row
execute function public.mirror_new_accountant_role_permissions();

delete from public.role_permissions rp using public.roles r, public.permissions p
where rp.role_id = r.id and rp.permission_id = p.id
  and r.code = 'accountant' and p.code = 'night_audit.run';

revoke all on function public.mirror_gm_permissions_to_accountant(uuid),
  public.mirror_new_gm_permission_to_accountant(),
  public.mirror_new_accountant_role_permissions() from public, anon, authenticated;

-- Accountant self-review is an explicit management choice. Keep mandatory notes,
-- immutable submitter/reviewer identities, and a searchable audit marker.
do $$
declare constraint_name text;
begin
  select c.conname into constraint_name from pg_constraint c
  where c.conrelid = 'public.operating_expenses'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%reviewed_by%'
    and pg_get_constraintdef(c.oid) like '%submitted_by%'
  limit 1;
  if constraint_name is null then raise exception 'Operating expense review constraint not found'; end if;
  execute format('alter table public.operating_expenses drop constraint %I', constraint_name);
end;
$$;
alter table public.operating_expenses add constraint operating_expenses_review_state_check
check ((status = 'pending_review' and reviewed_by is null and reviewed_at is null and review_note is null)
  or (status in ('approved','rejected') and reviewed_by is not null
    and reviewed_at is not null and nullif(trim(review_note),'') is not null));

do $$
declare constraint_name text;
begin
  select c.conname into constraint_name from pg_constraint c
  where c.conrelid = 'public.internal_daily_reconciliations'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%reviewed_by%'
    and pg_get_constraintdef(c.oid) like '%submitted_by%'
  limit 1;
  if constraint_name is null then raise exception 'Reconciliation review constraint not found'; end if;
  execute format('alter table public.internal_daily_reconciliations drop constraint %I', constraint_name);
end;
$$;
alter table public.internal_daily_reconciliations add constraint internal_reconciliation_review_state_check
check ((status = 'submitted' and reviewed_by is null and reviewed_at is null and review_note is null)
  or (status in ('approved', 'rejected') and reviewed_by is not null
    and reviewed_at is not null and length(trim(review_note)) >= 3));

create or replace function public.review_operating_expense(target_expense_id uuid,decision_value text,note_value text)
returns void language plpgsql security definer set search_path=public as $$
declare e public.operating_expenses; self_review boolean;
begin
  select * into e from public.operating_expenses where id=target_expense_id for update;
  if not found then raise exception 'Expense record not found'; end if;
  if not public.has_hotel_permission(e.hotel_id,'expenses.review') then raise exception 'Not authorised to review operating expenses'; end if;
  if e.status<>'pending_review' then raise exception 'Only pending expenses can be reviewed'; end if;
  self_review := e.submitted_by = auth.uid();
  if self_review and not exists (
    select 1 from public.user_roles ur join public.roles r on r.id=ur.role_id
    where ur.profile_id=auth.uid() and r.hotel_id=e.hotel_id and r.code='accountant' and r.active
  ) then raise exception 'Only the accountant may review their own expense'; end if;
  if decision_value not in ('approved','rejected') then raise exception 'Choose approve or reject'; end if;
  if nullif(trim(note_value),'') is null or length(trim(note_value))<3 then raise exception 'A review note of at least 3 characters is required'; end if;
  update public.operating_expenses set status=decision_value,reviewed_by=auth.uid(),reviewed_at=now(),review_note=trim(note_value) where id=e.id;
  perform public.log_activity(e.hotel_id,case when decision_value='approved' then 'expense.approved' else 'expense.rejected' end,
    'operating_expense',e.id,jsonb_build_object('expense_number',e.expense_number,'amount_kobo',e.amount_kobo,
      'review_note',trim(note_value),'self_review',self_review));
end;
$$;

create or replace function public.decide_finance_approval(target_request_id uuid, approve boolean, decision_note_value text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r public.finance_approval_requests; self_review boolean;
begin
  select * into r from public.finance_approval_requests where id = target_request_id for update;
  if not found then raise exception 'Financial approval request not found'; end if;
  if not public.has_hotel_permission(r.hotel_id, 'finance_approvals.approve') then raise exception 'Not authorised to approve financial corrections'; end if;
  self_review := r.requested_by = auth.uid();
  if self_review and not exists (
    select 1 from public.user_roles ur join public.roles role on role.id=ur.role_id
    where ur.profile_id=auth.uid() and role.hotel_id=r.hotel_id and role.code='accountant' and role.active
  ) then raise exception 'Only the accountant may approve their own correction request'; end if;
  if r.status <> 'pending' then raise exception 'Only pending requests can be decided'; end if;
  if r.expires_at <= now() then update public.finance_approval_requests set status = 'expired' where id = r.id; raise exception 'This request has expired'; end if;
  if nullif(trim(decision_note_value), '') is null or length(trim(decision_note_value)) < 3 then raise exception 'A decision note of at least 3 characters is required'; end if;
  update public.finance_approval_requests set status = case when approve then 'approved' else 'rejected' end,
    decided_by = auth.uid(), decided_at = now(), decision_note = trim(decision_note_value) where id = r.id;
  perform public.log_activity(r.hotel_id, case when approve then 'finance_approval.approved' else 'finance_approval.rejected' end,
    'finance_approval_request', r.id, jsonb_build_object('action_type', r.action_type,
      'decision_note', trim(decision_note_value), 'self_review', self_review));
end;
$$;

create or replace function public.review_internal_daily_reconciliation(target_id uuid, decision_value text, note_value text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.internal_daily_reconciliations; self_review boolean;
begin
  select * into strict r from public.internal_daily_reconciliations where id = target_id;
  perform public.assert_internal_finance_access(r.hotel_id, 'review');
  perform 1 from public.hotels where id = r.hotel_id for update;
  select * into strict r from public.internal_daily_reconciliations where id = target_id for update;
  if r.status <> 'submitted' then raise exception 'Only submitted reconciliations can be reviewed'; end if;
  self_review := r.submitted_by = auth.uid();
  if self_review and not exists (
    select 1 from public.user_roles ur join public.roles role on role.id=ur.role_id
    where ur.profile_id=auth.uid() and role.hotel_id=r.hotel_id and role.code='accountant' and role.active
  ) then raise exception 'Only the accountant may review their own reconciliation'; end if;
  if decision_value is null or decision_value not in ('approved', 'rejected')
    or coalesce(length(trim(note_value)), 0) < 3 or length(note_value) > 2000 then
    raise exception 'Choose approve or reject and provide a review note';
  end if;
  if decision_value = 'approved' and r.source_snapshot is distinct from public.build_internal_reconciliation_source(r.hotel_id, r.business_date) then
    raise exception 'Source records changed. Reject this submission and prepare a new reconciliation';
  end if;
  update public.internal_daily_reconciliations set status = decision_value, reviewed_by = auth.uid(), reviewed_at = now(), review_note = trim(note_value)
    where id = r.id;
  perform public.log_activity(r.hotel_id, 'internal_reconciliation.' || decision_value, 'internal_daily_reconciliation', r.id,
    jsonb_build_object('business_date', r.business_date, 'review_note', trim(note_value), 'self_review', self_review));
end;
$$;

revoke all on function public.review_operating_expense(uuid,text,text),
  public.decide_finance_approval(uuid,boolean,text),
  public.review_internal_daily_reconciliation(uuid,text,text) from public, anon;
grant execute on function public.review_operating_expense(uuid,text,text),
  public.decide_finance_approval(uuid,boolean,text),
  public.review_internal_daily_reconciliation(uuid,text,text) to authenticated;

-- The combined-payment refund has an additional execution-time separation
-- guard. Match the accountant exception here, otherwise a self-approved
-- request could be approved but never executed.
create or replace function public.execute_approved_combined_guest_refund(target_request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.finance_approval_requests; c public.combined_guest_payments;
  p public.payments; f public.guest_folios; shift_id uuid; method_code text;
  refund_id uuid; refund_number_value text; order_link public.combined_guest_payment_orders;
  totals record;
begin
  select * into r from public.finance_approval_requests where id = target_request_id for update;
  if not found or r.action_type <> 'combined_payment_refund' or r.status <> 'approved'
      or r.expires_at <= now() then raise exception 'Approved combined refund not found'; end if;
  if not public.has_hotel_permission(r.hotel_id, 'finance_approvals.approve')
      or r.decided_by <> auth.uid()
      or (r.requested_by = auth.uid() and not exists (
        select 1 from public.user_roles ur join public.roles role on role.id=ur.role_id
        where ur.profile_id=auth.uid() and role.hotel_id=r.hotel_id and role.code='accountant' and role.active
      )) then raise exception 'Only the approver may execute the refund';
  end if;
  select * into c from public.combined_guest_payments where payment_id = r.target_entity_id;
  select * into p from public.payments where id = c.payment_id for update;
  select * into f from public.guest_folios where id = c.folio_id for update;
  if c.hotel_id <> r.hotel_id or p.status <> 'completed' or f.status <> 'open'
      or exists (select 1 from public.payment_refunds where payment_id = p.id) then
    raise exception 'The original combined payment is no longer refundable';
  end if;
  for order_link in select * from public.combined_guest_payment_orders
      where payment_id = p.id order by order_id loop
    perform 1 from public.pos_orders where id = order_link.order_id for update;
  end loop;
  select code into method_code from public.payment_methods where id = p.payment_method_id;
  if method_code = 'cash' then
    if not public.has_hotel_permission(p.hotel_id, 'cashier_shifts.open') then
      raise exception 'An authorised hotel cash shift is required for the payout';
    end if;
    select id into shift_id from public.cashier_shifts
      where hotel_id = p.hotel_id and opened_by = auth.uid() and status = 'open' for update;
    if shift_id is null then raise exception 'Open a hotel cash shift before this refund'; end if;
  elsif nullif(trim(r.payload ->> 'reference'), '') is null then
    raise exception 'A payout reference is required';
  end if;
  if (r.payload ->> 'amount_kobo')::bigint <> p.amount_kobo then
    raise exception 'A combined payment refund must reverse the full external collection';
  end if;
  refund_number_value := public.next_document_number(p.hotel_id, 'RFN');
  perform set_config('app.combined_refund_id', p.id::text, true);
  insert into public.payment_refunds(hotel_id, refund_number, payment_id,
    folio_id, amount_kobo, reference, reason, refunded_by, cashier_shift_id)
  values(p.hotel_id, refund_number_value, p.id, f.id, p.amount_kobo,
    nullif(trim(r.payload ->> 'reference'), ''), r.reason, auth.uid(), shift_id)
  returning id into refund_id;
  update public.payments set status = 'refunded' where id = p.id;
  perform set_config('app.combined_refund_id', '', true);
  for order_link in select * from public.combined_guest_payment_orders
      where payment_id = p.id order by order_id loop
    select * into totals from public.pos_order_totals(order_link.order_id);
    if totals.completed_kobo < totals.gross_total_kobo then
      update public.pos_orders set status = 'open', settled_at = null
        where id = order_link.order_id;
    end if;
  end loop;
  perform public.log_activity(p.hotel_id, 'payment.combined_refunded', 'payment_refund', refund_id,
    jsonb_build_object('payment_id', p.id, 'amount_kobo', p.amount_kobo,
      'hotel_amount_kobo', c.hotel_amount_kobo, 'refund_number', refund_number_value,
      'approval_request_id', r.id));
end;
$$;
revoke all on function public.execute_approved_combined_guest_refund(uuid) from public, anon, authenticated;

-- Give the discreet Owner email a private exception count without exposing
-- the Owner recipient or delivery configuration to any staff-facing page.
create or replace function public.get_owner_private_self_reviews(target_hotel_id uuid, target_date date)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.action), '[]'::jsonb)
  from (
    select al.action, count(*)::bigint as record_count
    from public.activity_logs al
    where al.hotel_id = target_hotel_id and al.metadata->>'self_review' = 'true'
      and public.hotel_business_date(target_hotel_id, al.occurred_at) = target_date
    group by al.action
  ) x;
$$;
revoke all on function public.get_owner_private_self_reviews(uuid,date) from public, anon, authenticated;
grant execute on function public.get_owner_private_self_reviews(uuid,date) to service_role;

notify pgrst, 'reload schema';
