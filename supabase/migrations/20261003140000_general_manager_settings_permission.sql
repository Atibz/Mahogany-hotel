-- The development seed creates permission rows after the original role
-- provisioning migration. Ensure the GM receives settings management for both
-- existing and future hotels regardless of that ordering.

create or replace function public.provision_general_manager_settings_permission(
  target_hotel_id uuid
)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.code in ('settings.read', 'settings.manage')
  where r.hotel_id = target_hotel_id
    and r.code = 'general_manager'
  on conflict do nothing;
$$;

select public.provision_general_manager_settings_permission(id)
from public.hotels;

create or replace function public.handle_general_manager_settings_permission()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_general_manager_settings_permission(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzzzzzzz_hotel_general_manager_settings on public.hotels;
create trigger zzzzzzzzzzz_hotel_general_manager_settings
after insert on public.hotels
for each row execute function public.handle_general_manager_settings_permission();

revoke all on function public.provision_general_manager_settings_permission(uuid),
  public.handle_general_manager_settings_permission()
from public, anon, authenticated;
