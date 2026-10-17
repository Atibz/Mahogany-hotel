-- Controlled business-day close. Posting remains idempotent and may be
-- automated, but the final close requires an Owner/GM review.

create table public.night_audit_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  business_date date not null,
  exception_code text not null check (exception_code in ('overdue_departures', 'unsettled_open_folios')),
  record_count bigint not null check (record_count > 0),
  reason text not null check (length(trim(reason)) > 0),
  acknowledged_by uuid references public.profiles(id) on delete set null,
  acknowledged_at timestamptz not null default now(),
  unique (hotel_id, business_date, exception_code)
);

create table public.business_day_closes (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  business_date date not null,
  close_number text not null,
  snapshot jsonb not null,
  closed_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz not null default now(),
  unique (hotel_id, business_date),
  unique (hotel_id, close_number)
);

create index night_audit_acknowledgements_hotel_date_idx
  on public.night_audit_acknowledgements(hotel_id, business_date);
create index business_day_closes_hotel_date_idx
  on public.business_day_closes(hotel_id, business_date desc);

create or replace function public.is_hotel_owner_or_gm(target_hotel_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    join public.profiles p on p.id = ur.profile_id
    where ur.profile_id = auth.uid() and r.hotel_id = target_hotel_id
      and r.code in ('owner', 'general_manager') and r.active and p.active
  );
$$;

create or replace function public.acknowledge_night_audit_exception(
  target_hotel_id uuid,
  target_exception_code text,
  acknowledgement_reason text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  report_date date := public.hotel_business_date(target_hotel_id);
  current_count bigint;
begin
  if not public.is_hotel_owner_or_gm(target_hotel_id) then
    raise exception 'Only the Owner or General Manager may acknowledge a night-audit exception';
  end if;
  if target_exception_code not in ('overdue_departures', 'unsettled_open_folios') then
    raise exception 'This exception must be resolved and cannot be acknowledged';
  end if;
  if nullif(trim(acknowledgement_reason), '') is null then
    raise exception 'An acknowledgement reason is required';
  end if;

  if target_exception_code = 'overdue_departures' then
    select count(*) into current_count from public.stays
    where hotel_id = target_hotel_id and status = 'checked_in'
      and expected_check_out_date < report_date;
  else
    select count(*) into current_count from public.guest_folios gf
    where gf.hotel_id = target_hotel_id and gf.status = 'open'
      and public.folio_balance(gf.id) <> 0;
  end if;
  if current_count = 0 then raise exception 'This exception no longer requires acknowledgement'; end if;

  insert into public.night_audit_acknowledgements
    (hotel_id, business_date, exception_code, record_count, reason, acknowledged_by)
  values
    (target_hotel_id, report_date, target_exception_code, current_count, trim(acknowledgement_reason), auth.uid())
  on conflict (hotel_id, business_date, exception_code) do update
  set record_count = excluded.record_count, reason = excluded.reason,
      acknowledged_by = excluded.acknowledged_by, acknowledged_at = now();

  perform public.log_activity(target_hotel_id, 'night_audit.exception_acknowledged',
    'hotel', target_hotel_id, jsonb_build_object('business_date', report_date,
      'exception_code', target_exception_code, 'record_count', current_count,
      'reason', trim(acknowledgement_reason)));
end;
$$;

create or replace function public.get_business_day_close_status(target_hotel_id uuid)
returns table (
  business_date date, posting_status text, open_cashier_shifts bigint,
  pending_payment_verification bigint, overdue_departures bigint,
  unsettled_open_folios bigint, overdue_acknowledged boolean,
  folios_acknowledged boolean, can_close boolean, close_number text,
  closed_at timestamptz, closed_by_name text
)
language plpgsql stable security definer set search_path = public as $$
declare report_date date := public.hotel_business_date(target_hotel_id);
begin
  if not public.has_hotel_permission(target_hotel_id, 'night_audit.read') then
    raise exception 'Not authorised to view business-day close status';
  end if;
  return query
  with counts as (
    select
      (select npr.status::text from public.nightly_posting_runs npr where npr.hotel_id = target_hotel_id and npr.service_date = report_date) as posting_status,
      (select count(*) from public.cashier_shifts cs where cs.hotel_id = target_hotel_id and cs.status = 'open') as open_shifts,
      (select count(*) from public.payments p where p.hotel_id = target_hotel_id and p.status = 'pending_verification') as pending_payments,
      (select count(*) from public.stays s where s.hotel_id = target_hotel_id and s.status = 'checked_in' and s.expected_check_out_date < report_date) as overdue,
      (select count(*) from public.guest_folios gf where gf.hotel_id = target_hotel_id and gf.status = 'open' and public.folio_balance(gf.id) <> 0) as unsettled
  ), state as (
    select c.*,
      (c.overdue = 0 or exists (select 1 from public.night_audit_acknowledgements a where a.hotel_id = target_hotel_id and a.business_date = report_date and a.exception_code = 'overdue_departures' and a.record_count = c.overdue)) as overdue_ack,
      (c.unsettled = 0 or exists (select 1 from public.night_audit_acknowledgements a where a.hotel_id = target_hotel_id and a.business_date = report_date and a.exception_code = 'unsettled_open_folios' and a.record_count = c.unsettled)) as folios_ack
    from counts c
  )
  select report_date, s.posting_status, s.open_shifts, s.pending_payments,
    s.overdue, s.unsettled, s.overdue_ack, s.folios_ack,
    (s.posting_status = 'completed' and s.open_shifts = 0 and s.pending_payments = 0 and s.overdue_ack and s.folios_ack),
    bdc.close_number, bdc.closed_at, closer.full_name
  from state s
  left join public.business_day_closes bdc on bdc.hotel_id = target_hotel_id and bdc.business_date = report_date
  left join public.profiles closer on closer.id = bdc.closed_by;
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
  if not public.is_hotel_owner_or_gm(target_hotel_id) then
    raise exception 'Only the Owner or General Manager may close the business day';
  end if;
  perform 1 from public.hotels where id = target_hotel_id for update;
  if exists (select 1 from public.business_day_closes where hotel_id = target_hotel_id and business_date = report_date) then
    raise exception 'This business day is already closed';
  end if;
  select * into status_record from public.get_business_day_close_status(target_hotel_id);
  if status_record.posting_status is distinct from 'completed' then raise exception 'Complete the night-audit posting before close'; end if;
  if status_record.open_cashier_shifts > 0 then raise exception 'Close every cashier shift before business-day close'; end if;
  if status_record.pending_payment_verification > 0 then raise exception 'Verify or reject every pending payment before business-day close'; end if;
  if not status_record.overdue_acknowledged then raise exception 'Acknowledge the current overdue departures with a reason'; end if;
  if not status_record.folios_acknowledged then raise exception 'Acknowledge the current unsettled folios with a reason'; end if;

  document_number := public.next_document_number(target_hotel_id, 'DAC');
  close_snapshot := jsonb_build_object(
    'business_date', report_date,
    'posting_status', status_record.posting_status,
    'open_cashier_shifts', status_record.open_cashier_shifts,
    'pending_payment_verification', status_record.pending_payment_verification,
    'overdue_departures', status_record.overdue_departures,
    'unsettled_open_folios', status_record.unsettled_open_folios,
    'acknowledgements', coalesce((select jsonb_agg(to_jsonb(a) - 'id' - 'hotel_id') from public.night_audit_acknowledgements a where a.hotel_id = target_hotel_id and a.business_date = report_date), '[]'::jsonb)
  );
  insert into public.business_day_closes
    (hotel_id, business_date, close_number, snapshot, closed_by)
  values (target_hotel_id, report_date, document_number, close_snapshot, auth.uid())
  returning id into close_id;
  perform public.log_activity(target_hotel_id, 'business_day.closed', 'business_day_close', close_id,
    jsonb_build_object('business_date', report_date, 'close_number', document_number));
  return close_id;
end;
$$;

revoke all on public.night_audit_acknowledgements, public.business_day_closes from public, anon, authenticated;
grant select on public.night_audit_acknowledgements, public.business_day_closes to authenticated;
alter table public.night_audit_acknowledgements enable row level security;
alter table public.business_day_closes enable row level security;
create policy night_audit_acknowledgements_read on public.night_audit_acknowledgements for select to authenticated
using (public.has_hotel_permission(hotel_id, 'night_audit.read'));
create policy business_day_closes_read on public.business_day_closes for select to authenticated
using (public.has_hotel_permission(hotel_id, 'night_audit.read'));

revoke all on function public.is_hotel_owner_or_gm(uuid),
  public.acknowledge_night_audit_exception(uuid, text, text),
  public.get_business_day_close_status(uuid),
  public.close_current_business_day(uuid) from public, anon;
grant execute on function public.get_business_day_close_status(uuid) to authenticated;
grant execute on function public.acknowledge_night_audit_exception(uuid, text, text),
  public.close_current_business_day(uuid) to authenticated;
