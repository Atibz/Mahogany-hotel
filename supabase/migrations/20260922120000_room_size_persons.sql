-- Room-type size and person-based capacity.

alter table public.room_types
add column if not exists size_sqft integer check (size_sqft is null or size_sqft > 0);

create or replace function public.create_room_type(
  target_hotel_id uuid,
  type_name text,
  type_description text,
  base_rate bigint,
  room_capacity smallint,
  type_amenities jsonb,
  room_size_sqft integer
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
  if room_size_sqft is not null and room_size_sqft <= 0 then raise exception 'Room size must be greater than zero'; end if;
  insert into public.room_types (hotel_id, name, description, base_rate_kobo, capacity, amenities, size_sqft)
  values (target_hotel_id, trim(type_name), nullif(trim(type_description), ''), base_rate, room_capacity, coalesce(type_amenities, '[]'::jsonb), room_size_sqft)
  returning id into new_id;
  perform public.log_activity(target_hotel_id, 'room_type.created', 'room_type', new_id, jsonb_build_object('size_sqft', room_size_sqft));
  return new_id;
end;
$$;

create or replace function public.update_room_type(
  target_room_type_id uuid,
  type_name text,
  type_description text,
  base_rate bigint,
  room_capacity smallint,
  is_active boolean,
  room_size_sqft integer
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
  if room_size_sqft is not null and room_size_sqft <= 0 then raise exception 'Room size must be greater than zero'; end if;
  update public.room_types set name = trim(type_name), description = nullif(trim(type_description), ''), base_rate_kobo = base_rate, capacity = room_capacity, size_sqft = room_size_sqft, active = is_active, updated_at = now() where id = target_room_type_id;
  perform public.log_activity(target_hotel_id, 'room_type.updated', 'room_type', target_room_type_id, jsonb_build_object('active', is_active, 'size_sqft', room_size_sqft));
end;
$$;

create or replace view public.room_board as
select
  r.id,
  r.hotel_id,
  r.room_number,
  r.room_type_id,
  rt.name as room_type_name,
  coalesce(r.rate_override_kobo, rt.base_rate_kobo) as current_rate_kobo,
  case
    when not r.active or r.blocked_at is not null then 'blocked'
    when exists (select 1 from public.stays s where s.room_id = r.id and s.status = 'checked_in') then 'occupied'
    when exists (
      select 1 from public.reservations rv
      where rv.room_id = r.id
        and rv.status in ('pending', 'confirmed')
        and daterange(rv.check_in_date, rv.check_out_date, '[)') @> current_date
    ) then 'reserved'
    else 'available'
  end as status,
  rt.size_sqft,
  rt.capacity
from public.rooms r
join public.room_types rt on rt.id = r.room_type_id;

alter view public.room_board set (security_invoker = true);

grant select on public.room_board to authenticated;
revoke all on function public.create_room_type(uuid, text, text, bigint, smallint, jsonb, integer), public.update_room_type(uuid, text, text, bigint, smallint, boolean, integer) from public;
grant execute on function public.create_room_type(uuid, text, text, bigint, smallint, jsonb, integer), public.update_room_type(uuid, text, text, bigint, smallint, boolean, integer) to authenticated;
