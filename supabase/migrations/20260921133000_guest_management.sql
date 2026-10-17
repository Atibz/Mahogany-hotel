-- Guest lifecycle management: audited edits, deactivation, merge, and anonymisation.
-- Guest rows are retained so historical reservations and financial records remain linked.

insert into public.permissions (code, name, description)
values ('guests.manage', 'Manage guests', 'Edit, deactivate, merge, and anonymise guest records.')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.hotel_id = '00000000-0000-4000-8000-000000000001'
  and r.code in ('owner', 'general_manager', 'staff_admin')
  and p.code = 'guests.manage'
on conflict do nothing;

create or replace function public.update_guest(
  target_guest_id uuid,
  guest_full_name text,
  guest_phone text default null,
  guest_email text default null,
  guest_address text default null,
  guest_identification_type text default null,
  guest_identification_reference text default null,
  guest_notes text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_guest public.guests;
begin
  select * into target_guest from public.guests where id = target_guest_id for update;
  if not found then raise exception 'Guest not found'; end if;
  if not public.has_hotel_permission(target_guest.hotel_id, 'guests.manage') then
    raise exception 'Not authorised to manage guests';
  end if;
  if nullif(trim(guest_full_name), '') is null then raise exception 'Guest name is required'; end if;

  update public.guests
  set full_name = trim(guest_full_name),
      phone = nullif(trim(guest_phone), ''),
      email = nullif(lower(trim(guest_email)), ''),
      address = nullif(trim(guest_address), ''),
      identification_type = nullif(trim(guest_identification_type), ''),
      identification_reference = nullif(trim(guest_identification_reference), ''),
      notes = nullif(trim(guest_notes), ''),
      updated_by = auth.uid(),
      updated_at = now()
  where id = target_guest_id;

  perform public.log_activity(target_guest.hotel_id, 'guest.updated', 'guest', target_guest_id, '{}'::jsonb);
end;
$$;

create or replace function public.deactivate_guest(target_guest_id uuid, deactivation_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_guest public.guests;
begin
  select * into target_guest from public.guests where id = target_guest_id for update;
  if not found then raise exception 'Guest not found'; end if;
  if not public.has_hotel_permission(target_guest.hotel_id, 'guests.manage') then
    raise exception 'Not authorised to manage guests';
  end if;
  if nullif(trim(deactivation_reason), '') is null then raise exception 'A deactivation reason is required'; end if;
  if exists (select 1 from public.stays where guest_id = target_guest_id and status = 'checked_in') then
    raise exception 'An active stay must be checked out before deactivating this guest';
  end if;

  update public.guests
  set active = false,
      notes = concat_ws(E'\n', notes, '[Deactivated] ' || trim(deactivation_reason)),
      updated_by = auth.uid(),
      updated_at = now()
  where id = target_guest_id;

  perform public.log_activity(target_guest.hotel_id, 'guest.deactivated', 'guest', target_guest_id,
    jsonb_build_object('reason', trim(deactivation_reason)));
end;
$$;

create or replace function public.merge_guests(target_survivor_id uuid, target_duplicate_id uuid, merge_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  survivor public.guests;
  duplicate public.guests;
begin
  if target_survivor_id = target_duplicate_id then raise exception 'Survivor and duplicate must be different guests'; end if;
  select * into survivor from public.guests where id = target_survivor_id for update;
  select * into duplicate from public.guests where id = target_duplicate_id for update;
  if not found then raise exception 'Guest not found'; end if;
  if survivor.hotel_id <> duplicate.hotel_id then raise exception 'Guests must belong to the same hotel'; end if;
  if not public.has_hotel_permission(survivor.hotel_id, 'guests.manage') then
    raise exception 'Not authorised to manage guests';
  end if;
  if nullif(trim(merge_reason), '') is null then raise exception 'A merge reason is required'; end if;
  if exists (select 1 from public.stays where guest_id = target_duplicate_id and status = 'checked_in') then
    raise exception 'The duplicate guest has an active stay and cannot be merged';
  end if;

  update public.reservations set guest_id = target_survivor_id, updated_by = auth.uid()
  where guest_id = target_duplicate_id;
  update public.stays set guest_id = target_survivor_id, updated_at = now()
  where guest_id = target_duplicate_id;

  update public.guests
  set active = false,
      notes = concat_ws(E'\n', notes, '[Merged into guest ' || target_survivor_id || '] ' || trim(merge_reason)),
      updated_by = auth.uid(),
      updated_at = now()
  where id = target_duplicate_id;

  perform public.log_activity(survivor.hotel_id, 'guest.merged', 'guest', target_survivor_id,
    jsonb_build_object('duplicate_guest_id', target_duplicate_id, 'reason', trim(merge_reason)));
end;
$$;

create or replace function public.anonymise_guest(target_guest_id uuid, anonymisation_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_guest public.guests;
begin
  select * into target_guest from public.guests where id = target_guest_id for update;
  if not found then raise exception 'Guest not found'; end if;
  if not public.has_hotel_permission(target_guest.hotel_id, 'guests.manage') then
    raise exception 'Not authorised to manage guests';
  end if;
  if nullif(trim(anonymisation_reason), '') is null then raise exception 'An anonymisation reason is required'; end if;
  if exists (select 1 from public.stays where guest_id = target_guest_id and status = 'checked_in') then
    raise exception 'An active stay must be checked out before anonymising this guest';
  end if;

  update public.guests
  set full_name = 'Anonymised guest ' || left(target_guest_id::text, 8),
      phone = null,
      email = null,
      address = null,
      identification_type = null,
      identification_reference = null,
      notes = '[Anonymised] ' || trim(anonymisation_reason),
      active = false,
      updated_by = auth.uid(),
      updated_at = now()
  where id = target_guest_id;

  perform public.log_activity(target_guest.hotel_id, 'guest.anonymised', 'guest', target_guest_id,
    jsonb_build_object('reason', trim(anonymisation_reason)));
end;
$$;

revoke all on function public.update_guest(uuid, text, text, text, text, text, text, text), public.deactivate_guest(uuid, text), public.merge_guests(uuid, uuid, text), public.anonymise_guest(uuid, text) from public;
grant execute on function public.update_guest(uuid, text, text, text, text, text, text, text), public.deactivate_guest(uuid, text), public.merge_guests(uuid, uuid, text), public.anonymise_guest(uuid, text) to authenticated;
