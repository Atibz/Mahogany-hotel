-- First inventory slice: item/supplier registers and an append-only quantity
-- ledger. Deliberately excludes stock valuation, invoice matching, payables,
-- payments, tax, and automatic POS consumption.

create table if not exists public.inventory_locations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  code text not null check (code in ('main_store', 'hotel', 'restaurant', 'bar')),
  name text not null check (length(trim(name)) between 2 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (hotel_id, code),
  unique (hotel_id, name)
);

create table if not exists public.inventory_suppliers (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  name text not null check (length(trim(name)) between 2 and 160),
  contact_name text check (contact_name is null or length(trim(contact_name)) <= 120),
  phone text check (phone is null or length(trim(phone)) <= 60),
  email text check (email is null or length(trim(email)) <= 254),
  notes text check (notes is null or length(trim(notes)) <= 500),
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, name)
);

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  item_code text not null check (length(trim(item_code)) between 2 and 40),
  name text not null check (length(trim(name)) between 2 and 160),
  category text not null check (length(trim(category)) between 2 and 80),
  base_unit text not null check (length(trim(base_unit)) between 1 and 24),
  reorder_level numeric(14,3) not null default 0 check (reorder_level >= 0),
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, item_code)
);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  movement_group_id uuid not null default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  location_id uuid not null references public.inventory_locations(id) on delete restrict,
  movement_type text not null check (movement_type in ('receipt', 'issue', 'transfer_in', 'transfer_out', 'waste')),
  quantity_delta numeric(14,3) not null check (quantity_delta <> 0),
  supplier_id uuid references public.inventory_suppliers(id) on delete restrict,
  reference text check (reference is null or length(trim(reference)) <= 100),
  reason text not null check (length(trim(reason)) between 5 and 500),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((movement_type in ('receipt', 'transfer_in') and quantity_delta > 0)
      or (movement_type in ('issue', 'transfer_out', 'waste') and quantity_delta < 0))
);

create index if not exists inventory_movements_item_location_idx
  on public.inventory_movements (item_id, location_id, created_at desc);
create index if not exists inventory_movements_hotel_created_idx
  on public.inventory_movements (hotel_id, created_at desc);

insert into public.permissions (code, name, description) values
  ('inventory.read', 'View inventory', 'View stock items, suppliers, locations, and quantity movements.'),
  ('inventory.manage', 'Manage inventory', 'Manage stock items and suppliers and record reasoned stock movements.')
on conflict (code) do nothing;

create or replace function public.provision_inventory_permissions(target_hotel_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.code in ('inventory.read', 'inventory.manage')
  where r.hotel_id = target_hotel_id and r.code in ('general_manager', 'storekeeper')
  on conflict do nothing;

  insert into public.inventory_locations (hotel_id, code, name)
  values
    (target_hotel_id, 'main_store', 'Main Store'),
    (target_hotel_id, 'hotel', 'Hotel Operations'),
    (target_hotel_id, 'restaurant', 'Restaurant'),
    (target_hotel_id, 'bar', 'Bar')
  on conflict (hotel_id, code) do nothing;
end;
$$;

select public.provision_inventory_permissions(id) from public.hotels;

create or replace function public.handle_hotel_inventory_provisioning()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.provision_inventory_permissions(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzzzzzz_hotel_inventory_provisioning on public.hotels;
create trigger zzzzzzzzzz_hotel_inventory_provisioning
after insert on public.hotels
for each row execute function public.handle_hotel_inventory_provisioning();

drop trigger if exists inventory_items_set_updated_at on public.inventory_items;
create trigger inventory_items_set_updated_at before update on public.inventory_items
for each row execute function public.set_updated_at();
drop trigger if exists inventory_suppliers_set_updated_at on public.inventory_suppliers;
create trigger inventory_suppliers_set_updated_at before update on public.inventory_suppliers
for each row execute function public.set_updated_at();

create or replace function public.prevent_inventory_movement_change()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'Inventory movements are append-only; record a correcting movement instead';
end;
$$;
drop trigger if exists inventory_movements_append_only on public.inventory_movements;
create trigger inventory_movements_append_only before update or delete on public.inventory_movements
for each row execute function public.prevent_inventory_movement_change();

alter table public.inventory_locations enable row level security;
alter table public.inventory_suppliers enable row level security;
alter table public.inventory_items enable row level security;
alter table public.inventory_movements enable row level security;

drop policy if exists inventory_locations_read on public.inventory_locations;
create policy inventory_locations_read on public.inventory_locations for select to authenticated
using (public.has_hotel_permission(hotel_id, 'inventory.read'));
drop policy if exists inventory_suppliers_read on public.inventory_suppliers;
create policy inventory_suppliers_read on public.inventory_suppliers for select to authenticated
using (public.has_hotel_permission(hotel_id, 'inventory.read'));
drop policy if exists inventory_items_read on public.inventory_items;
create policy inventory_items_read on public.inventory_items for select to authenticated
using (public.has_hotel_permission(hotel_id, 'inventory.read'));
drop policy if exists inventory_movements_read on public.inventory_movements;
create policy inventory_movements_read on public.inventory_movements for select to authenticated
using (public.has_hotel_permission(hotel_id, 'inventory.read'));

revoke all on public.inventory_locations, public.inventory_suppliers, public.inventory_items, public.inventory_movements from public, anon, authenticated;
grant select on public.inventory_locations, public.inventory_suppliers, public.inventory_items, public.inventory_movements to authenticated;

create or replace function public.save_inventory_item(
  target_hotel_id uuid,
  target_item_id uuid,
  item_code_value text,
  name_value text,
  category_value text,
  base_unit_value text,
  reorder_level_value numeric,
  active_value boolean default true
)
returns uuid language plpgsql security definer set search_path = public as $$
declare saved_item_id uuid;
begin
  if not public.has_hotel_permission(target_hotel_id, 'inventory.manage') then raise exception 'Not authorised to manage inventory'; end if;
  if length(trim(coalesce(item_code_value, ''))) not between 2 and 40
    or length(trim(coalesce(name_value, ''))) not between 2 and 160
    or length(trim(coalesce(category_value, ''))) not between 2 and 80
    or length(trim(coalesce(base_unit_value, ''))) not between 1 and 24
    or reorder_level_value is null or reorder_level_value < 0 then
    raise exception 'Enter a valid item code, name, category, unit, and reorder level';
  end if;

  if target_item_id is null then
    insert into public.inventory_items (hotel_id, item_code, name, category, base_unit, reorder_level, active, created_by)
    values (target_hotel_id, trim(item_code_value), trim(name_value), trim(category_value), trim(base_unit_value), reorder_level_value, active_value, auth.uid())
    returning id into saved_item_id;
    perform public.log_activity(target_hotel_id, 'inventory.item_created', 'inventory_item', saved_item_id,
      jsonb_build_object('item_code', trim(item_code_value), 'name', trim(name_value), 'unit', trim(base_unit_value)));
  else
    if not exists (select 1 from public.inventory_items where id = target_item_id and hotel_id = target_hotel_id) then raise exception 'Inventory item not found'; end if;
    if exists (select 1 from public.inventory_movements where item_id = target_item_id)
      and exists (select 1 from public.inventory_items where id = target_item_id and base_unit <> trim(base_unit_value)) then
      raise exception 'The base unit cannot change after stock movements exist';
    end if;
    update public.inventory_items
    set item_code = trim(item_code_value), name = trim(name_value), category = trim(category_value),
        base_unit = trim(base_unit_value), reorder_level = reorder_level_value, active = active_value
    where id = target_item_id and hotel_id = target_hotel_id
    returning id into saved_item_id;
    perform public.log_activity(target_hotel_id, 'inventory.item_updated', 'inventory_item', saved_item_id,
      jsonb_build_object('item_code', trim(item_code_value), 'active', active_value));
  end if;
  return saved_item_id;
end;
$$;

create or replace function public.save_inventory_supplier(
  target_hotel_id uuid,
  target_supplier_id uuid,
  name_value text,
  contact_name_value text default null,
  phone_value text default null,
  email_value text default null,
  notes_value text default null,
  active_value boolean default true
)
returns uuid language plpgsql security definer set search_path = public as $$
declare saved_supplier_id uuid;
begin
  if not public.has_hotel_permission(target_hotel_id, 'inventory.manage') then raise exception 'Not authorised to manage inventory'; end if;
  if length(trim(coalesce(name_value, ''))) not between 2 and 160 then raise exception 'Enter a valid supplier name'; end if;
  if target_supplier_id is null then
    insert into public.inventory_suppliers (hotel_id, name, contact_name, phone, email, notes, active, created_by)
    values (target_hotel_id, trim(name_value), nullif(trim(contact_name_value), ''), nullif(trim(phone_value), ''), nullif(trim(email_value), ''), nullif(trim(notes_value), ''), active_value, auth.uid())
    returning id into saved_supplier_id;
    perform public.log_activity(target_hotel_id, 'inventory.supplier_created', 'inventory_supplier', saved_supplier_id, jsonb_build_object('name', trim(name_value)));
  else
    if not exists (select 1 from public.inventory_suppliers where id = target_supplier_id and hotel_id = target_hotel_id) then raise exception 'Supplier not found'; end if;
    update public.inventory_suppliers set name = trim(name_value), contact_name = nullif(trim(contact_name_value), ''),
      phone = nullif(trim(phone_value), ''), email = nullif(trim(email_value), ''), notes = nullif(trim(notes_value), ''), active = active_value
    where id = target_supplier_id and hotel_id = target_hotel_id returning id into saved_supplier_id;
    perform public.log_activity(target_hotel_id, 'inventory.supplier_updated', 'inventory_supplier', saved_supplier_id, jsonb_build_object('name', trim(name_value), 'active', active_value));
  end if;
  return saved_supplier_id;
end;
$$;

create or replace function public.get_inventory_balances(target_hotel_id uuid)
returns table (
  item_id uuid,
  item_code text,
  item_name text,
  category text,
  base_unit text,
  reorder_level numeric,
  location_code text,
  location_name text,
  on_hand numeric,
  active boolean
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'inventory.read') then raise exception 'Not authorised to view inventory'; end if;
  return query
  select i.id, i.item_code, i.name, i.category, i.base_unit, i.reorder_level,
    l.code, l.name, coalesce(sum(m.quantity_delta), 0)::numeric(14,3), i.active
  from public.inventory_items i
  join public.inventory_locations l on l.hotel_id = i.hotel_id and l.active
  left join public.inventory_movements m on m.item_id = i.id and m.location_id = l.id
  where i.hotel_id = target_hotel_id
  group by i.id, i.item_code, i.name, i.category, i.base_unit, i.reorder_level, l.code, l.name, i.active
  order by i.active desc, i.category, i.name, l.code;
end;
$$;

create or replace function public.record_inventory_movement(
  target_hotel_id uuid,
  target_item_id uuid,
  movement_type_value text,
  quantity_value numeric,
  source_location_code text,
  destination_location_code text default null,
  supplier_value_id uuid default null,
  reference_value text default null,
  reason_value text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  group_id uuid := gen_random_uuid();
  source_location_id uuid;
  destination_location_id uuid;
  supplier_record_id uuid;
  current_balance numeric(14,3);
  item_code_value text;
begin
  if not public.has_hotel_permission(target_hotel_id, 'inventory.manage') then raise exception 'Not authorised to manage inventory'; end if;
  if quantity_value is null or quantity_value <= 0 or quantity_value > 99999999999.999 then raise exception 'Enter a quantity greater than zero'; end if;
  if length(trim(coalesce(reason_value, ''))) not between 5 and 500 then raise exception 'A reason of at least five characters is required'; end if;
  if length(trim(coalesce(reference_value, ''))) > 100 then raise exception 'Reference must be 100 characters or fewer'; end if;
  if movement_type_value is null or movement_type_value not in ('receipt', 'issue', 'transfer', 'waste') then raise exception 'Select a supported stock movement'; end if;

  select item_code into item_code_value from public.inventory_items
  where id = target_item_id and hotel_id = target_hotel_id and active for update;
  if item_code_value is null then raise exception 'Active inventory item not found'; end if;
  select id into source_location_id from public.inventory_locations
  where hotel_id = target_hotel_id and code = source_location_code and active;
  if source_location_id is null then raise exception 'Source stock location is unavailable'; end if;

  if movement_type_value = 'receipt' then
    if source_location_code <> 'main_store' then raise exception 'Stock receipts must first be received into the Main Store'; end if;
    if supplier_value_id is not null and not exists (select 1 from public.inventory_suppliers where id = supplier_value_id and hotel_id = target_hotel_id and active) then raise exception 'Supplier is unavailable'; end if;
    insert into public.inventory_movements (movement_group_id, hotel_id, item_id, location_id, movement_type, quantity_delta, supplier_id, reference, reason, created_by)
    values (group_id, target_hotel_id, target_item_id, source_location_id, 'receipt', quantity_value, supplier_value_id, nullif(trim(reference_value), ''), trim(reason_value), auth.uid());
  elsif movement_type_value = 'transfer' then
    if destination_location_code is null or destination_location_code = source_location_code then raise exception 'Choose a different destination location'; end if;
    select id into destination_location_id from public.inventory_locations
    where hotel_id = target_hotel_id and code = destination_location_code and active;
    if destination_location_id is null then raise exception 'Destination stock location is unavailable'; end if;
    select coalesce(sum(quantity_delta), 0) into current_balance from public.inventory_movements where item_id = target_item_id and location_id = source_location_id;
    if current_balance < quantity_value then raise exception 'Insufficient stock at the source location'; end if;
    insert into public.inventory_movements (movement_group_id, hotel_id, item_id, location_id, movement_type, quantity_delta, reference, reason, created_by)
    values
      (group_id, target_hotel_id, target_item_id, source_location_id, 'transfer_out', -quantity_value, nullif(trim(reference_value), ''), trim(reason_value), auth.uid()),
      (group_id, target_hotel_id, target_item_id, destination_location_id, 'transfer_in', quantity_value, nullif(trim(reference_value), ''), trim(reason_value), auth.uid());
  else
    if source_location_code = 'main_store' and movement_type_value in ('issue', 'waste') then raise exception 'Use transfer to move Main Store stock into an operating location first'; end if;
    select coalesce(sum(quantity_delta), 0) into current_balance from public.inventory_movements where item_id = target_item_id and location_id = source_location_id;
    if current_balance < quantity_value then raise exception 'Insufficient stock at this location'; end if;
    insert into public.inventory_movements (movement_group_id, hotel_id, item_id, location_id, movement_type, quantity_delta, reference, reason, created_by)
    values (group_id, target_hotel_id, target_item_id, source_location_id,
      case when movement_type_value = 'issue' then 'issue' else 'waste' end,
      -quantity_value, nullif(trim(reference_value), ''), trim(reason_value), auth.uid());
  end if;

  perform public.log_activity(target_hotel_id, 'inventory.stock_' || movement_type_value, 'inventory_item', target_item_id,
    jsonb_build_object('item_code', item_code_value, 'quantity', quantity_value, 'source', source_location_code,
      'destination', case when movement_type_value = 'transfer' then destination_location_code else null end,
      'reference', nullif(trim(reference_value), ''), 'reason', trim(reason_value), 'movement_group_id', group_id));
  return group_id;
end;
$$;

revoke all on function public.provision_inventory_permissions(uuid), public.handle_hotel_inventory_provisioning(),
  public.prevent_inventory_movement_change(), public.save_inventory_item(uuid, uuid, text, text, text, text, numeric, boolean),
  public.save_inventory_supplier(uuid, uuid, text, text, text, text, text, boolean),
  public.get_inventory_balances(uuid), public.record_inventory_movement(uuid, uuid, text, numeric, text, text, uuid, text, text)
from public, anon;
grant execute on function public.save_inventory_item(uuid, uuid, text, text, text, text, numeric, boolean),
  public.save_inventory_supplier(uuid, uuid, text, text, text, text, text, boolean),
  public.get_inventory_balances(uuid), public.record_inventory_movement(uuid, uuid, text, numeric, text, text, uuid, text, text)
to authenticated;
