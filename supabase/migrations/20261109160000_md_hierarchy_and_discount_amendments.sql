-- An MD has GM operational access, but only the Owner may change an MD's
-- account or role. Keep this rule in RPCs as well as in the staff UI.
-- The older GM staff.manage grant covered existing hotels only. Provision it
-- for hotels created later too, so the hierarchy check is exercised in use.
insert into public.permissions (code, name, description) values
  ('staff.read', 'View staff', 'View staff accounts and role assignments.'),
  ('staff.manage', 'Manage staff', 'Manage staff accounts and role assignments.')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('staff.read', 'staff.manage')
where r.code = 'general_manager' on conflict do nothing;

create or replace function public.grant_gm_staff_management()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.code = 'general_manager' then
    insert into public.role_permissions (role_id, permission_id)
    select new.id, p.id from public.permissions p where p.code in ('staff.read', 'staff.manage')
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger grant_gm_staff_management
after insert on public.roles for each row execute function public.grant_gm_staff_management();
revoke all on function public.grant_gm_staff_management() from public, anon, authenticated;

create or replace function public.set_staff_active(target_profile_id uuid, should_be_active boolean)
returns void language plpgsql security definer set search_path = public as $$
declare target_hotel_id uuid; actor_is_owner boolean;
begin
  select r.hotel_id into target_hotel_id
  from public.user_roles ur join public.roles r on r.id = ur.role_id
  where ur.profile_id = target_profile_id limit 1;
  if target_hotel_id is null or not public.has_hotel_permission(target_hotel_id, 'staff.manage') then
    raise exception 'Not authorised to manage staff';
  end if;
  if target_profile_id = auth.uid() and not should_be_active then
    raise exception 'You cannot deactivate your own account';
  end if;
  select exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.profile_id = auth.uid() and r.hotel_id = target_hotel_id
      and r.code = 'owner' and r.active
  ) into actor_is_owner;
  if not actor_is_owner and exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.profile_id = target_profile_id and r.hotel_id = target_hotel_id
      and r.code in ('owner', 'managing_director')
  ) then raise exception 'Only the hotel owner may change an Owner or Managing Director account'; end if;
  update public.profiles set active = should_be_active where id = target_profile_id;
  perform public.log_activity(target_hotel_id,
    case when should_be_active then 'staff.activated' else 'staff.deactivated' end,
    'profile', target_profile_id, '{}'::jsonb);
end;
$$;

create or replace function public.assign_staff_role(target_profile_id uuid, target_role_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare hotel_id_value uuid; target_role_code text; actor_is_owner boolean;
begin
  select hotel_id, code into hotel_id_value, target_role_code
  from public.roles where id = target_role_id and active;
  if hotel_id_value is null or not public.has_hotel_permission(hotel_id_value, 'staff.manage') then
    raise exception 'Not authorised to manage staff';
  end if;
  select exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.profile_id = auth.uid() and r.hotel_id = hotel_id_value
      and r.code = 'owner' and r.active
  ) into actor_is_owner;
  if not actor_is_owner and (
    target_role_code in ('owner', 'managing_director') or exists (
      select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.profile_id = target_profile_id and r.hotel_id = hotel_id_value
        and r.code in ('owner', 'managing_director')
    )
  ) then raise exception 'Only the hotel owner may change an Owner or Managing Director role'; end if;
  insert into public.user_roles (profile_id, role_id, created_by)
  values (target_profile_id, target_role_id, auth.uid()) on conflict do nothing;
  perform public.log_activity(hotel_id_value, 'staff.role_assigned', 'profile', target_profile_id,
    jsonb_build_object('role_id', target_role_id));
end;
$$;

create or replace function public.replace_staff_role(target_profile_id uuid, target_role_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare target_hotel_id uuid; target_role_code text; existing_role_codes text[]; actor_is_owner boolean;
begin
  select hotel_id, code into target_hotel_id, target_role_code
  from public.roles where id = target_role_id and active for update;
  if target_hotel_id is null then raise exception 'The selected role is not available'; end if;
  if not public.has_hotel_permission(target_hotel_id, 'staff.manage') then
    raise exception 'Not authorised to manage staff';
  end if;
  select exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.profile_id = auth.uid() and r.hotel_id = target_hotel_id
      and r.code = 'owner' and r.active
  ) into actor_is_owner;
  select array_agg(r.code order by r.code) into existing_role_codes
  from public.user_roles ur join public.roles r on r.id = ur.role_id
  where ur.profile_id = target_profile_id and r.hotel_id = target_hotel_id;
  if coalesce(array_length(existing_role_codes, 1), 0) = 0 then
    raise exception 'Staff member is not assigned to this hotel';
  end if;
  if not actor_is_owner and (
    'owner' = any(existing_role_codes) or 'managing_director' = any(existing_role_codes)
    or target_role_code in ('owner', 'managing_director')
  ) then raise exception 'Only the hotel owner may change an Owner or Managing Director role'; end if;
  if 'owner' = any(existing_role_codes) and target_role_code <> 'owner' and not exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where r.hotel_id = target_hotel_id and r.code = 'owner' and ur.profile_id <> target_profile_id
  ) then raise exception 'The hotel must always have at least one owner'; end if;
  delete from public.user_roles ur using public.roles r
  where ur.role_id = r.id and ur.profile_id = target_profile_id and r.hotel_id = target_hotel_id;
  insert into public.user_roles (profile_id, role_id, created_by)
  values (target_profile_id, target_role_id, auth.uid());
  perform public.log_activity(target_hotel_id, 'staff.role_reassigned', 'profile', target_profile_id,
    jsonb_build_object('previous_roles', coalesce(to_jsonb(existing_role_codes), '[]'::jsonb),
      'role_id', target_role_id, 'role_code', target_role_code));
end;
$$;

-- Keep the amendment and approval request in one transaction. If either
-- fails, the existing reservation stays untouched.
create or replace function public.amend_reservation_with_discount_request(
  target_reservation_id uuid, target_room_type_id uuid, target_room_id uuid,
  arrival_date date, departure_date date, requested_rate_kobo bigint,
  amendment_reason text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare reservation_record public.reservations; standard_rate bigint; request_id uuid;
begin
  select * into reservation_record from public.reservations
  where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(reservation_record.hotel_id, 'reservations.manage') then
    raise exception 'Not authorised to manage reservations';
  end if;
  select coalesce(r.rate_override_kobo, rt.base_rate_kobo) into standard_rate
  from public.rooms r join public.room_types rt on rt.id = r.room_type_id
  where r.id = target_room_id and r.hotel_id = reservation_record.hotel_id
    and rt.id = target_room_type_id;
  if standard_rate is null or standard_rate <= 0 then
    raise exception 'A valid standard room rate is required';
  end if;
  if requested_rate_kobo <= 0 or requested_rate_kobo >= standard_rate then
    raise exception 'The requested rate must be a genuine discount above zero and below the standard rate';
  end if;
  perform public.amend_reservation(target_reservation_id, target_room_type_id,
    target_room_id, arrival_date, departure_date, standard_rate, amendment_reason);
  request_id := public.request_reservation_discount(
    target_reservation_id, requested_rate_kobo, amendment_reason);
  return request_id;
end;
$$;

revoke all on function public.amend_reservation_with_discount_request(
  uuid, uuid, uuid, date, date, bigint, text) from public, anon, authenticated;
grant execute on function public.amend_reservation_with_discount_request(
  uuid, uuid, uuid, date, date, bigint, text) to authenticated;
