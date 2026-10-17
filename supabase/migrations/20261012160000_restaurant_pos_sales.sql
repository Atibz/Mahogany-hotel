-- Restaurant sales have their own order, tender, receipt, and cash-shift ledger.
-- They never create hotel payments, guest-folio allocations, hotel receipts, or tax.

create table public.pos_cashier_shifts (
  id uuid primary key default gen_random_uuid(), hotel_id uuid not null references public.hotels(id) on delete restrict,
  outlet_id uuid not null, shift_number text not null, business_date date not null,
  status text not null default 'open' check (status in ('open','closed')),
  opening_float_kobo bigint not null default 0 check (opening_float_kobo >= 0),
  expected_cash_kobo bigint, declared_cash_kobo bigint, variance_kobo bigint, variance_reason text,
  opened_by uuid not null references public.profiles(id) on delete restrict, opened_at timestamptz not null default now(),
  closed_by uuid references public.profiles(id) on delete restrict, closed_at timestamptz,
  unique (hotel_id, shift_number), foreign key (outlet_id,hotel_id) references public.pos_outlets(id,hotel_id) on delete restrict,
  check ((status='open' and closed_at is null and declared_cash_kobo is null and variance_kobo is null)
    or (status='closed' and closed_at is not null and closed_by is not null and declared_cash_kobo is not null and expected_cash_kobo is not null and variance_kobo is not null)),
  check (variance_kobo = 0 or nullif(trim(variance_reason),'') is not null)
);
create unique index pos_cashier_shifts_one_open_idx on public.pos_cashier_shifts(hotel_id,outlet_id,opened_by) where status='open';

create table public.pos_orders (
  id uuid primary key default gen_random_uuid(), hotel_id uuid not null references public.hotels(id) on delete restrict,
  outlet_id uuid not null, order_number text not null, business_date date not null,
  service_mode text not null check (service_mode in ('dine_in','takeaway','delivery')),
  table_reference text, guest_label text, outlet_name_snapshot text not null, department_code_snapshot text not null,
  status text not null default 'open' check (status in ('open','settled','voided')),
  created_by uuid references public.profiles(id) on delete set null, created_at timestamptz not null default now(), settled_at timestamptz,
  voided_at timestamptz, voided_by uuid references public.profiles(id) on delete set null, void_reason text,
  unique (hotel_id,order_number), unique (id,hotel_id,outlet_id),
  foreign key (outlet_id,hotel_id) references public.pos_outlets(id,hotel_id) on delete restrict,
  check ((status='settled' and settled_at is not null) or status<>'settled'),
  check ((status='voided' and voided_at is not null and nullif(trim(void_reason),'') is not null) or status<>'voided')
);
create table public.pos_order_lines (
  id uuid primary key default gen_random_uuid(), hotel_id uuid not null, outlet_id uuid not null, order_id uuid not null,
  menu_item_id uuid not null, item_code_snapshot text not null, item_name_snapshot text not null,
  unit_price_kobo bigint not null check (unit_price_kobo>0), quantity smallint not null check (quantity between 1 and 99),
  line_total_kobo bigint generated always as (unit_price_kobo*quantity) stored,
  created_by uuid references public.profiles(id) on delete set null, created_at timestamptz not null default now(),
  foreign key (order_id,hotel_id,outlet_id) references public.pos_orders(id,hotel_id,outlet_id) on delete restrict,
  foreign key (menu_item_id,hotel_id,outlet_id) references public.pos_menu_items(id,hotel_id,outlet_id) on delete restrict
);
create table public.pos_order_payments (
  id uuid primary key default gen_random_uuid(), hotel_id uuid not null, outlet_id uuid not null, order_id uuid not null,
  payment_number text not null, payment_method_id uuid not null references public.payment_methods(id) on delete restrict,
  payment_method_name_snapshot text not null, amount_kobo bigint not null check (amount_kobo>0), reference text,
  status text not null check (status in ('completed','pending_verification','voided')),
  cashier_shift_id uuid references public.pos_cashier_shifts(id) on delete restrict,
  received_by uuid references public.profiles(id) on delete set null, received_at timestamptz not null default now(),
  verified_by uuid references public.profiles(id) on delete set null, verified_at timestamptz, verification_note text,
  voided_by uuid references public.profiles(id) on delete set null, voided_at timestamptz, void_reason text,
  unique (hotel_id,payment_number), unique (id,hotel_id,outlet_id),
  foreign key (order_id,hotel_id,outlet_id) references public.pos_orders(id,hotel_id,outlet_id) on delete restrict,
  check (status<>'pending_verification' or cashier_shift_id is null),
  check (status<>'voided' or (voided_at is not null and nullif(trim(void_reason),'') is not null))
);
create table public.pos_order_receipts (
  id uuid primary key default gen_random_uuid(), hotel_id uuid not null references public.hotels(id) on delete restrict,
  outlet_id uuid not null, order_id uuid not null, payment_id uuid not null, receipt_number text not null,
  order_number_snapshot text not null, outlet_name_snapshot text not null, department_code_snapshot text not null,
  payment_method_name_snapshot text not null, amount_kobo bigint not null check (amount_kobo>0), reference text,
  issued_by uuid references public.profiles(id) on delete set null, issued_at timestamptz not null default now(),
  unique (payment_id), unique (hotel_id,receipt_number),
  foreign key (order_id,hotel_id,outlet_id) references public.pos_orders(id,hotel_id,outlet_id) on delete restrict,
  foreign key (payment_id,hotel_id,outlet_id) references public.pos_order_payments(id,hotel_id,outlet_id) on delete restrict
);
create index pos_orders_outlet_date_idx on public.pos_orders(outlet_id,business_date desc,created_at desc);
create index pos_order_lines_order_idx on public.pos_order_lines(order_id,created_at);
create index pos_order_payments_order_idx on public.pos_order_payments(order_id,received_at desc);

insert into public.permissions(code,name,description) values
 ('pos.sales.read','View restaurant POS sales','View restaurant orders, payments, receipts, shifts, and summaries.'),
 ('pos.sales.create','Record restaurant POS sales','Open restaurant orders, add items, record payments, and manage a personal cash shift.'),
 ('pos.payments.verify','Verify restaurant POS payments','Verify or reject pending restaurant POS transfers independently of hotel folio payments.')
on conflict(code) do nothing;
create or replace function public.provision_restaurant_pos_permissions(target_hotel_id uuid)
returns void language sql security definer set search_path=public as $$
 insert into public.role_permissions(role_id,permission_id)
 select r.id,p.id from public.roles r join public.permissions p on
   (r.code='general_manager' and p.code in ('pos.sales.read','pos.sales.create','pos.payments.verify','pos.catalog.read'))
   or (r.code='accountant' and p.code in ('pos.sales.read','pos.payments.verify'))
   or (r.code='restaurant_staff' and p.code in ('pos.sales.read','pos.sales.create'))
 where r.hotel_id=target_hotel_id on conflict do nothing;
$$;
select public.provision_restaurant_pos_permissions(id) from public.hotels;
create or replace function public.handle_hotel_restaurant_pos_permission_provisioning()
returns trigger language plpgsql security definer set search_path=public as $$
begin perform public.provision_restaurant_pos_permissions(new.id); return new; end;
$$;
drop trigger if exists zzzzzzzzzz_hotel_restaurant_pos_permissions on public.hotels;
create trigger zzzzzzzzzz_hotel_restaurant_pos_permissions after insert on public.hotels
for each row execute function public.handle_hotel_restaurant_pos_permission_provisioning();

revoke all on public.pos_cashier_shifts,public.pos_orders,public.pos_order_lines,public.pos_order_payments,public.pos_order_receipts from public,anon,authenticated;
grant select on public.pos_cashier_shifts,public.pos_orders,public.pos_order_lines,public.pos_order_payments,public.pos_order_receipts to authenticated;
alter table public.pos_cashier_shifts enable row level security;
alter table public.pos_orders enable row level security;
alter table public.pos_order_lines enable row level security;
alter table public.pos_order_payments enable row level security;
alter table public.pos_order_receipts enable row level security;
create policy pos_cashier_shifts_read on public.pos_cashier_shifts for select to authenticated using(public.has_hotel_permission(hotel_id,'pos.sales.read'));
create policy pos_orders_read on public.pos_orders for select to authenticated using(public.has_hotel_permission(hotel_id,'pos.sales.read'));
create policy pos_order_lines_read on public.pos_order_lines for select to authenticated using(public.has_hotel_permission(hotel_id,'pos.sales.read'));
create policy pos_order_payments_read on public.pos_order_payments for select to authenticated using(public.has_hotel_permission(hotel_id,'pos.sales.read'));
create policy pos_order_receipts_read on public.pos_order_receipts for select to authenticated using(public.has_hotel_permission(hotel_id,'pos.sales.read'));

-- Restaurant sales staff can read restaurant menu data, but not the bar menu.
drop policy if exists pos_outlets_read on public.pos_outlets;
create policy pos_outlets_read on public.pos_outlets for select to authenticated using(
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or
 (outlet_type='restaurant' and public.has_hotel_permission(hotel_id,'pos.sales.read')));
drop policy if exists pos_menu_categories_read on public.pos_menu_categories;
create policy pos_menu_categories_read on public.pos_menu_categories for select to authenticated using(active and (
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or
 (exists(select 1 from public.pos_outlets o where o.id=outlet_id and o.outlet_type='restaurant') and public.has_hotel_permission(hotel_id,'pos.sales.read'))));
drop policy if exists pos_menu_items_read on public.pos_menu_items;
create policy pos_menu_items_read on public.pos_menu_items for select to authenticated using(active and (
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or
 (exists(select 1 from public.pos_outlets o where o.id=outlet_id and o.outlet_type='restaurant') and public.has_hotel_permission(hotel_id,'pos.sales.read'))));
drop policy if exists pos_menu_item_prices_read on public.pos_menu_item_prices;
create policy pos_menu_item_prices_read on public.pos_menu_item_prices for select to authenticated using(
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or
 (exists(select 1 from public.pos_outlets o where o.id=outlet_id and o.outlet_type='restaurant') and public.has_hotel_permission(hotel_id,'pos.sales.read')));
drop policy if exists pos_modifier_groups_read on public.pos_modifier_groups;
create policy pos_modifier_groups_read on public.pos_modifier_groups for select to authenticated using(active and (
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or
 (exists(select 1 from public.pos_outlets o where o.id=outlet_id and o.outlet_type='restaurant') and public.has_hotel_permission(hotel_id,'pos.sales.read'))));
drop policy if exists pos_modifier_options_read on public.pos_modifier_options;
create policy pos_modifier_options_read on public.pos_modifier_options for select to authenticated using(active and (
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or
 (exists(select 1 from public.pos_outlets o where o.id=outlet_id and o.outlet_type='restaurant') and public.has_hotel_permission(hotel_id,'pos.sales.read'))));
drop policy if exists pos_menu_item_modifier_groups_read on public.pos_menu_item_modifier_groups;
create policy pos_menu_item_modifier_groups_read on public.pos_menu_item_modifier_groups for select to authenticated using(active and (
 public.has_hotel_permission(hotel_id,'pos.catalog.read') or
 (exists(select 1 from public.pos_outlets o where o.id=outlet_id and o.outlet_type='restaurant') and public.has_hotel_permission(hotel_id,'pos.sales.read'))));

create or replace function public.pos_order_totals(target_order_id uuid)
returns table(gross_total_kobo bigint,completed_kobo bigint,pending_kobo bigint)
language sql stable security definer set search_path=public as $$
 select coalesce((select sum(line_total_kobo) from public.pos_order_lines where order_id=target_order_id),0),
 coalesce((select sum(amount_kobo) from public.pos_order_payments where order_id=target_order_id and status='completed'),0),
 coalesce((select sum(amount_kobo) from public.pos_order_payments where order_id=target_order_id and status='pending_verification'),0)
$$;

create or replace function public.create_restaurant_pos_order(target_outlet_id uuid,service_mode_value text,table_reference_value text default null,guest_label_value text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare o public.pos_outlets; new_id uuid; number_value text;
begin
 select * into o from public.pos_outlets where id=target_outlet_id and active and outlet_type='restaurant' for update;
 if not found then raise exception 'Choose an active restaurant outlet'; end if;
 if not public.has_hotel_permission(o.hotel_id,'pos.sales.create') then raise exception 'Not authorised to record restaurant sales'; end if;
 if service_mode_value not in ('dine_in','takeaway','delivery') then raise exception 'Choose a valid service type'; end if;
 if service_mode_value='dine_in' and nullif(trim(table_reference_value),'') is null then raise exception 'A table reference is required for dine-in orders'; end if;
 number_value:=public.next_document_number(o.hotel_id,'FBO');
 insert into public.pos_orders(hotel_id,outlet_id,order_number,business_date,service_mode,table_reference,guest_label,outlet_name_snapshot,department_code_snapshot,created_by)
 values(o.hotel_id,o.id,number_value,public.hotel_business_date(o.hotel_id),service_mode_value,nullif(trim(table_reference_value),''),nullif(trim(guest_label_value),''),o.name,o.department_code,auth.uid()) returning id into new_id;
 perform public.log_activity(o.hotel_id,'pos.restaurant_order_opened','pos_order',new_id,jsonb_build_object('order_number',number_value,'outlet_id',o.id,'department_code',o.department_code,'service_mode',service_mode_value));
 return new_id;
end; $$;

create or replace function public.add_restaurant_pos_order_item(target_order_id uuid,target_menu_item_id uuid,item_quantity smallint)
returns uuid language plpgsql security definer set search_path=public as $$
declare o public.pos_orders; i public.pos_menu_items; price_value bigint; new_id uuid;
begin
 select * into o from public.pos_orders where id=target_order_id for update;
 if not found then raise exception 'POS order not found'; end if;
 if not public.has_hotel_permission(o.hotel_id,'pos.sales.create') then raise exception 'Not authorised to edit restaurant orders'; end if;
 if o.status<>'open' then raise exception 'Only open orders accept items'; end if;
 if item_quantity is null or item_quantity not between 1 and 99 then raise exception 'Quantity must be between 1 and 99'; end if;
 select * into i from public.pos_menu_items where id=target_menu_item_id and outlet_id=o.outlet_id and hotel_id=o.hotel_id and active;
 if not found then raise exception 'Choose an active menu item from this restaurant outlet'; end if;
 select amount_kobo into price_value from public.pos_menu_item_prices where menu_item_id=i.id and effective_from<=o.business_date order by effective_from desc limit 1;
 if price_value is null then raise exception 'This menu item has no effective price'; end if;
 insert into public.pos_order_lines(hotel_id,outlet_id,order_id,menu_item_id,item_code_snapshot,item_name_snapshot,unit_price_kobo,quantity,created_by)
 values(o.hotel_id,o.outlet_id,o.id,i.id,i.code,i.name,price_value,item_quantity,auth.uid()) returning id into new_id;
 perform public.log_activity(o.hotel_id,'pos.restaurant_order_item_added','pos_order',o.id,jsonb_build_object('line_id',new_id,'item_code',i.code,'quantity',item_quantity,'unit_price_kobo',price_value,'department_code',o.department_code_snapshot));
 return new_id;
end; $$;

create or replace function public.void_restaurant_pos_order(target_order_id uuid,reason_value text)
returns void language plpgsql security definer set search_path=public as $$
declare o public.pos_orders; totals record;
begin
 select * into o from public.pos_orders where id=target_order_id for update;
 if not found then raise exception 'POS order not found'; end if;
 if not public.has_hotel_permission(o.hotel_id,'pos.sales.create') then raise exception 'Not authorised to void restaurant orders'; end if;
 if o.status<>'open' then raise exception 'Only open unpaid orders can be voided'; end if;
 select * into totals from public.pos_order_totals(o.id);
 if totals.completed_kobo>0 then raise exception 'Orders with received payments need a separately approved correction workflow'; end if;
 if totals.pending_kobo>0 then raise exception 'Reject pending payments before voiding this order'; end if;
 if nullif(trim(reason_value),'') is null then raise exception 'A reason is required to void an order'; end if;
 update public.pos_orders set status='voided',voided_at=now(),voided_by=auth.uid(),void_reason=trim(reason_value) where id=o.id;
 perform public.log_activity(o.hotel_id,'pos.restaurant_order_voided','pos_order',o.id,jsonb_build_object('order_number',o.order_number,'reason',trim(reason_value)));
end; $$;

create or replace function public.open_pos_cashier_shift(target_outlet_id uuid,opening_float_value_kobo bigint)
returns uuid language plpgsql security definer set search_path=public as $$
declare o public.pos_outlets; new_id uuid; number_value text;
begin
 select * into o from public.pos_outlets where id=target_outlet_id and active and outlet_type='restaurant';
 if not found then raise exception 'Choose an active restaurant outlet'; end if;
 if not public.has_hotel_permission(o.hotel_id,'pos.sales.create') then raise exception 'Not authorised to open a restaurant cash shift'; end if;
 if opening_float_value_kobo is null or opening_float_value_kobo<0 then raise exception 'Opening float cannot be negative'; end if;
 if exists(select 1 from public.pos_cashier_shifts where outlet_id=o.id and opened_by=auth.uid() and status='open') then raise exception 'You already have an open cash shift for this outlet'; end if;
 number_value:=public.next_document_number(o.hotel_id,'PCS');
 insert into public.pos_cashier_shifts(hotel_id,outlet_id,shift_number,business_date,opening_float_kobo,opened_by)
 values(o.hotel_id,o.id,number_value,public.hotel_business_date(o.hotel_id),opening_float_value_kobo,auth.uid()) returning id into new_id;
 perform public.log_activity(o.hotel_id,'pos.cash_shift_opened','pos_cashier_shift',new_id,jsonb_build_object('shift_number',number_value,'outlet_id',o.id,'opening_float_kobo',opening_float_value_kobo));
 return new_id;
end; $$;

create or replace function public.close_pos_cashier_shift(target_shift_id uuid,declared_cash_value_kobo bigint,variance_reason_value text default null)
returns void language plpgsql security definer set search_path=public as $$
declare s public.pos_cashier_shifts; expected_value bigint; variance_value bigint;
begin
 select * into s from public.pos_cashier_shifts where id=target_shift_id for update;
 if not found then raise exception 'Restaurant cash shift not found'; end if;
 if not public.has_hotel_permission(s.hotel_id,'pos.sales.create') or s.opened_by<>auth.uid() then raise exception 'You may only close your own authorised restaurant cash shift'; end if;
 if s.status<>'open' then raise exception 'This restaurant cash shift is already closed'; end if;
 if declared_cash_value_kobo is null or declared_cash_value_kobo<0 then raise exception 'Declared cash cannot be negative'; end if;
 select s.opening_float_kobo+coalesce(sum(p.amount_kobo),0) into expected_value from public.pos_order_payments p join public.payment_methods m on m.id=p.payment_method_id
 where p.cashier_shift_id=s.id and m.code='cash' and p.status='completed';
 variance_value:=declared_cash_value_kobo-expected_value;
 if variance_value<>0 and nullif(trim(variance_reason_value),'') is null then raise exception 'A reason is required when declared cash differs from expected cash'; end if;
 update public.pos_cashier_shifts set status='closed',expected_cash_kobo=expected_value,declared_cash_kobo=declared_cash_value_kobo,
 variance_kobo=variance_value,variance_reason=nullif(trim(variance_reason_value),''),closed_by=auth.uid(),closed_at=now() where id=s.id;
 perform public.log_activity(s.hotel_id,'pos.cash_shift_closed','pos_cashier_shift',s.id,jsonb_build_object('expected_cash_kobo',expected_value,'declared_cash_kobo',declared_cash_value_kobo,'variance_kobo',variance_value,'variance_reason',nullif(trim(variance_reason_value),'')));
end; $$;

create or replace function public.record_restaurant_pos_payment(target_order_id uuid,target_payment_method_id uuid,payment_amount_kobo bigint,payment_reference text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare o public.pos_orders; m public.payment_methods; shift_id uuid; pay_id uuid; pay_no text; receipt_no text; t record; initial_status text;
begin
 select * into o from public.pos_orders where id=target_order_id for update;
 if not found then raise exception 'POS order not found'; end if;
 if not public.has_hotel_permission(o.hotel_id,'pos.sales.create') then raise exception 'Not authorised to record restaurant payments'; end if;
 if o.status<>'open' then raise exception 'This restaurant order is no longer open'; end if;
 if payment_amount_kobo is null or payment_amount_kobo<=0 then raise exception 'Payment must be greater than zero'; end if;
 select * into m from public.payment_methods where id=target_payment_method_id and hotel_id=o.hotel_id and active;
 if not found then raise exception 'Payment method is not available'; end if;
 if m.requires_reference and nullif(trim(payment_reference),'') is null then raise exception 'A reference is required for this payment method'; end if;
 if m.code='cash' and m.requires_verification then raise exception 'Cash cannot require payment verification'; end if;
 select * into t from public.pos_order_totals(o.id);
 if t.gross_total_kobo<=0 then raise exception 'Add at least one menu item before taking payment'; end if;
 if payment_amount_kobo>t.gross_total_kobo-t.completed_kobo-t.pending_kobo then raise exception 'Payment exceeds the remaining order balance, including pending verification'; end if;
 if m.code='cash' then
  select id into shift_id from public.pos_cashier_shifts where outlet_id=o.outlet_id and opened_by=auth.uid() and status='open' for update;
  if shift_id is null then raise exception 'Open your restaurant cash shift before receiving cash'; end if;
 end if;
 initial_status:=case when m.requires_verification then 'pending_verification' else 'completed' end;
 pay_no:=public.next_document_number(o.hotel_id,'FBP');
 insert into public.pos_order_payments(hotel_id,outlet_id,order_id,payment_number,payment_method_id,payment_method_name_snapshot,amount_kobo,reference,status,cashier_shift_id,received_by)
 values(o.hotel_id,o.outlet_id,o.id,pay_no,m.id,m.name,payment_amount_kobo,nullif(trim(payment_reference),''),initial_status,shift_id,auth.uid()) returning id into pay_id;
 if initial_status='completed' then
  receipt_no:=public.next_document_number(o.hotel_id,'FBR');
  insert into public.pos_order_receipts(hotel_id,outlet_id,order_id,payment_id,receipt_number,order_number_snapshot,outlet_name_snapshot,department_code_snapshot,payment_method_name_snapshot,amount_kobo,reference,issued_by)
  values(o.hotel_id,o.outlet_id,o.id,pay_id,receipt_no,o.order_number,o.outlet_name_snapshot,o.department_code_snapshot,m.name,payment_amount_kobo,nullif(trim(payment_reference),''),auth.uid());
  select * into t from public.pos_order_totals(o.id);
  if t.completed_kobo>=t.gross_total_kobo then update public.pos_orders set status='settled',settled_at=now() where id=o.id; end if;
 end if;
 perform public.log_activity(o.hotel_id,'pos.restaurant_payment_recorded','pos_payment',pay_id,jsonb_build_object('order_id',o.id,'order_number',o.order_number,'outlet_id',o.outlet_id,'department_code',o.department_code_snapshot,'amount_kobo',payment_amount_kobo,'payment_method',m.name,'status',initial_status,'receipt_number',receipt_no,'cashier_shift_id',shift_id));
 return pay_id;
end; $$;

create or replace function public.verify_restaurant_pos_payment(target_payment_id uuid,note_value text)
returns void language plpgsql security definer set search_path=public as $$
declare p public.pos_order_payments; o public.pos_orders; t record; receipt_no text;
begin
 select * into p from public.pos_order_payments where id=target_payment_id for update;
 if not found then raise exception 'Restaurant POS payment not found'; end if;
 if not public.has_hotel_permission(p.hotel_id,'pos.payments.verify') then raise exception 'Not authorised to verify restaurant POS payments'; end if;
 if p.status<>'pending_verification' then raise exception 'Only pending restaurant POS payments can be verified'; end if;
 if nullif(trim(note_value),'') is null then raise exception 'A verification note is required'; end if;
 select * into o from public.pos_orders where id=p.order_id for update;
 if o.status<>'open' then raise exception 'Only payments on an open restaurant order can be verified'; end if;
 receipt_no:=public.next_document_number(p.hotel_id,'FBR');
 insert into public.pos_order_receipts(hotel_id,outlet_id,order_id,payment_id,receipt_number,order_number_snapshot,outlet_name_snapshot,department_code_snapshot,payment_method_name_snapshot,amount_kobo,reference,issued_by)
 values(p.hotel_id,p.outlet_id,p.order_id,p.id,receipt_no,o.order_number,o.outlet_name_snapshot,o.department_code_snapshot,p.payment_method_name_snapshot,p.amount_kobo,p.reference,auth.uid());
 update public.pos_order_payments set status='completed',verified_by=auth.uid(),verified_at=now(),verification_note=trim(note_value) where id=p.id;
 select * into t from public.pos_order_totals(o.id);
 if t.completed_kobo>=t.gross_total_kobo then update public.pos_orders set status='settled',settled_at=now() where id=o.id; end if;
 perform public.log_activity(p.hotel_id,'pos.restaurant_payment_verified','pos_payment',p.id,jsonb_build_object('receipt_number',receipt_no,'verification_note',trim(note_value)));
end; $$;

create or replace function public.reject_restaurant_pos_payment(target_payment_id uuid,reason_value text)
returns void language plpgsql security definer set search_path=public as $$
declare p public.pos_order_payments;
begin
 select * into p from public.pos_order_payments where id=target_payment_id for update;
 if not found then raise exception 'Restaurant POS payment not found'; end if;
 if not public.has_hotel_permission(p.hotel_id,'pos.payments.verify') then raise exception 'Not authorised to reject restaurant POS payments'; end if;
 if p.status<>'pending_verification' then raise exception 'Only pending restaurant POS payments can be rejected'; end if;
 if nullif(trim(reason_value),'') is null then raise exception 'A rejection reason is required'; end if;
 update public.pos_order_payments set status='voided',voided_by=auth.uid(),voided_at=now(),void_reason=trim(reason_value) where id=p.id;
 perform public.log_activity(p.hotel_id,'pos.restaurant_payment_rejected','pos_payment',p.id,jsonb_build_object('reason',trim(reason_value)));
end; $$;

create or replace function public.get_restaurant_pos_sales_report(target_hotel_id uuid,from_date date,to_date date)
returns table(business_date date,outlet_id uuid,outlet_name text,department_code text,settled_orders bigint,gross_sales_kobo bigint,collected_kobo bigint,pending_kobo bigint,open_balance_kobo bigint)
language plpgsql stable security definer set search_path=public as $$
begin
 if not public.has_hotel_permission(target_hotel_id,'pos.sales.read') then raise exception 'Not authorised to view restaurant POS reports'; end if;
 if from_date is null or to_date is null or from_date>to_date or to_date-from_date>92 then raise exception 'Choose a valid report period of up to 93 days'; end if;
 return query with amounts as (
  select o.id,o.business_date,o.outlet_id,o.outlet_name_snapshot,o.department_code_snapshot,o.status,coalesce(sum(l.line_total_kobo),0)::bigint gross
  from public.pos_orders o left join public.pos_order_lines l on l.order_id=o.id
  where o.hotel_id=target_hotel_id and o.business_date between from_date and to_date and o.status<>'voided' group by o.id
 ), tenders as (
  select p.order_id,coalesce(sum(p.amount_kobo) filter(where p.status='completed'),0)::bigint collected,
   coalesce(sum(p.amount_kobo) filter(where p.status='pending_verification'),0)::bigint pending
  from public.pos_order_payments p join amounts a on a.id=p.order_id group by p.order_id
 )
 select a.business_date,a.outlet_id,a.outlet_name_snapshot,a.department_code_snapshot,
  count(*) filter(where a.status='settled'),coalesce(sum(a.gross),0)::bigint,
  coalesce(sum(t.collected),0)::bigint,coalesce(sum(t.pending),0)::bigint,
  coalesce(sum(greatest(a.gross-t.collected,0)),0)::bigint
 from amounts a left join tenders t on t.order_id=a.id
 group by a.business_date,a.outlet_id,a.outlet_name_snapshot,a.department_code_snapshot order by a.business_date desc,a.outlet_name_snapshot;
end; $$;

create or replace function public.get_restaurant_pos_business_date(target_hotel_id uuid)
returns date language plpgsql stable security definer set search_path=public as $$
begin
 if not public.has_hotel_permission(target_hotel_id,'pos.sales.read') then raise exception 'Not authorised to view restaurant POS'; end if;
 return public.hotel_business_date(target_hotel_id);
end;
$$;

revoke all on function public.provision_restaurant_pos_permissions(uuid),public.handle_hotel_restaurant_pos_permission_provisioning(),
 public.pos_order_totals(uuid),public.create_restaurant_pos_order(uuid,text,text,text),public.add_restaurant_pos_order_item(uuid,uuid,smallint),
 public.void_restaurant_pos_order(uuid,text),public.open_pos_cashier_shift(uuid,bigint),public.close_pos_cashier_shift(uuid,bigint,text),
 public.record_restaurant_pos_payment(uuid,uuid,bigint,text),public.verify_restaurant_pos_payment(uuid,text),
 public.reject_restaurant_pos_payment(uuid,text),public.get_restaurant_pos_sales_report(uuid,date,date),
 public.get_restaurant_pos_business_date(uuid) from public,anon,authenticated;
grant execute on function public.create_restaurant_pos_order(uuid,text,text,text),public.add_restaurant_pos_order_item(uuid,uuid,smallint),
 public.void_restaurant_pos_order(uuid,text),public.open_pos_cashier_shift(uuid,bigint),public.close_pos_cashier_shift(uuid,bigint,text),
 public.record_restaurant_pos_payment(uuid,uuid,bigint,text),public.verify_restaurant_pos_payment(uuid,text),
 public.reject_restaurant_pos_payment(uuid,text),public.get_restaurant_pos_sales_report(uuid,date,date),
 public.get_restaurant_pos_business_date(uuid) to authenticated;
