-- Provision standard roles and permissions for every hotel, not only the development seed hotel.
-- An owner role is intentionally unrestricted by public.has_hotel_permission().

create or replace function public.provision_hotel_roles(target_hotel_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.hotels where id = target_hotel_id) then
    raise exception 'Hotel not found';
  end if;

  insert into public.roles (hotel_id, code, name, description)
  values
    (target_hotel_id, 'owner', 'Owner', 'Full access to this hotel.'),
    (target_hotel_id, 'general_manager', 'General Manager', 'Operational and management access.'),
    (target_hotel_id, 'receptionist', 'Receptionist', 'Guest, reservation, stay, folio, and permitted payment operations.'),
    (target_hotel_id, 'cashier', 'Cashier', 'Payment, settlement, and receipt operations.'),
    (target_hotel_id, 'restaurant_staff', 'Restaurant Staff', 'Restaurant POS operations.'),
    (target_hotel_id, 'bar_staff', 'Bar Staff', 'Bar POS operations.'),
    (target_hotel_id, 'storekeeper', 'Storekeeper', 'Inventory and supplier operations.'),
    (target_hotel_id, 'accountant', 'Accountant', 'Financial reporting and reconciliation operations.'),
    (target_hotel_id, 'staff_admin', 'Staff Admin', 'Staff and role administration.')
  on conflict (hotel_id, code) do nothing;

  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join (
    values
      ('general_manager', 'settings.read'), ('general_manager', 'settings.manage'),
      ('general_manager', 'staff.read'), ('general_manager', 'audit.read'),
      ('general_manager', 'guests.read'), ('general_manager', 'guests.create'), ('general_manager', 'guests.manage'),
      ('general_manager', 'room_types.manage'), ('general_manager', 'rooms.manage'),
      ('general_manager', 'reservations.read'), ('general_manager', 'reservations.create'), ('general_manager', 'reservations.manage'),
      ('general_manager', 'stays.read'), ('general_manager', 'stays.check_in'), ('general_manager', 'stays.manage'), ('general_manager', 'stays.rate_change'), ('general_manager', 'stays.checkout'),
      ('general_manager', 'folios.read'), ('general_manager', 'night_audit.read'), ('general_manager', 'night_audit.run'),
      ('general_manager', 'payments.read'), ('general_manager', 'payments.create'), ('general_manager', 'receipts.read'),
      ('receptionist', 'guests.read'), ('receptionist', 'guests.create'),
      ('receptionist', 'reservations.read'), ('receptionist', 'reservations.create'), ('receptionist', 'reservations.manage'),
      ('receptionist', 'stays.read'), ('receptionist', 'stays.check_in'), ('receptionist', 'stays.manage'),
      ('receptionist', 'folios.read'), ('receptionist', 'payments.read'), ('receptionist', 'payments.create'), ('receptionist', 'receipts.read'),
      ('cashier', 'folios.read'), ('cashier', 'payments.read'), ('cashier', 'payments.create'), ('cashier', 'stays.checkout'), ('cashier', 'receipts.read'),
      ('accountant', 'folios.read'), ('accountant', 'payments.read'), ('accountant', 'receipts.read'), ('accountant', 'audit.read'),
      ('staff_admin', 'staff.read'), ('staff_admin', 'staff.manage'), ('staff_admin', 'audit.read')
  ) as assigned_permissions(role_code, permission_code) on assigned_permissions.role_code = r.code
  join public.permissions p on p.code = assigned_permissions.permission_code
  where r.hotel_id = target_hotel_id
  on conflict do nothing;
end;
$$;

do $$
declare hotel_record record;
begin
  for hotel_record in select id from public.hotels loop
    perform public.provision_hotel_roles(hotel_record.id);
  end loop;
end;
$$;

create or replace function public.handle_hotel_role_provisioning()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_hotel_roles(new.id);
  return new;
end;
$$;

drop trigger if exists hotel_roles_provisioned on public.hotels;
create trigger hotel_roles_provisioned
after insert on public.hotels
for each row execute function public.handle_hotel_role_provisioning();

revoke all on function public.provision_hotel_roles(uuid), public.handle_hotel_role_provisioning() from public;
