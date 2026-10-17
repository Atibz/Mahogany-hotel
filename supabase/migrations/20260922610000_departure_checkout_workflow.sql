-- Controlled front-desk departure workflow. Payment collection remains
-- separate from the operational act of checking a guest out.

insert into public.permissions (code, name, description)
values ('departures.checkout', 'Complete guest checkout', 'Complete the final departure checklist, close a settled folio, and issue the invoice.')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'departures.checkout'
where r.code in ('general_manager', 'receptionist')
on conflict do nothing;

create or replace function public.provision_departure_checkout_permission(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.code = 'departures.checkout'
  where r.hotel_id = target_hotel_id and r.code in ('general_manager', 'receptionist')
  on conflict do nothing;
$$;

create or replace function public.handle_hotel_departure_checkout_permission()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_departure_checkout_permission(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzzzzz_hotel_departure_checkout_permission on public.hotels;
create trigger zzzzzzzzz_hotel_departure_checkout_permission
after insert on public.hotels
for each row execute function public.handle_hotel_departure_checkout_permission();

create or replace function public.get_departure_queue(target_hotel_id uuid)
returns table (
  stay_id uuid,
  room_number text,
  room_type_name text,
  guest_name text,
  guest_phone text,
  guest_email text,
  actual_check_in_date date,
  expected_check_out_date date,
  business_date date,
  departure_state text,
  days_overdue integer,
  folio_id uuid,
  folio_number text,
  balance_kobo bigint,
  posted_charge_count bigint,
  posted_charge_total_kobo bigint,
  completed_payment_total_kobo bigint,
  pending_payment_count bigint,
  pending_payment_total_kobo bigint,
  ready_to_checkout boolean,
  blocking_reason text
)
language plpgsql
stable
security definer set search_path = public
as $$
declare current_business_date date := public.hotel_business_date(target_hotel_id);
begin
  if not public.has_hotel_permission(target_hotel_id, 'rooms.read')
     or not public.has_hotel_permission(target_hotel_id, 'stays.read')
     or not public.has_hotel_permission(target_hotel_id, 'folios.read') then
    raise exception 'Not authorised to view departures';
  end if;

  return query
  select
    s.id,
    r.room_number,
    rt.name,
    g.full_name,
    g.phone,
    g.email,
    s.actual_check_in_date,
    s.expected_check_out_date,
    current_business_date,
    case
      when s.expected_check_out_date < current_business_date then 'overdue'
      when s.expected_check_out_date = current_business_date then 'due_today'
      else 'upcoming'
    end,
    greatest(current_business_date - s.expected_check_out_date, 0),
    gf.id,
    gf.folio_number,
    public.folio_balance(gf.id),
    (select count(*) from public.folio_items fi where fi.folio_id = gf.id and fi.status = 'posted'),
    (select coalesce(sum(fi.total_amount_kobo), 0)::bigint from public.folio_items fi where fi.folio_id = gf.id and fi.status = 'posted'),
    (select coalesce(sum(pa.amount_kobo), 0)::bigint from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where pa.folio_id = gf.id and p.status in ('completed', 'refunded')),
    (select count(*) from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where pa.folio_id = gf.id and p.status = 'pending_verification'),
    (select coalesce(sum(pa.amount_kobo), 0)::bigint from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where pa.folio_id = gf.id and p.status = 'pending_verification'),
    public.folio_balance(gf.id) = 0
      and not exists (select 1 from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where pa.folio_id = gf.id and p.status = 'pending_verification'),
    case
      when exists (select 1 from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where pa.folio_id = gf.id and p.status = 'pending_verification') then 'A payment is awaiting verification'
      when public.folio_balance(gf.id) > 0 then 'Outstanding payment must be collected'
      when public.folio_balance(gf.id) < 0 then 'Guest credit must be resolved'
      else null
    end
  from public.stays s
  join public.rooms r on r.id = s.room_id
  join public.room_types rt on rt.id = r.room_type_id
  join public.guests g on g.id = s.guest_id
  join public.guest_folios gf on gf.stay_id = s.id and gf.status = 'open'
  where s.hotel_id = target_hotel_id and s.status = 'checked_in'
  order by
    case when s.expected_check_out_date < current_business_date then 0 when s.expected_check_out_date = current_business_date then 1 else 2 end,
    s.expected_check_out_date,
    r.room_number;
end;
$$;

create or replace function public.complete_departure_checkout(
  target_stay_id uuid,
  room_charges_confirmed boolean,
  incidental_charges_confirmed boolean,
  key_return_confirmed boolean,
  guest_details_confirmed boolean,
  checkout_notes text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_stay public.stays;
  target_folio_id uuid;
  invoice_id uuid;
begin
  select * into target_stay from public.stays where id = target_stay_id for update;
  if not found then raise exception 'Stay not found'; end if;
  if not public.has_hotel_permission(target_stay.hotel_id, 'departures.checkout') then
    raise exception 'Not authorised to complete guest checkout';
  end if;
  if not coalesce(room_charges_confirmed, false)
     or not coalesce(incidental_charges_confirmed, false)
     or not coalesce(key_return_confirmed, false)
     or not coalesce(guest_details_confirmed, false) then
    raise exception 'Every checkout confirmation must be completed';
  end if;

  select gf.id into target_folio_id
  from public.guest_folios gf
  where gf.stay_id = target_stay.id and gf.status = 'open'
  for update;
  if target_folio_id is null then raise exception 'Open folio not found'; end if;
  if exists (
    select 1 from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id
    where pa.folio_id = target_folio_id and p.status = 'pending_verification'
  ) then raise exception 'A pending payment must be verified or rejected before checkout'; end if;

  invoice_id := public.checkout_stay(target_stay.id, public.hotel_business_date(target_stay.hotel_id));
  perform public.log_activity(
    target_stay.hotel_id,
    'stay.checkout_checklist_completed',
    'stay',
    target_stay.id,
    jsonb_build_object(
      'invoice_id', invoice_id,
      'folio_id', target_folio_id,
      'room_charges_confirmed', room_charges_confirmed,
      'incidental_charges_confirmed', incidental_charges_confirmed,
      'key_return_confirmed', key_return_confirmed,
      'guest_details_confirmed', guest_details_confirmed,
      'notes', nullif(trim(checkout_notes), '')
    )
  );
  return invoice_id;
end;
$$;

create or replace function public.get_checkout_invoice(target_invoice_id uuid)
returns table (
  invoice_id uuid,
  invoice_number text,
  issued_at timestamptz,
  hotel_name text,
  snapshot jsonb
)
language plpgsql
stable
security definer set search_path = public
as $$
declare target_hotel_id uuid;
begin
  select i.hotel_id into target_hotel_id from public.invoices i where i.id = target_invoice_id;
  if target_hotel_id is null then raise exception 'Invoice not found'; end if;
  if not public.has_hotel_permission(target_hotel_id, 'invoices.read') then
    raise exception 'Not authorised to view this invoice';
  end if;
  return query
  select i.id, i.invoice_number, i.issued_at, h.trading_name, i.snapshot
  from public.invoices i join public.hotels h on h.id = i.hotel_id
  where i.id = target_invoice_id;
end;
$$;

revoke all on function public.checkout_stay(uuid, date) from authenticated;
revoke all on function public.get_departure_queue(uuid), public.complete_departure_checkout(uuid, boolean, boolean, boolean, boolean, text), public.get_checkout_invoice(uuid) from public, anon;
grant execute on function public.get_departure_queue(uuid), public.complete_departure_checkout(uuid, boolean, boolean, boolean, boolean, text), public.get_checkout_invoice(uuid) to authenticated;
revoke all on function public.provision_departure_checkout_permission(uuid), public.handle_hotel_departure_checkout_permission() from public, anon, authenticated;

