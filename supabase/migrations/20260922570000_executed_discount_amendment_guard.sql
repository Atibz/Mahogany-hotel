-- An executed approval remains valid for that exact reservation, standard
-- rate, and agreed rate. This permits later date-only amendments while a room
-- or rate change still requires a new approval.

create or replace function public.enforce_reservation_discount_limit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare standard_rate bigint;
begin
  select coalesce(r.rate_override_kobo, rt.base_rate_kobo)
  into standard_rate
  from public.room_types rt
  left join public.rooms r on r.id = new.room_id and r.room_type_id = rt.id
  where rt.id = new.room_type_id and rt.hotel_id = new.hotel_id;

  if standard_rate is null or standard_rate <= 0 then
    raise exception 'A valid standard room rate is required';
  end if;
  if new.agreed_rate_kobo < 0 then raise exception 'Rate cannot be negative'; end if;

  if new.agreed_rate_kobo * 100 < standard_rate * 80 and not exists (
    select 1
    from public.finance_approval_requests far
    where far.hotel_id = new.hotel_id
      and far.action_type = 'reservation_discount'
      and far.target_entity_type = 'reservation'
      and far.target_entity_id = new.id
      and far.status in ('approved', 'executed')
      and (far.payload->>'requested_rate_kobo')::bigint = new.agreed_rate_kobo
      and (far.payload->>'standard_rate_kobo')::bigint = standard_rate
  ) then
    raise exception 'Discounts above 20%% require an approved GM or Owner request';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_reservation_discount_limit()
from public, anon, authenticated;
