-- Opt-in, version-by-movement stock consumption for outlet order lines.
-- Existing menu items remain unconfigured so deployment cannot silently invent recipes.
alter table public.pos_menu_items add column stock_tracking_mode text not null default 'unconfigured'
  check (stock_tracking_mode in ('unconfigured', 'automatic', 'non_stock'));
alter table public.pos_modifier_options add column stock_tracking_mode text not null default 'unconfigured'
  check (stock_tracking_mode in ('unconfigured', 'automatic', 'non_stock'));
alter table public.pos_order_lines add column stock_tracking_mode_snapshot text not null default 'unconfigured'
  check (stock_tracking_mode_snapshot in ('unconfigured', 'automatic', 'non_stock'));
alter table public.pos_order_line_modifiers add column stock_tracking_mode_snapshot text not null default 'unconfigured'
  check (stock_tracking_mode_snapshot in ('unconfigured', 'automatic', 'non_stock'));

create table public.pos_stock_components (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id),
  outlet_id uuid not null,
  menu_item_id uuid,
  modifier_option_id uuid,
  inventory_item_id uuid not null references public.inventory_items(id),
  quantity_per_unit numeric(14,3) not null check (quantity_per_unit > 0 and quantity_per_unit <= 1000000),
  configured_by uuid references public.profiles(id),
  configured_at timestamptz not null default now(),
  check ((menu_item_id is not null) <> (modifier_option_id is not null)),
  foreign key (menu_item_id, hotel_id, outlet_id) references public.pos_menu_items(id, hotel_id, outlet_id),
  foreign key (modifier_option_id, hotel_id, outlet_id) references public.pos_modifier_options(id, hotel_id, outlet_id)
);
create unique index pos_stock_component_menu_unique on public.pos_stock_components(menu_item_id, inventory_item_id)
  where menu_item_id is not null;
create unique index pos_stock_component_modifier_unique on public.pos_stock_components(modifier_option_id, inventory_item_id)
  where modifier_option_id is not null;
alter table public.pos_stock_components enable row level security;
revoke all on public.pos_stock_components from public, anon, authenticated;
grant select on public.pos_stock_components to authenticated;
create policy pos_stock_components_read on public.pos_stock_components for select to authenticated
  using (public.has_hotel_permission(hotel_id, 'pos.catalog.read') and public.has_hotel_permission(hotel_id, 'inventory.read'));

alter table public.inventory_movements drop constraint inventory_movements_movement_type_check;
alter table public.inventory_movements drop constraint inventory_movements_check;
alter table public.inventory_movements add constraint inventory_movements_movement_type_check
  check (movement_type in ('receipt', 'issue', 'transfer_in', 'transfer_out', 'waste', 'pos_sale', 'pos_void'));
alter table public.inventory_movements add constraint inventory_movements_direction_check
  check ((movement_type in ('receipt', 'transfer_in', 'pos_void') and quantity_delta > 0)
    or (movement_type in ('issue', 'transfer_out', 'waste', 'pos_sale') and quantity_delta < 0));
alter table public.inventory_movements
  add column pos_order_id uuid references public.pos_orders(id),
  add column pos_order_line_id uuid references public.pos_order_lines(id),
  add column pos_modifier_option_id uuid references public.pos_modifier_options(id),
  add column reverses_movement_id uuid unique references public.inventory_movements(id),
  add constraint inventory_movements_pos_link_check check (
    (movement_type not in ('pos_sale', 'pos_void') and pos_order_id is null and pos_order_line_id is null
      and pos_modifier_option_id is null and reverses_movement_id is null)
    or (movement_type = 'pos_sale' and pos_order_id is not null and pos_order_line_id is not null
      and reverses_movement_id is null)
    or (movement_type = 'pos_void' and pos_order_id is not null and pos_order_line_id is not null
      and reverses_movement_id is not null));
create index inventory_movements_pos_order_idx on public.inventory_movements(pos_order_id) where pos_order_id is not null;

create function public.configure_pos_stock_components(
  target_kind text, target_id uuid, tracking_mode_value text, component_rows jsonb, reason_value text
) returns void language plpgsql security definer set search_path = public as $$
declare target_hotel uuid; target_outlet uuid; component record;
begin
  if target_kind not in ('menu_item', 'modifier_option') or tracking_mode_value not in ('automatic', 'non_stock') then
    raise exception 'Choose a supported stock link and tracking mode';
  end if;
  if length(trim(coalesce(reason_value, ''))) not between 5 and 500 then raise exception 'Explain the stock setup'; end if;
  if jsonb_typeof(component_rows) <> 'array' or jsonb_array_length(component_rows) > 30 then
    raise exception 'Supply a valid ingredient list (maximum 30)';
  end if;
  if (tracking_mode_value = 'automatic' and jsonb_array_length(component_rows) = 0)
    or (tracking_mode_value = 'non_stock' and jsonb_array_length(component_rows) <> 0) then
    raise exception 'Automatic tracking needs ingredients; non-stock items must have none';
  end if;
  if target_kind = 'menu_item' then
    select hotel_id, outlet_id into target_hotel, target_outlet from public.pos_menu_items where id = target_id for update;
  else
    select hotel_id, outlet_id into target_hotel, target_outlet from public.pos_modifier_options where id = target_id for update;
  end if;
  if target_hotel is null then raise exception 'POS catalog record not found'; end if;
  if not public.has_hotel_permission(target_hotel, 'pos.catalog.manage')
    or not public.has_hotel_permission(target_hotel, 'inventory.manage') then
    raise exception 'Not authorised to configure POS stock';
  end if;
  for component in select * from jsonb_to_recordset(component_rows) as x(item_id uuid, quantity numeric) loop
    if component.item_id is null or component.quantity is null or component.quantity <= 0
      or component.quantity > 1000000 or component.quantity <> round(component.quantity, 3)
      or not exists (select 1 from public.inventory_items i
        where i.id = component.item_id and i.hotel_id = target_hotel and i.active) then
      raise exception 'Choose active hotel stock items and valid quantities (up to three decimals)';
    end if;
  end loop;
  delete from public.pos_stock_components c where (target_kind = 'menu_item' and c.menu_item_id = target_id)
    or (target_kind = 'modifier_option' and c.modifier_option_id = target_id);
  insert into public.pos_stock_components(hotel_id, outlet_id, menu_item_id, modifier_option_id,
    inventory_item_id, quantity_per_unit, configured_by)
  select target_hotel, target_outlet,
    case when target_kind = 'menu_item' then target_id end,
    case when target_kind = 'modifier_option' then target_id end,
    x.item_id, x.quantity, auth.uid()
  from jsonb_to_recordset(component_rows) as x(item_id uuid, quantity numeric);
  if target_kind = 'menu_item' then
    update public.pos_menu_items set stock_tracking_mode = tracking_mode_value where id = target_id;
  else
    update public.pos_modifier_options set stock_tracking_mode = tracking_mode_value where id = target_id;
  end if;
  perform public.log_activity(target_hotel, 'pos.stock_recipe_configured', target_kind, target_id,
    jsonb_build_object('outlet_id', target_outlet, 'mode', tracking_mode_value,
      'components', component_rows, 'reason', trim(reason_value)));
end; $$;

create function public.pos_stock_snapshot_mode() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'pos_order_lines' then
    select stock_tracking_mode into new.stock_tracking_mode_snapshot
      from public.pos_menu_items where id = new.menu_item_id for share;
  else
    select stock_tracking_mode into new.stock_tracking_mode_snapshot
      from public.pos_modifier_options where id = new.modifier_option_id for share;
  end if;
  return new;
end; $$;
create trigger pos_order_line_stock_snapshot before insert on public.pos_order_lines
  for each row execute function public.pos_stock_snapshot_mode();
create trigger pos_modifier_stock_snapshot before insert on public.pos_order_line_modifiers
  for each row execute function public.pos_stock_snapshot_mode();

create function public.consume_pos_stock_for_line() returns trigger
language plpgsql security definer set search_path = public as $$
declare sale public.pos_orders; line public.pos_order_lines; outlet_type_value text; option_id uuid;
  stock_location_id uuid; component record; needed numeric(14,3); available numeric(14,3); group_id uuid := gen_random_uuid();
begin
  if new.stock_tracking_mode_snapshot <> 'automatic' then return new; end if;
  if tg_table_name = 'pos_order_lines' then
    line := new;
  else
    select * into line from public.pos_order_lines where id = new.order_line_id;
    option_id := new.modifier_option_id;
  end if;
  select * into sale from public.pos_orders where id = line.order_id;
  select outlet_type::text into outlet_type_value from public.pos_outlets where id = sale.outlet_id;
  select id into stock_location_id from public.inventory_locations
    where hotel_id = sale.hotel_id and code = outlet_type_value and active;
  if stock_location_id is null then raise exception 'Outlet stock location is unavailable'; end if;
  for component in
    select c.inventory_item_id, c.quantity_per_unit, i.name as item_name
    from public.pos_stock_components c join public.inventory_items i on i.id = c.inventory_item_id
    where (tg_table_name = 'pos_order_lines' and c.menu_item_id = line.menu_item_id)
       or (tg_table_name = 'pos_order_line_modifiers' and c.modifier_option_id = option_id)
    order by c.inventory_item_id
  loop
    perform 1 from public.inventory_items where id = component.inventory_item_id and active for update;
    if not found then raise exception 'Stock item % is inactive; ask the manager to update the recipe', component.item_name; end if;
    needed := component.quantity_per_unit * line.quantity;
    select coalesce(sum(quantity_delta), 0) into available from public.inventory_movements
      where item_id = component.inventory_item_id and location_id = stock_location_id;
    if available < needed then
      raise exception 'Insufficient % stock in %. Available %, required %',
        component.item_name, outlet_type_value, available, needed;
    end if;
    insert into public.inventory_movements(movement_group_id, hotel_id, item_id, location_id,
      movement_type, quantity_delta, reference, reason, created_by,
      pos_order_id, pos_order_line_id, pos_modifier_option_id)
    values (group_id, sale.hotel_id, component.inventory_item_id, stock_location_id,
      'pos_sale', -needed, sale.order_number, 'POS order item consumed', line.created_by,
      sale.id, line.id, option_id);
  end loop;
  return new;
end; $$;
create trigger pos_order_line_consume_stock after insert on public.pos_order_lines
  for each row execute function public.consume_pos_stock_for_line();
create trigger pos_modifier_consume_stock after insert on public.pos_order_line_modifiers
  for each row execute function public.consume_pos_stock_for_line();

create function public.reverse_pos_stock_on_void() returns trigger
language plpgsql security definer set search_path = public as $$
declare movement record; group_id uuid := gen_random_uuid();
begin
  if old.status = 'voided' or new.status <> 'voided' then return new; end if;
  for movement in select * from public.inventory_movements
    where pos_order_id = new.id and movement_type = 'pos_sale' order by item_id, id
  loop
    insert into public.inventory_movements(movement_group_id, hotel_id, item_id, location_id,
      movement_type, quantity_delta, reference, reason, created_by, pos_order_id,
      pos_order_line_id, pos_modifier_option_id, reverses_movement_id)
    values (group_id, movement.hotel_id, movement.item_id, movement.location_id,
      'pos_void', -movement.quantity_delta, new.order_number,
      'POS order voided: ' || left(new.void_reason, 400), new.voided_by,
      new.id, movement.pos_order_line_id, movement.pos_modifier_option_id, movement.id);
  end loop;
  return new;
end; $$;
create trigger pos_order_void_restore_stock after update of status on public.pos_orders
  for each row execute function public.reverse_pos_stock_on_void();

revoke all on function public.configure_pos_stock_components(text, uuid, text, jsonb, text),
  public.pos_stock_snapshot_mode(), public.consume_pos_stock_for_line(),
  public.reverse_pos_stock_on_void() from public, anon;
grant execute on function public.configure_pos_stock_components(text, uuid, text, jsonb, text) to authenticated;
