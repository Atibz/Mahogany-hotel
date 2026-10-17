-- Enable Bar POS while keeping restaurant and bar staff isolated by outlet type.
-- Hotel management and accounting roles retain their broader POS permissions.
insert into public.permissions(code,name,description) values
 ('pos.restaurant.read','View restaurant POS','View restaurant outlet sales only.'),
 ('pos.restaurant.create','Record restaurant POS sales','Create and reconcile restaurant outlet sales only.'),
 ('pos.bar.read','View bar POS','View bar outlet sales only.'),
 ('pos.bar.create','Record bar POS sales','Create and reconcile bar outlet sales only.')
on conflict(code) do nothing;

delete from public.role_permissions rp using public.roles r,public.permissions p
where rp.role_id=r.id and rp.permission_id=p.id and r.code='restaurant_staff'
  and p.code in ('pos.sales.read','pos.sales.create');

create or replace function public.provision_restaurant_pos_permissions(target_hotel_id uuid)
returns void language sql security definer set search_path=public as $$
 insert into public.role_permissions(role_id,permission_id)
 select r.id,p.id from public.roles r join public.permissions p on
   (r.code='general_manager' and p.code in ('pos.sales.read','pos.sales.create','pos.payments.verify','pos.catalog.read'))
   or (r.code='accountant' and p.code in ('pos.sales.read','pos.payments.verify'))
   or (r.code='restaurant_staff' and p.code in ('pos.restaurant.read','pos.restaurant.create'))
   or (r.code='bar_staff' and p.code in ('pos.bar.read','pos.bar.create'))
 where r.hotel_id=target_hotel_id on conflict do nothing;
$$;
select public.provision_restaurant_pos_permissions(id) from public.hotels;

create or replace function public.has_pos_outlet_permission(target_hotel_id uuid,target_outlet_id uuid,action_value text)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare outlet_type_value text;
begin
 select outlet_type into outlet_type_value from public.pos_outlets
 where id=target_outlet_id and hotel_id=target_hotel_id;
 if outlet_type_value not in ('restaurant','bar') then return false; end if;
 if action_value='read' and public.has_hotel_permission(target_hotel_id,'pos.sales.read') then return true; end if;
 if action_value='create' and public.has_hotel_permission(target_hotel_id,'pos.sales.create') then return true; end if;
 if action_value='read' and outlet_type_value='restaurant' then
   return public.has_hotel_permission(target_hotel_id,'pos.restaurant.read');
 elsif action_value='create' and outlet_type_value='restaurant' then
   return public.has_hotel_permission(target_hotel_id,'pos.restaurant.create');
 elsif action_value='read' and outlet_type_value='bar' then
   return public.has_hotel_permission(target_hotel_id,'pos.bar.read');
 elsif action_value='create' and outlet_type_value='bar' then
   return public.has_hotel_permission(target_hotel_id,'pos.bar.create');
 end if;
 return false;
end;
$$;

create or replace function public.can_view_pos_hotel(target_hotel_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select public.has_hotel_permission(target_hotel_id,'pos.sales.read') or exists (
  select 1 from public.pos_outlets o where o.hotel_id=target_hotel_id
   and public.has_pos_outlet_permission(target_hotel_id,o.id,'read')
);
$$;

-- Ensure the workspace bootstrap RPC exists locally as well as remotely.
create or replace function public.get_restaurant_pos_business_date(target_hotel_id uuid)
returns date language plpgsql stable security definer set search_path=public as $$
begin
 if not public.can_view_pos_hotel(target_hotel_id) then raise exception 'Not authorised to view POS'; end if;
 return public.hotel_business_date(target_hotel_id);
end;
$$;

revoke all on function public.has_pos_outlet_permission(uuid,uuid,text),public.can_view_pos_hotel(uuid) from public,anon;
grant execute on function public.has_pos_outlet_permission(uuid,uuid,text),public.can_view_pos_hotel(uuid) to authenticated;
revoke all on function public.get_restaurant_pos_business_date(uuid) from public,anon;
grant execute on function public.get_restaurant_pos_business_date(uuid) to authenticated;

drop policy if exists pos_cashier_shifts_read on public.pos_cashier_shifts;
create policy pos_cashier_shifts_read on public.pos_cashier_shifts for select to authenticated
using(public.has_pos_outlet_permission(hotel_id,outlet_id,'read'));
drop policy if exists pos_orders_read on public.pos_orders;
create policy pos_orders_read on public.pos_orders for select to authenticated
using(public.has_pos_outlet_permission(hotel_id,outlet_id,'read'));
drop policy if exists pos_order_lines_read on public.pos_order_lines;
create policy pos_order_lines_read on public.pos_order_lines for select to authenticated
using(public.has_pos_outlet_permission(hotel_id,outlet_id,'read'));
drop policy if exists pos_order_payments_read on public.pos_order_payments;
create policy pos_order_payments_read on public.pos_order_payments for select to authenticated
using(public.has_pos_outlet_permission(hotel_id,outlet_id,'read'));
drop policy if exists pos_order_receipts_read on public.pos_order_receipts;
create policy pos_order_receipts_read on public.pos_order_receipts for select to authenticated
using(public.has_pos_outlet_permission(hotel_id,outlet_id,'read'));

drop policy if exists pos_outlets_read on public.pos_outlets;
create policy pos_outlets_read on public.pos_outlets for select to authenticated
using(public.has_hotel_permission(hotel_id,'pos.catalog.read') or public.has_pos_outlet_permission(hotel_id,id,'read'));
drop policy if exists pos_menu_categories_read on public.pos_menu_categories;
create policy pos_menu_categories_read on public.pos_menu_categories for select to authenticated using(active and (
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or public.has_pos_outlet_permission(hotel_id,outlet_id,'read')));
drop policy if exists pos_menu_items_read on public.pos_menu_items;
create policy pos_menu_items_read on public.pos_menu_items for select to authenticated using(active and (
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or public.has_pos_outlet_permission(hotel_id,outlet_id,'read')));
drop policy if exists pos_menu_item_prices_read on public.pos_menu_item_prices;
create policy pos_menu_item_prices_read on public.pos_menu_item_prices for select to authenticated using(
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or public.has_pos_outlet_permission(hotel_id,outlet_id,'read'));
drop policy if exists pos_modifier_groups_read on public.pos_modifier_groups;
create policy pos_modifier_groups_read on public.pos_modifier_groups for select to authenticated using(active and (
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or public.has_pos_outlet_permission(hotel_id,outlet_id,'read')));
drop policy if exists pos_modifier_options_read on public.pos_modifier_options;
create policy pos_modifier_options_read on public.pos_modifier_options for select to authenticated using(active and (
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or exists(select 1 from public.pos_modifier_groups g
  where g.id=modifier_group_id and public.has_pos_outlet_permission(hotel_id,g.outlet_id,'read'))));
drop policy if exists pos_menu_item_modifier_groups_read on public.pos_menu_item_modifier_groups;
create policy pos_menu_item_modifier_groups_read on public.pos_menu_item_modifier_groups for select to authenticated using(active and (
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or exists(select 1 from public.pos_menu_items i
  where i.id=menu_item_id and public.has_pos_outlet_permission(hotel_id,i.outlet_id,'read'))));

-- Apply narrowly checked source changes to the existing security-definer RPCs.
do $$
declare item record; function_oid oid; definition text;
begin
 for item in select * from (values
  ('public.create_restaurant_pos_order(uuid,text,text,text)','outlet_type=''restaurant''','outlet_type in (''restaurant'',''bar'')'),
  ('public.create_restaurant_pos_order(uuid,text,text,text)','public.has_hotel_permission(o.hotel_id,''pos.sales.create'')','public.has_pos_outlet_permission(o.hotel_id,o.id,''create'')'),
  ('public.add_restaurant_pos_order_item(uuid,uuid,smallint)','public.has_hotel_permission(o.hotel_id,''pos.sales.create'')','public.has_pos_outlet_permission(o.hotel_id,o.outlet_id,''create'')'),
  ('public.void_restaurant_pos_order(uuid,text)','public.has_hotel_permission(o.hotel_id,''pos.sales.create'')','public.has_pos_outlet_permission(o.hotel_id,o.outlet_id,''create'')'),
  ('public.open_pos_cashier_shift(uuid,bigint)','outlet_type=''restaurant''','outlet_type in (''restaurant'',''bar'')'),
  ('public.open_pos_cashier_shift(uuid,bigint)','public.has_hotel_permission(o.hotel_id,''pos.sales.create'')','public.has_pos_outlet_permission(o.hotel_id,o.id,''create'')'),
  ('public.close_pos_cashier_shift(uuid,bigint,text)','public.has_hotel_permission(s.hotel_id,''pos.sales.create'')','public.has_pos_outlet_permission(s.hotel_id,s.outlet_id,''create'')'),
  ('public.record_restaurant_pos_payment(uuid,uuid,bigint,text)','public.has_hotel_permission(o.hotel_id,''pos.sales.create'')','public.has_pos_outlet_permission(o.hotel_id,o.outlet_id,''create'')'),
  ('public.get_restaurant_pos_sales_report(uuid,date,date)','not public.has_hotel_permission(target_hotel_id,''pos.sales.read'')','not public.can_view_pos_hotel(target_hotel_id)'),
  ('public.get_restaurant_pos_sales_report(uuid,date,date)','o.hotel_id=target_hotel_id and o.business_date between from_date and to_date and o.status<>''voided''','o.hotel_id=target_hotel_id and o.business_date between from_date and to_date and o.status<>''voided'' and public.has_pos_outlet_permission(o.hotel_id,o.outlet_id,''read'')'),
  ('public.get_restaurant_pos_business_date(uuid)','not public.has_hotel_permission(target_hotel_id,''pos.sales.read'')','not public.can_view_pos_hotel(target_hotel_id)')
 ) as changes(signature,old_text,new_text)
 loop
  function_oid:=to_regprocedure(item.signature);
  if function_oid is null then raise exception 'Required POS function is missing: %',item.signature; end if;
  definition:=pg_get_functiondef(function_oid);
  if position(item.old_text in definition)=0 then
   if position(item.new_text in definition)>0 then continue; end if;
   raise exception 'Expected source text was not found in %',item.signature;
  end if;
  execute replace(definition,item.old_text,item.new_text);
 end loop;
end;
$$;
