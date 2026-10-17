-- Audited maintenance for the shared POS catalog. Retirements are soft state
-- changes: menu prices, identifiers, and historical records are never deleted.

create or replace function public.update_pos_outlet(
  target_outlet_id uuid,
  outlet_name_value text,
  department_code_value text,
  kitchen_tickets_enabled_value boolean,
  change_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  outlet_record public.pos_outlets;
  normalized_name text := trim(outlet_name_value);
begin
  select * into outlet_record from public.pos_outlets where id = target_outlet_id for update;
  if not found then raise exception 'POS outlet not found'; end if;
  if not public.has_hotel_permission(outlet_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;
  if normalized_name is null or length(normalized_name) not between 1 and 100 then
    raise exception 'Outlet name must be between 1 and 100 characters';
  end if;
  if not exists (
    select 1 from public.departments d
    where d.hotel_id = outlet_record.hotel_id and d.code = department_code_value and d.active
  ) then raise exception 'Choose an active department for this outlet'; end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for catalog changes'; end if;

  update public.pos_outlets
  set name = normalized_name, department_code = department_code_value,
      kitchen_tickets_enabled = kitchen_tickets_enabled_value, updated_at = now()
  where id = target_outlet_id;
  perform public.log_activity(outlet_record.hotel_id, 'pos.outlet_updated', 'pos_outlet', target_outlet_id,
    jsonb_build_object('old_name', outlet_record.name, 'new_name', normalized_name,
      'old_department_code', outlet_record.department_code, 'new_department_code', department_code_value,
      'kitchen_tickets_enabled', kitchen_tickets_enabled_value, 'reason', trim(change_reason)));
end;
$$;

create or replace function public.set_pos_outlet_active(
  target_outlet_id uuid,
  should_be_active boolean,
  change_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  outlet_record public.pos_outlets;
  categories_changed integer := 0;
  items_changed integer := 0;
  groups_changed integer := 0;
  options_changed integer := 0;
begin
  select * into outlet_record from public.pos_outlets where id = target_outlet_id for update;
  if not found then raise exception 'POS outlet not found'; end if;
  if not public.has_hotel_permission(outlet_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;
  if should_be_active is null then raise exception 'Choose whether the outlet is active'; end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for catalog changes'; end if;
  if outlet_record.active = should_be_active then raise exception 'POS outlet already has that status'; end if;

  update public.pos_outlets set active = should_be_active, updated_at = now() where id = target_outlet_id;
  if not should_be_active then
    update public.pos_menu_categories set active = false, updated_at = now()
      where outlet_id = target_outlet_id and active;
    get diagnostics categories_changed = row_count;
    update public.pos_menu_items set active = false, updated_at = now()
      where outlet_id = target_outlet_id and active;
    get diagnostics items_changed = row_count;
    update public.pos_modifier_groups set active = false, updated_at = now()
      where outlet_id = target_outlet_id and active;
    get diagnostics groups_changed = row_count;
    update public.pos_modifier_options set active = false, updated_at = now()
      where outlet_id = target_outlet_id and active;
    get diagnostics options_changed = row_count;
  end if;
  perform public.log_activity(outlet_record.hotel_id,
    case when should_be_active then 'pos.outlet_reactivated' else 'pos.outlet_retired' end,
    'pos_outlet', target_outlet_id,
    jsonb_build_object('reason', trim(change_reason), 'categories_deactivated', categories_changed,
      'items_deactivated', items_changed, 'modifier_groups_deactivated', groups_changed,
      'modifier_options_deactivated', options_changed));
end;
$$;

create or replace function public.update_pos_menu_category(
  target_category_id uuid,
  category_name_value text,
  display_order_value integer,
  change_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  category_record public.pos_menu_categories;
  normalized_name text := trim(category_name_value);
begin
  select * into category_record from public.pos_menu_categories where id = target_category_id for update;
  if not found then raise exception 'POS category not found'; end if;
  if not public.has_hotel_permission(category_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;
  if normalized_name is null or length(normalized_name) not between 1 and 100 then
    raise exception 'Category name must be between 1 and 100 characters';
  end if;
  if display_order_value is null or display_order_value < 0 or display_order_value > 32767 then
    raise exception 'Display order must be between 0 and 32767';
  end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for catalog changes'; end if;
  update public.pos_menu_categories set name = normalized_name, display_order = display_order_value, updated_at = now()
    where id = target_category_id;
  perform public.log_activity(category_record.hotel_id, 'pos.category_updated', 'pos_menu_category', target_category_id,
    jsonb_build_object('old_name', category_record.name, 'new_name', normalized_name,
      'old_display_order', category_record.display_order, 'new_display_order', display_order_value,
      'reason', trim(change_reason)));
end;
$$;

create or replace function public.set_pos_menu_category_active(
  target_category_id uuid,
  should_be_active boolean,
  change_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  category_record public.pos_menu_categories;
  items_changed integer := 0;
begin
  select * into category_record from public.pos_menu_categories where id = target_category_id for update;
  if not found then raise exception 'POS category not found'; end if;
  if not public.has_hotel_permission(category_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;
  if should_be_active is null then raise exception 'Choose whether the category is active'; end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for catalog changes'; end if;
  if category_record.active = should_be_active then raise exception 'POS category already has that status'; end if;

  update public.pos_menu_categories set active = should_be_active, updated_at = now() where id = target_category_id;
  if not should_be_active then
    update public.pos_menu_items set active = false, updated_at = now()
      where category_id = target_category_id and active;
    get diagnostics items_changed = row_count;
  end if;
  perform public.log_activity(category_record.hotel_id,
    case when should_be_active then 'pos.category_reactivated' else 'pos.category_retired' end,
    'pos_menu_category', target_category_id,
    jsonb_build_object('reason', trim(change_reason), 'menu_items_deactivated', items_changed));
end;
$$;

create or replace function public.update_pos_menu_item(
  target_menu_item_id uuid,
  target_category_id uuid,
  item_name_value text,
  item_description_value text,
  display_order_value integer,
  change_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  item_record public.pos_menu_items;
  normalized_name text := trim(item_name_value);
begin
  select * into item_record from public.pos_menu_items where id = target_menu_item_id for update;
  if not found then raise exception 'POS menu item not found'; end if;
  if not public.has_hotel_permission(item_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;
  if normalized_name is null or length(normalized_name) not between 1 and 120 then
    raise exception 'Item name must be between 1 and 120 characters';
  end if;
  if display_order_value is null or display_order_value < 0 or display_order_value > 32767 then
    raise exception 'Display order must be between 0 and 32767';
  end if;
  if not exists (
    select 1 from public.pos_menu_categories c
    join public.pos_outlets o on o.id = c.outlet_id and o.hotel_id = c.hotel_id
    where c.id = target_category_id and c.outlet_id = item_record.outlet_id
      and c.hotel_id = item_record.hotel_id and c.active and o.active
  ) then raise exception 'Choose an active category from the same active outlet'; end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for catalog changes'; end if;

  update public.pos_menu_items
  set category_id = target_category_id, name = normalized_name,
      description = nullif(trim(item_description_value), ''), display_order = display_order_value,
      updated_at = now()
  where id = target_menu_item_id;
  perform public.log_activity(item_record.hotel_id, 'pos.menu_item_updated', 'pos_menu_item', target_menu_item_id,
    jsonb_build_object('old_category_id', item_record.category_id, 'new_category_id', target_category_id,
      'old_name', item_record.name, 'new_name', normalized_name,
      'old_description', item_record.description, 'new_description', nullif(trim(item_description_value), ''),
      'old_display_order', item_record.display_order, 'new_display_order', display_order_value,
      'reason', trim(change_reason)));
end;
$$;

create or replace function public.set_pos_menu_item_active(
  target_menu_item_id uuid,
  should_be_active boolean,
  change_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  item_record public.pos_menu_items;
begin
  select * into item_record from public.pos_menu_items where id = target_menu_item_id for update;
  if not found then raise exception 'POS menu item not found'; end if;
  if not public.has_hotel_permission(item_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;
  if should_be_active is null then raise exception 'Choose whether the menu item is active'; end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for catalog changes'; end if;
  if item_record.active = should_be_active then raise exception 'POS menu item already has that status'; end if;
  if should_be_active and not exists (
    select 1 from public.pos_menu_categories c join public.pos_outlets o
      on o.id = c.outlet_id and o.hotel_id = c.hotel_id
    where c.id = item_record.category_id and c.active and o.active
  ) then raise exception 'Reactivate its outlet and category before reactivating this item'; end if;

  update public.pos_menu_items set active = should_be_active, updated_at = now() where id = target_menu_item_id;
  perform public.log_activity(item_record.hotel_id,
    case when should_be_active then 'pos.menu_item_reactivated' else 'pos.menu_item_retired' end,
    'pos_menu_item', target_menu_item_id,
    jsonb_build_object('name', item_record.name, 'reason', trim(change_reason)));
end;
$$;

create or replace function public.update_pos_modifier_group(
  target_modifier_group_id uuid,
  group_name_value text,
  minimum_selections smallint,
  maximum_selections smallint,
  display_order_value integer,
  change_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  group_record public.pos_modifier_groups;
  normalized_name text := trim(group_name_value);
begin
  select * into group_record from public.pos_modifier_groups where id = target_modifier_group_id for update;
  if not found then raise exception 'POS modifier group not found'; end if;
  if not public.has_hotel_permission(group_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;
  if normalized_name is null or length(normalized_name) not between 1 and 100 then
    raise exception 'Modifier group name must be between 1 and 100 characters';
  end if;
  if minimum_selections is null or maximum_selections is null or minimum_selections < 0
     or maximum_selections < 1 or maximum_selections > 20 or minimum_selections > maximum_selections then
    raise exception 'Modifier selection limits are invalid';
  end if;
  if display_order_value is null or display_order_value < 0 or display_order_value > 32767 then
    raise exception 'Display order must be between 0 and 32767';
  end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for catalog changes'; end if;
  update public.pos_modifier_groups
  set name = normalized_name, min_selections = minimum_selections,
      max_selections = maximum_selections, display_order = display_order_value, updated_at = now()
  where id = target_modifier_group_id;
  perform public.log_activity(group_record.hotel_id, 'pos.modifier_group_updated', 'pos_modifier_group', target_modifier_group_id,
    jsonb_build_object('old_name', group_record.name, 'new_name', normalized_name,
      'old_min', group_record.min_selections, 'new_min', minimum_selections,
      'old_max', group_record.max_selections, 'new_max', maximum_selections,
      'reason', trim(change_reason)));
end;
$$;

create or replace function public.set_pos_modifier_group_active(
  target_modifier_group_id uuid,
  should_be_active boolean,
  change_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  group_record public.pos_modifier_groups;
  options_changed integer := 0;
begin
  select * into group_record from public.pos_modifier_groups where id = target_modifier_group_id for update;
  if not found then raise exception 'POS modifier group not found'; end if;
  if not public.has_hotel_permission(group_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;
  if should_be_active is null then raise exception 'Choose whether the modifier group is active'; end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for catalog changes'; end if;
  if group_record.active = should_be_active then raise exception 'POS modifier group already has that status'; end if;
  if should_be_active and not exists (select 1 from public.pos_outlets where id = group_record.outlet_id and active) then
    raise exception 'Reactivate its outlet before reactivating this modifier group';
  end if;

  update public.pos_modifier_groups set active = should_be_active, updated_at = now() where id = target_modifier_group_id;
  if not should_be_active then
    update public.pos_modifier_options set active = false, updated_at = now()
      where modifier_group_id = target_modifier_group_id and active;
    get diagnostics options_changed = row_count;
  end if;
  perform public.log_activity(group_record.hotel_id,
    case when should_be_active then 'pos.modifier_group_reactivated' else 'pos.modifier_group_retired' end,
    'pos_modifier_group', target_modifier_group_id,
    jsonb_build_object('reason', trim(change_reason), 'options_deactivated', options_changed));
end;
$$;

create or replace function public.update_pos_modifier_option(
  target_modifier_option_id uuid,
  option_name_value text,
  price_delta_kobo_value bigint,
  display_order_value integer,
  change_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  option_record public.pos_modifier_options;
  normalized_name text := trim(option_name_value);
begin
  select * into option_record from public.pos_modifier_options where id = target_modifier_option_id for update;
  if not found then raise exception 'POS modifier option not found'; end if;
  if not public.has_hotel_permission(option_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;
  if normalized_name is null or length(normalized_name) not between 1 and 100 then
    raise exception 'Modifier option name must be between 1 and 100 characters';
  end if;
  if price_delta_kobo_value is null then raise exception 'Price adjustment is required'; end if;
  if display_order_value is null or display_order_value < 0 or display_order_value > 32767 then
    raise exception 'Display order must be between 0 and 32767';
  end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for catalog changes'; end if;
  update public.pos_modifier_options
  set name = normalized_name, price_delta_kobo = price_delta_kobo_value,
      display_order = display_order_value, updated_at = now()
  where id = target_modifier_option_id;
  perform public.log_activity(option_record.hotel_id, 'pos.modifier_option_updated', 'pos_modifier_option', target_modifier_option_id,
    jsonb_build_object('old_name', option_record.name, 'new_name', normalized_name,
      'old_price_delta_kobo', option_record.price_delta_kobo, 'new_price_delta_kobo', price_delta_kobo_value,
      'reason', trim(change_reason)));
end;
$$;

create or replace function public.set_pos_modifier_option_active(
  target_modifier_option_id uuid,
  should_be_active boolean,
  change_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  option_record public.pos_modifier_options;
begin
  select * into option_record from public.pos_modifier_options where id = target_modifier_option_id for update;
  if not found then raise exception 'POS modifier option not found'; end if;
  if not public.has_hotel_permission(option_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;
  if should_be_active is null then raise exception 'Choose whether the modifier option is active'; end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for catalog changes'; end if;
  if option_record.active = should_be_active then raise exception 'POS modifier option already has that status'; end if;
  if should_be_active and not exists (
    select 1 from public.pos_modifier_groups g join public.pos_outlets o on o.id = g.outlet_id
    where g.id = option_record.modifier_group_id and g.active and o.active
  ) then raise exception 'Reactivate its outlet and modifier group before reactivating this option'; end if;

  update public.pos_modifier_options set active = should_be_active, updated_at = now()
    where id = target_modifier_option_id;
  perform public.log_activity(option_record.hotel_id,
    case when should_be_active then 'pos.modifier_option_reactivated' else 'pos.modifier_option_retired' end,
    'pos_modifier_option', target_modifier_option_id,
    jsonb_build_object('name', option_record.name, 'reason', trim(change_reason)));
end;
$$;

create or replace function public.remove_pos_modifier_group(
  target_menu_item_id uuid,
  target_modifier_group_id uuid,
  change_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  item_record public.pos_menu_items;
  group_record public.pos_modifier_groups;
begin
  select * into item_record from public.pos_menu_items where id = target_menu_item_id for update;
  if not found then raise exception 'POS menu item not found'; end if;
  if not public.has_hotel_permission(item_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;
  select * into group_record from public.pos_modifier_groups
    where id = target_modifier_group_id and outlet_id = item_record.outlet_id and hotel_id = item_record.hotel_id;
  if not found then raise exception 'Modifier group does not belong to this outlet'; end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for catalog changes'; end if;
  delete from public.pos_menu_item_modifier_groups
    where menu_item_id = target_menu_item_id and modifier_group_id = target_modifier_group_id;
  if not found then raise exception 'Modifier group is not attached to this menu item'; end if;
  perform public.log_activity(item_record.hotel_id, 'pos.modifier_group_unassigned', 'pos_menu_item', target_menu_item_id,
    jsonb_build_object('modifier_group_id', target_modifier_group_id, 'modifier_group_name', group_record.name,
      'reason', trim(change_reason)));
end;
$$;

revoke all on function public.update_pos_outlet(uuid, text, text, boolean, text),
  public.set_pos_outlet_active(uuid, boolean, text),
  public.update_pos_menu_category(uuid, text, integer, text),
  public.set_pos_menu_category_active(uuid, boolean, text),
  public.update_pos_menu_item(uuid, uuid, text, text, integer, text),
  public.set_pos_menu_item_active(uuid, boolean, text),
  public.update_pos_modifier_group(uuid, text, smallint, smallint, integer, text),
  public.set_pos_modifier_group_active(uuid, boolean, text),
  public.update_pos_modifier_option(uuid, text, bigint, integer, text),
  public.set_pos_modifier_option_active(uuid, boolean, text),
  public.remove_pos_modifier_group(uuid, uuid, text) from public, anon;
grant execute on function public.update_pos_outlet(uuid, text, text, boolean, text),
  public.set_pos_outlet_active(uuid, boolean, text),
  public.update_pos_menu_category(uuid, text, integer, text),
  public.set_pos_menu_category_active(uuid, boolean, text),
  public.update_pos_menu_item(uuid, uuid, text, text, integer, text),
  public.set_pos_menu_item_active(uuid, boolean, text),
  public.update_pos_modifier_group(uuid, text, smallint, smallint, integer, text),
  public.set_pos_modifier_group_active(uuid, boolean, text),
  public.update_pos_modifier_option(uuid, text, bigint, integer, text),
  public.set_pos_modifier_option_active(uuid, boolean, text),
  public.remove_pos_modifier_group(uuid, uuid, text) to authenticated;
