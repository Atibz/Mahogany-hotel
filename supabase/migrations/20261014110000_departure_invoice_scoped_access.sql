-- Reception can retrieve the invoice produced by their own controlled
-- departure, without granting hotel-wide invoice browsing permission.
create or replace function public.get_checkout_invoice(target_invoice_id uuid)
returns table (
  invoice_id uuid,
  invoice_number text,
  issued_at timestamptz,
  hotel_name text,
  snapshot jsonb
)
language plpgsql stable security definer set search_path = public
as $$
declare
  target_hotel_id uuid;
  invoice_issuer_id uuid;
begin
  select i.hotel_id, i.issued_by
  into target_hotel_id, invoice_issuer_id
  from public.invoices i
  where i.id = target_invoice_id;

  if target_hotel_id is null then raise exception 'Invoice not found'; end if;
  if not public.has_hotel_permission(target_hotel_id, 'invoices.read')
     and not (
       public.has_hotel_permission(target_hotel_id, 'departures.checkout')
       and invoice_issuer_id = auth.uid()
     ) then
    raise exception 'Not authorised to view this invoice';
  end if;

  return query
  select i.id, i.invoice_number, i.issued_at, h.trading_name, i.snapshot
  from public.invoices i
  join public.hotels h on h.id = i.hotel_id
  where i.id = target_invoice_id;
end;
$$;

revoke all on function public.get_checkout_invoice(uuid) from public, anon;
grant execute on function public.get_checkout_invoice(uuid) to authenticated;
