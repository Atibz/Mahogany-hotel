-- Reception core: rooms, guests, reservations, stays, folios, and nightly room posting.
-- Monetary values are stored as integer kobo. Dates are hotel-local business dates.

create extension if not exists btree_gist;

create type public.reservation_status as enum (
  'pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'
);
create type public.stay_status as enum ('checked_in', 'checked_out', 'cancelled');
create type public.folio_status as enum ('open', 'closed');
create type public.folio_item_type as enum (
  'room_charge', 'restaurant_charge', 'bar_charge', 'other_charge', 'adjustment', 'reversal'
);
create type public.folio_item_status as enum ('posted', 'voided', 'reversed');
create type public.posting_run_status as enum ('running', 'completed', 'failed');

create table public.room_types (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  name text not null,
  description text,
  base_rate_kobo bigint not null check (base_rate_kobo >= 0),
  capacity smallint not null check (capacity > 0),
  amenities jsonb not null default '[]' check (jsonb_typeof(amenities) = 'array'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, name)
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  room_type_id uuid not null references public.room_types(id) on delete restrict,
  room_number text not null,
  rate_override_kobo bigint check (rate_override_kobo >= 0),
  amenities jsonb not null default '[]' check (jsonb_typeof(amenities) = 'array'),
  active boolean not null default true,
  blocked_at timestamptz,
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, room_number),
  check ((blocked_at is null and blocked_reason is null) or blocked_at is not null)
);

create table public.guests (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  full_name text not null,
  phone text,
  email text,
  address text,
  identification_type text,
  identification_reference text,
  notes text,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(full_name)) > 0),
  check (email is null or position('@' in email) > 1)
);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  reservation_number text not null,
  guest_id uuid not null references public.guests(id) on delete restrict,
  room_type_id uuid not null references public.room_types(id) on delete restrict,
  room_id uuid references public.rooms(id) on delete restrict,
  check_in_date date not null,
  check_out_date date not null,
  adults smallint not null default 1 check (adults > 0),
  children smallint not null default 0 check (children >= 0),
  agreed_rate_kobo bigint not null check (agreed_rate_kobo >= 0),
  deposit_expected_kobo bigint not null default 0 check (deposit_expected_kobo >= 0),
  booking_source text,
  status public.reservation_status not null default 'pending',
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_out_date > check_in_date),
  unique (hotel_id, reservation_number)
);

-- Assigned rooms are protected at the database layer, including concurrent requests.
alter table public.reservations add constraint reservations_assigned_room_no_overlap
exclude using gist (
  room_id with =,
  daterange(check_in_date, check_out_date, '[)') with &&
)
where (room_id is not null and status in ('pending', 'confirmed', 'checked_in'));

create table public.stays (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  reservation_id uuid unique references public.reservations(id) on delete restrict,
  guest_id uuid not null references public.guests(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  actual_check_in_date date not null,
  expected_check_out_date date not null,
  actual_check_out_date date,
  agreed_rate_kobo bigint not null check (agreed_rate_kobo >= 0),
  status public.stay_status not null default 'checked_in',
  checked_in_by uuid references public.profiles(id) on delete set null,
  checked_out_by uuid references public.profiles(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expected_check_out_date > actual_check_in_date),
  check (actual_check_out_date is null or actual_check_out_date >= actual_check_in_date)
);

create unique index stays_one_open_stay_per_room_idx
on public.stays (room_id)
where status = 'checked_in';

create table public.stay_rate_periods (
  id uuid primary key default gen_random_uuid(),
  stay_id uuid not null references public.stays(id) on delete restrict,
  effective_from date not null,
  effective_to date,
  rate_kobo bigint not null check (rate_kobo >= 0),
  tax_rule_snapshot jsonb not null default '[]' check (jsonb_typeof(tax_rule_snapshot) = 'array'),
  reason text not null,
  approved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (stay_id, effective_from)
);

create table public.guest_folios (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  stay_id uuid not null unique references public.stays(id) on delete restrict,
  folio_number text not null,
  status public.folio_status not null default 'open',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, folio_number),
  check ((status = 'open' and closed_at is null) or (status = 'closed' and closed_at is not null))
);

create table public.folio_items (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  folio_id uuid not null references public.guest_folios(id) on delete restrict,
  item_type public.folio_item_type not null,
  status public.folio_item_status not null default 'posted',
  description text not null,
  department_code text,
  service_date date,
  base_amount_kobo bigint not null,
  tax_amount_kobo bigint not null default 0,
  service_charge_amount_kobo bigint not null default 0,
  total_amount_kobo bigint not null,
  tax_snapshot jsonb not null default '[]' check (jsonb_typeof(tax_snapshot) = 'array'),
  reference_type text,
  reference_id uuid,
  reversal_of_item_id uuid references public.folio_items(id) on delete restrict,
  reason text,
  posted_by uuid references public.profiles(id) on delete set null,
  posted_at timestamptz not null default now(),
  check (length(trim(description)) > 0),
  check (total_amount_kobo = base_amount_kobo + tax_amount_kobo + service_charge_amount_kobo),
  check (status <> 'posted' or reversal_of_item_id is null)
);

create table public.room_night_posts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  stay_id uuid not null references public.stays(id) on delete restrict,
  folio_id uuid not null references public.guest_folios(id) on delete restrict,
  folio_item_id uuid not null unique references public.folio_items(id) on delete restrict,
  service_date date not null,
  rate_period_id uuid references public.stay_rate_periods(id) on delete set null,
  rate_kobo bigint not null check (rate_kobo >= 0),
  tax_snapshot jsonb not null default '[]' check (jsonb_typeof(tax_snapshot) = 'array'),
  posted_at timestamptz not null default now(),
  posted_by uuid references public.profiles(id) on delete set null,
  unique (stay_id, service_date)
);

create table public.nightly_posting_runs (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  service_date date not null,
  status public.posting_run_status not null default 'running',
  posts_created integer not null default 0 check (posts_created >= 0),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_detail text,
  initiated_by uuid references public.profiles(id) on delete set null,
  unique (hotel_id, service_date)
);

create index room_types_hotel_id_idx on public.room_types(hotel_id);
create index rooms_hotel_type_idx on public.rooms(hotel_id, room_type_id);
create index guests_hotel_name_idx on public.guests(hotel_id, full_name);
create index guests_hotel_phone_idx on public.guests(hotel_id, phone) where phone is not null;
create index reservations_hotel_dates_idx on public.reservations(hotel_id, check_in_date, check_out_date);
create index reservations_guest_idx on public.reservations(guest_id, created_at desc);
create index stays_hotel_status_idx on public.stays(hotel_id, status);
create index folio_items_folio_idx on public.folio_items(folio_id, posted_at);
create index room_night_posts_hotel_date_idx on public.room_night_posts(hotel_id, service_date);

create trigger room_types_set_updated_at before update on public.room_types
for each row execute function public.set_updated_at();
create trigger rooms_set_updated_at before update on public.rooms
for each row execute function public.set_updated_at();
create trigger guests_set_updated_at before update on public.guests
for each row execute function public.set_updated_at();
create trigger reservations_set_updated_at before update on public.reservations
for each row execute function public.set_updated_at();
create trigger stays_set_updated_at before update on public.stays
for each row execute function public.set_updated_at();
create trigger guest_folios_set_updated_at before update on public.guest_folios
for each row execute function public.set_updated_at();

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
  end as status
from public.rooms r
join public.room_types rt on rt.id = r.room_type_id;

create sequence public.document_number_sequence as bigint;

create or replace function public.next_document_number(target_hotel_id uuid, prefix text)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  next_value bigint;
begin
  -- A sequence value makes collisions impossible. Its gaps are intentional and auditable.
  next_value := nextval('public.document_number_sequence');
  return prefix || '-' || to_char(current_date, 'YYYYMMDD') || '-' || lpad(next_value::text, 7, '0');
end;
$$;

create or replace function public.log_activity(
  target_hotel_id uuid,
  event_action text,
  target_entity_type text,
  target_entity_id uuid,
  event_metadata jsonb default '{}'
)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.activity_logs (hotel_id, actor_id, action, entity_type, entity_id, metadata)
  values (target_hotel_id, auth.uid(), event_action, target_entity_type, target_entity_id, event_metadata);
$$;

create or replace function public.create_guest(
  target_hotel_id uuid,
  guest_full_name text,
  guest_phone text default null,
  guest_email text default null,
  guest_address text default null,
  guest_identification_type text default null,
  guest_identification_reference text default null,
  guest_notes text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare new_guest_id uuid;
begin
  if not public.has_hotel_permission(target_hotel_id, 'guests.create') then
    raise exception 'Not authorised to create guests';
  end if;

  insert into public.guests (
    hotel_id, full_name, phone, email, address, identification_type,
    identification_reference, notes, created_by, updated_by
  ) values (
    target_hotel_id, trim(guest_full_name), nullif(trim(guest_phone), ''),
    nullif(lower(trim(guest_email)), ''), nullif(trim(guest_address), ''),
    nullif(trim(guest_identification_type), ''), nullif(trim(guest_identification_reference), ''),
    nullif(trim(guest_notes), ''), auth.uid(), auth.uid()
  ) returning id into new_guest_id;

  perform public.log_activity(target_hotel_id, 'guest.created', 'guest', new_guest_id, '{}'::jsonb);
  return new_guest_id;
end;
$$;

create or replace function public.create_reservation(
  target_hotel_id uuid,
  target_guest_id uuid,
  target_room_type_id uuid,
  target_room_id uuid,
  arrival_date date,
  departure_date date,
  agreed_rate bigint,
  adult_count smallint default 1,
  child_count smallint default 0,
  deposit_expected bigint default 0,
  source text default null,
  reservation_notes text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  new_reservation_id uuid;
  new_reservation_number text;
begin
  if not public.has_hotel_permission(target_hotel_id, 'reservations.create') then
    raise exception 'Not authorised to create reservations';
  end if;
  if departure_date <= arrival_date then
    raise exception 'Checkout date must be after check-in date';
  end if;
  if not exists (select 1 from public.guests where id = target_guest_id and hotel_id = target_hotel_id and active) then
    raise exception 'Guest is not available for this hotel';
  end if;
  if not exists (select 1 from public.room_types where id = target_room_type_id and hotel_id = target_hotel_id and active) then
    raise exception 'Room type is not available';
  end if;
  if target_room_id is not null and not exists (
    select 1 from public.rooms where id = target_room_id and hotel_id = target_hotel_id and room_type_id = target_room_type_id and active and blocked_at is null
  ) then
    raise exception 'Room is not available for this room type';
  end if;

  new_reservation_number := public.next_document_number(target_hotel_id, 'RSV');
  insert into public.reservations (
    hotel_id, reservation_number, guest_id, room_type_id, room_id, check_in_date,
    check_out_date, adults, children, agreed_rate_kobo, deposit_expected_kobo,
    booking_source, status, notes, created_by, updated_by
  ) values (
    target_hotel_id, new_reservation_number, target_guest_id, target_room_type_id,
    target_room_id, arrival_date, departure_date, adult_count, child_count,
    agreed_rate, deposit_expected, nullif(trim(source), ''), 'confirmed',
    nullif(trim(reservation_notes), ''), auth.uid(), auth.uid()
  ) returning id into new_reservation_id;

  perform public.log_activity(target_hotel_id, 'reservation.created', 'reservation', new_reservation_id,
    jsonb_build_object('reservation_number', new_reservation_number));
  return new_reservation_id;
end;
$$;

create or replace function public.check_in_reservation(target_reservation_id uuid, check_in_on date default current_date)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  reservation_record public.reservations;
  new_stay_id uuid;
  new_folio_number text;
begin
  select * into reservation_record from public.reservations where id = target_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(reservation_record.hotel_id, 'stays.check_in') then
    raise exception 'Not authorised to check in guests';
  end if;
  if reservation_record.status not in ('pending', 'confirmed') then
    raise exception 'Only pending or confirmed reservations can be checked in';
  end if;
  if reservation_record.room_id is null then raise exception 'Assign a room before check-in'; end if;
  if check_in_on < reservation_record.check_in_date or check_in_on >= reservation_record.check_out_date then
    raise exception 'Check-in date is outside the reservation dates';
  end if;
  if exists (select 1 from public.stays where room_id = reservation_record.room_id and status = 'checked_in') then
    raise exception 'This room already has an active stay';
  end if;

  insert into public.stays (
    hotel_id, reservation_id, guest_id, room_id, actual_check_in_date,
    expected_check_out_date, agreed_rate_kobo, status, checked_in_by, notes
  ) values (
    reservation_record.hotel_id, reservation_record.id, reservation_record.guest_id,
    reservation_record.room_id, check_in_on, reservation_record.check_out_date,
    reservation_record.agreed_rate_kobo, 'checked_in', auth.uid(), reservation_record.notes
  ) returning id into new_stay_id;

  insert into public.stay_rate_periods (stay_id, effective_from, rate_kobo, reason, approved_by)
  values (new_stay_id, check_in_on, reservation_record.agreed_rate_kobo, 'Rate agreed at reservation', auth.uid());

  new_folio_number := public.next_document_number(reservation_record.hotel_id, 'FOL');
  insert into public.guest_folios (hotel_id, stay_id, folio_number)
  values (reservation_record.hotel_id, new_stay_id, new_folio_number);

  update public.reservations
  set status = 'checked_in', updated_by = auth.uid()
  where id = reservation_record.id;

  perform public.log_activity(reservation_record.hotel_id, 'stay.checked_in', 'stay', new_stay_id,
    jsonb_build_object('reservation_id', reservation_record.id, 'room_id', reservation_record.room_id));
  return new_stay_id;
end;
$$;

create or replace function public.post_room_night(target_stay_id uuid, target_service_date date)
returns table (night_post_id uuid, folio_item_id uuid, created boolean)
language plpgsql
security definer set search_path = public
as $$
declare
  stay_record public.stays;
  target_folio_id uuid;
  target_rate_period_id uuid;
  target_rate_kobo bigint;
  target_tax_snapshot jsonb;
  target_tax_amount_kobo bigint;
  new_folio_item_id uuid;
  new_night_post_id uuid;
begin
  select * into stay_record from public.stays where id = target_stay_id for update;
  if not found then raise exception 'Stay not found'; end if;
  if auth.uid() is not null and not public.has_hotel_permission(stay_record.hotel_id, 'night_audit.run') then
    raise exception 'Not authorised to post room nights';
  end if;
  if stay_record.status <> 'checked_in' then raise exception 'Only active stays may receive room-night charges'; end if;
  if target_service_date < stay_record.actual_check_in_date or target_service_date >= stay_record.expected_check_out_date then
    raise exception 'Service date is outside the active stay';
  end if;

  select gf.id into target_folio_id from public.guest_folios gf
  where gf.stay_id = stay_record.id and gf.status = 'open' for update;
  if target_folio_id is null then raise exception 'Open folio not found for stay'; end if;

  select srp.id, srp.rate_kobo into target_rate_period_id, target_rate_kobo
  from public.stay_rate_periods srp
  where srp.stay_id = stay_record.id
    and srp.effective_from <= target_service_date
    and (srp.effective_to is null or srp.effective_to >= target_service_date)
  order by srp.effective_from desc limit 1;
  if target_rate_kobo is null then raise exception 'No rate period is available for this service date'; end if;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', tr.id, 'code', tr.code, 'name', tr.name, 'jurisdiction', tr.jurisdiction,
      'basis', tr.basis, 'rate_basis_points', tr.rate_basis_points,
      'fixed_amount_kobo', tr.fixed_amount_kobo, 'amount_kobo',
      case when tr.basis = 'percentage' then round(target_rate_kobo::numeric * tr.rate_basis_points / 10000)::bigint else tr.fixed_amount_kobo end
    ) order by tr.calculation_order), '[]'::jsonb),
    coalesce(sum(case when tr.basis = 'percentage' then round(target_rate_kobo::numeric * tr.rate_basis_points / 10000)::bigint else tr.fixed_amount_kobo end), 0)
  into target_tax_snapshot, target_tax_amount_kobo
  from public.tax_rules tr
  where tr.hotel_id = stay_record.hotel_id
    and tr.active
    and 'room' = any(tr.applies_to)
    and tr.effective_from <= target_service_date
    and (tr.effective_to is null or tr.effective_to >= target_service_date);

  begin
    insert into public.folio_items (
      hotel_id, folio_id, item_type, description, department_code, service_date,
      base_amount_kobo, tax_amount_kobo, total_amount_kobo, tax_snapshot,
      reference_type, posted_by
    ) values (
      stay_record.hotel_id, target_folio_id, 'room_charge',
      'Room charge for ' || to_char(target_service_date, 'DD Mon YYYY'), 'reception', target_service_date,
      target_rate_kobo, target_tax_amount_kobo, target_rate_kobo + target_tax_amount_kobo,
      target_tax_snapshot, 'room_night_post', auth.uid()
    ) returning id into new_folio_item_id;

    insert into public.room_night_posts (
      hotel_id, stay_id, folio_id, folio_item_id, service_date, rate_period_id,
      rate_kobo, tax_snapshot, posted_by
    ) values (
      stay_record.hotel_id, stay_record.id, target_folio_id, new_folio_item_id,
      target_service_date, target_rate_period_id, target_rate_kobo, target_tax_snapshot, auth.uid()
    ) returning id into new_night_post_id;
  exception when unique_violation then
    select rnp.id, rnp.folio_item_id into new_night_post_id, new_folio_item_id
    from public.room_night_posts rnp
    where rnp.stay_id = stay_record.id and rnp.service_date = target_service_date;
    return query select new_night_post_id, new_folio_item_id, false;
    return;
  end;

  perform public.log_activity(stay_record.hotel_id, 'folio.room_night_posted', 'room_night_post', new_night_post_id,
    jsonb_build_object('stay_id', stay_record.id, 'service_date', target_service_date));
  return query select new_night_post_id, new_folio_item_id, true;
end;
$$;

create or replace function public.run_nightly_room_posting(target_hotel_id uuid, target_service_date date)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  stay_id_to_post uuid;
  post_result record;
  created_count integer := 0;
begin
  if auth.uid() is not null and not public.has_hotel_permission(target_hotel_id, 'night_audit.run') then
    raise exception 'Not authorised to run nightly posting';
  end if;

  insert into public.nightly_posting_runs (hotel_id, service_date, initiated_by)
  values (target_hotel_id, target_service_date, auth.uid())
  on conflict (hotel_id, service_date) do update set status = 'running', started_at = now(), error_detail = null;

  for stay_id_to_post in
    select s.id from public.stays s
    where s.hotel_id = target_hotel_id
      and s.status = 'checked_in'
      and target_service_date >= s.actual_check_in_date
      and target_service_date < s.expected_check_out_date
  loop
    select * into post_result from public.post_room_night(stay_id_to_post, target_service_date);
    if post_result.created then created_count := created_count + 1; end if;
  end loop;

  update public.nightly_posting_runs
  set status = 'completed', posts_created = created_count, finished_at = now()
  where hotel_id = target_hotel_id and service_date = target_service_date;
  return created_count;
exception when others then
  update public.nightly_posting_runs
  set status = 'failed', error_detail = sqlerrm, finished_at = now()
  where hotel_id = target_hotel_id and service_date = target_service_date;
  raise;
end;
$$;

revoke all on all tables in schema public from anon;
revoke all on function public.next_document_number(uuid, text), public.log_activity(uuid, text, text, uuid, jsonb) from public;
revoke all on function public.create_guest(uuid, text, text, text, text, text, text, text), public.create_reservation(uuid, uuid, uuid, uuid, date, date, bigint, smallint, smallint, bigint, text, text), public.check_in_reservation(uuid, date), public.post_room_night(uuid, date), public.run_nightly_room_posting(uuid, date) from public;
grant select on public.room_types, public.rooms, public.room_board, public.guests,
  public.reservations, public.stays, public.stay_rate_periods, public.guest_folios,
  public.folio_items, public.room_night_posts, public.nightly_posting_runs to authenticated;
grant execute on function public.create_guest(uuid, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.create_reservation(uuid, uuid, uuid, uuid, date, date, bigint, smallint, smallint, bigint, text, text) to authenticated;
grant execute on function public.check_in_reservation(uuid, date) to authenticated;
grant execute on function public.post_room_night(uuid, date) to authenticated;
grant execute on function public.run_nightly_room_posting(uuid, date) to authenticated;

alter table public.room_types enable row level security;
alter table public.rooms enable row level security;
alter table public.guests enable row level security;
alter table public.reservations enable row level security;
alter table public.stays enable row level security;
alter table public.stay_rate_periods enable row level security;
alter table public.guest_folios enable row level security;
alter table public.folio_items enable row level security;
alter table public.room_night_posts enable row level security;
alter table public.nightly_posting_runs enable row level security;

create policy room_types_read on public.room_types for select to authenticated using (public.has_hotel_access(hotel_id));
create policy rooms_read on public.rooms for select to authenticated using (public.has_hotel_access(hotel_id));
create policy guests_read on public.guests for select to authenticated using (public.has_hotel_permission(hotel_id, 'guests.read'));
create policy reservations_read on public.reservations for select to authenticated using (public.has_hotel_permission(hotel_id, 'reservations.read'));
create policy stays_read on public.stays for select to authenticated using (public.has_hotel_permission(hotel_id, 'stays.read'));
create policy stay_rate_periods_read on public.stay_rate_periods for select to authenticated using (exists (
  select 1 from public.stays s where s.id = stay_id and public.has_hotel_permission(s.hotel_id, 'stays.read')
));
create policy guest_folios_read on public.guest_folios for select to authenticated using (public.has_hotel_permission(hotel_id, 'folios.read'));
create policy folio_items_read on public.folio_items for select to authenticated using (public.has_hotel_permission(hotel_id, 'folios.read'));
create policy room_night_posts_read on public.room_night_posts for select to authenticated using (public.has_hotel_permission(hotel_id, 'folios.read'));
create policy nightly_posting_runs_read on public.nightly_posting_runs for select to authenticated using (public.has_hotel_permission(hotel_id, 'night_audit.read'));

grant select on public.room_board to authenticated;
alter view public.room_board set (security_invoker = true);

-- No direct browser writes are allowed for these core tables. The RPCs above own the
-- critical state transitions and attach activity records in the same transaction.
