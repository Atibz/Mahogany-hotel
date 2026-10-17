-- Narrow reservation-facing business account directory. Reception can select
-- an active account without receiving unrestricted table access.

create or replace function public.get_reservation_business_account_directory(target_hotel_id uuid)
returns table (
  id uuid,
  account_number text,
  account_type text,
  display_name text,
  direct_billing_enabled boolean,
  credit_limit_kobo bigint,
  credit_exposure_kobo bigint,
  available_credit_kobo bigint,
  payment_terms_days integer
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not (
    public.has_hotel_permission(target_hotel_id, 'reservations.read')
    or public.has_hotel_permission(target_hotel_id, 'business_accounts.read')
  ) then raise exception 'Not authorised to view business accounts'; end if;
  return query
  select ba.id, ba.account_number, ba.account_type,
    coalesce(ba.trading_name, ba.legal_name) as display_name,
    ba.direct_billing_enabled, ba.credit_limit_kobo,
    public.business_account_credit_exposure(ba.id) as credit_exposure_kobo,
    greatest(ba.credit_limit_kobo - public.business_account_credit_exposure(ba.id), 0) as available_credit_kobo,
    ba.payment_terms_days
  from public.business_accounts ba
  where ba.hotel_id = target_hotel_id and ba.status = 'active'
  order by coalesce(ba.trading_name, ba.legal_name);
end;
$$;

create or replace function public.get_reservation_business_authorizations(target_hotel_id uuid)
returns table (
  authorization_id uuid,
  reservation_id uuid,
  business_account_id uuid,
  account_number text,
  account_name text,
  billing_mode text,
  authorized_amount_kobo bigint,
  instructions_snapshot text,
  authorized_at timestamptz
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not (
    public.has_hotel_permission(target_hotel_id, 'reservations.read')
    or public.has_hotel_permission(target_hotel_id, 'business_accounts.read')
  ) then raise exception 'Not authorised to view reservation billing'; end if;
  return query
  select a.id, a.reservation_id, a.business_account_id, ba.account_number,
    coalesce(ba.trading_name, ba.legal_name), a.billing_mode,
    a.authorized_amount_kobo, a.instructions_snapshot, a.authorized_at
  from public.reservation_business_account_authorizations a
  join public.business_accounts ba on ba.id = a.business_account_id
  where a.hotel_id = target_hotel_id and a.status = 'active';
end;
$$;

revoke all on function public.get_reservation_business_account_directory(uuid),
  public.get_reservation_business_authorizations(uuid) from public, anon;
grant execute on function public.get_reservation_business_account_directory(uuid),
  public.get_reservation_business_authorizations(uuid) to authenticated;
