-- Staff changes are auditable. Deactivation removes application access without
-- deleting the employee's financial and operational history.

create or replace function public.replace_staff_role(target_profile_id uuid, target_role_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_hotel_id uuid;
  target_role_code text;
  existing_role_codes text[];
  actor_is_owner boolean;
begin
  select hotel_id, code into target_hotel_id, target_role_code
  from public.roles where id = target_role_id and active for update;
  if target_hotel_id is null then raise exception 'The selected role is not available'; end if;
  if not public.has_hotel_permission(target_hotel_id, 'staff.manage') then raise exception 'Not authorised to manage staff'; end if;

  select exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.profile_id = auth.uid() and r.hotel_id = target_hotel_id and r.code = 'owner'
  ) into actor_is_owner;

  select array_agg(r.code order by r.code) into existing_role_codes
  from public.user_roles ur join public.roles r on r.id = ur.role_id
  where ur.profile_id = target_profile_id and r.hotel_id = target_hotel_id;
  if coalesce(array_length(existing_role_codes, 1), 0) = 0 then raise exception 'Staff member is not assigned to this hotel'; end if;
  if ('owner' = any(existing_role_codes) or target_role_code = 'owner') and not actor_is_owner then raise exception 'Only an owner may change an owner role'; end if;
  if 'owner' = any(existing_role_codes) and target_role_code <> 'owner' and not exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where r.hotel_id = target_hotel_id and r.code = 'owner' and ur.profile_id <> target_profile_id
  ) then raise exception 'The hotel must always have at least one owner'; end if;

  delete from public.user_roles ur using public.roles r
  where ur.role_id = r.id and ur.profile_id = target_profile_id and r.hotel_id = target_hotel_id;
  insert into public.user_roles (profile_id, role_id, created_by) values (target_profile_id, target_role_id, auth.uid());
  perform public.log_activity(target_hotel_id, 'staff.role_reassigned', 'profile', target_profile_id,
    jsonb_build_object('previous_roles', coalesce(to_jsonb(existing_role_codes), '[]'::jsonb), 'role_id', target_role_id, 'role_code', target_role_code));
end;
$$;

revoke all on function public.replace_staff_role(uuid, uuid) from public;
grant execute on function public.replace_staff_role(uuid, uuid) to authenticated;
