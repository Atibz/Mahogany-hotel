-- Immutable daily-close report snapshot. Open-day previews use the same
-- builder, while closed dates always return their stored snapshot.

create or replace function public.build_business_day_close_snapshot(
  target_hotel_id uuid,
  target_business_date date
)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  hotel_timezone text;
begin
  select timezone into hotel_timezone from public.hotels where id = target_hotel_id;
  if hotel_timezone is null then raise exception 'Hotel not found'; end if;

  return jsonb_build_object(
    'hotel', (select jsonb_build_object('legal_name', h.legal_name, 'trading_name', h.trading_name, 'address_line_1', h.address_line_1, 'address_line_2', h.address_line_2, 'city', h.city, 'state_region', h.state_region) from public.hotels h where h.id = target_hotel_id),
    'business_date', target_business_date,
    'operations', jsonb_build_object(
      'scheduled_arrivals', (select count(*) from public.reservations r where r.hotel_id = target_hotel_id and r.check_in_date = target_business_date and r.status in ('pending', 'confirmed')),
      'checked_in_arrivals', (select count(*) from public.stays s where s.hotel_id = target_hotel_id and s.actual_check_in_date = target_business_date),
      'scheduled_departures', (select count(*) from public.stays s where s.hotel_id = target_hotel_id and s.expected_check_out_date = target_business_date),
      'checked_out_departures', (select count(*) from public.stays s where s.hotel_id = target_hotel_id and s.actual_check_out_date = target_business_date),
      'no_shows', (select count(*) from public.reservations r where r.hotel_id = target_hotel_id and r.check_in_date = target_business_date and r.status = 'no_show'),
      'in_house_at_close', (select count(*) from public.stays s where s.hotel_id = target_hotel_id and s.status = 'checked_in')
    ),
    'night_audit', coalesce((select to_jsonb(npr) - 'hotel_id' - 'initiated_by' from public.nightly_posting_runs npr where npr.hotel_id = target_hotel_id and npr.service_date = target_business_date), '{}'::jsonb),
    'revenue_by_department', coalesce((select jsonb_agg(to_jsonb(x)) from public.get_daily_revenue_by_department(target_hotel_id, target_business_date) x), '[]'::jsonb),
    'tax_breakdown', coalesce((select jsonb_agg(to_jsonb(x)) from public.get_daily_tax_breakdown(target_hotel_id, target_business_date) x), '[]'::jsonb),
    'payments_by_method', coalesce((select jsonb_agg(to_jsonb(x)) from public.get_daily_payment_reconciliation(target_hotel_id, target_business_date) x), '[]'::jsonb),
    'cashier_shifts', coalesce((select jsonb_agg(jsonb_build_object('shift_number', cs.shift_number, 'status', cs.status, 'opening_float_kobo', cs.opening_float_kobo, 'expected_cash_kobo', cs.expected_cash_kobo, 'declared_cash_kobo', cs.declared_cash_kobo, 'variance_kobo', cs.variance_kobo, 'handover_reference', cs.handover_reference)) from public.cashier_shifts cs where cs.hotel_id = target_hotel_id and cs.business_date = target_business_date), '[]'::jsonb),
    'corrections', coalesce((select jsonb_agg(jsonb_build_object('item_type', fi.item_type, 'description', fi.description, 'amount_kobo', fi.total_amount_kobo, 'reason', fi.reason)) from public.folio_items fi where fi.hotel_id = target_hotel_id and fi.item_type in ('adjustment', 'reversal') and (fi.posted_at at time zone hotel_timezone)::date = target_business_date), '[]'::jsonb),
    'liabilities', coalesce((select jsonb_agg(to_jsonb(x)) from public.get_deposit_guest_credit_liabilities(target_hotel_id) x), '[]'::jsonb),
    'outstanding_folios', coalesce((select jsonb_agg(jsonb_build_object('folio_number', gf.folio_number, 'balance_kobo', public.folio_balance(gf.id))) from public.guest_folios gf where gf.hotel_id = target_hotel_id and gf.status = 'open' and public.folio_balance(gf.id) <> 0), '[]'::jsonb),
    'acknowledgements', coalesce((select jsonb_agg(jsonb_build_object('exception_code', a.exception_code, 'record_count', a.record_count, 'reason', a.reason, 'acknowledged_at', a.acknowledged_at, 'acknowledged_by_name', p.full_name)) from public.night_audit_acknowledgements a left join public.profiles p on p.id = a.acknowledged_by where a.hotel_id = target_hotel_id and a.business_date = target_business_date), '[]'::jsonb)
  );
end;
$$;

create or replace function public.close_current_business_day(target_hotel_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  report_date date := public.hotel_business_date(target_hotel_id);
  status_record record;
  close_id uuid;
  document_number text;
  close_snapshot jsonb;
begin
  if not public.is_hotel_owner_or_gm(target_hotel_id) then raise exception 'Only the Owner or General Manager may close the business day'; end if;
  perform 1 from public.hotels where id = target_hotel_id for update;
  if exists (select 1 from public.business_day_closes where hotel_id = target_hotel_id and business_date = report_date) then raise exception 'This business day is already closed'; end if;
  select * into status_record from public.get_business_day_close_status(target_hotel_id);
  if status_record.posting_status is distinct from 'completed' then raise exception 'Complete the night-audit posting before close'; end if;
  if status_record.open_cashier_shifts > 0 then raise exception 'Close every cashier shift before business-day close'; end if;
  if status_record.pending_payment_verification > 0 then raise exception 'Verify or reject every pending payment before business-day close'; end if;
  if not status_record.overdue_acknowledged then raise exception 'Acknowledge the current overdue departures with a reason'; end if;
  if not status_record.folios_acknowledged then raise exception 'Acknowledge the current unsettled folios with a reason'; end if;

  document_number := public.next_document_number(target_hotel_id, 'DAC');
  close_snapshot := public.build_business_day_close_snapshot(target_hotel_id, report_date)
    || jsonb_build_object('close_number', document_number, 'closed_at', now(), 'closed_by', auth.uid(), 'closed_by_name', (select full_name from public.profiles where id = auth.uid()));
  insert into public.business_day_closes (hotel_id, business_date, close_number, snapshot, closed_by)
  values (target_hotel_id, report_date, document_number, close_snapshot, auth.uid()) returning id into close_id;
  perform public.log_activity(target_hotel_id, 'business_day.closed', 'business_day_close', close_id, jsonb_build_object('business_date', report_date, 'close_number', document_number));
  return close_id;
end;
$$;

create or replace function public.get_business_day_close_report(target_hotel_id uuid, target_business_date date default null)
returns table (report jsonb, is_closed boolean)
language plpgsql stable security definer set search_path = public as $$
declare report_date date := coalesce(target_business_date, public.hotel_business_date(target_hotel_id));
begin
  if not public.has_hotel_permission(target_hotel_id, 'night_audit.read') then raise exception 'Not authorised to view the daily-close report'; end if;
  if exists (select 1 from public.business_day_closes b where b.hotel_id = target_hotel_id and b.business_date = report_date) then
    return query select b.snapshot, true from public.business_day_closes b where b.hotel_id = target_hotel_id and b.business_date = report_date;
  elsif report_date = public.hotel_business_date(target_hotel_id) then
    return query select public.build_business_day_close_snapshot(target_hotel_id, report_date), false;
  else
    raise exception 'No immutable close report exists for this business date';
  end if;
end;
$$;

revoke all on function public.build_business_day_close_snapshot(uuid, date), public.get_business_day_close_report(uuid, date) from public, anon;
grant execute on function public.get_business_day_close_report(uuid, date) to authenticated;
