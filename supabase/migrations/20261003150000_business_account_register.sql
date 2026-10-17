-- Corporate and agency account register.
-- This migration records approved credit terms and billing instructions but
-- does not yet permit a reservation or folio to consume that credit.

insert into public.permissions (code, name, description) values
  ('business_accounts.read', 'View business accounts', 'View corporate and agency billing accounts.'),
  ('business_accounts.manage', 'Manage business accounts', 'Create and maintain corporate and agency billing accounts and credit terms.')
on conflict (code) do nothing;

create table if not exists public.business_accounts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  account_number text not null,
  account_type text not null check (account_type in ('corporate', 'agency')),
  legal_name text not null check (length(trim(legal_name)) > 0),
  trading_name text,
  contact_name text,
  contact_email text check (contact_email is null or position('@' in contact_email) > 1),
  contact_phone text,
  billing_address text,
  tax_identifier text,
  credit_limit_kobo bigint not null default 0 check (credit_limit_kobo >= 0),
  payment_terms_days integer not null default 0 check (payment_terms_days between 0 and 365),
  direct_billing_enabled boolean not null default false,
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  billing_instructions text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, account_number)
);

create index if not exists business_accounts_hotel_status_idx
  on public.business_accounts(hotel_id, status, legal_name);

alter table public.business_accounts enable row level security;
revoke all on public.business_accounts from public, anon, authenticated;
grant select on public.business_accounts to authenticated;

drop policy if exists business_accounts_read on public.business_accounts;
create policy business_accounts_read on public.business_accounts
for select to authenticated
using (public.has_hotel_permission(hotel_id, 'business_accounts.read'));

create or replace function public.create_business_account(
  target_hotel_id uuid,
  account_type_value text,
  legal_name_value text,
  trading_name_value text default null,
  contact_name_value text default null,
  contact_email_value text default null,
  contact_phone_value text default null,
  billing_address_value text default null,
  tax_identifier_value text default null,
  credit_limit_kobo_value bigint default 0,
  payment_terms_days_value integer default 0,
  direct_billing_enabled_value boolean default false,
  billing_instructions_value text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  account_id uuid;
  generated_account_number text;
begin
  if not public.has_hotel_permission(target_hotel_id, 'business_accounts.manage') then
    raise exception 'Not authorised to manage business accounts';
  end if;
  if account_type_value not in ('corporate', 'agency') then
    raise exception 'Account type must be corporate or agency';
  end if;
  if nullif(trim(legal_name_value), '') is null then
    raise exception 'Legal name is required';
  end if;
  if credit_limit_kobo_value < 0 then raise exception 'Credit limit cannot be negative'; end if;
  if payment_terms_days_value not between 0 and 365 then raise exception 'Payment terms must be between 0 and 365 days'; end if;
  if direct_billing_enabled_value and credit_limit_kobo_value = 0 then
    raise exception 'Direct billing requires a positive approved credit limit';
  end if;

  generated_account_number := public.next_document_number(target_hotel_id, 'BAC');
  insert into public.business_accounts (
    hotel_id, account_number, account_type, legal_name, trading_name,
    contact_name, contact_email, contact_phone, billing_address, tax_identifier,
    credit_limit_kobo, payment_terms_days, direct_billing_enabled,
    billing_instructions, created_by, updated_by
  ) values (
    target_hotel_id, generated_account_number, account_type_value, trim(legal_name_value),
    nullif(trim(trading_name_value), ''), nullif(trim(contact_name_value), ''),
    nullif(trim(contact_email_value), ''), nullif(trim(contact_phone_value), ''),
    nullif(trim(billing_address_value), ''), nullif(trim(tax_identifier_value), ''),
    credit_limit_kobo_value, payment_terms_days_value, direct_billing_enabled_value,
    nullif(trim(billing_instructions_value), ''), auth.uid(), auth.uid()
  ) returning id into account_id;

  perform public.log_activity(target_hotel_id, 'business_account.created', 'business_account', account_id,
    jsonb_build_object('account_number', generated_account_number, 'account_type', account_type_value,
      'credit_limit_kobo', credit_limit_kobo_value, 'payment_terms_days', payment_terms_days_value,
      'direct_billing_enabled', direct_billing_enabled_value));
  return account_id;
end;
$$;

create or replace function public.update_business_account(
  target_account_id uuid,
  account_type_value text,
  legal_name_value text,
  trading_name_value text default null,
  contact_name_value text default null,
  contact_email_value text default null,
  contact_phone_value text default null,
  billing_address_value text default null,
  tax_identifier_value text default null,
  credit_limit_kobo_value bigint default 0,
  payment_terms_days_value integer default 0,
  direct_billing_enabled_value boolean default false,
  status_value text default 'active',
  billing_instructions_value text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_account public.business_accounts;
begin
  select * into target_account from public.business_accounts where id = target_account_id for update;
  if not found then raise exception 'Business account not found'; end if;
  if not public.has_hotel_permission(target_account.hotel_id, 'business_accounts.manage') then
    raise exception 'Not authorised to manage business accounts';
  end if;
  if account_type_value not in ('corporate', 'agency') then raise exception 'Account type must be corporate or agency'; end if;
  if nullif(trim(legal_name_value), '') is null then raise exception 'Legal name is required'; end if;
  if credit_limit_kobo_value < 0 then raise exception 'Credit limit cannot be negative'; end if;
  if payment_terms_days_value not between 0 and 365 then raise exception 'Payment terms must be between 0 and 365 days'; end if;
  if status_value not in ('active', 'suspended', 'closed') then raise exception 'Invalid account status'; end if;
  if direct_billing_enabled_value and credit_limit_kobo_value = 0 then
    raise exception 'Direct billing requires a positive approved credit limit';
  end if;

  update public.business_accounts set
    account_type = account_type_value,
    legal_name = trim(legal_name_value),
    trading_name = nullif(trim(trading_name_value), ''),
    contact_name = nullif(trim(contact_name_value), ''),
    contact_email = nullif(trim(contact_email_value), ''),
    contact_phone = nullif(trim(contact_phone_value), ''),
    billing_address = nullif(trim(billing_address_value), ''),
    tax_identifier = nullif(trim(tax_identifier_value), ''),
    credit_limit_kobo = credit_limit_kobo_value,
    payment_terms_days = payment_terms_days_value,
    direct_billing_enabled = direct_billing_enabled_value,
    status = status_value,
    billing_instructions = nullif(trim(billing_instructions_value), ''),
    updated_by = auth.uid(), updated_at = now()
  where id = target_account.id;

  perform public.log_activity(target_account.hotel_id, 'business_account.updated', 'business_account', target_account.id,
    jsonb_build_object('account_number', target_account.account_number,
      'previous_credit_limit_kobo', target_account.credit_limit_kobo,
      'credit_limit_kobo', credit_limit_kobo_value,
      'previous_status', target_account.status, 'status', status_value,
      'direct_billing_enabled', direct_billing_enabled_value));
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
    (r.code = 'general_manager' and p.code in ('business_accounts.read', 'business_accounts.manage'))
    or (r.code = 'accountant' and p.code = 'business_accounts.read')
  )
  where r.hotel_id = target_hotel_id
  on conflict do nothing;
$$;

select public.provision_business_account_permissions(id) from public.hotels;

create or replace function public.handle_hotel_business_account_permission_provisioning()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_business_account_permissions(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzz_hotel_business_account_permissions on public.hotels;
create trigger zzzzzz_hotel_business_account_permissions
after insert on public.hotels
for each row execute function public.handle_hotel_business_account_permission_provisioning();

revoke all on function public.create_business_account(uuid, text, text, text, text, text, text, text, text, bigint, integer, boolean, text),
  public.update_business_account(uuid, text, text, text, text, text, text, text, text, bigint, integer, boolean, text, text),
  public.provision_business_account_permissions(uuid),
  public.handle_hotel_business_account_permission_provisioning() from public, anon;
grant execute on function public.create_business_account(uuid, text, text, text, text, text, text, text, text, bigint, integer, boolean, text),
  public.update_business_account(uuid, text, text, text, text, text, text, text, text, bigint, integer, boolean, text, text) to authenticated;
