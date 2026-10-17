-- Immutable reservation-to-business-account authorisations and live credit exposure.

insert into public.permissions (code, name, description) values
  ('business_accounts.assign', 'Assign business accounts', 'Associate an active corporate or agency account with a reservation.'),
  ('business_accounts.authorize_credit', 'Authorise business credit', 'Approve direct-bill credit against a reservation within the account limit.')
on conflict (code) do nothing;

create table public.reservation_business_account_authorizations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  business_account_id uuid not null references public.business_accounts(id) on delete restrict,
  billing_mode text not null check (billing_mode in ('reference', 'direct_bill')),
  authorized_amount_kobo bigint not null default 0 check (authorized_amount_kobo >= 0),
  instructions_snapshot text,
  status text not null default 'active' check (status in ('active', 'revoked', 'released', 'settled')),
  authorized_by uuid references public.profiles(id) on delete set null,
  authorized_at timestamptz not null default now(),
  ended_by uuid references public.profiles(id) on delete set null,
  ended_at timestamptz,
  end_reason text,
  check (
    (status = 'active' and ended_at is null and ended_by is null and end_reason is null)
    or (status <> 'active' and ended_at is not null and nullif(trim(end_reason), '') is not null)
  ),
  check (
    (billing_mode = 'reference' and authorized_amount_kobo = 0)
    or (billing_mode = 'direct_bill' and authorized_amount_kobo > 0)
  )
);

create unique index reservation_business_account_one_active_idx
  on public.reservation_business_account_authorizations(reservation_id)
  where status = 'active';
create index reservation_business_account_exposure_idx
  on public.reservation_business_account_authorizations(business_account_id, status);

alter table public.reservation_business_account_authorizations enable row level security;
revoke all on public.reservation_business_account_authorizations from public, anon, authenticated;
grant select on public.reservation_business_account_authorizations to authenticated;

create policy reservation_business_account_read on public.reservation_business_account_authorizations
for select to authenticated using (
  public.has_hotel_permission(hotel_id, 'business_accounts.read')
  or public.has_hotel_permission(hotel_id, 'reservations.read')
);

create or replace function public.business_account_credit_exposure(target_business_account_id uuid)
returns bigint
language sql
stable
security definer set search_path = public
as $$
  select coalesce(sum(a.authorized_amount_kobo), 0)::bigint
  from public.reservation_business_account_authorizations a
  join public.reservations r on r.id = a.reservation_id
  where a.business_account_id = target_business_account_id
    and a.status = 'active'
    and a.billing_mode = 'direct_bill'
    and r.status in ('pending', 'confirmed', 'checked_in');
$$;

create or replace function public.authorize_reservation_business_account(
  target_reservation_id uuid,
  target_business_account_id uuid,
  billing_mode_value text,
  authorized_amount_kobo_value bigint default 0,
  authorization_reason text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_reservation public.reservations;
  target_account public.business_accounts;
  current_exposure bigint;
  expected_room_value bigint;
  authorization_id uuid;
  previous_authorization_id uuid;
begin
  select * into target_reservation from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  select * into target_account from public.business_accounts where id = target_business_account_id for update;
  if not found or target_account.hotel_id <> target_reservation.hotel_id then raise exception 'Business account is not available for this hotel'; end if;
  if target_account.status <> 'active' then raise exception 'Only an active business account can be assigned'; end if;
  if target_reservation.status not in ('pending', 'confirmed') then raise exception 'Business billing must be authorised before check-in'; end if;
  if not public.has_hotel_permission(target_reservation.hotel_id, 'business_accounts.assign') then raise exception 'Not authorised to assign business accounts'; end if;
  if billing_mode_value not in ('reference', 'direct_bill') then raise exception 'Invalid billing mode'; end if;
  if nullif(trim(authorization_reason), '') is null then raise exception 'An assignment reason is required'; end if;

  if billing_mode_value = 'reference' then
    authorized_amount_kobo_value := 0;
  else
    if not public.has_hotel_permission(target_reservation.hotel_id, 'business_accounts.authorize_credit') then raise exception 'Only authorised management may approve direct billing'; end if;
    if not target_account.direct_billing_enabled then raise exception 'Direct billing is disabled for this business account'; end if;
    if authorized_amount_kobo_value <= 0 then raise exception 'Enter a positive authorised amount'; end if;
    expected_room_value := (target_reservation.check_out_date - target_reservation.check_in_date) * target_reservation.agreed_rate_kobo;
    if authorized_amount_kobo_value > expected_room_value then raise exception 'Authorised credit cannot exceed the current reserved room value'; end if;
    current_exposure := public.business_account_credit_exposure(target_account.id);
    if current_exposure + authorized_amount_kobo_value > target_account.credit_limit_kobo then
      raise exception 'Authorisation exceeds the available business credit limit';
    end if;
  end if;

  select id into previous_authorization_id
  from public.reservation_business_account_authorizations
  where reservation_id = target_reservation.id and status = 'active'
  for update;
  if previous_authorization_id is not null then
    update public.reservation_business_account_authorizations
    set status = 'revoked', ended_by = auth.uid(), ended_at = now(), end_reason = 'Replaced by a new authorisation'
    where id = previous_authorization_id;
  end if;

  insert into public.reservation_business_account_authorizations (
    hotel_id, reservation_id, business_account_id, billing_mode,
    authorized_amount_kobo, instructions_snapshot, authorized_by
  ) values (
    target_reservation.hotel_id, target_reservation.id, target_account.id,
    billing_mode_value, authorized_amount_kobo_value,
    target_account.billing_instructions, auth.uid()
  ) returning id into authorization_id;

  perform public.log_activity(target_reservation.hotel_id, 'reservation.business_account_authorized', 'reservation', target_reservation.id,
    jsonb_build_object('authorization_id', authorization_id, 'business_account_id', target_account.id,
      'account_number', target_account.account_number, 'billing_mode', billing_mode_value,
      'authorized_amount_kobo', authorized_amount_kobo_value, 'reason', trim(authorization_reason)));
  return authorization_id;
end;
$$;

create or replace function public.revoke_reservation_business_account(target_reservation_id uuid, revocation_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare target_authorization public.reservation_business_account_authorizations;
begin
  select * into target_authorization from public.reservation_business_account_authorizations
  where reservation_id = target_reservation_id and status = 'active' for update;
  if not found then raise exception 'No active business-account authorisation was found'; end if;
  if not public.has_hotel_permission(target_authorization.hotel_id, 'business_accounts.assign') then raise exception 'Not authorised to change this assignment'; end if;
  if nullif(trim(revocation_reason), '') is null then raise exception 'A revocation reason is required'; end if;
  update public.reservation_business_account_authorizations
  set status = 'revoked', ended_by = auth.uid(), ended_at = now(), end_reason = trim(revocation_reason)
  where id = target_authorization.id;
  perform public.log_activity(target_authorization.hotel_id, 'reservation.business_account_revoked', 'reservation', target_reservation_id,
    jsonb_build_object('authorization_id', target_authorization.id, 'reason', trim(revocation_reason)));
end;
$$;

create or replace function public.provision_business_account_permissions(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on (
    (r.code = 'general_manager' and p.code in (
      'business_accounts.read', 'business_accounts.manage',
      'business_accounts.assign', 'business_accounts.authorize_credit'
    ))
    or (r.code = 'accountant' and p.code = 'business_accounts.read')
    or (r.code = 'receptionist' and p.code = 'business_accounts.assign')
  )
  where r.hotel_id = target_hotel_id
  on conflict do nothing;
$$;

select public.provision_business_account_permissions(id) from public.hotels;

revoke all on function public.business_account_credit_exposure(uuid),
  public.authorize_reservation_business_account(uuid, uuid, text, bigint, text),
  public.revoke_reservation_business_account(uuid, text),
  public.provision_business_account_permissions(uuid) from public, anon;
grant execute on function public.business_account_credit_exposure(uuid),
  public.authorize_reservation_business_account(uuid, uuid, text, bigint, text),
  public.revoke_reservation_business_account(uuid, text) to authenticated;
