-- Keep the guest's single hotel-side collection distinct from outlet receipts.
-- The outlet allocation is a liability/settlement item, not a second payment.
alter function public.build_internal_reconciliation_source(uuid, date)
  rename to build_internal_reconciliation_source_before_combined;
revoke all on function public.build_internal_reconciliation_source_before_combined(uuid, date)
  from public, anon, authenticated;

create function public.build_internal_reconciliation_source(target_hotel_id uuid, date_value date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare source_data jsonb; unsettled_count bigint; outlet_liability bigint;
begin
  source_data := public.build_internal_reconciliation_source_before_combined(target_hotel_id, date_value);
  select count(*) into unsettled_count from public.combined_guest_payments c
    join public.payments p on p.id = c.payment_id
    where c.hotel_id = target_hotel_id
      and public.hotel_business_date(target_hotel_id, p.received_at) = date_value
      and p.status in ('completed', 'pending_verification')
      and c.review_status <> 'confirmed';
  select coalesce(sum(a.amount_kobo), 0) into outlet_liability
    from public.combined_guest_payment_orders a
    join public.payments p on p.id = a.payment_id
    where a.hotel_id = target_hotel_id and p.status = 'completed'
      and public.hotel_business_date(target_hotel_id, p.received_at) = date_value;
  return jsonb_set(
    jsonb_set(source_data, '{blockers,unconfirmed_combined_payments}', to_jsonb(unsettled_count), true),
    '{hotel_collected_for_outlets_kobo}', to_jsonb(outlet_liability), true
  );
end; $$;
revoke all on function public.build_internal_reconciliation_source(uuid,date)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
