-- Read-only operational exceptions for management before night audit.
create or replace function public.get_night_audit_exceptions(target_hotel_id uuid)
returns table(exception_code text, exception_label text, record_count bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'night_audit.read') then raise exception 'Not authorised to view night-audit exceptions'; end if;
  return query
  select 'open_cashier_shifts', 'Open cashier shifts', count(*) from public.cashier_shifts where hotel_id = target_hotel_id and status = 'open'
  union all
  select 'pending_payment_verification', 'Payments awaiting verification', count(*) from public.payments where hotel_id = target_hotel_id and status = 'pending_verification'
  union all
  select 'unsettled_open_folios', 'Open folios with balance due', count(*) from public.guest_folios gf where gf.hotel_id = target_hotel_id and gf.status = 'open' and public.folio_balance(gf.id) <> 0
  union all
  select 'failed_night_audits', 'Failed night-audit runs', count(*) from public.nightly_posting_runs where hotel_id = target_hotel_id and status = 'failed';
end; $$;
revoke all on function public.get_night_audit_exceptions(uuid) from public, anon;
grant execute on function public.get_night_audit_exceptions(uuid) to authenticated;
