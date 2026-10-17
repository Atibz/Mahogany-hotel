-- Financial corrections require an independently approved, append-only request.

create table public.finance_approval_requests (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  action_type text not null check (action_type in ('void_payment', 'refund_payment', 'folio_adjustment', 'reverse_folio_item')),
  target_entity_type text not null,
  target_entity_id uuid not null,
  payload jsonb not null,
  reason text not null check (length(trim(reason)) > 0),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'executed', 'expired')),
  decided_by uuid references public.profiles(id) on delete restrict,
  decided_at timestamptz,
  decision_note text,
  executed_by uuid references public.profiles(id) on delete restrict,
  executed_at timestamptz,
  check ((status in ('pending', 'withdrawn', 'expired') and decided_at is null and executed_at is null) or (status in ('approved', 'rejected') and decided_at is not null and executed_at is null) or (status = 'executed' and decided_at is not null and executed_at is not null))
);
create index finance_approval_requests_hotel_status_idx on public.finance_approval_requests(hotel_id, status, requested_at desc);

insert into public.permissions (code, name, description) values
  ('finance_approvals.request', 'Request financial correction', 'Request a void, refund, folio adjustment, or charge reversal for approval.'),
  ('finance_approvals.approve', 'Approve financial correction', 'Independently approve and execute requested financial corrections.')
on conflict (code) do nothing;

create or replace function public.provision_finance_approval_permissions(target_hotel_id uuid) returns void language sql security definer set search_path = public as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id from public.roles r join public.permissions p on
    (r.code in ('cashier', 'accountant', 'general_manager') and p.code = 'finance_approvals.request')
    or (r.code = 'general_manager' and p.code = 'finance_approvals.approve')
  where r.hotel_id = target_hotel_id on conflict do nothing;
$$;
select public.provision_finance_approval_permissions(id) from public.hotels;

create or replace function public.handle_hotel_finance_approval_permission_provisioning() returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.provision_finance_approval_permissions(new.id); return new; end;
$$;
drop trigger if exists zzzzzzzzz_hotel_finance_approval_permissions on public.hotels;
create trigger zzzzzzzzz_hotel_finance_approval_permissions after insert on public.hotels for each row execute function public.handle_hotel_finance_approval_permission_provisioning();

create or replace function public.request_finance_approval(request_action_type text, target_id uuid, amount_kobo bigint default null, request_reason text default null, request_reference text default null, request_description text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare hotel_id_value uuid; entity_type_value text; request_id uuid; payload_value jsonb;
begin
  if nullif(trim(request_reason), '') is null then raise exception 'A correction reason is required'; end if;
  case request_action_type
    when 'void_payment' then select hotel_id into hotel_id_value from public.payments where id = target_id; entity_type_value := 'payment'; if hotel_id_value is null or not public.has_hotel_permission(hotel_id_value, 'payments.void') then raise exception 'Not authorised to request a payment void'; end if; payload_value := jsonb_build_object('payment_id', target_id);
    when 'refund_payment' then select hotel_id into hotel_id_value from public.payments where id = target_id; entity_type_value := 'payment'; if amount_kobo is null or amount_kobo <= 0 then raise exception 'Refund amount must be greater than zero'; end if; if hotel_id_value is null or not public.has_hotel_permission(hotel_id_value, 'payments.refund') then raise exception 'Not authorised to request a payment refund'; end if; payload_value := jsonb_build_object('payment_id', target_id, 'amount_kobo', amount_kobo, 'reference', nullif(trim(request_reference), ''));
    when 'folio_adjustment' then select hotel_id into hotel_id_value from public.guest_folios where id = target_id; entity_type_value := 'folio'; if amount_kobo is null or amount_kobo = 0 or nullif(trim(request_description), '') is null then raise exception 'Adjustment amount and description are required'; end if; if hotel_id_value is null or not public.has_hotel_permission(hotel_id_value, 'folios.adjust') then raise exception 'Not authorised to request a folio adjustment'; end if; payload_value := jsonb_build_object('folio_id', target_id, 'amount_kobo', amount_kobo, 'description', trim(request_description));
    when 'reverse_folio_item' then select hotel_id into hotel_id_value from public.folio_items where id = target_id; entity_type_value := 'folio_item'; if hotel_id_value is null or not public.has_hotel_permission(hotel_id_value, 'folios.reverse') then raise exception 'Not authorised to request a charge reversal'; end if; payload_value := jsonb_build_object('folio_item_id', target_id);
    else raise exception 'Unsupported financial approval action';
  end case;
  if not public.has_hotel_permission(hotel_id_value, 'finance_approvals.request') then raise exception 'Not authorised to request financial corrections'; end if;
  insert into public.finance_approval_requests(hotel_id, action_type, target_entity_type, target_entity_id, payload, reason, requested_by)
  values(hotel_id_value, request_action_type, entity_type_value, target_id, payload_value, trim(request_reason), auth.uid()) returning id into request_id;
  perform public.log_activity(hotel_id_value, 'finance_approval.requested', 'finance_approval_request', request_id, jsonb_build_object('action_type', request_action_type, 'target_entity_id', target_id));
  return request_id;
end; $$;

create or replace function public.decide_finance_approval(target_request_id uuid, approve boolean, decision_note_value text default null) returns void language plpgsql security definer set search_path = public as $$
declare r public.finance_approval_requests;
begin
  select * into r from public.finance_approval_requests where id = target_request_id for update;
  if not found then raise exception 'Financial approval request not found'; end if;
  if not public.has_hotel_permission(r.hotel_id, 'finance_approvals.approve') then raise exception 'Not authorised to approve financial corrections'; end if;
  if r.requested_by = auth.uid() then raise exception 'You cannot approve your own financial correction request'; end if;
  if r.status <> 'pending' then raise exception 'Only pending requests can be decided'; end if;
  if r.expires_at <= now() then update public.finance_approval_requests set status = 'expired' where id = r.id; raise exception 'This request has expired'; end if;
  if nullif(trim(decision_note_value), '') is null then raise exception 'An approval or rejection note is required'; end if;
  update public.finance_approval_requests set status = case when approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(), decision_note = trim(decision_note_value) where id = r.id;
  perform public.log_activity(r.hotel_id, case when approve then 'finance_approval.approved' else 'finance_approval.rejected' end, 'finance_approval_request', r.id, jsonb_build_object('action_type', r.action_type));
end; $$;

create or replace function public.execute_finance_approval(target_request_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare r public.finance_approval_requests;
begin
  select * into r from public.finance_approval_requests where id = target_request_id for update;
  if not found then raise exception 'Financial approval request not found'; end if;
  if not public.has_hotel_permission(r.hotel_id, 'finance_approvals.approve') then raise exception 'Not authorised to execute financial corrections'; end if;
  if r.decided_by <> auth.uid() then raise exception 'Only the independent approver may execute this correction'; end if;
  if r.expires_at <= now() then update public.finance_approval_requests set status = 'expired' where id = r.id; raise exception 'This request has expired'; end if;
  if r.status <> 'approved' then raise exception 'Only an approved request can be executed'; end if;
  case r.action_type
    when 'void_payment' then perform public.void_folio_payment((r.payload->>'payment_id')::uuid, r.reason);
    when 'refund_payment' then perform public.refund_folio_payment((r.payload->>'payment_id')::uuid, (r.payload->>'amount_kobo')::bigint, r.reason, r.payload->>'reference');
    when 'folio_adjustment' then perform public.create_folio_adjustment((r.payload->>'folio_id')::uuid, (r.payload->>'amount_kobo')::bigint, r.payload->>'description', r.reason);
    when 'reverse_folio_item' then perform public.reverse_folio_item((r.payload->>'folio_item_id')::uuid, r.reason);
  end case;
  update public.finance_approval_requests set status = 'executed', executed_by = auth.uid(), executed_at = now() where id = r.id;
  perform public.log_activity(r.hotel_id, 'finance_approval.executed', 'finance_approval_request', r.id, jsonb_build_object('action_type', r.action_type));
end; $$;

revoke all on public.finance_approval_requests from public, anon, authenticated;
grant select on public.finance_approval_requests to authenticated;
alter table public.finance_approval_requests enable row level security;
create policy finance_approval_requests_read on public.finance_approval_requests for select to authenticated using (requested_by = auth.uid() or public.has_hotel_permission(hotel_id, 'finance_approvals.approve'));
revoke all on function public.void_folio_payment(uuid, text), public.refund_folio_payment(uuid, bigint, text, text), public.create_folio_adjustment(uuid, bigint, text, text), public.reverse_folio_item(uuid, text) from authenticated;
revoke all on function public.provision_finance_approval_permissions(uuid), public.request_finance_approval(text, uuid, bigint, text, text, text), public.decide_finance_approval(uuid, boolean, text), public.execute_finance_approval(uuid) from public, anon;
grant execute on function public.request_finance_approval(text, uuid, bigint, text, text, text), public.decide_finance_approval(uuid, boolean, text), public.execute_finance_approval(uuid) to authenticated;
