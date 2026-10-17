-- Snapshot selected POS modifiers on order lines and include their price
-- adjustments in the already-existing outlet-only line total.
alter table public.pos_order_lines
  add column base_unit_price_kobo bigint;

update public.pos_order_lines
set base_unit_price_kobo = unit_price_kobo
where base_unit_price_kobo is null;

alter table public.pos_order_lines
  alter column base_unit_price_kobo set not null,
  add constraint pos_order_lines_base_price_positive check (base_unit_price_kobo > 0),
  add constraint pos_order_lines_id_scope_unique unique (id, hotel_id, outlet_id);

create table public.pos_order_line_modifiers (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  outlet_id uuid not null,
  order_line_id uuid not null,
  modifier_group_id uuid not null,
  modifier_option_id uuid not null,
  group_code_snapshot text not null,
  group_name_snapshot text not null,
  option_code_snapshot text not null,
  option_name_snapshot text not null,
  price_delta_kobo bigint not null,
  created_at timestamptz not null default now(),
  unique (order_line_id, modifier_option_id),
  foreign key (order_line_id, hotel_id, outlet_id)
    references public.pos_order_lines(id, hotel_id, outlet_id) on delete restrict,
  foreign key (modifier_group_id, hotel_id, outlet_id)
    references public.pos_modifier_groups(id, hotel_id, outlet_id) on delete restrict,
  foreign key (modifier_option_id, hotel_id, outlet_id)
    references public.pos_modifier_options(id, hotel_id, outlet_id) on delete restrict
);

create index pos_order_line_modifiers_line_idx
  on public.pos_order_line_modifiers(order_line_id);

revoke all on public.pos_order_line_modifiers from public, anon, authenticated;
grant select on public.pos_order_line_modifiers to authenticated;
alter table public.pos_order_line_modifiers enable row level security;
create policy pos_order_line_modifiers_read on public.pos_order_line_modifiers
  for select to authenticated
  using (public.has_pos_outlet_permission(hotel_id, outlet_id, 'read'));

create or replace function public.add_restaurant_pos_order_item_with_modifiers(
  target_order_id uuid,
  target_menu_item_id uuid,
  item_quantity smallint,
  selected_modifier_option_ids uuid[]
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  order_record public.pos_orders;
  item_record public.pos_menu_items;
  group_record record;
  base_price bigint;
  modifier_total bigint := 0;
  final_unit_price bigint;
  modifier_id_count integer := 0;
  new_line_id uuid;
begin
  select * into order_record
  from public.pos_orders where id = target_order_id for update;
  if not found then raise exception 'POS order not found'; end if;
  if not public.has_pos_outlet_permission(order_record.hotel_id, order_record.outlet_id, 'create') then
    raise exception 'Not authorised to edit this POS outlet order';
  end if;
  if order_record.status <> 'open' then raise exception 'Only open orders accept items'; end if;
  if item_quantity is null or item_quantity not between 1 and 99 then
    raise exception 'Quantity must be between 1 and 99';
  end if;

  select * into item_record
  from public.pos_menu_items
  where id = target_menu_item_id
    and outlet_id = order_record.outlet_id
    and hotel_id = order_record.hotel_id
    and active;
  if not found then raise exception 'Choose an active menu item from this outlet'; end if;

  selected_modifier_option_ids := coalesce(selected_modifier_option_ids, '{}'::uuid[]);
  if cardinality(selected_modifier_option_ids) > 100 then
    raise exception 'Too many modifier selections';
  end if;

  select count(distinct mo.id)::integer, coalesce(sum(mo.price_delta_kobo), 0)::bigint
  into modifier_id_count, modifier_total
  from public.pos_modifier_options mo
  join public.pos_modifier_groups mg on mg.id = mo.modifier_group_id
  join public.pos_menu_item_modifier_groups assignment
    on assignment.menu_item_id = item_record.id
   and assignment.modifier_group_id = mg.id
   and assignment.hotel_id = item_record.hotel_id
   and assignment.outlet_id = item_record.outlet_id
   and assignment.active
  where mo.id = any(selected_modifier_option_ids)
    and mo.hotel_id = item_record.hotel_id
    and mo.outlet_id = item_record.outlet_id
    and mo.active and mg.active;

  if modifier_id_count <> cardinality(selected_modifier_option_ids) then
    raise exception 'One or more selected options are unavailable for this menu item';
  end if;

  for group_record in
    select mg.id, mg.name, mg.min_selections, mg.max_selections,
      count(mo.id)::integer as selected_count
    from public.pos_menu_item_modifier_groups assignment
    join public.pos_modifier_groups mg
      on mg.id = assignment.modifier_group_id
     and mg.hotel_id = assignment.hotel_id
     and mg.outlet_id = assignment.outlet_id
     and mg.active
    left join public.pos_modifier_options mo
      on mo.modifier_group_id = mg.id
     and mo.id = any(selected_modifier_option_ids)
     and mo.active
    where assignment.menu_item_id = item_record.id
      and assignment.hotel_id = item_record.hotel_id
      and assignment.outlet_id = item_record.outlet_id
      and assignment.active
    group by mg.id
  loop
    if group_record.selected_count < group_record.min_selections then
      raise exception 'Choose at least % option(s) for %', group_record.min_selections, group_record.name;
    end if;
    if group_record.selected_count > group_record.max_selections then
      raise exception 'Choose no more than % option(s) for %', group_record.max_selections, group_record.name;
    end if;
  end loop;

  select p.amount_kobo into base_price
  from public.pos_menu_item_prices p
  where p.menu_item_id = item_record.id
    and p.effective_from <= order_record.business_date
  order by p.effective_from desc
  limit 1;
  if base_price is null then raise exception 'This menu item has no effective price'; end if;
  final_unit_price := base_price + modifier_total;
  if final_unit_price <= 0 then raise exception 'Selected options result in an invalid item price'; end if;

  insert into public.pos_order_lines (
    hotel_id, outlet_id, order_id, menu_item_id, item_code_snapshot,
    item_name_snapshot, base_unit_price_kobo, unit_price_kobo, quantity, created_by
  ) values (
    item_record.hotel_id, item_record.outlet_id, order_record.id, item_record.id,
    item_record.code, item_record.name, base_price, final_unit_price, item_quantity, auth.uid()
  ) returning id into new_line_id;

  insert into public.pos_order_line_modifiers (
    hotel_id, outlet_id, order_line_id, modifier_group_id, modifier_option_id,
    group_code_snapshot, group_name_snapshot, option_code_snapshot,
    option_name_snapshot, price_delta_kobo
  )
  select item_record.hotel_id, item_record.outlet_id, new_line_id, mg.id, mo.id,
    mg.code, mg.name, mo.code, mo.name, mo.price_delta_kobo
  from public.pos_modifier_options mo
  join public.pos_modifier_groups mg on mg.id = mo.modifier_group_id
  where mo.id = any(selected_modifier_option_ids)
    and mo.hotel_id = item_record.hotel_id and mo.outlet_id = item_record.outlet_id;

  perform public.log_activity(order_record.hotel_id, 'pos.order_item_added', 'pos_order', order_record.id,
    jsonb_build_object(
      'line_id', new_line_id,
      'item_code', item_record.code,
      'quantity', item_quantity,
      'base_unit_price_kobo', base_price,
      'modifier_total_per_unit_kobo', modifier_total,
      'unit_price_kobo', final_unit_price,
      'modifier_option_ids', to_jsonb(selected_modifier_option_ids),
      'department_code', order_record.department_code_snapshot
    ));
  return new_line_id;
end;
$$;

-- Keep legacy callers safe: required modifier groups are still enforced by the
-- new RPC, even if an older client submits an item without selections.
create or replace function public.add_restaurant_pos_order_item(
  target_order_id uuid,
  target_menu_item_id uuid,
  item_quantity smallint
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
begin
  return public.add_restaurant_pos_order_item_with_modifiers(
    target_order_id, target_menu_item_id, item_quantity, '{}'::uuid[]
  );
end;
$$;

revoke all on function public.add_restaurant_pos_order_item_with_modifiers(uuid, uuid, smallint, uuid[])
  from public, anon, authenticated;
grant execute on function public.add_restaurant_pos_order_item_with_modifiers(uuid, uuid, smallint, uuid[])
  to authenticated;
