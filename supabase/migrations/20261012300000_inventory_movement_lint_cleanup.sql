-- Replace the movement RPC without the unused supplier_record_id variable.
-- This is behavior-preserving; all movement validation remains in the RPC.

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
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  group_id uuid := gen_random_uuid();
  source_location_id uuid;
  destination_location_id uuid;
  current_balance numeric(14,3);
  item_code_value text;
begin
  if not public.has_hotel_permission(target_hotel_id, 'inventory.manage') then
    raise exception 'Not authorised to manage inventory';
  end if;
  if quantity_value is null or quantity_value <= 0 or quantity_value > 99999999999.999 then
    raise exception 'Enter a quantity greater than zero';
  end if;
  if length(trim(coalesce(reason_value, ''))) not between 5 and 500 then
    raise exception 'A reason of at least five characters is required';
  end if;
  if length(trim(coalesce(reference_value, ''))) > 100 then
    raise exception 'Reference must be 100 characters or fewer';
  end if;
  if movement_type_value is null or movement_type_value not in ('receipt', 'issue', 'transfer', 'waste') then
    raise exception 'Select a supported stock movement';
  end if;

  select item_code into item_code_value
  from public.inventory_items
  where id = target_item_id and hotel_id = target_hotel_id and active
  for update;
  if item_code_value is null then
    raise exception 'Active inventory item not found';
  end if;

  select id into source_location_id
  from public.inventory_locations
  where hotel_id = target_hotel_id and code = source_location_code and active;
  if source_location_id is null then
    raise exception 'Source stock location is unavailable';
  end if;

  if movement_type_value = 'receipt' then
    if source_location_code <> 'main_store' then
      raise exception 'Stock receipts must first be received into the Main Store';
    end if;
    if supplier_value_id is not null and not exists (
      select 1 from public.inventory_suppliers
      where id = supplier_value_id and hotel_id = target_hotel_id and active
    ) then
      raise exception 'Supplier is unavailable';
    end if;
    insert into public.inventory_movements (
      movement_group_id, hotel_id, item_id, location_id, movement_type,
      quantity_delta, supplier_id, reference, reason, created_by
    ) values (
      group_id, target_hotel_id, target_item_id, source_location_id, 'receipt',
      quantity_value, supplier_value_id, nullif(trim(reference_value), ''), trim(reason_value), auth.uid()
    );
  elsif movement_type_value = 'transfer' then
    if destination_location_code is null or destination_location_code = source_location_code then
      raise exception 'Choose a different destination location';
    end if;
    select id into destination_location_id
    from public.inventory_locations
    where hotel_id = target_hotel_id and code = destination_location_code and active;
    if destination_location_id is null then
      raise exception 'Destination stock location is unavailable';
    end if;
    select coalesce(sum(quantity_delta), 0) into current_balance
    from public.inventory_movements
    where item_id = target_item_id and location_id = source_location_id;
    if current_balance < quantity_value then
      raise exception 'Insufficient stock at the source location';
    end if;
    insert into public.inventory_movements (
      movement_group_id, hotel_id, item_id, location_id, movement_type,
      quantity_delta, reference, reason, created_by
    ) values
      (group_id, target_hotel_id, target_item_id, source_location_id, 'transfer_out', -quantity_value, nullif(trim(reference_value), ''), trim(reason_value), auth.uid()),
      (group_id, target_hotel_id, target_item_id, destination_location_id, 'transfer_in', quantity_value, nullif(trim(reference_value), ''), trim(reason_value), auth.uid());
  else
    if source_location_code = 'main_store' and movement_type_value in ('issue', 'waste') then
      raise exception 'Use transfer to move Main Store stock into an operating location first';
    end if;
    select coalesce(sum(quantity_delta), 0) into current_balance
    from public.inventory_movements
    where item_id = target_item_id and location_id = source_location_id;
    if current_balance < quantity_value then
      raise exception 'Insufficient stock at this location';
    end if;
    insert into public.inventory_movements (
      movement_group_id, hotel_id, item_id, location_id, movement_type,
      quantity_delta, reference, reason, created_by
    ) values (
      group_id, target_hotel_id, target_item_id, source_location_id,
      case when movement_type_value = 'issue' then 'issue' else 'waste' end,
      -quantity_value, nullif(trim(reference_value), ''), trim(reason_value), auth.uid()
    );
  end if;

  perform public.log_activity(
    target_hotel_id,
    'inventory.stock_' || movement_type_value,
    'inventory_item',
    target_item_id,
    jsonb_build_object(
      'item_code', item_code_value,
      'quantity', quantity_value,
      'source', source_location_code,
      'destination', case when movement_type_value = 'transfer' then destination_location_code else null end,
      'reference', nullif(trim(reference_value), ''),
      'reason', trim(reason_value),
      'movement_group_id', group_id
    )
  );
  return group_id;
end;
$$;
