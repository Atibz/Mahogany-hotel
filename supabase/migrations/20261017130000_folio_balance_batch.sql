-- Return balances for a page of folios in one database round trip. The
-- caller must have folio read access to the hotel, and IDs cannot escape it.
create function public.get_folio_balances(
  target_hotel_id uuid,
  target_folio_ids uuid[]
)
returns table (folio_id uuid, balance_kobo bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'folios.read') then
    raise exception 'Not authorised to view folio balances';
  end if;
  if coalesce(array_length(target_folio_ids, 1), 0) > 500 then
    raise exception 'Too many folios requested';
  end if;
  return query
    select gf.id, public.folio_balance(gf.id)
    from public.guest_folios gf
    where gf.hotel_id = target_hotel_id and gf.id = any(target_folio_ids);
end;
$$;

revoke all on function public.get_folio_balances(uuid, uuid[]) from public, anon;
grant execute on function public.get_folio_balances(uuid, uuid[]) to authenticated;
