-- Include exceptional reservation discounts in the existing finance approval
-- register so management can trace the reservation and approved rate.

create or replace function public.get_finance_approval_register(
  target_hotel_id uuid,
  target_from_date date default null,
  target_to_date date default null
)
returns table (
  request_id uuid,
  action_type text,
  status text,
  target_document text,
  amount_kobo bigint,
  reference text,
  description text,
  reason text,
  requested_by_name text,
  requested_at timestamptz,
  expires_at timestamptz,
  decided_by_name text,
  decided_at timestamptz,
  decision_note text,
  executed_by_name text,
  executed_at timestamptz
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  hotel_timezone text;
  from_date date;
  to_date date;
begin
  if not public.has_hotel_permission(target_hotel_id, 'finance_approvals.read') then
    raise exception 'Not authorised to view the finance approval register';
  end if;

  select h.timezone into hotel_timezone from public.hotels h where h.id = target_hotel_id;
  if hotel_timezone is null then raise exception 'Hotel not found'; end if;
  to_date := coalesce(target_to_date, public.hotel_business_date(target_hotel_id));
  from_date := coalesce(target_from_date, to_date - 89);
  if from_date > to_date then raise exception 'Report start date must not be after the end date'; end if;

  return query
  select
    far.id,
    far.action_type,
    far.status,
    case far.target_entity_type
      when 'payment' then (select p.payment_number from public.payments p where p.id = far.target_entity_id)
      when 'folio' then (select gf.folio_number from public.guest_folios gf where gf.id = far.target_entity_id)
      when 'folio_item' then (select gf.folio_number || ' / ' || fi.description from public.folio_items fi join public.guest_folios gf on gf.id = fi.folio_id where fi.id = far.target_entity_id)
      when 'reservation' then (select r.reservation_number from public.reservations r where r.id = far.target_entity_id)
    end,
    case far.action_type
      when 'refund_payment' then (far.payload->>'amount_kobo')::bigint
      when 'folio_adjustment' then abs((far.payload->>'amount_kobo')::bigint)
      when 'void_payment' then (select p.amount_kobo from public.payments p where p.id = far.target_entity_id)
      when 'reverse_folio_item' then (select abs(fi.total_amount_kobo) from public.folio_items fi where fi.id = far.target_entity_id)
      when 'reservation_discount' then (far.payload->>'standard_rate_kobo')::bigint - (far.payload->>'requested_rate_kobo')::bigint
    end,
    coalesce(far.payload->>'reference', (select p.reference from public.payments p where p.id = far.target_entity_id and far.target_entity_type = 'payment')),
    case
      when far.action_type = 'reservation_discount' then
        'Exceptional nightly discount ' ||
        trim(to_char((far.payload->>'discount_basis_points')::numeric / 100, 'FM999990.00')) || '%'
      else coalesce(far.payload->>'description', (select fi.description from public.folio_items fi where fi.id = far.target_entity_id and far.target_entity_type = 'folio_item'))
    end,
    far.reason,
    requester.full_name,
    far.requested_at,
    far.expires_at,
    approver.full_name,
    far.decided_at,
    far.decision_note,
    executor.full_name,
    far.executed_at
  from public.finance_approval_requests far
  left join public.profiles requester on requester.id = far.requested_by
  left join public.profiles approver on approver.id = far.decided_by
  left join public.profiles executor on executor.id = far.executed_by
  where far.hotel_id = target_hotel_id
    and (far.requested_at at time zone hotel_timezone)::date between from_date and to_date
  order by far.requested_at desc
  limit 500;
end;
$$;

revoke all on function public.get_finance_approval_register(uuid, date, date) from public, anon;
grant execute on function public.get_finance_approval_register(uuid, date, date) to authenticated;
