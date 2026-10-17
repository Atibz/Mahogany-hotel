-- Forward-only hardening after the first local inventory rollout. Lock the
-- item while validating unit changes so a concurrent stock receipt cannot
-- race the immutable base-unit rule; bound numeric reorder levels to the
-- storage type's representable finite range.

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
declare
  saved_item_id uuid;
  existing_base_unit text;
begin
  if not public.has_hotel_permission(target_hotel_id, 'inventory.manage') then raise exception 'Not authorised to manage inventory'; end if;
  if length(trim(coalesce(item_code_value, ''))) not between 2 and 40
    or length(trim(coalesce(name_value, ''))) not between 2 and 160
    or length(trim(coalesce(category_value, ''))) not between 2 and 80
    or length(trim(coalesce(base_unit_value, ''))) not between 1 and 24
    or reorder_level_value is null or reorder_level_value < 0 or reorder_level_value > 99999999999.999 then
    raise exception 'Enter a valid item code, name, category, unit, and reorder level';
  end if;

  if target_item_id is null then
    insert into public.inventory_items (hotel_id, item_code, name, category, base_unit, reorder_level, active, created_by)
    values (target_hotel_id, trim(item_code_value), trim(name_value), trim(category_value), trim(base_unit_value), reorder_level_value, active_value, auth.uid())
    returning id into saved_item_id;
    perform public.log_activity(target_hotel_id, 'inventory.item_created', 'inventory_item', saved_item_id,
      jsonb_build_object('item_code', trim(item_code_value), 'name', trim(name_value), 'unit', trim(base_unit_value)));
  else
    select base_unit into existing_base_unit from public.inventory_items
    where id = target_item_id and hotel_id = target_hotel_id for update;
    if not found then raise exception 'Inventory item not found'; end if;
    if existing_base_unit <> trim(base_unit_value)
      and exists (select 1 from public.inventory_movements where item_id = target_item_id) then
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
