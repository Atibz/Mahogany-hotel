-- Evidence of the hotel later passing an outlet's share to that independent
-- business. This records an external transfer; it neither initiates money
-- movement nor creates a second guest collection or outlet sale.
create table public.combined_guest_payment_settlements (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null,
  order_id uuid not null,
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  amount_kobo bigint not null check (amount_kobo > 0),
  evidence_reference text not null check (length(trim(evidence_reference)) between 3 and 200),
  note text not null check (length(trim(note)) between 3 and 500),
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  foreign key (payment_id, order_id)
    references public.combined_guest_payment_orders(payment_id, order_id) on delete restrict,
  unique (hotel_id, evidence_reference, order_id)
);
create index combined_guest_settlements_payment_idx
  on public.combined_guest_payment_settlements(payment_id, order_id);
alter table public.combined_guest_payment_settlements enable row level security;
revoke all on public.combined_guest_payment_settlements from public, anon, authenticated;

create table public.combined_guest_payment_settlement_reversals (
  settlement_id uuid primary key references public.combined_guest_payment_settlements(id) on delete restrict,
  evidence_reference text not null check (length(trim(evidence_reference)) between 3 and 200),
  note text not null check (length(trim(note)) between 10 and 500),
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now()
);
alter table public.combined_guest_payment_settlement_reversals enable row level security;
revoke all on public.combined_guest_payment_settlement_reversals from public, anon, authenticated;

create function public.record_combined_guest_payment_settlement(
  target_payment_id uuid, target_order_id uuid, amount_value_kobo bigint,
  evidence_value text, note_value text
) returns uuid language plpgsql security definer set search_path = public as $$
declare allocation public.combined_guest_payment_orders;
  payment_record public.payments; combined_record public.combined_guest_payments;
  already_settled bigint; result_id uuid;
begin
  select * into allocation from public.combined_guest_payment_orders
    where payment_id = target_payment_id and order_id = target_order_id for update;
  if not found then raise exception 'Choose an outlet order linked to this combined payment'; end if;
  if not exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.profile_id = auth.uid() and r.hotel_id = allocation.hotel_id and r.code = 'accountant') then
    raise exception 'Only the accountant may record an internal outlet settlement';
  end if;
  select * into payment_record from public.payments where id = target_payment_id for update;
  select * into combined_record from public.combined_guest_payments where payment_id = target_payment_id;
  if payment_record.status <> 'completed' or combined_record.review_status <> 'confirmed' then
    raise exception 'Verify the guest payment and confirm the phone approval before documenting settlement';
  end if;
  if exists (select 1 from public.finance_approval_requests r
      where r.action_type = 'combined_payment_refund'
        and r.target_entity_id = target_payment_id
        and r.status in ('pending', 'approved') and r.expires_at > now()) then
    raise exception 'Resolve the pending full-refund request before documenting outlet settlement';
  end if;
  if amount_value_kobo is null or amount_value_kobo <= 0 then
    raise exception 'Enter a positive amount passed to the outlet';
  end if;
  if coalesce(length(trim(evidence_value)), 0) not between 3 and 200
      or coalesce(length(trim(note_value)), 0) not between 3 and 500 then
    raise exception 'Record the actual transfer evidence and note';
  end if;
  select coalesce(sum(s.amount_kobo), 0) into already_settled
    from public.combined_guest_payment_settlements s
    where s.payment_id = target_payment_id and s.order_id = target_order_id
      and not exists (select 1 from public.combined_guest_payment_settlement_reversals v
        where v.settlement_id = s.id);
  if amount_value_kobo > allocation.amount_kobo - already_settled then
    raise exception 'Settlement exceeds the outlet amount still held by hotel';
  end if;
  insert into public.combined_guest_payment_settlements(payment_id, order_id,
    hotel_id, amount_kobo, evidence_reference, note, recorded_by)
  values(target_payment_id, target_order_id, allocation.hotel_id,
    amount_value_kobo, trim(evidence_value), trim(note_value), auth.uid())
  returning id into result_id;
  perform public.log_activity(allocation.hotel_id, 'payment.combined_outlet_settled',
    'combined_guest_payment_settlement', result_id,
    jsonb_build_object('payment_id', target_payment_id, 'order_id', target_order_id,
      'outlet_id', allocation.outlet_id, 'amount_kobo', amount_value_kobo,
      'evidence_reference', trim(evidence_value)));
  return result_id;
end; $$;

create function public.reverse_combined_guest_payment_settlement(
  target_settlement_id uuid, evidence_value text, note_value text
) returns void language plpgsql security definer set search_path = public as $$
declare settlement public.combined_guest_payment_settlements;
begin
  select * into settlement from public.combined_guest_payment_settlements
    where id = target_settlement_id for update;
  if not found then raise exception 'Outlet settlement not found'; end if;
  if not exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.profile_id = auth.uid() and r.hotel_id = settlement.hotel_id and r.code = 'accountant') then
    raise exception 'Only the accountant may record an outlet settlement reversal';
  end if;
  if coalesce(length(trim(evidence_value)), 0) not between 3 and 200
      or coalesce(length(trim(note_value)), 0) not between 10 and 500 then
    raise exception 'Record the actual return evidence and reason';
  end if;
  insert into public.combined_guest_payment_settlement_reversals
    (settlement_id, evidence_reference, note, recorded_by)
  values (target_settlement_id, trim(evidence_value), trim(note_value), auth.uid());
  perform public.log_activity(settlement.hotel_id, 'payment.combined_outlet_settlement_reversed',
    'combined_guest_payment_settlement', target_settlement_id,
    jsonb_build_object('payment_id', settlement.payment_id, 'order_id', settlement.order_id,
      'amount_kobo', settlement.amount_kobo, 'evidence_reference', trim(evidence_value)));
end; $$;

-- A guest refund after the outlet share has actually left the hotel needs an
-- independently documented reversal first. Never let an approval bypass this.
create function public.guard_combined_refund_after_outlet_settlement()
returns trigger language plpgsql set search_path = public as $$
declare target_payment_id uuid;
begin
  if tg_table_name = 'finance_approval_requests' then
    if new.action_type <> 'combined_payment_refund' then return new; end if;
    target_payment_id := new.target_entity_id;
  else
    target_payment_id := new.payment_id;
  end if;
  if exists (select 1 from public.combined_guest_payment_settlements s
      where s.payment_id = target_payment_id and not exists
        (select 1 from public.combined_guest_payment_settlement_reversals v
          where v.settlement_id = s.id)) then
    raise exception 'Outlet settlement is already documented; reverse it with the outlet before a full guest refund';
  end if;
  return new;
end; $$;
create trigger guard_combined_refund_request_after_settlement
before insert on public.finance_approval_requests
for each row execute function public.guard_combined_refund_after_outlet_settlement();
create trigger guard_combined_refund_execution_after_settlement
before insert on public.payment_refunds
for each row execute function public.guard_combined_refund_after_outlet_settlement();

create or replace function public.get_combined_guest_payments(target_hotel_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'payments.read')
      and not public.has_hotel_permission(target_hotel_id, 'payments.create') then
    raise exception 'Not authorised to view combined payments';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'payment_id', c.payment_id, 'payment_number', p.payment_number,
    'received_at', p.received_at, 'status', p.status, 'reference', p.reference,
    'amount_kobo', p.amount_kobo, 'hotel_amount_kobo', c.hotel_amount_kobo,
    'folio_id', c.folio_id, 'folio_number', f.folio_number,
    'reason', c.reason, 'verbal_approver_name', c.verbal_approver_name,
    'review_status', c.review_status, 'review_note', c.review_note,
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
      'order_id', a.order_id, 'order_number', o.order_number,
      'outlet_name', a.outlet_name_snapshot, 'amount_kobo', a.amount_kobo,
      'settled_kobo', coalesce((select sum(s.amount_kobo)
        from public.combined_guest_payment_settlements s
        where s.payment_id = a.payment_id and s.order_id = a.order_id
          and not exists (select 1 from public.combined_guest_payment_settlement_reversals v
            where v.settlement_id = s.id)), 0),
      'settlements', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'amount_kobo', s.amount_kobo,
        'evidence_reference', s.evidence_reference,
        'reversed', v.settlement_id is not null) order by s.recorded_at)
        from public.combined_guest_payment_settlements s
        left join public.combined_guest_payment_settlement_reversals v on v.settlement_id = s.id
        where s.payment_id = a.payment_id and s.order_id = a.order_id), '[]'::jsonb))
      order by o.order_number) from public.combined_guest_payment_orders a
      join public.pos_orders o on o.id = a.order_id where a.payment_id = c.payment_id), '[]'::jsonb)
  ) order by p.received_at desc) from public.combined_guest_payments c
    join public.payments p on p.id = c.payment_id
    join public.guest_folios f on f.id = c.folio_id
    where c.hotel_id = target_hotel_id
      and (c.collected_by = auth.uid() or public.has_hotel_permission(target_hotel_id, 'payments.read'))), '[]'::jsonb);
end; $$;

revoke all on function public.record_combined_guest_payment_settlement(uuid,uuid,bigint,text,text),
  public.reverse_combined_guest_payment_settlement(uuid,text,text),
  public.get_combined_guest_payments(uuid),
  public.guard_combined_refund_after_outlet_settlement() from public, anon, authenticated;
grant execute on function public.record_combined_guest_payment_settlement(uuid,uuid,bigint,text,text),
  public.reverse_combined_guest_payment_settlement(uuid,text,text),
  public.get_combined_guest_payments(uuid) to authenticated;
notify pgrst, 'reload schema';
