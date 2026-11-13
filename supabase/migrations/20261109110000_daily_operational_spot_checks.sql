-- Independent observations supplement, but never change, the room and stock ledgers.
create table public.daily_operational_spot_checks (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id),
  business_date date not null,
  kind text not null check (kind in ('room', 'stock')),
  room_id uuid references public.rooms(id),
  item_id uuid references public.inventory_items(id),
  location_id uuid references public.inventory_locations(id),
  expected_occupied boolean,
  observed_occupied boolean,
  expected_quantity numeric(14,3),
  observed_quantity numeric(14,3),
  evidence_note text not null check (length(trim(evidence_note)) between 5 and 500),
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default clock_timestamp(),
  review_status text not null default 'pending' check (review_status in ('pending', 'confirmed', 'disputed')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  check ((kind = 'room' and room_id is not null and item_id is null and location_id is null
      and expected_occupied is not null and observed_occupied is not null
      and expected_quantity is null and observed_quantity is null)
    or (kind = 'stock' and room_id is null and item_id is not null and location_id is not null
      and expected_occupied is null and observed_occupied is null
      and expected_quantity is not null and observed_quantity is not null and observed_quantity >= 0)),
  check ((review_status = 'pending' and reviewed_by is null and reviewed_at is null and review_note is null)
    or (review_status <> 'pending' and reviewed_by is not null and reviewed_by <> submitted_by
      and reviewed_at is not null and length(trim(review_note)) between 5 and 500))
);
create index daily_operational_spot_checks_history
  on public.daily_operational_spot_checks(hotel_id, business_date desc, submitted_at desc);
create unique index daily_operational_spot_checks_one_pending_room
  on public.daily_operational_spot_checks(hotel_id, business_date, room_id)
  where kind = 'room' and review_status = 'pending';
create unique index daily_operational_spot_checks_one_pending_stock
  on public.daily_operational_spot_checks(hotel_id, business_date, item_id, location_id)
  where kind = 'stock' and review_status = 'pending';

alter table public.daily_operational_spot_checks enable row level security;
revoke all on public.daily_operational_spot_checks from public, anon, authenticated;

create function public.get_daily_operational_spot_checks(target_hotel_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.has_hotel_permission(target_hotel_id, 'expenses.read')
    and not public.has_hotel_permission(target_hotel_id, 'inventory.read') then
    raise exception 'Not authorised to view operational checks';
  end if;
  select jsonb_build_object(
    'business_date', public.hotel_business_date(target_hotel_id, now()),
    'rooms', coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'name', r.room_number, 'expected_occupied', exists (
        select 1 from public.stays s where s.room_id = r.id and s.status = 'checked_in')) order by r.room_number)
      from public.rooms r where r.hotel_id = target_hotel_id and r.active), '[]'::jsonb),
    'stock', coalesce((select jsonb_agg(jsonb_build_object(
      'item_id', i.id, 'item_name', i.name, 'unit', i.base_unit,
      'location_id', l.id, 'location_name', l.name,
      'expected_quantity', coalesce((select sum(m.quantity_delta) from public.inventory_movements m
        where m.item_id = i.id and m.location_id = l.id), 0)) order by i.name, l.name)
      from public.inventory_items i join public.inventory_locations l on l.hotel_id = i.hotel_id and l.active
      where i.hotel_id = target_hotel_id and i.active), '[]'::jsonb),
    'checks', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'kind', c.kind, 'business_date', c.business_date, 'room_id', c.room_id,
      'item_id', c.item_id, 'location_id', c.location_id,
      'expected_occupied', c.expected_occupied, 'observed_occupied', c.observed_occupied,
      'expected_quantity', c.expected_quantity, 'observed_quantity', c.observed_quantity,
      'evidence_note', c.evidence_note, 'submitted_by', c.submitted_by,
      'submitted_at', c.submitted_at, 'review_status', c.review_status,
      'reviewed_by', c.reviewed_by, 'reviewed_at', c.reviewed_at, 'review_note', c.review_note)
      order by c.submitted_at desc)
      from public.daily_operational_spot_checks c where c.hotel_id = target_hotel_id
        and c.business_date = public.hotel_business_date(target_hotel_id, now())), '[]'::jsonb)
  ) into result;
  return result;
end; $$;

create function public.submit_daily_operational_spot_check(
  target_hotel_id uuid, kind_value text, target_room_id uuid,
  target_item_id uuid, target_location_id uuid, observed_occupied_value boolean,
  observed_quantity_value numeric, evidence_note_value text
) returns uuid language plpgsql security definer set search_path = public as $$
declare result_id uuid; expected_room boolean; expected_stock numeric(14,3); check_date date;
begin
  if auth.uid() is null or (not public.has_hotel_permission(target_hotel_id, 'expenses.submit')
    and not public.has_hotel_permission(target_hotel_id, 'inventory.manage')) then
    raise exception 'Not authorised to submit operational checks';
  end if;
  if length(trim(coalesce(evidence_note_value, ''))) not between 5 and 500 then
    raise exception 'Describe how the physical observation was made (5-500 characters)';
  end if;
  perform 1 from public.hotels where id = target_hotel_id for update;
  check_date := public.hotel_business_date(target_hotel_id, now());
  if kind_value = 'room' then
    if not public.has_hotel_permission(target_hotel_id, 'rooms.read') and
       not public.has_hotel_permission(target_hotel_id, 'expenses.submit') then
      raise exception 'Not authorised to check rooms';
    end if;
    if target_room_id is null or target_item_id is not null or target_location_id is not null
      or observed_occupied_value is null or observed_quantity_value is not null then
      raise exception 'Choose one room and its observed occupancy';
    end if;
    if not exists (select 1 from public.rooms where id = target_room_id and hotel_id = target_hotel_id and active) then
      raise exception 'Active room not found';
    end if;
    select exists (select 1 from public.stays where room_id = target_room_id and status = 'checked_in') into expected_room;
    insert into public.daily_operational_spot_checks(hotel_id, business_date, kind, room_id,
      expected_occupied, observed_occupied, evidence_note, submitted_by)
    values (target_hotel_id, check_date, 'room', target_room_id, expected_room,
      observed_occupied_value, trim(evidence_note_value), auth.uid()) returning id into result_id;
  elsif kind_value = 'stock' then
    if not public.has_hotel_permission(target_hotel_id, 'inventory.manage') then
      raise exception 'Not authorised to count stock';
    end if;
    if target_item_id is null or target_location_id is null or target_room_id is not null
      or observed_occupied_value is not null or observed_quantity_value is null
      or observed_quantity_value < 0 or observed_quantity_value > 99999999999.999
      or observed_quantity_value <> round(observed_quantity_value, 3) then
      raise exception 'Choose one item and location and enter a valid physical count';
    end if;
    if not exists (select 1 from public.inventory_items where id = target_item_id and hotel_id = target_hotel_id and active)
      or not exists (select 1 from public.inventory_locations where id = target_location_id and hotel_id = target_hotel_id and active) then
      raise exception 'Active item or stock location not found';
    end if;
    select coalesce(sum(quantity_delta), 0) into expected_stock from public.inventory_movements
      where item_id = target_item_id and location_id = target_location_id;
    insert into public.daily_operational_spot_checks(hotel_id, business_date, kind, item_id, location_id,
      expected_quantity, observed_quantity, evidence_note, submitted_by)
    values (target_hotel_id, check_date, 'stock', target_item_id, target_location_id, expected_stock,
      observed_quantity_value, trim(evidence_note_value), auth.uid()) returning id into result_id;
  else
    raise exception 'Unsupported operational check';
  end if;
  perform public.log_activity(target_hotel_id, 'operational_check.submitted', 'daily_operational_spot_check', result_id,
    jsonb_build_object('kind', kind_value, 'business_date', check_date));
  return result_id;
end; $$;

create function public.review_daily_operational_spot_check(target_check_id uuid, decision_value text, note_value text)
returns void language plpgsql security definer set search_path = public as $$
declare check_record public.daily_operational_spot_checks;
begin
  select * into check_record from public.daily_operational_spot_checks where id = target_check_id for update;
  if not found then raise exception 'Operational check not found'; end if;
  if auth.uid() is null or not public.has_hotel_permission(check_record.hotel_id, 'expenses.review') then
    raise exception 'Not authorised to review operational checks';
  end if;
  if decision_value not in ('confirmed', 'disputed') or length(trim(coalesce(note_value, ''))) not between 5 and 500 then
    raise exception 'Choose a decision and explain it (5-500 characters)';
  end if;
  if check_record.review_status <> 'pending' then raise exception 'This check has already been reviewed'; end if;
  if check_record.submitted_by = auth.uid() then raise exception 'Another person must review this check'; end if;
  update public.daily_operational_spot_checks set review_status = decision_value,
    reviewed_by = auth.uid(), reviewed_at = clock_timestamp(), review_note = trim(note_value)
  where id = target_check_id;
  perform public.log_activity(check_record.hotel_id, 'operational_check.' || decision_value,
    'daily_operational_spot_check', target_check_id, jsonb_build_object('kind', check_record.kind, 'business_date', check_record.business_date));
end; $$;

revoke all on function public.get_daily_operational_spot_checks(uuid),
  public.submit_daily_operational_spot_check(uuid, text, uuid, uuid, uuid, boolean, numeric, text),
  public.review_daily_operational_spot_check(uuid, text, text) from public, anon;
grant execute on function public.get_daily_operational_spot_checks(uuid),
  public.submit_daily_operational_spot_check(uuid, text, uuid, uuid, uuid, boolean, numeric, text),
  public.review_daily_operational_spot_check(uuid, text, text) to authenticated;
