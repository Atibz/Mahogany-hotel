-- Room and room-type management: audited configuration and controlled blocking.

insert into public.permissions (code, name, description)
values
  ('rooms.manage', 'Manage rooms', 'Create, edit, activate, deactivate, block, and unblock rooms.'),
  ('room_types.manage', 'Manage room types', 'Create, edit, activate, and deactivate room types.')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.hotel_id = '00000000-0000-4000-8000-000000000001'
  and r.code in ('owner', 'general_manager', 'staff_admin')
  and p.code in ('rooms.manage', 'room_types.manage')
on conflict do nothing;

create or replace function public.create_room_type(
  target_hotel_id uuid,
  type_name text,
  type_description text,
  base_rate bigint,
  room_capacity smallint,
  type_amenities jsonb default '[]'
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare new_id uuid;
begin
  if not public.has_hotel_permission(target_hotel_id, 'room_types.manage') then raise exception 'Not authorised to manage room types'; end if;
  if nullif(trim(type_name), '') is null then raise exception 'Room type name is required'; end if;
  if base_rate < 0 then raise exception 'Base rate cannot be negative'; end if;
  if room_capacity <= 0 then raise exception 'Capacity must be greater than zero'; end if;
  insert into public.room_types (hotel_id, name, description, base_rate_kobo, capacity, amenities)
  values (target_hotel_id, trim(type_name), nullif(trim(type_description), ''), base_rate, room_capacity, coalesce(type_amenities, '[]'::jsonb))
  returning id into new_id;
  perform public.log_activity(target_hotel_id, 'room_type.created', 'room_type', new_id, '{}'::jsonb);
  return new_id;
end;
$$;

create or replace function public.update_room_type(
  target_room_type_id uuid,
  type_name text,
  type_description text,
  base_rate bigint,
  room_capacity smallint,
  is_active boolean
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare target_hotel_id uuid;
begin
  select hotel_id into target_hotel_id from public.room_types where id = target_room_type_id for update;
  if not found then raise exception 'Room type not found'; end if;
  if not public.has_hotel_permission(target_hotel_id, 'room_types.manage') then raise exception 'Not authorised to manage room types'; end if;
  if nullif(trim(type_name), '') is null then raise exception 'Room type name is required'; end if;
  if base_rate < 0 or room_capacity <= 0 then raise exception 'Rate and capacity must be valid'; end if;
  if not is_active and exists (select 1 from public.rooms where room_type_id = target_room_type_id and active) then
    raise exception 'Deactivate or reassign active rooms before deactivating this room type';
  end if;
  update public.room_types set name = trim(type_name), description = nullif(trim(type_description), ''), base_rate_kobo = base_rate, capacity = room_capacity, active = is_active, updated_at = now() where id = target_room_type_id;
  perform public.log_activity(target_hotel_id, 'room_type.updated', 'room_type', target_room_type_id, jsonb_build_object('active', is_active));
end;
$$;

create or replace function public.create_room(
  target_hotel_id uuid,
  target_room_type_id uuid,
  room_number_value text,
  rate_override bigint default null,
  room_amenities jsonb default '[]'
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare new_id uuid;
begin
  if not public.has_hotel_permission(target_hotel_id, 'rooms.manage') then raise exception 'Not authorised to manage rooms'; end if;
  if nullif(trim(room_number_value), '') is null then raise exception 'Room number is required'; end if;
  if rate_override is not null and rate_override < 0 then raise exception 'Rate override cannot be negative'; end if;
  if not exists (select 1 from public.room_types where id = target_room_type_id and hotel_id = target_hotel_id and active) then raise exception 'Room type is not available'; end if;
  insert into public.rooms (hotel_id, room_type_id, room_number, rate_override_kobo, amenities)
  values (target_hotel_id, target_room_type_id, trim(room_number_value), rate_override, coalesce(room_amenities, '[]'::jsonb))
  returning id into new_id;
  perform public.log_activity(target_hotel_id, 'room.created', 'room', new_id, '{}'::jsonb);
  return new_id;
end;
$$;

create or replace function public.update_room(
  target_room_id uuid,
  target_room_type_id uuid,
  room_number_value text,
  rate_override bigint,
  room_amenities jsonb,
  is_active boolean
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare target_hotel_id uuid;
begin
  select hotel_id into target_hotel_id from public.rooms where id = target_room_id for update;
  if not found then raise exception 'Room not found'; end if;
  if not public.has_hotel_permission(target_hotel_id, 'rooms.manage') then raise exception 'Not authorised to manage rooms'; end if;
  if nullif(trim(room_number_value), '') is null then raise exception 'Room number is required'; end if;
  if not exists (select 1 from public.room_types where id = target_room_type_id and hotel_id = target_hotel_id and active) then raise exception 'Room type is not available'; end if;
  if not is_active and exists (select 1 from public.stays where room_id = target_room_id and status = 'checked_in') then raise exception 'An active stay prevents deactivating this room'; end if;
  update public.rooms set room_type_id = target_room_type_id, room_number = trim(room_number_value), rate_override_kobo = rate_override, amenities = coalesce(room_amenities, '[]'::jsonb), active = is_active, updated_at = now() where id = target_room_id;
  perform public.log_activity(target_hotel_id, 'room.updated', 'room', target_room_id, jsonb_build_object('active', is_active));
end;
$$;

create or replace function public.set_room_blocked(target_room_id uuid, should_block boolean, block_reason text default null)
returns void
language plpgsql
security definer set search_path = public
as $$
declare target_hotel_id uuid;
begin
  select hotel_id into target_hotel_id from public.rooms where id = target_room_id for update;
  if not found then raise exception 'Room not found'; end if;
  if not public.has_hotel_permission(target_hotel_id, 'rooms.manage') then raise exception 'Not authorised to manage rooms'; end if;
  if should_block and nullif(trim(block_reason), '') is null then raise exception 'A block reason is required'; end if;
  if should_block and exists (select 1 from public.stays where room_id = target_room_id and status = 'checked_in') then raise exception 'An active stay prevents blocking this room'; end if;
  if should_block and exists (select 1 from public.reservations where room_id = target_room_id and status in ('pending', 'confirmed') and check_out_date >= current_date) then raise exception 'A future reservation prevents blocking this room'; end if;
  update public.rooms set blocked_at = case when should_block then now() else null end, blocked_reason = case when should_block then trim(block_reason) else null end, updated_at = now() where id = target_room_id;
  perform public.log_activity(target_hotel_id, case when should_block then 'room.blocked' else 'room.unblocked' end, 'room', target_room_id, jsonb_build_object('reason', nullif(trim(block_reason), '')));
end;
$$;

revoke all on function public.create_room_type(uuid, text, text, bigint, smallint, jsonb), public.update_room_type(uuid, text, text, bigint, smallint, boolean), public.create_room(uuid, uuid, text, bigint, jsonb), public.update_room(uuid, uuid, text, bigint, jsonb, boolean), public.set_room_blocked(uuid, boolean, text) from public;
grant execute on function public.create_room_type(uuid, text, text, bigint, smallint, jsonb), public.update_room_type(uuid, text, text, bigint, smallint, boolean), public.create_room(uuid, uuid, text, bigint, jsonb), public.update_room(uuid, uuid, text, bigint, jsonb, boolean), public.set_room_blocked(uuid, boolean, text) to authenticated;
