-- Folio readers need enough context to identify a payment without receiving
-- general access to guest, stay, or room records.
-- Also reconcile the standard finance-role grant in databases initially
-- populated by the development seed after role provisioning ran.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'folios.read'
where r.code in ('accountant', 'cashier')
on conflict do nothing;

create function public.get_folio_context(
  target_hotel_id uuid,
  target_folio_ids uuid[]
)
returns table (
  folio_id uuid,
  stay_id uuid,
  guest_name text,
  room_number text
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'folios.read') then
    raise exception 'Not authorised to view folio context';
  end if;
  if coalesce(array_length(target_folio_ids, 1), 0) > 500 then
    raise exception 'Too many folios requested';
  end if;

  return query
    select gf.id, s.id, g.full_name, r.room_number
    from public.guest_folios gf
    join public.stays s on s.id = gf.stay_id and s.hotel_id = gf.hotel_id
    join public.guests g on g.id = s.guest_id and g.hotel_id = gf.hotel_id
    join public.rooms r on r.id = s.room_id and r.hotel_id = gf.hotel_id
    where gf.hotel_id = target_hotel_id
      and gf.id = any(target_folio_ids);
end;
$$;

revoke all on function public.get_folio_context(uuid, uuid[]) from public, anon;
grant execute on function public.get_folio_context(uuid, uuid[]) to authenticated;
