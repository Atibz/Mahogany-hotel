-- A cash count is not complete until the physical funds have a traceable
-- handover reference and an independent manager review.

alter table public.cashier_shifts
  add column if not exists handover_reference text,
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_notes text;

alter table public.cashier_shifts
  drop constraint if exists cashier_shifts_closed_handover_check;
alter table public.cashier_shifts
  add constraint cashier_shifts_closed_handover_check
  check (status <> 'closed' or nullif(trim(handover_reference), '') is not null)
  not valid;

drop function if exists public.close_cashier_shift(uuid, bigint, text);

create or replace function public.close_cashier_shift(
  target_cashier_shift_id uuid,
  declared_cash_value_kobo bigint,
  variance_reason_value text default null,
  handover_reference_value text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare target_shift public.cashier_shifts; calculated_expected bigint; calculated_variance bigint; can_manage boolean;
begin
  select * into target_shift from public.cashier_shifts where id = target_cashier_shift_id for update;
  if not found then raise exception 'Cashier shift not found'; end if;
  if auth.uid() is null or not public.has_hotel_permission(target_shift.hotel_id, 'cashier_shifts.close') then raise exception 'Not authorised to close a cashier shift'; end if;
  can_manage := public.has_hotel_permission(target_shift.hotel_id, 'cashier_shifts.manage');
  if target_shift.opened_by <> auth.uid() and not can_manage then raise exception 'You may only close your own cashier shift'; end if;
  if target_shift.status <> 'open' then raise exception 'This cashier shift is already closed'; end if;
  if declared_cash_value_kobo < 0 then raise exception 'Declared cash cannot be negative'; end if;
  if nullif(trim(handover_reference_value), '') is null then raise exception 'A cash handover or bank-deposit reference is required'; end if;
  calculated_expected := public.cashier_shift_expected_cash(target_shift.id);
  calculated_variance := declared_cash_value_kobo - calculated_expected;
  if calculated_variance <> 0 and nullif(trim(variance_reason_value), '') is null then raise exception 'A reason is required when declared cash differs from expected cash'; end if;
  update public.cashier_shifts
  set status = 'closed', expected_cash_kobo = calculated_expected, declared_cash_kobo = declared_cash_value_kobo,
      variance_kobo = calculated_variance, variance_reason = nullif(trim(variance_reason_value), ''),
      handover_reference = trim(handover_reference_value), closed_by = auth.uid(), closed_at = now()
  where id = target_shift.id;
  perform public.log_activity(target_shift.hotel_id, 'cashier_shift.closed', 'cashier_shift', target_shift.id,
    jsonb_build_object('expected_cash_kobo', calculated_expected, 'declared_cash_kobo', declared_cash_value_kobo,
      'variance_kobo', calculated_variance, 'variance_reason', nullif(trim(variance_reason_value), ''),
      'handover_reference', trim(handover_reference_value)));
end;
$$;

create or replace function public.review_cashier_shift(target_cashier_shift_id uuid, review_notes_value text default null)
returns void
language plpgsql
security definer set search_path = public
as $$
declare target_shift public.cashier_shifts;
begin
  select * into target_shift from public.cashier_shifts where id = target_cashier_shift_id for update;
  if not found then raise exception 'Cashier shift not found'; end if;
  if not public.has_hotel_permission(target_shift.hotel_id, 'cashier_shifts.manage') then raise exception 'Not authorised to review cashier shifts'; end if;
  if target_shift.status <> 'closed' then raise exception 'Only closed cashier shifts can be reviewed'; end if;
  if target_shift.reviewed_at is not null then raise exception 'This cashier shift has already been reviewed'; end if;
  if target_shift.opened_by = auth.uid() or target_shift.closed_by = auth.uid() then raise exception 'A cashier shift must be reviewed by someone other than the opener and closer'; end if;
  if target_shift.variance_kobo <> 0 and nullif(trim(review_notes_value), '') is null then raise exception 'A manager review note is required for a cash variance'; end if;
  update public.cashier_shifts
  set reviewed_by = auth.uid(), reviewed_at = now(), review_notes = nullif(trim(review_notes_value), '')
  where id = target_shift.id;
  perform public.log_activity(target_shift.hotel_id, 'cashier_shift.reviewed', 'cashier_shift', target_shift.id,
    jsonb_build_object('variance_kobo', target_shift.variance_kobo, 'handover_reference', target_shift.handover_reference,
      'review_notes', nullif(trim(review_notes_value), '')));
end;
$$;

create or replace function public.get_cashier_shift_history(target_hotel_id uuid)
returns table (
  id uuid,
  shift_number text,
  business_date date,
  status text,
  opening_float_kobo bigint,
  expected_cash_kobo bigint,
  declared_cash_kobo bigint,
  variance_kobo bigint,
  variance_reason text,
  handover_reference text,
  opened_at timestamptz,
  closed_at timestamptz,
  opened_by_name text,
  reviewed_at timestamptz,
  reviewed_by_name text,
  review_notes text
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'cashier_shifts.read') then raise exception 'Not authorised to view cashier shifts'; end if;
  return query
  select cs.id, cs.shift_number, cs.business_date, cs.status, cs.opening_float_kobo, cs.expected_cash_kobo,
    cs.declared_cash_kobo, cs.variance_kobo, cs.variance_reason, cs.handover_reference, cs.opened_at, cs.closed_at,
    opener.full_name, cs.reviewed_at, reviewer.full_name, cs.review_notes
  from public.cashier_shifts cs
  join public.profiles opener on opener.id = cs.opened_by
  left join public.profiles reviewer on reviewer.id = cs.reviewed_by
  where cs.hotel_id = target_hotel_id
  order by cs.opened_at desc
  limit 100;
end;
$$;

revoke all on function public.close_cashier_shift(uuid, bigint, text, text), public.review_cashier_shift(uuid, text), public.get_cashier_shift_history(uuid) from public, anon;
grant execute on function public.close_cashier_shift(uuid, bigint, text, text), public.review_cashier_shift(uuid, text), public.get_cashier_shift_history(uuid) to authenticated;
