-- The MD is a distinct staff role with the GM's operational permissions.
-- A companion GM assignment keeps existing explicit GM checks and future GM
-- permission provisioning effective without granting the Owner role.
insert into public.permissions (code, name, description)
values ('reservations.create', 'Create reservations', 'Create reservations.')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r
join public.permissions p on p.code = 'reservations.create'
where r.code in ('general_manager', 'receptionist') on conflict do nothing;

create or replace function public.provision_managing_director(target_hotel_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.roles (hotel_id, code, name, description)
  values (target_hotel_id, 'managing_director', 'Managing Director',
    'General Manager-level operational and discount approval access.')
  on conflict (hotel_id, code) do nothing;
end;
$$;

select public.provision_managing_director(id) from public.hotels;

create or replace function public.handle_managing_director_provisioning()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.provision_managing_director(new.id);
  return new;
end;
$$;

create trigger zzzzzzzzzz_managing_director_provisioned
after insert on public.hotels for each row
execute function public.handle_managing_director_provisioning();

create or replace function public.sync_managing_director_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
declare md_role public.roles; gm_role_id uuid;
begin
  if tg_op = 'INSERT' then
    select * into md_role from public.roles where id = new.role_id;
  else
    select * into md_role from public.roles where id = old.role_id;
  end if;
  if md_role.code <> 'managing_director' then
    if tg_op = 'INSERT' then return new; else return old; end if;
  end if;
  select id into gm_role_id from public.roles
  where hotel_id = md_role.hotel_id and code = 'general_manager' and active;
  if gm_role_id is null then raise exception 'General Manager role is required for Managing Director'; end if;
  if tg_op = 'INSERT' then
    if new.created_by is not null and not exists (
      select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.profile_id = new.created_by and r.hotel_id = md_role.hotel_id
        and r.code = 'owner' and r.active
    ) then raise exception 'Only the hotel owner may assign the Managing Director role'; end if;
    insert into public.user_roles (profile_id, role_id, created_by)
    values (new.profile_id, gm_role_id, new.created_by) on conflict do nothing;
    return new;
  end if;
  if auth.uid() is not null and not exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.profile_id = auth.uid() and r.hotel_id = md_role.hotel_id
      and r.code = 'owner' and r.active
  ) then raise exception 'Only the hotel owner may change the Managing Director role'; end if;
  delete from public.user_roles where profile_id = old.profile_id and role_id = gm_role_id;
  return old;
end;
$$;

create trigger sync_managing_director_assignment
after insert or delete on public.user_roles for each row
execute function public.sync_managing_director_assignment();

-- Any receptionist concession must be independently approved for the exact
-- reservation, standard rate and requested rate. Manager-created concessions
-- up to 20% retain the existing policy; >20% still require approval.
create or replace function public.enforce_receptionist_reservation_discount()
returns trigger language plpgsql security definer set search_path = public as $$
declare standard_rate bigint; is_receptionist boolean;
begin
  select coalesce(r.rate_override_kobo, rt.base_rate_kobo) into standard_rate
  from public.room_types rt
  left join public.rooms r on r.id = new.room_id and r.room_type_id = rt.id
  where rt.id = new.room_type_id and rt.hotel_id = new.hotel_id;
  if standard_rate is null or standard_rate <= 0 then raise exception 'A valid standard room rate is required'; end if;
  select exists (
    select 1 from public.user_roles ur join public.roles role on role.id = ur.role_id
    where ur.profile_id = auth.uid() and role.hotel_id = new.hotel_id
      and role.code = 'receptionist'
  ) and not exists (
    select 1 from public.user_roles ur join public.roles role on role.id = ur.role_id
    where ur.profile_id = auth.uid() and role.hotel_id = new.hotel_id
      and role.code in ('owner', 'general_manager', 'managing_director')
  ) into is_receptionist;
  if is_receptionist and new.agreed_rate_kobo < standard_rate and not exists (
    select 1 from public.finance_approval_requests far
    where far.hotel_id = new.hotel_id and far.action_type = 'reservation_discount'
      and far.target_entity_type = 'reservation' and far.target_entity_id = new.id
      and far.status in ('approved', 'executed')
      and (far.payload->>'requested_rate_kobo')::bigint = new.agreed_rate_kobo
      and (far.payload->>'standard_rate_kobo')::bigint = standard_rate
  ) then
    raise exception 'Reception discounts require independent approval before the rate is applied';
  end if;
  return new;
end;
$$;

create trigger enforce_receptionist_reservation_discount
before insert or update of room_type_id, room_id, agreed_rate_kobo on public.reservations
for each row execute function public.enforce_receptionist_reservation_discount();

create or replace function public.enforce_receptionist_walk_in_discount()
returns trigger language plpgsql security definer set search_path = public as $$
declare standard_rate bigint; is_receptionist boolean;
begin
  if new.reservation_id is not null then return new; end if;
  select coalesce(r.rate_override_kobo, rt.base_rate_kobo) into standard_rate
  from public.rooms r join public.room_types rt on rt.id = r.room_type_id
  where r.id = new.room_id and r.hotel_id = new.hotel_id;
  if standard_rate is null or standard_rate <= 0 then raise exception 'A valid standard room rate is required'; end if;
  select exists (
    select 1 from public.user_roles ur join public.roles role on role.id = ur.role_id
    where ur.profile_id = auth.uid() and role.hotel_id = new.hotel_id
      and role.code = 'receptionist'
  ) and not exists (
    select 1 from public.user_roles ur join public.roles role on role.id = ur.role_id
    where ur.profile_id = auth.uid() and role.hotel_id = new.hotel_id
      and role.code in ('owner', 'general_manager', 'managing_director')
  ) into is_receptionist;
  if is_receptionist and new.agreed_rate_kobo < standard_rate then
    raise exception 'Reception walk-in discounts require an approved reservation before check-in';
  end if;
  return new;
end;
$$;

create trigger enforce_receptionist_walk_in_discount
before insert on public.stays for each row
execute function public.enforce_receptionist_walk_in_discount();

-- Reuse the existing approval queue for concessions of any size.
create or replace function public.request_reservation_discount(
  target_reservation_id uuid, requested_rate_kobo bigint, request_reason text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare reservation_record public.reservations; standard_rate bigint;
  request_id uuid; discount_basis_points integer;
begin
  select * into reservation_record from public.reservations
  where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if reservation_record.status not in ('pending', 'confirmed') then
    raise exception 'Only a pending or confirmed reservation can receive a discount approval';
  end if;
  if not public.has_hotel_permission(reservation_record.hotel_id, 'reservation_discounts.request') then
    raise exception 'Not authorised to request a reservation discount';
  end if;
  if nullif(trim(request_reason), '') is null then raise exception 'A discount reason is required'; end if;
  select coalesce(r.rate_override_kobo, rt.base_rate_kobo) into standard_rate
  from public.room_types rt
  left join public.rooms r on r.id = reservation_record.room_id and r.room_type_id = rt.id
  where rt.id = reservation_record.room_type_id and rt.hotel_id = reservation_record.hotel_id;
  if standard_rate is null or standard_rate <= 0 then raise exception 'A valid standard room rate is required'; end if;
  if requested_rate_kobo < 0 or requested_rate_kobo >= standard_rate then
    raise exception 'The requested rate must be a genuine discount below the standard rate';
  end if;
  if exists (
    select 1 from public.finance_approval_requests far
    where far.action_type = 'reservation_discount'
      and far.target_entity_id = reservation_record.id
      and far.status in ('pending', 'approved')
  ) then raise exception 'This reservation already has an active discount request'; end if;
  discount_basis_points := round((standard_rate - requested_rate_kobo)::numeric * 10000 / standard_rate)::integer;
  insert into public.finance_approval_requests (
    hotel_id, action_type, target_entity_type, target_entity_id, payload, reason, requested_by
  ) values (
    reservation_record.hotel_id, 'reservation_discount', 'reservation', reservation_record.id,
    jsonb_build_object('reservation_id', reservation_record.id,
      'standard_rate_kobo', standard_rate, 'requested_rate_kobo', requested_rate_kobo,
      'discount_basis_points', discount_basis_points), trim(request_reason), auth.uid()
  ) returning id into request_id;
  perform public.log_activity(reservation_record.hotel_id, 'reservation.discount_requested',
    'finance_approval_request', request_id,
    jsonb_build_object('reservation_id', reservation_record.id,
      'standard_rate_kobo', standard_rate, 'requested_rate_kobo', requested_rate_kobo,
      'discount_basis_points', discount_basis_points));
  return request_id;
end;
$$;

-- Preserve guest count, booking source and notes on the approval path.
create or replace function public.create_reservation_with_discount_request(
  target_hotel_id uuid, target_guest_id uuid, target_room_type_id uuid,
  target_room_id uuid, arrival_date date, departure_date date,
  requested_rate_kobo bigint, request_reason text,
  adult_count smallint default 1, child_count smallint default 0,
  source text default null, reservation_notes text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare standard_rate bigint; reservation_id uuid;
begin
  select coalesce(r.rate_override_kobo, rt.base_rate_kobo) into standard_rate
  from public.room_types rt join public.rooms r on r.id = target_room_id and r.room_type_id = rt.id
  where rt.id = target_room_type_id and rt.hotel_id = target_hotel_id;
  if standard_rate is null or standard_rate <= 0 then raise exception 'A valid standard room rate is required'; end if;
  if requested_rate_kobo < 0 or requested_rate_kobo >= standard_rate then
    raise exception 'The requested rate must be a genuine discount below the standard rate';
  end if;
  reservation_id := public.create_reservation(target_hotel_id, target_guest_id,
    target_room_type_id, target_room_id, arrival_date, departure_date,
    standard_rate, adult_count, child_count, 0, source, reservation_notes);
  perform public.request_reservation_discount(reservation_id, requested_rate_kobo, request_reason);
  return reservation_id;
end;
$$;

revoke all on function public.create_reservation_with_discount_request(
  uuid, uuid, uuid, uuid, date, date, bigint, text, smallint, smallint, text, text
) from public, anon, authenticated;
grant execute on function public.create_reservation_with_discount_request(
  uuid, uuid, uuid, uuid, date, date, bigint, text, smallint, smallint, text, text
) to authenticated;

revoke all on function public.provision_managing_director(uuid),
  public.handle_managing_director_provisioning(),
  public.sync_managing_director_assignment(),
  public.enforce_receptionist_reservation_discount(),
  public.enforce_receptionist_walk_in_discount() from public, anon, authenticated;
