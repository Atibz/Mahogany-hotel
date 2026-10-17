-- Reception may agree discounts up to and including 20%. Deeper discounts
-- require an immutable request and independent GM/Owner approval. Walk-ins
-- cannot wait for approval, so deeper discounts must be prepared as a
-- reservation before check-in.

insert into public.permissions (code, name, description)
values ('reservation_discounts.request', 'Request exceptional reservation discount', 'Request GM approval for a reservation discount above 20%.')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'reservation_discounts.request'
where r.code in ('receptionist', 'general_manager')
on conflict do nothing;

create or replace function public.provision_finance_approval_permissions(target_hotel_id uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id from public.roles r join public.permissions p on
    (r.code in ('cashier', 'accountant', 'general_manager') and p.code = 'finance_approvals.request')
    or (r.code = 'general_manager' and p.code = 'finance_approvals.approve')
    or (r.code in ('receptionist', 'general_manager') and p.code = 'reservation_discounts.request')
  where r.hotel_id = target_hotel_id on conflict do nothing;
$$;

do $$
declare constraint_name text;
begin
  select c.conname into constraint_name
  from pg_constraint c
  where c.conrelid = 'public.finance_approval_requests'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%action_type%'
  limit 1;
  if constraint_name is not null then
    execute format('alter table public.finance_approval_requests drop constraint %I', constraint_name);
  end if;
end;
$$;

alter table public.finance_approval_requests
  add constraint finance_approval_requests_action_type_check
  check (action_type in ('void_payment', 'refund_payment', 'folio_adjustment', 'reverse_folio_item', 'reservation_discount'));

create or replace function public.enforce_reservation_discount_limit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare standard_rate bigint;
begin
  select coalesce(r.rate_override_kobo, rt.base_rate_kobo)
  into standard_rate
  from public.room_types rt
  left join public.rooms r on r.id = new.room_id and r.room_type_id = rt.id
  where rt.id = new.room_type_id and rt.hotel_id = new.hotel_id;

  if standard_rate is null or standard_rate <= 0 then
    raise exception 'A valid standard room rate is required';
  end if;
  if new.agreed_rate_kobo < 0 then raise exception 'Rate cannot be negative'; end if;

  if new.agreed_rate_kobo * 100 < standard_rate * 80 and not exists (
    select 1
    from public.finance_approval_requests far
    where far.hotel_id = new.hotel_id
      and far.action_type = 'reservation_discount'
      and far.target_entity_type = 'reservation'
      and far.target_entity_id = new.id
      and far.status in ('approved', 'executed')
      and (far.payload->>'requested_rate_kobo')::bigint = new.agreed_rate_kobo
      and (far.payload->>'standard_rate_kobo')::bigint = standard_rate
  ) then
    raise exception 'Discounts above 20%% require an approved GM or Owner request';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_reservation_discount_limit on public.reservations;
create trigger enforce_reservation_discount_limit
before insert or update of room_type_id, room_id, agreed_rate_kobo on public.reservations
for each row execute function public.enforce_reservation_discount_limit();

create or replace function public.request_reservation_discount(
  target_reservation_id uuid,
  requested_rate_kobo bigint,
  request_reason text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  reservation_record public.reservations;
  standard_rate bigint;
  request_id uuid;
  discount_basis_points integer;
begin
  select * into reservation_record
  from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if reservation_record.status not in ('pending', 'confirmed') then
    raise exception 'Only a pending or confirmed reservation can receive a discount approval';
  end if;
  if not public.has_hotel_permission(reservation_record.hotel_id, 'reservation_discounts.request') then
    raise exception 'Not authorised to request an exceptional discount';
  end if;
  if nullif(trim(request_reason), '') is null then raise exception 'A discount reason is required'; end if;
  if requested_rate_kobo < 0 then raise exception 'Requested rate cannot be negative'; end if;

  select coalesce(r.rate_override_kobo, rt.base_rate_kobo)
  into standard_rate
  from public.room_types rt
  left join public.rooms r on r.id = reservation_record.room_id and r.room_type_id = rt.id
  where rt.id = reservation_record.room_type_id and rt.hotel_id = reservation_record.hotel_id;
  if standard_rate is null or standard_rate <= 0 then raise exception 'A valid standard room rate is required'; end if;
  if requested_rate_kobo * 100 >= standard_rate * 80 then
    raise exception 'Only discounts above 20%% require this approval workflow';
  end if;
  if exists (
    select 1 from public.finance_approval_requests far
    where far.action_type = 'reservation_discount'
      and far.target_entity_id = reservation_record.id
      and far.status in ('pending', 'approved')
  ) then raise exception 'This reservation already has an active discount request'; end if;

  discount_basis_points := round((standard_rate - requested_rate_kobo)::numeric * 10000 / standard_rate)::integer;
  insert into public.finance_approval_requests (
    hotel_id, action_type, target_entity_type, target_entity_id, payload, reason, requested_by
  ) values (
    reservation_record.hotel_id, 'reservation_discount', 'reservation', reservation_record.id,
    jsonb_build_object(
      'reservation_id', reservation_record.id,
      'standard_rate_kobo', standard_rate,
      'requested_rate_kobo', requested_rate_kobo,
      'discount_basis_points', discount_basis_points
    ), trim(request_reason), auth.uid()
  ) returning id into request_id;

  perform public.log_activity(
    reservation_record.hotel_id, 'reservation.discount_requested',
    'finance_approval_request', request_id,
    jsonb_build_object(
      'reservation_id', reservation_record.id,
      'standard_rate_kobo', standard_rate,
      'requested_rate_kobo', requested_rate_kobo,
      'discount_basis_points', discount_basis_points
    )
  );
  return request_id;
end;
$$;

create or replace function public.create_reservation_with_discount_request(
  target_hotel_id uuid,
  target_guest_id uuid,
  target_room_type_id uuid,
  target_room_id uuid,
  arrival_date date,
  departure_date date,
  requested_rate_kobo bigint,
  request_reason text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  standard_rate bigint;
  reservation_id uuid;
begin
  select coalesce(r.rate_override_kobo, rt.base_rate_kobo)
  into standard_rate
  from public.room_types rt
  join public.rooms r on r.id = target_room_id and r.room_type_id = rt.id
  where rt.id = target_room_type_id and rt.hotel_id = target_hotel_id;
  if standard_rate is null or standard_rate <= 0 then raise exception 'A valid standard room rate is required'; end if;
  if requested_rate_kobo * 100 >= standard_rate * 80 then
    raise exception 'This workflow is only for discounts above 20%%';
  end if;

  reservation_id := public.create_reservation(
    target_hotel_id, target_guest_id, target_room_type_id, target_room_id,
    arrival_date, departure_date, standard_rate
  );
  perform public.request_reservation_discount(reservation_id, requested_rate_kobo, request_reason);
  return reservation_id;
end;
$$;

create or replace function public.apply_approved_reservation_discount(target_request_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  request_record public.finance_approval_requests;
  reservation_record public.reservations;
  current_standard_rate bigint;
begin
  select * into request_record
  from public.finance_approval_requests where id = target_request_id for update;
  if not found or request_record.action_type <> 'reservation_discount' or request_record.status <> 'approved' then
    raise exception 'An approved reservation discount request is required';
  end if;
  select * into reservation_record
  from public.reservations where id = request_record.target_entity_id for update;
  if not found or reservation_record.status not in ('pending', 'confirmed') then
    raise exception 'Reservation is no longer eligible for this discount';
  end if;

  select coalesce(r.rate_override_kobo, rt.base_rate_kobo)
  into current_standard_rate
  from public.room_types rt
  left join public.rooms r on r.id = reservation_record.room_id and r.room_type_id = rt.id
  where rt.id = reservation_record.room_type_id and rt.hotel_id = reservation_record.hotel_id;
  if current_standard_rate <> (request_record.payload->>'standard_rate_kobo')::bigint then
    raise exception 'The standard room rate changed; submit a new discount request';
  end if;

  update public.reservations
  set agreed_rate_kobo = (request_record.payload->>'requested_rate_kobo')::bigint,
      updated_by = auth.uid(), updated_at = now()
  where id = reservation_record.id;
  perform public.log_activity(
    reservation_record.hotel_id, 'reservation.discount_applied', 'reservation', reservation_record.id,
    jsonb_build_object(
      'approval_request_id', request_record.id,
      'standard_rate_kobo', current_standard_rate,
      'agreed_rate_kobo', (request_record.payload->>'requested_rate_kobo')::bigint,
      'discount_basis_points', (request_record.payload->>'discount_basis_points')::integer
    )
  );
end;
$$;

create or replace function public.execute_finance_approval(target_request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
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
    when 'reservation_discount' then perform public.apply_approved_reservation_discount(r.id);
    else raise exception 'Unsupported financial approval action';
  end case;
  update public.finance_approval_requests set status = 'executed', executed_by = auth.uid(), executed_at = now() where id = r.id;
  perform public.log_activity(r.hotel_id, 'finance_approval.executed', 'finance_approval_request', r.id, jsonb_build_object('action_type', r.action_type));
end;
$$;

create or replace function public.enforce_walk_in_discount_limit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare standard_rate bigint;
begin
  if new.reservation_id is not null and exists (
    select 1 from public.finance_approval_requests far
    where far.action_type = 'reservation_discount'
      and far.target_entity_id = new.reservation_id
      and far.status in ('pending', 'approved')
  ) then
    raise exception 'Complete the reservation discount approval before check-in';
  end if;
  select coalesce(r.rate_override_kobo, rt.base_rate_kobo)
  into standard_rate
  from public.rooms r join public.room_types rt on rt.id = r.room_type_id
  where r.id = new.room_id and r.hotel_id = new.hotel_id;
  if standard_rate is null or standard_rate <= 0 then raise exception 'A valid standard room rate is required'; end if;
  if new.reservation_id is null and new.agreed_rate_kobo * 100 < standard_rate * 80 then
    raise exception 'Walk-in discounts above 20%% must be approved through a reservation before check-in';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_walk_in_discount_limit on public.stays;
create trigger enforce_walk_in_discount_limit
before insert on public.stays
for each row execute function public.enforce_walk_in_discount_limit();

revoke all on function public.request_reservation_discount(uuid, bigint, text),
  public.create_reservation_with_discount_request(uuid, uuid, uuid, uuid, date, date, bigint, text),
  public.apply_approved_reservation_discount(uuid),
  public.enforce_reservation_discount_limit(),
  public.enforce_walk_in_discount_limit()
from public, anon, authenticated;
grant execute on function public.request_reservation_discount(uuid, bigint, text),
  public.create_reservation_with_discount_request(uuid, uuid, uuid, uuid, date, date, bigint, text)
to authenticated;
