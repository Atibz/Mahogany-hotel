-- A server-side, hotel-scoped report. It does not equate ledger usage with a physical count.
create function public.get_pos_stock_coverage_report(target_hotel_id uuid, target_date date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare report_date date; result jsonb;
begin
  if auth.uid() is null or not public.has_hotel_permission(target_hotel_id, 'pos.sales.read')
    or not public.has_hotel_permission(target_hotel_id, 'inventory.read') then
    raise exception 'Not authorised to view POS stock coverage';
  end if;
  if not exists (select 1 from public.hotels where id = target_hotel_id) then
    raise exception 'Hotel not found';
  end if;
  report_date := coalesce(target_date, public.hotel_business_date(target_hotel_id, now()));
  with sales as (
    select id, outlet_id from public.pos_orders
    where hotel_id = target_hotel_id and business_date = report_date and status <> 'voided'
  ), line_totals as (
    select s.outlet_id,
      coalesce(sum(l.quantity) filter (where l.stock_tracking_mode_snapshot = 'automatic'), 0) as automatic_units,
      coalesce(sum(l.quantity) filter (where l.stock_tracking_mode_snapshot = 'unconfigured'), 0) as unconfigured_units,
      coalesce(sum(l.quantity) filter (where l.stock_tracking_mode_snapshot = 'non_stock'), 0) as non_stock_units
    from sales s join public.pos_order_lines l on l.order_id = s.id
    group by s.outlet_id
  ), option_totals as (
    select s.outlet_id,
      coalesce(sum(l.quantity) filter (where m.stock_tracking_mode_snapshot = 'automatic'), 0) as automatic_units,
      coalesce(sum(l.quantity) filter (where m.stock_tracking_mode_snapshot = 'unconfigured'), 0) as unconfigured_units,
      coalesce(sum(l.quantity) filter (where m.stock_tracking_mode_snapshot = 'non_stock'), 0) as non_stock_units
    from sales s join public.pos_order_lines l on l.order_id = s.id
      join public.pos_order_line_modifiers m on m.order_line_id = l.id
    group by s.outlet_id
  ), latest_counts as (
    select distinct on (c.item_id, c.location_id) c.item_id, c.location_id,
      c.expected_quantity, c.observed_quantity, c.review_status, c.submitted_at
    from public.daily_operational_spot_checks c
    where c.hotel_id = target_hotel_id and c.business_date = report_date and c.kind = 'stock'
    order by c.item_id, c.location_id, c.submitted_at desc, c.id desc
  )
  select jsonb_build_object(
    'business_date', report_date,
    'outlets', coalesce((select jsonb_agg(jsonb_build_object(
      'outlet_id', o.id, 'outlet_name', o.name,
      'menu_automatic_units', coalesce(l.automatic_units, 0),
      'menu_unconfigured_units', coalesce(l.unconfigured_units, 0),
      'menu_non_stock_units', coalesce(l.non_stock_units, 0),
      'option_automatic_units', coalesce(p.automatic_units, 0),
      'option_unconfigured_units', coalesce(p.unconfigured_units, 0),
      'option_non_stock_units', coalesce(p.non_stock_units, 0)) order by o.name)
      from public.pos_outlets o left join line_totals l on l.outlet_id = o.id
        left join option_totals p on p.outlet_id = o.id
      where o.hotel_id = target_hotel_id and (o.active or l.outlet_id is not null)), '[]'::jsonb),
    'usage', coalesce((select jsonb_agg(jsonb_build_object(
      'outlet_id', grouped.outlet_id, 'outlet_name', grouped.outlet_name,
      'item_id', grouped.item_id, 'item_name', grouped.item_name, 'unit', grouped.base_unit,
      'quantity', grouped.quantity) order by grouped.outlet_name, grouped.item_name)
      from (select o.id as outlet_id, o.name as outlet_name, i.id as item_id,
        i.name as item_name, i.base_unit, sum(-m.quantity_delta) as quantity
        from public.inventory_movements m join public.pos_orders ord on ord.id = m.pos_order_id
        join public.pos_outlets o on o.id = ord.outlet_id
        join public.inventory_items i on i.id = m.item_id
        where m.hotel_id = target_hotel_id and ord.business_date = report_date
          and ord.status <> 'voided' and m.movement_type = 'pos_sale'
        group by o.id, o.name, i.id, i.name, i.base_unit) grouped), '[]'::jsonb),
    'physical_counts', coalesce((select jsonb_agg(jsonb_build_object(
      'item_name', i.name, 'unit', i.base_unit, 'location_name', loc.name,
      'expected_quantity', c.expected_quantity, 'observed_quantity', c.observed_quantity,
      'review_status', c.review_status, 'submitted_at', c.submitted_at)
      order by loc.name, i.name)
      from latest_counts c join public.inventory_items i on i.id = c.item_id
        join public.inventory_locations loc on loc.id = c.location_id), '[]'::jsonb)
  ) into result;
  return result;
end; $$;

revoke all on function public.get_pos_stock_coverage_report(uuid, date) from public, anon;
grant execute on function public.get_pos_stock_coverage_report(uuid, date) to authenticated;
