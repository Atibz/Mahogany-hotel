-- Hotel-configured cancellation/no-show terms, snapshotted when each booking is
-- created. This records policy only; it never posts or withholds money.

alter table public.hotel_settings
  add column if not exists free_cancellation_hours integer not null default 24
    check (free_cancellation_hours between 0 and 720),
  add column if not exists late_cancellation_charge_nights numeric(4,2) not null default 0
    check (late_cancellation_charge_nights between 0 and 30),
  add column if not exists no_show_grace_hours integer not null default 12
    check (no_show_grace_hours between 0 and 72),
  add column if not exists no_show_charge_nights numeric(4,2) not null default 0
    check (no_show_charge_nights between 0 and 30),
  add column if not exists cancellation_policy_notes text,
  add column if not exists cancellation_policy_confirmed boolean not null default false;

create table if not exists public.reservation_cancellation_policy_snapshots (
  reservation_id uuid primary key references public.reservations(id) on delete restrict,
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  terms_state text not null check (terms_state in ('recorded_at_booking', 'unconfirmed_at_booking', 'legacy_terms_unknown')),
  scheduled_check_in_time time,
  free_cancellation_hours integer,
  late_cancellation_charge_nights numeric(4,2),
  no_show_grace_hours integer,
  no_show_charge_nights numeric(4,2),
  policy_notes text,
  captured_at timestamptz not null default now(),
  captured_by uuid references public.profiles(id) on delete set null,
  check (
    (terms_state in ('recorded_at_booking', 'unconfirmed_at_booking') and scheduled_check_in_time is not null
      and free_cancellation_hours is not null
      and late_cancellation_charge_nights is not null and no_show_grace_hours is not null
      and no_show_charge_nights is not null)
    or (terms_state = 'legacy_terms_unknown' and scheduled_check_in_time is null
      and free_cancellation_hours is null
      and late_cancellation_charge_nights is null and no_show_grace_hours is null
      and no_show_charge_nights is null)
  )
);

-- Existing records predate terms snapshots. Do not fabricate what the guest
-- was told; explicitly mark those bookings as unknown.
insert into public.reservation_cancellation_policy_snapshots
  (reservation_id, hotel_id, terms_state)
select r.id, r.hotel_id, 'legacy_terms_unknown'
from public.reservations r
on conflict (reservation_id) do nothing;

create or replace function public.capture_reservation_cancellation_policy()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.reservation_cancellation_policy_snapshots (
    reservation_id, hotel_id, terms_state, scheduled_check_in_time, free_cancellation_hours,
    late_cancellation_charge_nights, no_show_grace_hours,
    no_show_charge_nights, policy_notes, captured_by
  )
  select new.id, new.hotel_id,
    case when coalesce(hs.cancellation_policy_confirmed, false) then 'recorded_at_booking' else 'unconfirmed_at_booking' end,
    coalesce(hs.standard_check_in_time, time '14:00'),
    coalesce(hs.free_cancellation_hours, 24),
    coalesce(hs.late_cancellation_charge_nights, 0),
    coalesce(hs.no_show_grace_hours, 12),
    coalesce(hs.no_show_charge_nights, 0),
    hs.cancellation_policy_notes, auth.uid()
  from public.hotel_settings hs
  where hs.hotel_id = new.hotel_id;

  if not found then
    insert into public.reservation_cancellation_policy_snapshots (
      reservation_id, hotel_id, terms_state, scheduled_check_in_time, free_cancellation_hours,
      late_cancellation_charge_nights, no_show_grace_hours,
      no_show_charge_nights, captured_by
    ) values (new.id, new.hotel_id, 'unconfirmed_at_booking', time '14:00', 24, 0, 12, 0, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_capture_cancellation_policy on public.reservations;
create trigger reservations_capture_cancellation_policy
after insert on public.reservations
for each row execute function public.capture_reservation_cancellation_policy();

create or replace function public.prevent_reservation_cancellation_policy_snapshot_mutation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  raise exception 'Reservation policy snapshots are immutable';
end;
$$;

drop trigger if exists reservation_cancellation_policy_snapshots_immutable on public.reservation_cancellation_policy_snapshots;
create trigger reservation_cancellation_policy_snapshots_immutable
before update or delete on public.reservation_cancellation_policy_snapshots
for each row execute function public.prevent_reservation_cancellation_policy_snapshot_mutation();

create or replace function public.update_reservation_cancellation_policy(
  target_hotel_id uuid,
  free_cancellation_hours_value integer,
  late_cancellation_charge_nights_value numeric,
  no_show_grace_hours_value integer,
  no_show_charge_nights_value numeric,
  policy_notes_value text default null,
  policy_confirmed_value boolean default false
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'settings.manage') then
    raise exception 'Not authorised to manage hotel policy';
  end if;
  if policy_confirmed_value is distinct from true then
    raise exception 'Owner or GM confirmation of the guest-facing policy is required';
  end if;
  if free_cancellation_hours_value not between 0 and 720
    or no_show_grace_hours_value not between 0 and 72
    or late_cancellation_charge_nights_value not between 0 and 30
    or no_show_charge_nights_value not between 0 and 30 then
    raise exception 'Cancellation and no-show policy values are outside allowed limits';
  end if;

  update public.hotel_settings
  set free_cancellation_hours = free_cancellation_hours_value,
      late_cancellation_charge_nights = late_cancellation_charge_nights_value,
      no_show_grace_hours = no_show_grace_hours_value,
      no_show_charge_nights = no_show_charge_nights_value,
      cancellation_policy_notes = nullif(trim(policy_notes_value), ''),
      cancellation_policy_confirmed = policy_confirmed_value
  where hotel_id = target_hotel_id;
  if not found then raise exception 'Hotel settings not found'; end if;

  perform public.log_activity(target_hotel_id, 'settings.reservation_cancellation_policy_updated',
    'hotel_settings', target_hotel_id, jsonb_build_object(
      'free_cancellation_hours', free_cancellation_hours_value,
      'late_cancellation_charge_nights', late_cancellation_charge_nights_value,
      'no_show_grace_hours', no_show_grace_hours_value,
      'no_show_charge_nights', no_show_charge_nights_value,
      'confirmed', policy_confirmed_value,
      'notes', nullif(trim(policy_notes_value), '')
    ));
end;
$$;

revoke all on public.reservation_cancellation_policy_snapshots from public, anon, authenticated;
grant select on public.reservation_cancellation_policy_snapshots to authenticated;
alter table public.reservation_cancellation_policy_snapshots enable row level security;
drop policy if exists reservation_cancellation_policy_snapshots_read on public.reservation_cancellation_policy_snapshots;
create policy reservation_cancellation_policy_snapshots_read
on public.reservation_cancellation_policy_snapshots for select to authenticated
using (public.has_hotel_permission(hotel_id, 'reservations.read'));

-- A reservation cannot be declared a no-show before the saved check-in time
-- plus the hotel's grace period (Africa/Lagos is the hotel's local timezone).
create or replace function public.mark_reservation_no_show(target_reservation_id uuid, no_show_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target public.reservations;
  allowed_after timestamptz;
begin
  select * into target from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(target.hotel_id, 'reservations.manage') then raise exception 'Not authorised to manage reservations'; end if;
  if target.status not in ('pending', 'confirmed') then raise exception 'Only pending or confirmed reservations can be marked no-show'; end if;
  if nullif(trim(no_show_reason), '') is null then raise exception 'A no-show reason is required'; end if;

  select ((target.check_in_date + coalesce(scheduled_check_in_time, hs.standard_check_in_time, time '14:00'))::timestamp at time zone 'Africa/Lagos')
      + make_interval(hours => coalesce(snap.no_show_grace_hours, hs.no_show_grace_hours, 12))
  into allowed_after
  from public.hotel_settings hs
  left join public.reservation_cancellation_policy_snapshots snap on snap.reservation_id = target.id
  where hs.hotel_id = target.hotel_id;
  if allowed_after is null then
    allowed_after := ((target.check_in_date + time '14:00')::timestamp at time zone 'Africa/Lagos') + interval '12 hours';
  end if;
  if now() < allowed_after then
    raise exception 'No-show can only be recorded after the scheduled check-in time and hotel grace period';
  end if;

  update public.reservations set status = 'no_show', notes = concat_ws(E'\n', notes, '[No-show] ' || trim(no_show_reason)), updated_by = auth.uid(), updated_at = now() where id = target.id;
  perform public.log_activity(target.hotel_id, 'reservation.no_show', 'reservation', target.id,
    jsonb_build_object('reason', trim(no_show_reason), 'allowed_after', allowed_after));
end;
$$;

revoke all on function public.capture_reservation_cancellation_policy(),
  public.prevent_reservation_cancellation_policy_snapshot_mutation(),
  public.update_reservation_cancellation_policy(uuid, integer, numeric, integer, numeric, text, boolean),
  public.mark_reservation_no_show(uuid, text)
from public, anon;
grant execute on function public.update_reservation_cancellation_policy(uuid, integer, numeric, integer, numeric, text, boolean)
to authenticated;
grant execute on function public.mark_reservation_no_show(uuid, text) to authenticated;
