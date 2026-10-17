-- Staff access administration for existing Auth accounts. Owner remains the
-- only role that can assign or alter an Owner role.

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'staff.manage'
where r.code = 'general_manager'
on conflict do nothing;

create or replace function public.set_staff_active(target_profile_id uuid, should_be_active boolean)
returns void language plpgsql security definer set search_path = public as $$
declare target_hotel_id uuid;
begin
  select r.hotel_id into target_hotel_id from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.profile_id = target_profile_id limit 1;
  if target_hotel_id is null or not public.has_hotel_permission(target_hotel_id, 'staff.manage') then raise exception 'Not authorised to manage staff'; end if;
  if target_profile_id = auth.uid() and not should_be_active then raise exception 'You cannot deactivate your own account'; end if;
  if exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.profile_id = target_profile_id and r.code = 'owner') and not exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.profile_id = auth.uid() and r.hotel_id = target_hotel_id and r.code = 'owner') then
    raise exception 'Only an owner may change an owner account';
  end if;
  update public.profiles set active = should_be_active where id = target_profile_id;
  perform public.log_activity(target_hotel_id, case when should_be_active then 'staff.activated' else 'staff.deactivated' end, 'profile', target_profile_id, '{}'::jsonb);
end;
$$;

create or replace function public.assign_staff_role(target_profile_id uuid, target_role_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare hotel_id_value uuid; target_role_code text;
begin
  select hotel_id, code into hotel_id_value, target_role_code from public.roles where id = target_role_id;
  if hotel_id_value is null or not public.has_hotel_permission(hotel_id_value, 'staff.manage') then raise exception 'Not authorised to manage staff'; end if;
  if target_role_code = 'owner' and not exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.profile_id = auth.uid() and r.hotel_id = hotel_id_value and r.code = 'owner') then raise exception 'Only an owner may assign the owner role'; end if;
  insert into public.user_roles (profile_id, role_id, created_by) values (target_profile_id, target_role_id, auth.uid()) on conflict do nothing;
  perform public.log_activity(hotel_id_value, 'staff.role_assigned', 'profile', target_profile_id, jsonb_build_object('role_id', target_role_id));
end;
$$;

revoke all on function public.set_staff_active(uuid, boolean), public.assign_staff_role(uuid, uuid) from public;
grant execute on function public.set_staff_active(uuid, boolean), public.assign_staff_role(uuid, uuid) to authenticated;
