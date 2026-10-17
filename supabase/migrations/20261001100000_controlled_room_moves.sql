-- Move an in-house guest without rewriting posted charges or stay history.
-- The vacated room becomes dirty and receives its own housekeeping task.

alter table public.room_turnover_tasks
  drop constraint if exists room_turnover_tasks_stay_id_key;

create index if not exists room_turnover_tasks_stay_created_idx
  on public.room_turnover_tasks(stay_id, created_at desc);

create table public.stay_room_moves (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  stay_id uuid not null references public.stays(id) on delete restrict,
  from_room_id uuid not null references public.rooms(id) on delete restrict,
  to_room_id uuid not null references public.rooms(id) on delete restrict,
  business_date date not null,
  preserved_rate_kobo bigint not null check (preserved_rate_kobo >= 0),
  reason text not null check (length(trim(reason)) > 0),
  moved_by uuid references public.profiles(id) on delete set null,
  moved_at timestamptz not null default now(),
  check (from_room_id <> to_room_id)
);

create index stay_room_moves_stay_moved_idx
  on public.stay_room_moves(stay_id, moved_at desc);
create index stay_room_moves_hotel_date_idx
  on public.stay_room_moves(hotel_id, business_date desc);

insert into public.permissions (code, name, description)
values (
  'stays.room_move',
  'Move in-house guests',
  'Move an active stay to a clean available room with a required reason.'
)
on conflict (code) do nothing;

create or replace function public.provision_stay_room_move_permission(
  target_hotel_id uuid
)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.code = 'stays.room_move'
  where r.hotel_id = target_hotel_id
    and r.code in ('general_manager', 'receptionist')
  on conflict do nothing;
$$;

select public.provision_stay_room_move_permission(id) from public.hotels;

create or replace function public.handle_hotel_stay_room_move_permission()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_stay_room_move_permission(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzzzzz_hotel_stay_room_move_permission
  on public.hotels;
create trigger zzzzzzzzz_hotel_stay_room_move_permission
after insert on public.hotels
for each row execute function public.handle_hotel_stay_room_move_permission();

create or replace function public.move_in_house_guest(
  target_stay_id uuid,
  target_room_id uuid,
  move_reason text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_stay public.stays;
  source_room public.rooms;
  destination_room public.rooms;
  move_business_date date;
  availability_end_date date;
  preserved_rate bigint;
  move_id uuid;
  turnover_task_id uuid;
begin
  select * into target_stay
  from public.stays
  where id = target_stay_id
  for update;

  if not found then raise exception 'Stay not found'; end if;
  if not public.has_hotel_permission(target_stay.hotel_id, 'stays.room_move') then
    raise exception 'Not authorised to move in-house guests';
  end if;
  if target_stay.status <> 'checked_in' then
    raise exception 'Only an active in-house stay can be moved';
  end if;
  if target_stay.room_id = target_room_id then
    raise exception 'Choose a different destination room';
  end if;
  if nullif(trim(move_reason), '') is null then
    raise exception 'A room-move reason is required';
  end if;

  -- Deterministic room locking prevents two simultaneous moves from swapping
  -- or claiming the same destination inconsistently.
  perform 1
  from public.rooms r
  where r.id in (target_stay.room_id, target_room_id)
  order by r.id
  for update;

  select * into source_room
  from public.rooms
  where id = target_stay.room_id;
  select * into destination_room
  from public.rooms
  where id = target_room_id;

  if destination_room.id is null
     or destination_room.hotel_id <> target_stay.hotel_id then
    raise exception 'Destination room is not available for this hotel';
  end if;
  if not destination_room.active
     or destination_room.blocked_at is not null
     or destination_room.maintenance_ticket_id is not null then
    raise exception 'Destination room is blocked or out of service';
  end if;
  if destination_room.turnover_status <> 'clean' then
    raise exception 'Destination room must be clean before a room move';
  end if;
  if exists (
    select 1 from public.stays s
    where s.room_id = destination_room.id and s.status = 'checked_in'
  ) then
    raise exception 'Destination room is already occupied';
  end if;

  move_business_date := public.hotel_business_date(target_stay.hotel_id);
  availability_end_date := greatest(
    target_stay.expected_check_out_date,
    move_business_date + 1
  );
  if exists (
    select 1
    from public.reservations rv
    where rv.room_id = destination_room.id
      and rv.status in ('pending', 'confirmed', 'checked_in')
      and daterange(rv.check_in_date, rv.check_out_date, '[)')
        && daterange(move_business_date, availability_end_date, '[)')
  ) then
    raise exception 'Destination room conflicts with a current or upcoming reservation';
  end if;
  if exists (
    select 1 from public.room_turnover_tasks t
    where t.room_id = source_room.id and t.status = 'open'
  ) then
    raise exception 'The vacated room already has an open housekeeping task';
  end if;

  select srp.rate_kobo into preserved_rate
  from public.stay_rate_periods srp
  where srp.stay_id = target_stay.id
    and srp.effective_from <= move_business_date
    and (srp.effective_to is null or srp.effective_to >= move_business_date)
  order by srp.effective_from desc
  limit 1;
  preserved_rate := coalesce(preserved_rate, target_stay.agreed_rate_kobo);

  insert into public.stay_room_moves (
    hotel_id, stay_id, from_room_id, to_room_id, business_date,
    preserved_rate_kobo, reason, moved_by
  ) values (
    target_stay.hotel_id, target_stay.id, source_room.id,
    destination_room.id, move_business_date, preserved_rate,
    trim(move_reason), auth.uid()
  )
  returning id into move_id;

  update public.stays
  set room_id = destination_room.id, updated_at = now()
  where id = target_stay.id;

  update public.rooms
  set turnover_status = 'dirty', turnover_updated_at = now(), updated_at = now()
  where id = source_room.id;

  insert into public.room_turnover_tasks (hotel_id, room_id, stay_id)
  values (target_stay.hotel_id, source_room.id, target_stay.id)
  returning id into turnover_task_id;

  perform public.log_activity(
    target_stay.hotel_id,
    'stay.room_moved',
    'stay_room_move',
    move_id,
    jsonb_build_object(
      'stay_id', target_stay.id,
      'from_room_id', source_room.id,
      'from_room_number', source_room.room_number,
      'to_room_id', destination_room.id,
      'to_room_number', destination_room.room_number,
      'business_date', move_business_date,
      'preserved_rate_kobo', preserved_rate,
      'reason', trim(move_reason),
      'turnover_task_id', turnover_task_id
    )
  );

  return move_id;
end;
$$;

revoke all on public.stay_room_moves from public, anon, authenticated;
grant select on public.stay_room_moves to authenticated;
alter table public.stay_room_moves enable row level security;
create policy stay_room_moves_read on public.stay_room_moves
for select to authenticated
using (public.has_hotel_permission(hotel_id, 'stays.read'));

revoke all on function public.provision_stay_room_move_permission(uuid),
  public.handle_hotel_stay_room_move_permission()
from public, anon, authenticated;
revoke all on function public.move_in_house_guest(uuid, uuid, text)
from public, anon;
grant execute on function public.move_in_house_guest(uuid, uuid, text)
to authenticated;
