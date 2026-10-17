-- Mahogany Hotel Management System: foundation, RBAC, and operational settings.
-- Apply with the Supabase CLI or SQL editor before application modules are deployed.

create extension if not exists pgcrypto;

create type public.tax_jurisdiction as enum ('federal', 'state', 'local');
create type public.tax_basis as enum ('percentage', 'fixed');
create type public.price_treatment as enum ('exclusive', 'inclusive');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.hotels (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  trading_name text not null,
  address_line_1 text,
  address_line_2 text,
  city text not null default 'Ibadan',
  state text not null default 'Oyo State',
  country_code char(2) not null default 'NG' check (country_code = 'NG'),
  timezone text not null default 'Africa/Lagos',
  currency_code char(3) not null default 'NGN' check (currency_code = 'NGN'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.hotel_settings (
  hotel_id uuid primary key references public.hotels(id) on delete restrict,
  phone text,
  email text,
  logo_path text,
  business_day_cutoff_time time not null default '02:00',
  standard_check_in_time time,
  standard_check_out_time time,
  receipt_prefix text not null default 'RCP',
  invoice_prefix text not null default 'INV',
  rates_price_treatment public.price_treatment not null default 'exclusive',
  privacy_retention_policy_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  code text not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, code),
  unique (hotel_id, name)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  code text not null,
  name text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, code),
  unique (hotel_id, name)
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text not null,
  created_at timestamptz not null default now()
);

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table public.user_roles (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  primary key (profile_id, role_id)
);

create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  code text not null,
  name text not null,
  requires_reference boolean not null default false,
  active boolean not null default true,
  display_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, code),
  unique (hotel_id, name)
);

create table public.tax_rules (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  code text not null,
  name text not null,
  jurisdiction public.tax_jurisdiction not null,
  basis public.tax_basis not null default 'percentage',
  rate_basis_points integer not null default 0 check (rate_basis_points >= 0),
  fixed_amount_kobo bigint not null default 0 check (fixed_amount_kobo >= 0),
  price_treatment public.price_treatment not null default 'exclusive',
  calculation_order smallint not null default 10 check (calculation_order > 0),
  applies_to text[] not null check (cardinality(applies_to) > 0),
  excluded_tax_codes text[] not null default '{}',
  effective_from date not null,
  effective_to date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  check (
    (basis = 'percentage' and fixed_amount_kobo = 0)
    or (basis = 'fixed' and rate_basis_points = 0)
  ),
  unique (hotel_id, code, effective_from)
);

create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

create index user_roles_profile_id_idx on public.user_roles(profile_id);
create index roles_hotel_id_idx on public.roles(hotel_id);
create index payment_methods_hotel_id_idx on public.payment_methods(hotel_id);
create index tax_rules_hotel_id_effective_idx on public.tax_rules(hotel_id, effective_from desc);
create index activity_logs_hotel_occurred_idx on public.activity_logs(hotel_id, occurred_at desc);
create index activity_logs_entity_idx on public.activity_logs(entity_type, entity_id);

create trigger hotels_set_updated_at before update on public.hotels
for each row execute function public.set_updated_at();
create trigger hotel_settings_set_updated_at before update on public.hotel_settings
for each row execute function public.set_updated_at();
create trigger departments_set_updated_at before update on public.departments
for each row execute function public.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger roles_set_updated_at before update on public.roles
for each row execute function public.set_updated_at();
create trigger payment_methods_set_updated_at before update on public.payment_methods
for each row execute function public.set_updated_at();
create trigger tax_rules_set_updated_at before update on public.tax_rules
for each row execute function public.set_updated_at();

-- Auth accounts are provisioned by an administrator; the trigger only creates the
-- application profile. The role assignment happens through an audited admin workflow.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger auth_user_profile_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- SECURITY DEFINER lets the policy helpers inspect RBAC tables without exposing those
-- joins to callers. Set search_path explicitly to avoid search-path injection.
create or replace function public.is_active_staff()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active = true
  );
$$;

create or replace function public.has_hotel_access(target_hotel_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select public.is_active_staff() and exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.profile_id = auth.uid()
      and r.hotel_id = target_hotel_id
      and r.active = true
  );
$$;

create or replace function public.has_hotel_permission(target_hotel_id uuid, required_code text)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select public.is_active_staff() and exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    left join public.role_permissions rp on rp.role_id = r.id
    left join public.permissions p on p.id = rp.permission_id
    where ur.profile_id = auth.uid()
      and r.hotel_id = target_hotel_id
      and r.active = true
      and (r.code = 'owner' or p.code = required_code)
  );
$$;

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant usage on schema public to authenticated;
grant select on public.hotels, public.hotel_settings, public.departments,
  public.profiles, public.roles, public.permissions, public.role_permissions,
  public.user_roles, public.payment_methods, public.tax_rules, public.activity_logs
  to authenticated;
grant insert on public.activity_logs to authenticated;

alter table public.hotels enable row level security;
alter table public.hotel_settings enable row level security;
alter table public.departments enable row level security;
alter table public.profiles enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles enable row level security;
alter table public.payment_methods enable row level security;
alter table public.tax_rules enable row level security;
alter table public.activity_logs enable row level security;

create policy hotels_read on public.hotels for select to authenticated
using (public.has_hotel_access(id));
create policy hotel_settings_read on public.hotel_settings for select to authenticated
using (public.has_hotel_access(hotel_id));
create policy departments_read on public.departments for select to authenticated
using (public.has_hotel_access(hotel_id));
create policy profiles_read on public.profiles for select to authenticated
using (id = auth.uid() or exists (
  select 1 from public.user_roles ur
  join public.roles r on r.id = ur.role_id
  where ur.profile_id = auth.uid()
    and public.has_hotel_permission(r.hotel_id, 'staff.read')
));
create policy roles_read on public.roles for select to authenticated
using (public.has_hotel_access(hotel_id));
create policy permissions_read on public.permissions for select to authenticated
using (public.is_active_staff());
create policy role_permissions_read on public.role_permissions for select to authenticated
using (exists (
  select 1 from public.roles r
  where r.id = role_id and public.has_hotel_access(r.hotel_id)
));
create policy user_roles_read on public.user_roles for select to authenticated
using (profile_id = auth.uid() or exists (
  select 1 from public.roles r
  where r.id = role_id and public.has_hotel_permission(r.hotel_id, 'staff.read')
));
create policy payment_methods_read on public.payment_methods for select to authenticated
using (public.has_hotel_access(hotel_id));
create policy tax_rules_read on public.tax_rules for select to authenticated
using (public.has_hotel_permission(hotel_id, 'settings.read'));
create policy activity_logs_read on public.activity_logs for select to authenticated
using (public.has_hotel_permission(hotel_id, 'audit.read'));
create policy activity_logs_insert on public.activity_logs for insert to authenticated
with check (actor_id = auth.uid() and public.has_hotel_access(hotel_id));

-- No generic client-side update/delete/write policies are granted. Later migrations add
-- narrowly scoped RPC functions for settings, staff, and financial state transitions.
