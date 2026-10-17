-- Audited, staff-initiated arrival emails. Delivery is never triggered by a
-- reservation insert; reception explicitly requests each email.

create table public.guest_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  check_in_date date not null,
  recipient_email text not null,
  status text not null check (status in ('sending', 'sent', 'failed')),
  provider_message_id text,
  provider_http_status integer,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

create unique index guest_email_deliveries_active_uq
  on public.guest_email_deliveries (reservation_id, check_in_date)
  where status in ('sending', 'sent');
create index guest_email_deliveries_hotel_created_idx
  on public.guest_email_deliveries (hotel_id, created_at desc);

alter table public.guest_email_deliveries enable row level security;
revoke all on public.guest_email_deliveries from public, anon, authenticated;

create or replace function public.claim_guest_arrival_email(target_reservation_id uuid)
returns table (
  delivery_id uuid,
  hotel_name text,
  guest_name text,
  guest_email text,
  reservation_number text,
  room_type_name text,
  room_number text,
  check_in_date date,
  check_out_date date,
  check_in_time time,
  hotel_phone text,
  hotel_email text
)
language plpgsql
security definer set search_path = public
as $$
declare
  booking record;
  existing_delivery public.guest_email_deliveries;
  new_delivery_id uuid;
begin
  select r.id, r.hotel_id, r.status, r.reservation_number, r.check_in_date,
    r.check_out_date, g.full_name, g.email, rt.name as room_type_name,
    rm.room_number, h.trading_name, hs.standard_check_in_time,
    hs.phone as hotel_phone, hs.email as hotel_email,
    public.hotel_business_date(r.hotel_id) as business_date
  into booking
  from public.reservations r
  join public.guests g on g.id = r.guest_id and g.hotel_id = r.hotel_id
  join public.room_types rt on rt.id = r.room_type_id and rt.hotel_id = r.hotel_id
  join public.hotels h on h.id = r.hotel_id
  left join public.rooms rm on rm.id = r.room_id and rm.hotel_id = r.hotel_id
  left join public.hotel_settings hs on hs.hotel_id = r.hotel_id
  where r.id = target_reservation_id
  for update of r;

  if not found then raise exception 'Reservation not found'; end if;
  if not public.has_hotel_permission(booking.hotel_id, 'reservations.manage') then
    raise exception 'Not authorised to send guest arrival emails';
  end if;
  if booking.status not in ('pending', 'confirmed') then
    raise exception 'Arrival emails are only available for pending or confirmed reservations';
  end if;
  if booking.check_in_date < booking.business_date then
    raise exception 'Arrival emails are not available for past arrivals';
  end if;
  if nullif(trim(booking.email), '') is null then
    raise exception 'This guest does not have an email address on file';
  end if;

  select * into existing_delivery
  from public.guest_email_deliveries d
  where d.reservation_id = booking.id and d.check_in_date = booking.check_in_date
    and d.status in ('sending', 'sent')
  for update;

  if found and existing_delivery.status = 'sent' then
    raise exception 'Arrival email has already been sent for this reservation';
  elsif found and existing_delivery.created_at > now() - interval '5 minutes' then
    raise exception 'Arrival email is already being sent; please wait a moment';
  elsif found then
    update public.guest_email_deliveries d
    set status = 'sending', recipient_email = trim(booking.email),
      created_by = auth.uid(), created_at = now(), updated_at = now(),
      provider_http_status = null
    where d.id = existing_delivery.id
    returning d.id into new_delivery_id;
  else
    insert into public.guest_email_deliveries (
      hotel_id, reservation_id, check_in_date, recipient_email, status, created_by
    ) values (
      booking.hotel_id, booking.id, booking.check_in_date, trim(booking.email), 'sending', auth.uid()
    ) returning id into new_delivery_id;
  end if;

  return query select new_delivery_id, booking.trading_name, booking.full_name,
    trim(booking.email), booking.reservation_number, booking.room_type_name,
    booking.room_number, booking.check_in_date, booking.check_out_date,
    booking.standard_check_in_time, booking.hotel_phone, booking.hotel_email;
end;
$$;

create or replace function public.complete_guest_arrival_email(
  target_delivery_id uuid,
  provider_message_id_value text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare delivery public.guest_email_deliveries;
begin
  select * into delivery from public.guest_email_deliveries
  where id = target_delivery_id for update;
  if not found or delivery.status <> 'sending' or delivery.created_by <> auth.uid() then
    raise exception 'Arrival email delivery is not active for this user';
  end if;
  if not public.has_hotel_permission(delivery.hotel_id, 'reservations.manage') then
    raise exception 'Not authorised to complete guest email delivery';
  end if;

  update public.guest_email_deliveries
  set status = 'sent', provider_message_id = provider_message_id_value,
    sent_at = now(), updated_at = now()
  where id = delivery.id;
  perform public.log_activity(delivery.hotel_id, 'reservation.arrival_email_sent',
    'reservation', delivery.reservation_id,
    jsonb_build_object('delivery_id', delivery.id, 'recipient_email', delivery.recipient_email,
      'check_in_date', delivery.check_in_date, 'provider_message_id', provider_message_id_value));
end;
$$;

create or replace function public.fail_guest_arrival_email(
  target_delivery_id uuid,
  provider_http_status_value integer default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare delivery public.guest_email_deliveries;
begin
  select * into delivery from public.guest_email_deliveries
  where id = target_delivery_id for update;
  if not found or delivery.status <> 'sending' or delivery.created_by <> auth.uid() then
    raise exception 'Arrival email delivery is not active for this user';
  end if;
  if not public.has_hotel_permission(delivery.hotel_id, 'reservations.manage') then
    raise exception 'Not authorised to update guest email delivery';
  end if;

  update public.guest_email_deliveries
  set status = 'failed', provider_http_status = provider_http_status_value,
    updated_at = now()
  where id = delivery.id;
  perform public.log_activity(delivery.hotel_id, 'reservation.arrival_email_failed',
    'reservation', delivery.reservation_id,
    jsonb_build_object('delivery_id', delivery.id, 'provider_http_status', provider_http_status_value));
end;
$$;

revoke all on function public.claim_guest_arrival_email(uuid),
  public.complete_guest_arrival_email(uuid, text),
  public.fail_guest_arrival_email(uuid, integer) from public, anon;
grant execute on function public.claim_guest_arrival_email(uuid),
  public.complete_guest_arrival_email(uuid, text),
  public.fail_guest_arrival_email(uuid, integer) to authenticated;
