-- Room-linked outlet orders remain Restaurant/Bar sales. Linking makes an
-- unpaid order visible to Reception and prevents a guest leaving unnoticed;
-- it does not post an outlet sale to the hotel folio or hotel revenue.
create unique index stays_id_hotel_for_pos_fk on public.stays(id, hotel_id);

alter table public.pos_orders
  add column stay_id uuid,
  add column room_number_snapshot text,
  add constraint pos_orders_room_link_consistent
    check ((stay_id is null) = (room_number_snapshot is null)),
  add constraint pos_orders_stay_hotel_fk
    foreign key (stay_id, hotel_id) references public.stays(id, hotel_id) on delete restrict;

create index pos_orders_linked_stay_idx on public.pos_orders(stay_id, created_at)
  where stay_id is not null;

-- Narrow lookup: outlet staff may verify one specified occupied room, not
-- browse the hotel guest register or access a different outlet's orders.
create function public.get_pos_room_occupant(target_outlet_id uuid, requested_room_number text)
returns table(stay_id uuid, room_number text, guest_name text)
language plpgsql stable security definer set search_path = public as $$
declare outlet_record public.pos_outlets;
begin
  select * into outlet_record from public.pos_outlets
  where id = target_outlet_id and active and outlet_type in ('restaurant', 'bar');
  if not found or not public.has_pos_outlet_permission(outlet_record.hotel_id, outlet_record.id, 'create') then
    raise exception 'Not authorised to verify a room for this outlet';
  end if;
  if nullif(trim(requested_room_number), '') is null or length(trim(requested_room_number)) > 30 then
    raise exception 'Enter a valid room number';
  end if;
  return query
  select s.id, r.room_number, g.full_name
  from public.rooms r
  join public.stays s on s.room_id = r.id and s.hotel_id = r.hotel_id and s.status = 'checked_in'
  join public.guests g on g.id = s.guest_id and g.hotel_id = s.hotel_id
  where r.hotel_id = outlet_record.hotel_id and r.room_number = trim(requested_room_number)
  limit 1;
end;
$$;

-- One transaction creates and links the order. Recheck the stay under lock:
-- a room transfer or checkout since the lookup must reject the stale choice.
create function public.create_room_linked_pos_order(
  target_outlet_id uuid, service_mode_value text, table_reference_value text,
  guest_label_value text, target_stay_id uuid, requested_room_number text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare outlet_record public.pos_outlets; stay_record record; new_order_id uuid;
begin
  select * into outlet_record from public.pos_outlets
  where id = target_outlet_id and active and outlet_type in ('restaurant', 'bar');
  if not found or not public.has_pos_outlet_permission(outlet_record.hotel_id, outlet_record.id, 'create') then
    raise exception 'Not authorised to open an order for this outlet';
  end if;
  select s.id, r.room_number, g.full_name into stay_record
  from public.stays s
  join public.rooms r on r.id = s.room_id and r.hotel_id = s.hotel_id
  join public.guests g on g.id = s.guest_id and g.hotel_id = s.hotel_id
  where s.id = target_stay_id and s.hotel_id = outlet_record.hotel_id
    and s.status = 'checked_in' and r.room_number = trim(requested_room_number)
  for update of s;
  if not found then raise exception 'Room occupant changed or checked out. Verify the room again'; end if;

  new_order_id := public.create_restaurant_pos_order(
    target_outlet_id, service_mode_value, table_reference_value,
    coalesce(nullif(trim(guest_label_value), ''), stay_record.full_name)
  );
  update public.pos_orders set stay_id = stay_record.id,
    room_number_snapshot = stay_record.room_number where id = new_order_id;
  perform public.log_activity(outlet_record.hotel_id, 'pos.order_linked_to_stay',
    'pos_order', new_order_id, jsonb_build_object('stay_id', stay_record.id,
      'room_number', stay_record.room_number, 'outlet_id', target_outlet_id));
  return new_order_id;
end;
$$;

-- Reception sees only outstanding/pending linked orders, not outlet menu or
-- unrelated customer sales. Completed combined-payment allocations count as
-- settlement through pos_order_totals, but pending verification does not.
create function public.get_room_pos_checkout_holds(target_hotel_id uuid)
returns table(stay_id uuid, order_id uuid, order_number text, outlet_name text,
  department_code text, gross_kobo bigint, completed_kobo bigint,
  pending_kobo bigint, balance_kobo bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'departures.checkout') then
    raise exception 'Not authorised to view room-order checkout holds';
  end if;
  return query
  select o.stay_id, o.id, o.order_number, o.outlet_name_snapshot,
    o.department_code_snapshot, t.gross_total_kobo,
    (t.completed_kobo - refunds.refunded_kobo)::bigint,
    t.pending_kobo,
    greatest(t.gross_total_kobo - t.completed_kobo + refunds.refunded_kobo, 0)::bigint
  from public.pos_orders o
  join public.stays s on s.id = o.stay_id and s.hotel_id = o.hotel_id
  cross join lateral public.pos_order_totals(o.id) t
  cross join lateral (select coalesce(sum(r.amount_kobo), 0)::bigint as refunded_kobo
    from public.pos_order_refunds r where r.order_id = o.id) refunds
  where o.hotel_id = target_hotel_id and s.status = 'checked_in'
    and o.status <> 'voided'
    and (t.gross_total_kobo > t.completed_kobo - refunds.refunded_kobo or t.pending_kobo > 0)
  order by o.created_at, o.id;
end;
$$;

-- This guard is at the state transition, so the checklist or an alternative
-- checkout RPC cannot bypass an unpaid linked order. A zero-line draft does
-- not hold checkout; adding lines after the stay ends is prohibited below.
create function public.prevent_checkout_with_unsettled_room_pos()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.pos_orders o
    cross join lateral public.pos_order_totals(o.id) t
    cross join lateral (select coalesce(sum(r.amount_kobo), 0)::bigint as refunded_kobo
      from public.pos_order_refunds r where r.order_id = o.id) refunds
    where o.stay_id = new.id and o.hotel_id = new.hotel_id and o.status <> 'voided'
      and (t.gross_total_kobo > t.completed_kobo - refunds.refunded_kobo or t.pending_kobo > 0)
  ) then
    raise exception 'Room has unsettled Restaurant or Bar orders. Settle or verify them before checkout';
  end if;
  return new;
end;
$$;

create trigger prevent_checkout_with_unsettled_room_pos
before update of status on public.stays
for each row when (old.status = 'checked_in' and new.status = 'checked_out')
execute function public.prevent_checkout_with_unsettled_room_pos();

create function public.prevent_room_pos_items_after_checkout()
returns trigger language plpgsql security definer set search_path = public as $$
declare stay_status public.stay_status;
begin
  -- Lock the stay so inserting a line and checkout cannot race each other.
  select s.status into stay_status from public.pos_orders o
  join public.stays s on s.id = o.stay_id
  where o.id = new.order_id for update of s;
  if found and stay_status <> 'checked_in' then
    raise exception 'Cannot add items to a room order after the guest checked out';
  end if;
  return new;
end;
$$;

create trigger prevent_room_pos_items_after_checkout
before insert on public.pos_order_lines
for each row execute function public.prevent_room_pos_items_after_checkout();

revoke all on function public.get_pos_room_occupant(uuid, text),
  public.create_room_linked_pos_order(uuid, text, text, text, uuid, text),
  public.get_room_pos_checkout_holds(uuid),
  public.prevent_checkout_with_unsettled_room_pos(),
  public.prevent_room_pos_items_after_checkout() from public, anon, authenticated;
grant execute on function public.get_pos_room_occupant(uuid, text),
  public.create_room_linked_pos_order(uuid, text, text, text, uuid, text),
  public.get_room_pos_checkout_holds(uuid) to authenticated;
