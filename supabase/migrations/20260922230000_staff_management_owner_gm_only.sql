-- Staff account administration belongs to the Owner and General Manager only.
-- Owner access is granted by has_hotel_permission(); the GM has staff.manage.

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.code = 'staff_admin'
  and p.code in ('staff.read', 'staff.manage');

-- Room inventory and room rates are operational data, not a hotel-wide read.
insert into public.permissions (code, name, description)
values ('rooms.read', 'View room inventory', 'View room types, room status, and current room rates.')
on conflict (code) do nothing;

create or replace function public.provision_room_read_permission(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r join public.permissions p on p.code = 'rooms.read'
  where r.hotel_id = target_hotel_id and r.code in ('general_manager', 'receptionist')
  on conflict do nothing;
$$;

select public.provision_room_read_permission(id) from public.hotels;

create or replace function public.handle_hotel_room_read_permission_provisioning()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_room_read_permission(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzz_hotel_room_read_permission on public.hotels;
create trigger zzzzz_hotel_room_read_permission
after insert on public.hotels
for each row execute function public.handle_hotel_room_read_permission_provisioning();

drop policy if exists room_types_read on public.room_types;
create policy room_types_read on public.room_types for select to authenticated
using (public.has_hotel_permission(hotel_id, 'rooms.read'));

drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms for select to authenticated
using (public.has_hotel_permission(hotel_id, 'rooms.read'));

revoke all on function public.provision_room_read_permission(uuid), public.handle_hotel_room_read_permission_provisioning() from public;
