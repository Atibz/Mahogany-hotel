-- Shared POS catalog foundation. Order settlement and revenue posting are kept
-- for a later migration so they can reuse the hotel's approved ledger controls.

create table public.pos_outlets (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  code text not null check (code = lower(trim(code)) and code ~ '^[a-z][a-z0-9_]{1,48}$'),
  name text not null check (length(trim(name)) between 1 and 100),
  outlet_type text not null check (outlet_type in ('restaurant', 'bar')),
  department_code text not null,
  kitchen_tickets_enabled boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, code),
  unique (hotel_id, name),
  unique (id, hotel_id),
  foreign key (hotel_id, department_code)
    references public.departments(hotel_id, code) on delete restrict
);

create table public.pos_menu_categories (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  outlet_id uuid not null,
  code text not null check (code = lower(trim(code)) and code ~ '^[a-z][a-z0-9_]{1,48}$'),
  name text not null check (length(trim(name)) between 1 and 100),
  display_order smallint not null default 0 check (display_order >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, code),
  unique (outlet_id, name),
  unique (id, hotel_id, outlet_id),
  foreign key (outlet_id, hotel_id)
    references public.pos_outlets(id, hotel_id) on delete restrict
);

create table public.pos_menu_items (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  outlet_id uuid not null,
  category_id uuid not null,
  code text not null check (code = lower(trim(code)) and code ~ '^[a-z][a-z0-9_]{1,48}$'),
  name text not null check (length(trim(name)) between 1 and 120),
  description text,
  display_order smallint not null default 0 check (display_order >= 0),
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, code),
  unique (id, hotel_id, outlet_id),
  foreign key (category_id, hotel_id, outlet_id)
    references public.pos_menu_categories(id, hotel_id, outlet_id) on delete restrict
);

-- Prices are versions, not in-place edits. Orders will snapshot the selected
-- price and tax calculation when posted in the order-lifecycle migration.
create table public.pos_menu_item_prices (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  outlet_id uuid not null,
  menu_item_id uuid not null,
  amount_kobo bigint not null check (amount_kobo > 0),
  effective_from date not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (menu_item_id, effective_from),
  foreign key (menu_item_id, hotel_id, outlet_id)
    references public.pos_menu_items(id, hotel_id, outlet_id) on delete restrict
);

create table public.pos_modifier_groups (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  outlet_id uuid not null,
  code text not null check (code = lower(trim(code)) and code ~ '^[a-z][a-z0-9_]{1,48}$'),
  name text not null check (length(trim(name)) between 1 and 100),
  min_selections smallint not null default 0 check (min_selections >= 0),
  max_selections smallint not null default 1 check (max_selections between 1 and 20 and min_selections <= max_selections),
  display_order smallint not null default 0 check (display_order >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, code),
  unique (id, hotel_id, outlet_id),
  foreign key (outlet_id, hotel_id)
    references public.pos_outlets(id, hotel_id) on delete restrict
);

create table public.pos_modifier_options (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  outlet_id uuid not null,
  modifier_group_id uuid not null,
  code text not null check (code = lower(trim(code)) and code ~ '^[a-z][a-z0-9_]{1,48}$'),
  name text not null check (length(trim(name)) between 1 and 100),
  price_delta_kobo bigint not null default 0,
  display_order smallint not null default 0 check (display_order >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (modifier_group_id, code),
  unique (id, hotel_id, outlet_id),
  foreign key (modifier_group_id, hotel_id, outlet_id)
    references public.pos_modifier_groups(id, hotel_id, outlet_id) on delete restrict
);

create table public.pos_menu_item_modifier_groups (
  hotel_id uuid not null,
  outlet_id uuid not null,
  menu_item_id uuid not null,
  modifier_group_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (menu_item_id, modifier_group_id),
  foreign key (menu_item_id, hotel_id, outlet_id)
    references public.pos_menu_items(id, hotel_id, outlet_id) on delete restrict,
  foreign key (modifier_group_id, hotel_id, outlet_id)
    references public.pos_modifier_groups(id, hotel_id, outlet_id) on delete restrict
);

create index pos_outlets_hotel_active_idx on public.pos_outlets(hotel_id, active, name);
create index pos_menu_categories_outlet_active_idx on public.pos_menu_categories(outlet_id, active, display_order);
create index pos_menu_items_outlet_active_idx on public.pos_menu_items(outlet_id, active, display_order);
create index pos_menu_item_prices_lookup_idx on public.pos_menu_item_prices(menu_item_id, effective_from desc);
create index pos_modifier_groups_outlet_active_idx on public.pos_modifier_groups(outlet_id, active, display_order);
create index pos_modifier_options_group_active_idx on public.pos_modifier_options(modifier_group_id, active, display_order);

insert into public.permissions (code, name, description) values
  ('pos.catalog.read', 'View POS catalog', 'View active outlets, menu categories, items, and prices.'),
  ('pos.catalog.manage', 'Manage POS catalog', 'Configure outlets, menu categories, menu items, and effective-dated prices.')
on conflict (code) do nothing;

create or replace function public.provision_pos_catalog_permissions(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.code in ('pos.catalog.read', 'pos.catalog.manage')
  where r.hotel_id = target_hotel_id
    and r.code = 'general_manager'
  on conflict do nothing;
$$;

select public.provision_pos_catalog_permissions(id) from public.hotels;

create or replace function public.handle_hotel_pos_catalog_permission_provisioning()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_pos_catalog_permissions(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzzzzzz_hotel_pos_catalog_permissions on public.hotels;
create trigger zzzzzzzzzz_hotel_pos_catalog_permissions
after insert on public.hotels
for each row execute function public.handle_hotel_pos_catalog_permission_provisioning();

revoke all on public.pos_outlets, public.pos_menu_categories, public.pos_menu_items,
  public.pos_menu_item_prices, public.pos_modifier_groups, public.pos_modifier_options,
  public.pos_menu_item_modifier_groups from public, anon, authenticated;
grant select on public.pos_outlets, public.pos_menu_categories,
  public.pos_menu_items, public.pos_menu_item_prices, public.pos_modifier_groups,
  public.pos_modifier_options, public.pos_menu_item_modifier_groups to authenticated;

alter table public.pos_outlets enable row level security;
alter table public.pos_menu_categories enable row level security;
alter table public.pos_menu_items enable row level security;
alter table public.pos_menu_item_prices enable row level security;
alter table public.pos_modifier_groups enable row level security;
alter table public.pos_modifier_options enable row level security;
alter table public.pos_menu_item_modifier_groups enable row level security;

create policy pos_outlets_read on public.pos_outlets for select to authenticated
using (public.has_hotel_permission(hotel_id, 'pos.catalog.read'));
create policy pos_menu_categories_read on public.pos_menu_categories for select to authenticated
using (active and public.has_hotel_permission(hotel_id, 'pos.catalog.read'));
create policy pos_menu_items_read on public.pos_menu_items for select to authenticated
using (active and public.has_hotel_permission(hotel_id, 'pos.catalog.read'));
create policy pos_menu_item_prices_read on public.pos_menu_item_prices for select to authenticated
using (public.has_hotel_permission(hotel_id, 'pos.catalog.read'));
create policy pos_modifier_groups_read on public.pos_modifier_groups for select to authenticated
using (active and public.has_hotel_permission(hotel_id, 'pos.catalog.read'));
create policy pos_modifier_options_read on public.pos_modifier_options for select to authenticated
using (active and public.has_hotel_permission(hotel_id, 'pos.catalog.read'));
create policy pos_menu_item_modifier_groups_read on public.pos_menu_item_modifier_groups for select to authenticated
using (public.has_hotel_permission(hotel_id, 'pos.catalog.read'));

create or replace function public.create_pos_outlet(
  target_hotel_id uuid,
  outlet_code_value text,
  outlet_name_value text,
  outlet_type_value text,
  department_code_value text,
  kitchen_tickets_enabled_value boolean default false
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare new_outlet_id uuid; normalized_code text := lower(trim(outlet_code_value)); normalized_name text := trim(outlet_name_value);
begin
  if not public.has_hotel_permission(target_hotel_id, 'pos.catalog.manage') then raise exception 'Not authorised to manage the POS catalog'; end if;
  if normalized_code is null or normalized_code !~ '^[a-z][a-z0-9_]{1,48}$' then raise exception 'Outlet code must use lowercase letters, numbers, and underscores'; end if;
  if normalized_name is null or length(normalized_name) > 100 then raise exception 'Outlet name must be between 1 and 100 characters'; end if;
  if outlet_type_value is null or outlet_type_value not in ('restaurant', 'bar') then raise exception 'Outlet type must be restaurant or bar'; end if;
  if not exists (select 1 from public.departments d where d.hotel_id = target_hotel_id and d.code = department_code_value and d.active) then raise exception 'Choose an active department for this outlet'; end if;
  insert into public.pos_outlets (hotel_id, code, name, outlet_type, department_code, kitchen_tickets_enabled)
  values (target_hotel_id, normalized_code, normalized_name, outlet_type_value, department_code_value, kitchen_tickets_enabled_value)
  returning id into new_outlet_id;
  perform public.log_activity(target_hotel_id, 'pos.outlet_created', 'pos_outlet', new_outlet_id,
    jsonb_build_object('code', normalized_code, 'type', outlet_type_value, 'department_code', department_code_value));
  return new_outlet_id;
end;
$$;

create or replace function public.create_pos_menu_category(
  target_outlet_id uuid,
  category_code_value text,
  category_name_value text,
  display_order_value integer default 0
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare outlet_record public.pos_outlets; new_category_id uuid; normalized_code text := lower(trim(category_code_value)); normalized_name text := trim(category_name_value);
begin
  select * into outlet_record from public.pos_outlets where id = target_outlet_id and active for update;
  if not found then raise exception 'Active POS outlet not found'; end if;
  if not public.has_hotel_permission(outlet_record.hotel_id, 'pos.catalog.manage') then raise exception 'Not authorised to manage the POS catalog'; end if;
  if normalized_code is null or normalized_code !~ '^[a-z][a-z0-9_]{1,48}$' then raise exception 'Category code must use lowercase letters, numbers, and underscores'; end if;
  if normalized_name is null or length(normalized_name) > 100 then raise exception 'Category name must be between 1 and 100 characters'; end if;
  if display_order_value is null or display_order_value < 0 or display_order_value > 32767 then raise exception 'Display order must be between 0 and 32767'; end if;
  insert into public.pos_menu_categories (hotel_id, outlet_id, code, name, display_order)
  values (outlet_record.hotel_id, outlet_record.id, normalized_code, normalized_name, display_order_value)
  returning id into new_category_id;
  perform public.log_activity(outlet_record.hotel_id, 'pos.category_created', 'pos_menu_category', new_category_id,
    jsonb_build_object('outlet_id', outlet_record.id, 'code', normalized_code));
  return new_category_id;
end;
$$;

create or replace function public.create_pos_menu_item(
  target_outlet_id uuid,
  target_category_id uuid,
  item_code_value text,
  item_name_value text,
  item_description_value text,
  display_order_value integer,
  initial_price_kobo bigint,
  effective_from_value date default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare outlet_record public.pos_outlets; new_item_id uuid; effective_date_value date; normalized_code text := lower(trim(item_code_value)); normalized_name text := trim(item_name_value);
begin
  select * into outlet_record from public.pos_outlets where id = target_outlet_id and active for update;
  if not found then raise exception 'Active POS outlet not found'; end if;
  if not public.has_hotel_permission(outlet_record.hotel_id, 'pos.catalog.manage') then raise exception 'Not authorised to manage the POS catalog'; end if;
  if not exists (select 1 from public.pos_menu_categories c where c.id = target_category_id and c.outlet_id = outlet_record.id and c.hotel_id = outlet_record.hotel_id and c.active) then raise exception 'Choose an active category from this outlet'; end if;
  if normalized_code is null or normalized_code !~ '^[a-z][a-z0-9_]{1,48}$' then raise exception 'Item code must use lowercase letters, numbers, and underscores'; end if;
  if normalized_name is null or length(normalized_name) > 120 then raise exception 'Item name must be between 1 and 120 characters'; end if;
  if display_order_value is null or display_order_value < 0 or display_order_value > 32767 then raise exception 'Display order must be between 0 and 32767'; end if;
  if initial_price_kobo is null or initial_price_kobo <= 0 then raise exception 'Menu price must be greater than zero'; end if;
  effective_date_value := coalesce(effective_from_value, public.hotel_business_date(outlet_record.hotel_id));
  if effective_date_value < public.hotel_business_date(outlet_record.hotel_id) then raise exception 'Menu prices cannot be backdated'; end if;
  insert into public.pos_menu_items (hotel_id, outlet_id, category_id, code, name, description, display_order, created_by)
  values (outlet_record.hotel_id, outlet_record.id, target_category_id, normalized_code, normalized_name,
    nullif(trim(item_description_value), ''), display_order_value, auth.uid())
  returning id into new_item_id;
  insert into public.pos_menu_item_prices (hotel_id, outlet_id, menu_item_id, amount_kobo, effective_from, created_by)
  values (outlet_record.hotel_id, outlet_record.id, new_item_id, initial_price_kobo, effective_date_value, auth.uid());
  perform public.log_activity(outlet_record.hotel_id, 'pos.menu_item_created', 'pos_menu_item', new_item_id,
    jsonb_build_object('outlet_id', outlet_record.id, 'category_id', target_category_id, 'price_kobo', initial_price_kobo, 'effective_from', effective_date_value));
  return new_item_id;
end;
$$;

create or replace function public.set_pos_menu_item_price(
  target_menu_item_id uuid,
  new_price_kobo bigint,
  effective_from_value date
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare item_record public.pos_menu_items; price_period_id uuid; current_business_date date;
begin
  select * into item_record from public.pos_menu_items where id = target_menu_item_id for update;
  if not found then raise exception 'POS menu item not found'; end if;
  if not public.has_hotel_permission(item_record.hotel_id, 'pos.catalog.manage') then raise exception 'Not authorised to manage the POS catalog'; end if;
  if not item_record.active then raise exception 'Inactive menu items cannot receive new prices'; end if;
  if new_price_kobo is null or new_price_kobo <= 0 then raise exception 'Menu price must be greater than zero'; end if;
  current_business_date := public.hotel_business_date(item_record.hotel_id);
  if effective_from_value is null or effective_from_value < current_business_date then raise exception 'Menu prices cannot be backdated'; end if;
  insert into public.pos_menu_item_prices (hotel_id, outlet_id, menu_item_id, amount_kobo, effective_from, created_by)
  values (item_record.hotel_id, item_record.outlet_id, item_record.id, new_price_kobo, effective_from_value, auth.uid())
  returning id into price_period_id;
  perform public.log_activity(item_record.hotel_id, 'pos.menu_price_created', 'pos_menu_item_price', price_period_id,
    jsonb_build_object('menu_item_id', item_record.id, 'amount_kobo', new_price_kobo, 'effective_from', effective_from_value));
  return price_period_id;
end;
$$;

create or replace function public.create_pos_modifier_group(
  target_outlet_id uuid,
  group_code_value text,
  group_name_value text,
  minimum_selections smallint default 0,
  maximum_selections smallint default 1,
  display_order_value integer default 0
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare outlet_record public.pos_outlets; group_id_value uuid; normalized_code text := lower(trim(group_code_value)); normalized_name text := trim(group_name_value);
begin
  select * into outlet_record from public.pos_outlets where id = target_outlet_id and active for update;
  if not found then raise exception 'Active POS outlet not found'; end if;
  if not public.has_hotel_permission(outlet_record.hotel_id, 'pos.catalog.manage') then raise exception 'Not authorised to manage the POS catalog'; end if;
  if normalized_code is null or normalized_code !~ '^[a-z][a-z0-9_]{1,48}$' then raise exception 'Modifier group code must use lowercase letters, numbers, and underscores'; end if;
  if normalized_name is null or length(normalized_name) > 100 then raise exception 'Modifier group name must be between 1 and 100 characters'; end if;
  if minimum_selections is null or maximum_selections is null or minimum_selections < 0 or maximum_selections < 1 or maximum_selections > 20 or minimum_selections > maximum_selections then raise exception 'Modifier selection limits are invalid'; end if;
  if display_order_value is null or display_order_value < 0 or display_order_value > 32767 then raise exception 'Display order must be between 0 and 32767'; end if;
  insert into public.pos_modifier_groups (hotel_id, outlet_id, code, name, min_selections, max_selections, display_order)
  values (outlet_record.hotel_id, outlet_record.id, normalized_code, normalized_name, minimum_selections, maximum_selections, display_order_value)
  returning id into group_id_value;
  perform public.log_activity(outlet_record.hotel_id, 'pos.modifier_group_created', 'pos_modifier_group', group_id_value,
    jsonb_build_object('outlet_id', outlet_record.id, 'code', normalized_code));
  return group_id_value;
end;
$$;

create or replace function public.create_pos_modifier_option(
  target_modifier_group_id uuid,
  option_code_value text,
  option_name_value text,
  price_delta_kobo_value bigint default 0,
  display_order_value integer default 0
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare group_record public.pos_modifier_groups; option_id_value uuid; normalized_code text := lower(trim(option_code_value)); normalized_name text := trim(option_name_value);
begin
  select g.* into group_record from public.pos_modifier_groups g where g.id = target_modifier_group_id and g.active for update;
  if not found then raise exception 'Active modifier group not found'; end if;
  if not public.has_hotel_permission(group_record.hotel_id, 'pos.catalog.manage') then raise exception 'Not authorised to manage the POS catalog'; end if;
  if normalized_code is null or normalized_code !~ '^[a-z][a-z0-9_]{1,48}$' then raise exception 'Modifier option code must use lowercase letters, numbers, and underscores'; end if;
  if normalized_name is null or length(normalized_name) > 100 then raise exception 'Modifier option name must be between 1 and 100 characters'; end if;
  if price_delta_kobo_value is null then raise exception 'Modifier price delta is required'; end if;
  if display_order_value is null or display_order_value < 0 or display_order_value > 32767 then raise exception 'Display order must be between 0 and 32767'; end if;
  insert into public.pos_modifier_options (hotel_id, outlet_id, modifier_group_id, code, name, price_delta_kobo, display_order)
  values (group_record.hotel_id, group_record.outlet_id, group_record.id, normalized_code, normalized_name, price_delta_kobo_value, display_order_value)
  returning id into option_id_value;
  perform public.log_activity(group_record.hotel_id, 'pos.modifier_option_created', 'pos_modifier_option', option_id_value,
    jsonb_build_object('group_id', group_record.id, 'code', normalized_code, 'price_delta_kobo', price_delta_kobo_value));
  return option_id_value;
end;
$$;

create or replace function public.assign_pos_modifier_group(target_menu_item_id uuid, target_modifier_group_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare item_record public.pos_menu_items; group_record public.pos_modifier_groups;
begin
  select * into item_record from public.pos_menu_items where id = target_menu_item_id and active for update;
  if not found then raise exception 'Active POS menu item not found'; end if;
  if not public.has_hotel_permission(item_record.hotel_id, 'pos.catalog.manage') then raise exception 'Not authorised to manage the POS catalog'; end if;
  select * into group_record from public.pos_modifier_groups where id = target_modifier_group_id and outlet_id = item_record.outlet_id and hotel_id = item_record.hotel_id and active for update;
  if not found then raise exception 'Choose an active modifier group from the same outlet'; end if;
  insert into public.pos_menu_item_modifier_groups (hotel_id, outlet_id, menu_item_id, modifier_group_id)
  values (item_record.hotel_id, item_record.outlet_id, item_record.id, group_record.id)
  on conflict do nothing;
  perform public.log_activity(item_record.hotel_id, 'pos.modifier_group_assigned', 'pos_menu_item', item_record.id,
    jsonb_build_object('modifier_group_id', group_record.id));
end;
$$;

revoke all on function public.provision_pos_catalog_permissions(uuid),
  public.handle_hotel_pos_catalog_permission_provisioning(),
  public.create_pos_outlet(uuid, text, text, text, text, boolean),
  public.create_pos_menu_category(uuid, text, text, integer),
  public.create_pos_menu_item(uuid, uuid, text, text, text, integer, bigint, date),
  public.set_pos_menu_item_price(uuid, bigint, date),
  public.create_pos_modifier_group(uuid, text, text, smallint, smallint, integer),
  public.create_pos_modifier_option(uuid, text, text, bigint, integer),
  public.assign_pos_modifier_group(uuid, uuid) from public, anon;
grant execute on function public.create_pos_outlet(uuid, text, text, text, text, boolean),
  public.create_pos_menu_category(uuid, text, text, integer),
  public.create_pos_menu_item(uuid, uuid, text, text, text, integer, bigint, date),
  public.set_pos_menu_item_price(uuid, bigint, date),
  public.create_pos_modifier_group(uuid, text, text, smallint, smallint, integer),
  public.create_pos_modifier_option(uuid, text, text, bigint, integer),
  public.assign_pos_modifier_group(uuid, uuid) to authenticated;
