-- Deposit history is available only in the context of a reservation, including
-- to reception staff who are authorised to receive its deposit.

create or replace function public.get_reservation_deposit_history(target_reservation_id uuid)
returns table (deposit_id uuid, receipt_number text, payment_number text, amount_kobo bigint, payment_method_name text, reference text, status public.payment_status, received_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare target_hotel_id uuid;
begin
  select hotel_id into target_hotel_id from public.reservations where id = target_reservation_id;
  if target_hotel_id is null then raise exception 'Reservation not found'; end if;
  if not (public.has_hotel_permission(target_hotel_id, 'deposits.read') or public.has_hotel_permission(target_hotel_id, 'deposits.create')) then raise exception 'Not authorised to view reservation deposits'; end if;
  return query select rd.id, rd.receipt_number, p.payment_number, p.amount_kobo, pm.name, p.reference, p.status, rd.received_at
  from public.reservation_deposits rd join public.payments p on p.id = rd.payment_id join public.payment_methods pm on pm.id = p.payment_method_id
  where rd.reservation_id = target_reservation_id order by rd.received_at desc;
end;
$$;

revoke all on function public.get_reservation_deposit_history(uuid) from public, anon;
grant execute on function public.get_reservation_deposit_history(uuid) to authenticated;
