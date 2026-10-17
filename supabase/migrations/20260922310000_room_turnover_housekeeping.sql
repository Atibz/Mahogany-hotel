-- A checked-out room is not saleable until housekeeping turnover is recorded.
-- The state lives on the room for fast availability checks; the task is the
-- immutable operational history of each checkout-to-clean handoff.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'room_turnover_status' and typnamespace = 'public'::regnamespace) then
    create type public.room_turnover_status as enum ('clean', 'dirty');
  end if;
end;
$$;

alter table public.rooms
  add column if not exists turnover_status public.room_turnover_status not null default 'clean',
  add column if not exists turnover_updated_at timestamptz not null default now();

create table if not exists public.room_turnover_tasks (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  stay_id uuid not null unique references public.stays(id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'completed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid references public.profiles(id) on delete set null,
  completion_notes text,
  check (
    (status = 'open' and completed_at is null and completed_by is null)
    or (status = 'completed' and completed_at is not null and completed_by is not null)
  )
);

create unique index if not exists room_turnover_tasks_one_open_room_idx
  on public.room_turnover_tasks(room_id) where status = 'open';
create index if not exists room_turnover_tasks_hotel_status_idx
  on public.room_turnover_tasks(hotel_id, status, created_at desc);

insert into public.permissions (code, name, description)
values ('room_turnover.complete', 'Complete room turnover', 'Mark a checked-out room clean after housekeeping turnover.')
on conflict (code) do nothing;

create or replace function public.provision_room_turnover_permissions(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.code = 'room_turnover.complete'
  where r.hotel_id = target_hotel_id
    and r.code in ('general_manager', 'receptionist')
  on conflict do nothing;
$$;

select public.provision_room_turnover_permissions(id) from public.hotels;

create or replace function public.handle_hotel_room_turnover_permission_provisioning()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_room_turnover_permissions(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzzzz_hotel_room_turnover_permissions on public.hotels;
create trigger zzzzzzzz_hotel_room_turnover_permissions
after insert on public.hotels
for each row execute function public.handle_hotel_room_turnover_permission_provisioning();

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
    when r.turnover_status = 'dirty' then 'dirty'
    when exists (
      select 1 from public.reservations rv
      where rv.room_id = r.id
        and rv.status in ('pending', 'confirmed')
        and daterange(rv.check_in_date, rv.check_out_date, '[)') @> public.hotel_business_date(r.hotel_id)
    ) then 'reserved'
    else 'available'
  end as status,
  rt.size_sqft,
  rt.capacity,
  coalesce(
    r.blocked_reason,
    case when not r.active then 'Room is inactive' end,
    case when r.turnover_status = 'dirty' then 'Awaiting housekeeping turnover' end
  ) as blocked_reason,
  r.turnover_status
from public.rooms r
join public.room_types rt on rt.id = r.room_type_id;

alter view public.room_board set (security_invoker = true);
grant select on public.room_board to authenticated;

create or replace view public.room_type_occupancy_summary as
select
  rt.hotel_id,
  rt.id as room_type_id,
  rt.name as room_type_name,
  count(rb.id) as total_room_count,
  count(rb.id) filter (where rb.status <> 'blocked') as active_room_count,
  count(rb.id) filter (where rb.status = 'available') as available_room_count,
  count(rb.id) filter (where rb.status = 'reserved') as reserved_room_count,
  count(rb.id) filter (where rb.status = 'occupied') as occupied_room_count,
  count(rb.id) filter (where rb.status = 'blocked') as blocked_room_count,
  count(rb.id) filter (where rb.status = 'dirty') as dirty_room_count
from public.room_types rt
left join public.room_board rb on rb.room_type_id = rt.id
group by rt.hotel_id, rt.id, rt.name;

alter view public.room_type_occupancy_summary set (security_invoker = true);
grant select on public.room_type_occupancy_summary to authenticated;

create or replace function public.complete_room_turnover(target_room_id uuid, completion_notes_value text default null)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_room public.rooms;
  turnover_task public.room_turnover_tasks;
begin
  select * into target_room from public.rooms where id = target_room_id for update;
  if not found then raise exception 'Room not found'; end if;
  if not public.has_hotel_permission(target_room.hotel_id, 'room_turnover.complete') then
    raise exception 'Not authorised to complete room turnover';
  end if;
  if target_room.turnover_status <> 'dirty' then
    raise exception 'This room is not awaiting housekeeping turnover';
  end if;

  select * into turnover_task
  from public.room_turnover_tasks
  where room_id = target_room.id and status = 'open'
  order by created_at desc
  limit 1
  for update;
  if not found then raise exception 'No open turnover task was found for this room'; end if;

  update public.room_turnover_tasks
  set status = 'completed', completed_at = now(), completed_by = auth.uid(), completion_notes = nullif(trim(completion_notes_value), '')
  where id = turnover_task.id;
  update public.rooms
  set turnover_status = 'clean', turnover_updated_at = now(), updated_at = now()
  where id = target_room.id;

  perform public.log_activity(target_room.hotel_id, 'room.turnover_completed', 'room_turnover_task', turnover_task.id,
    jsonb_build_object('room_id', target_room.id, 'notes', nullif(trim(completion_notes_value), '')));
  return turnover_task.id;
end;
$$;

-- Reservation check-in is the final database-side guard: a room may have been
-- assigned in advance, but cannot receive a guest while dirty.
create or replace function public.check_in_reservation(target_reservation_id uuid, check_in_on date default current_date)
returns uuid language plpgsql security definer set search_path = public as $$
declare reservation_record public.reservations; target_room public.rooms; new_stay_id uuid; new_folio_id uuid; new_folio_number text;
begin
  select * into reservation_record from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(reservation_record.hotel_id, 'stays.check_in') then raise exception 'Not authorised to check in guests'; end if;
  if reservation_record.status not in ('pending', 'confirmed') then raise exception 'Only pending or confirmed reservations can be checked in'; end if;
  if reservation_record.room_id is null then raise exception 'Assign a room before check-in'; end if;
  if check_in_on < reservation_record.check_in_date or check_in_on >= reservation_record.check_out_date then raise exception 'Check-in date is outside the reservation dates'; end if;

  select * into target_room from public.rooms where id = reservation_record.room_id and hotel_id = reservation_record.hotel_id for update;
  if not found or not target_room.active or target_room.blocked_at is not null then raise exception 'Assigned room is not available'; end if;
  if target_room.turnover_status <> 'clean' then raise exception 'Assigned room is awaiting housekeeping turnover'; end if;
  if exists (select 1 from public.stays where room_id = reservation_record.room_id and status = 'checked_in') then raise exception 'This room already has an active stay'; end if;

  insert into public.stays (hotel_id, reservation_id, guest_id, room_id, actual_check_in_date, expected_check_out_date, agreed_rate_kobo, status, checked_in_by, notes) values (reservation_record.hotel_id, reservation_record.id, reservation_record.guest_id, reservation_record.room_id, check_in_on, reservation_record.check_out_date, reservation_record.agreed_rate_kobo, 'checked_in', auth.uid(), reservation_record.notes) returning id into new_stay_id;
  insert into public.stay_rate_periods (stay_id, effective_from, rate_kobo, reason, approved_by) values (new_stay_id, check_in_on, reservation_record.agreed_rate_kobo, 'Rate agreed at reservation', auth.uid());
  new_folio_number := public.next_document_number(reservation_record.hotel_id, 'FOL');
  insert into public.guest_folios (hotel_id, stay_id, folio_number) values (reservation_record.hotel_id, new_stay_id, new_folio_number) returning id into new_folio_id;
  insert into public.payment_allocations (payment_id, folio_id, amount_kobo) select rd.payment_id, new_folio_id, p.amount_kobo from public.reservation_deposits rd join public.payments p on p.id = rd.payment_id where rd.reservation_id = reservation_record.id and p.status = 'completed';
  update public.reservations set status = 'checked_in', updated_by = auth.uid() where id = reservation_record.id;
  perform public.log_activity(reservation_record.hotel_id, 'stay.checked_in', 'stay', new_stay_id, jsonb_build_object('reservation_id', reservation_record.id, 'room_id', reservation_record.room_id, 'deposit_allocated', exists(select 1 from public.reservation_deposits where reservation_id = reservation_record.id)));
  return new_stay_id;
end;
$$;

create or replace function public.create_walk_in_stay(
  target_hotel_id uuid, guest_full_name text, guest_phone text, guest_email text,
  target_room_id uuid, check_in_on date, check_out_on date, agreed_rate bigint
)
returns uuid language plpgsql security definer set search_path = public as $$
declare target_room public.rooms; guest_id uuid; stay_id uuid; folio_number text; folio_id uuid;
begin
  if not public.has_hotel_permission(target_hotel_id, 'stays.manage') then raise exception 'Not authorised to create walk-in stays'; end if;
  if nullif(trim(guest_full_name), '') is null then raise exception 'Guest name is required'; end if;
  if check_out_on <= check_in_on then raise exception 'Checkout date must be after check-in date'; end if;
  if agreed_rate < 0 then raise exception 'Rate cannot be negative'; end if;

  select * into target_room from public.rooms where id = target_room_id and hotel_id = target_hotel_id for update;
  if not found or not target_room.active or target_room.blocked_at is not null then raise exception 'Room is not available'; end if;
  if target_room.turnover_status <> 'clean' then raise exception 'Room is awaiting housekeeping turnover'; end if;
  if exists (select 1 from public.stays where room_id = target_room_id and status = 'checked_in') then raise exception 'Room already has an active stay'; end if;
  if exists (select 1 from public.reservations where room_id = target_room_id and status in ('pending', 'confirmed', 'checked_in') and daterange(check_in_date, check_out_date, '[)') && daterange(check_in_on, check_out_on, '[)')) then raise exception 'Room is reserved for part of those dates'; end if;

  insert into public.guests (hotel_id, full_name, phone, email, created_by, updated_by) values (target_hotel_id, trim(guest_full_name), nullif(trim(guest_phone), ''), nullif(lower(trim(guest_email)), ''), auth.uid(), auth.uid()) returning id into guest_id;
  insert into public.stays (hotel_id, guest_id, room_id, actual_check_in_date, expected_check_out_date, agreed_rate_kobo, status, checked_in_by) values (target_hotel_id, guest_id, target_room_id, check_in_on, check_out_on, agreed_rate, 'checked_in', auth.uid()) returning id into stay_id;
  insert into public.stay_rate_periods (stay_id, effective_from, rate_kobo, reason, approved_by) values (stay_id, check_in_on, agreed_rate, 'Walk-in rate at check-in', auth.uid());
  folio_number := public.next_document_number(target_hotel_id, 'FOL');
  insert into public.guest_folios (hotel_id, stay_id, folio_number) values (target_hotel_id, stay_id, folio_number) returning id into folio_id;
  perform public.log_activity(target_hotel_id, 'stay.walk_in_checked_in', 'stay', stay_id, jsonb_build_object('guest_id', guest_id, 'room_id', target_room_id));
  return stay_id;
end;
$$;

create or replace function public.checkout_stay(target_stay_id uuid, checkout_on date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare target_stay public.stays; target_folio public.guest_folios; target_date date; target_balance bigint; invoice_id uuid; invoice_number text; invoice_snapshot jsonb;
begin
  select * into target_stay from public.stays where id = target_stay_id for update;
  if not found then raise exception 'Stay not found'; end if;
  if not public.has_hotel_permission(target_stay.hotel_id, 'stays.checkout') then raise exception 'Not authorised to check out guests'; end if;
  if target_stay.status <> 'checked_in' then raise exception 'Only active stays can be checked out'; end if;
  checkout_on := coalesce(checkout_on, public.hotel_business_date(target_stay.hotel_id));
  if checkout_on < target_stay.actual_check_in_date or checkout_on > target_stay.expected_check_out_date then raise exception 'Checkout date is outside the stay dates'; end if;
  select * into target_folio from public.guest_folios where stay_id = target_stay.id and status = 'open' for update;
  if not found then raise exception 'Open folio not found'; end if;
  target_date := target_stay.actual_check_in_date;
  while target_date < checkout_on loop perform public.post_room_night(target_stay.id, target_date); target_date := target_date + 1; end loop;
  target_balance := public.folio_balance(target_folio.id);
  if target_balance <> 0 then raise exception 'Folio must be fully settled before checkout. Balance: % kobo', target_balance; end if;
  select jsonb_build_object(
    'folio_number', target_folio.folio_number, 'stay_id', target_stay.id, 'guest_id', target_stay.guest_id, 'room_id', target_stay.room_id, 'checkout_date', checkout_on,
    'charges', coalesce((select jsonb_agg(jsonb_build_object('id', fi.id, 'description', fi.description, 'service_date', fi.service_date, 'base_amount_kobo', fi.base_amount_kobo, 'tax_amount_kobo', fi.tax_amount_kobo, 'service_charge_amount_kobo', fi.service_charge_amount_kobo, 'total_amount_kobo', fi.total_amount_kobo, 'status', fi.status) order by fi.posted_at) from public.folio_items fi where fi.folio_id = target_folio.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('payment_id', p.id, 'payment_number', p.payment_number, 'amount_kobo', pa.amount_kobo, 'method_id', p.payment_method_id, 'reference', p.reference, 'received_at', p.received_at) order by p.received_at) from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where pa.folio_id = target_folio.id), '[]'::jsonb),
    'final_balance_kobo', target_balance
  ) into invoice_snapshot;
  update public.stays set status = 'checked_out', actual_check_out_date = checkout_on, checked_out_by = auth.uid() where id = target_stay.id;
  update public.reservations set status = 'checked_out', updated_by = auth.uid() where id = target_stay.reservation_id;
  update public.guest_folios set status = 'closed', closed_at = now(), closed_by = auth.uid() where id = target_folio.id;
  update public.rooms set turnover_status = 'dirty', turnover_updated_at = now(), updated_at = now() where id = target_stay.room_id;
  insert into public.room_turnover_tasks (hotel_id, room_id, stay_id) values (target_stay.hotel_id, target_stay.room_id, target_stay.id);
  invoice_number := public.next_document_number(target_stay.hotel_id, 'INV');
  insert into public.invoices (hotel_id, invoice_number, folio_id, snapshot, issued_by) values (target_stay.hotel_id, invoice_number, target_folio.id, invoice_snapshot, auth.uid()) returning id into invoice_id;
  perform public.log_activity(target_stay.hotel_id, 'stay.checked_out', 'stay', target_stay.id, jsonb_build_object('folio_id', target_folio.id, 'invoice_id', invoice_id, 'invoice_number', invoice_number, 'room_id', target_stay.room_id, 'room_turnover_status', 'dirty'));
  return invoice_id;
end;
$$;

revoke all on public.room_turnover_tasks from public, anon, authenticated;
grant select on public.room_turnover_tasks to authenticated;
alter table public.room_turnover_tasks enable row level security;
create policy room_turnover_tasks_read on public.room_turnover_tasks for select to authenticated
using (public.has_hotel_permission(hotel_id, 'rooms.read'));

revoke all on function public.provision_room_turnover_permissions(uuid), public.handle_hotel_room_turnover_permission_provisioning() from public, anon, authenticated;
revoke all on function public.complete_room_turnover(uuid, text), public.check_in_reservation(uuid, date), public.create_walk_in_stay(uuid, text, text, text, uuid, date, date, bigint), public.checkout_stay(uuid, date) from public, anon;
grant execute on function public.complete_room_turnover(uuid, text), public.check_in_reservation(uuid, date), public.create_walk_in_stay(uuid, text, text, text, uuid, date, date, bigint), public.checkout_stay(uuid, date) to authenticated;
