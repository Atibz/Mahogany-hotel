-- Repair historical payments created before per-payment receipt issuance was enabled.
-- Each eligible payment receives exactly one new receipt record; no payment is changed.

create or replace function public.issue_missing_payment_receipts(target_hotel_id uuid default null)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  payment_record record;
  created_count integer := 0;
  receipt_number text;
begin
  if auth.uid() is not null then
    if target_hotel_id is null or not public.has_hotel_permission(target_hotel_id, 'payments.create') then
      raise exception 'Not authorised to issue missing payment receipts';
    end if;
  end if;

  for payment_record in
    select p.id as payment_id, p.hotel_id, pa.folio_id
    from public.payments p
    join public.payment_allocations pa on pa.payment_id = p.id
    where p.status in ('completed', 'refunded')
      and (target_hotel_id is null or p.hotel_id = target_hotel_id)
      and not exists (select 1 from public.receipts r where r.payment_id = p.id)
    order by p.received_at, p.id
  loop
    receipt_number := public.next_document_number(payment_record.hotel_id, 'RCP');
    insert into public.receipts (hotel_id, receipt_number, folio_id, payment_id, issued_by)
    values (payment_record.hotel_id, receipt_number, payment_record.folio_id, payment_record.payment_id, auth.uid())
    on conflict (payment_id) do nothing;
    if found then
      created_count := created_count + 1;
      perform public.log_activity(payment_record.hotel_id, 'receipt.issued_for_historical_payment', 'receipt', payment_record.payment_id,
        jsonb_build_object('payment_id', payment_record.payment_id, 'folio_id', payment_record.folio_id, 'receipt_number', receipt_number));
    end if;
  end loop;
  return created_count;
end;
$$;

-- This migration is safe after a partial run: existing receipt rows are skipped.
select public.issue_missing_payment_receipts();

revoke all on function public.issue_missing_payment_receipts(uuid) from public;
grant execute on function public.issue_missing_payment_receipts(uuid) to authenticated;
