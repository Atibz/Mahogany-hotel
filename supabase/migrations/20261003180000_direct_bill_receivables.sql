-- Convert approved company credit into a distinct accounts-receivable balance.
-- A direct-bill allocation settles the guest folio without pretending cash was paid.

insert into public.permissions (code, name, description) values
  ('receivables.read', 'View company receivables', 'View direct-bill invoices and outstanding company balances.'),
  ('receivables.settle', 'Settle company receivables', 'Record verified settlement of company receivables.')
on conflict (code) do nothing;

create table public.business_account_receivables (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  receivable_number text not null,
  business_account_id uuid not null references public.business_accounts(id) on delete restrict,
  authorization_id uuid not null unique references public.reservation_business_account_authorizations(id) on delete restrict,
  folio_id uuid not null unique references public.guest_folios(id) on delete restrict,
  invoice_id uuid unique references public.invoices(id) on delete restrict,
  due_date date not null,
  status text not null default 'open' check (status in ('open', 'partially_settled', 'settled', 'voided')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (hotel_id, receivable_number)
);

create table public.business_account_receivable_allocations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  receivable_id uuid not null references public.business_account_receivables(id) on delete restrict,
  folio_id uuid not null references public.guest_folios(id) on delete restrict,
  amount_kobo bigint not null check (amount_kobo > 0),
  reason text not null check (length(trim(reason)) > 0),
  allocated_by uuid references public.profiles(id) on delete set null,
  allocated_at timestamptz not null default now()
);

create index business_receivables_account_due_idx on public.business_account_receivables(business_account_id, status, due_date);
create index business_receivable_allocations_folio_idx on public.business_account_receivable_allocations(folio_id);

alter table public.business_account_receivables enable row level security;
alter table public.business_account_receivable_allocations enable row level security;
revoke all on public.business_account_receivables, public.business_account_receivable_allocations from public, anon, authenticated;
grant select on public.business_account_receivables, public.business_account_receivable_allocations to authenticated;
create policy business_receivables_read on public.business_account_receivables for select to authenticated
using (public.has_hotel_permission(hotel_id, 'receivables.read'));
create policy business_receivable_allocations_read on public.business_account_receivable_allocations for select to authenticated
using (public.has_hotel_permission(hotel_id, 'receivables.read'));

create or replace function public.folio_balance(target_folio_id uuid)
returns bigint
language sql
stable
security definer set search_path = public
as $$
  select coalesce(sum(case when fi.status = 'posted' then fi.total_amount_kobo else 0 end), 0)
    - coalesce((select sum(pa.amount_kobo) from public.payment_allocations pa
               join public.payments p on p.id = pa.payment_id
               where pa.folio_id = target_folio_id and p.status in ('completed', 'refunded')), 0)
    + coalesce((select sum(pr.amount_kobo) from public.payment_refunds pr where pr.folio_id = target_folio_id), 0)
    - coalesce((select sum(bara.amount_kobo) from public.business_account_receivable_allocations bara
               join public.business_account_receivables bar on bar.id = bara.receivable_id
               where bara.folio_id = target_folio_id and bar.status <> 'voided'), 0)
  from public.folio_items fi where fi.folio_id = target_folio_id;
$$;

create or replace function public.prepare_departure_folio(target_stay_id uuid)
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare
  target_stay public.stays; target_folio_id uuid; date_to_post date; through_date date;
  created_count integer := 0; post_result record; final_balance bigint;
  direct_authorization public.reservation_business_account_authorizations;
  target_account public.business_accounts; new_receivable_id uuid; allocated_total bigint;
begin
  select * into target_stay from public.stays where id = target_stay_id for update;
  if not found then raise exception 'Stay not found'; end if;
  if not public.has_hotel_permission(target_stay.hotel_id, 'departures.checkout') then raise exception 'Not authorised to prepare a departure folio'; end if;
  if target_stay.status <> 'checked_in' then raise exception 'Only an active stay can be prepared for checkout'; end if;
  select gf.id into target_folio_id from public.guest_folios gf where gf.stay_id = target_stay.id and gf.status = 'open' for update;
  if target_folio_id is null then raise exception 'Open folio not found'; end if;

  through_date := public.hotel_business_date(target_stay.hotel_id);
  date_to_post := target_stay.actual_check_in_date;
  while date_to_post <= through_date loop
    select * into post_result from public.post_occupied_room_night_for_audit(target_stay.id, date_to_post);
    if post_result.created then created_count := created_count + 1; end if;
    date_to_post := date_to_post + 1;
  end loop;

  final_balance := public.folio_balance(target_folio_id);
  select a.* into direct_authorization
  from public.reservation_business_account_authorizations a
  where a.reservation_id = target_stay.reservation_id and a.status = 'active' and a.billing_mode = 'direct_bill'
  for update;
  if found and final_balance > 0 then
    select * into target_account from public.business_accounts where id = direct_authorization.business_account_id for update;
    select coalesce(sum(amount_kobo), 0) into allocated_total
    from public.business_account_receivable_allocations where receivable_id = (
      select id from public.business_account_receivables where authorization_id = direct_authorization.id
    );
    if allocated_total + final_balance > direct_authorization.authorized_amount_kobo then
      raise exception 'Final folio exceeds the approved direct-bill amount by % kobo', allocated_total + final_balance - direct_authorization.authorized_amount_kobo;
    end if;
    select id into new_receivable_id from public.business_account_receivables where authorization_id = direct_authorization.id for update;
    if new_receivable_id is null then
      insert into public.business_account_receivables (
        hotel_id, receivable_number, business_account_id, authorization_id, folio_id, due_date, created_by
      ) values (
        target_stay.hotel_id, public.next_document_number(target_stay.hotel_id, 'AR'), target_account.id,
        direct_authorization.id, target_folio_id, through_date + target_account.payment_terms_days, auth.uid()
      ) returning id into new_receivable_id;
    end if;
    insert into public.business_account_receivable_allocations (hotel_id, receivable_id, folio_id, amount_kobo, reason, allocated_by)
    values (target_stay.hotel_id, new_receivable_id, target_folio_id, final_balance, 'Approved direct-bill transfer at final folio preparation', auth.uid());
    perform public.log_activity(target_stay.hotel_id, 'receivable.allocated', 'business_account_receivable', new_receivable_id,
      jsonb_build_object('folio_id', target_folio_id, 'amount_kobo', final_balance, 'authorization_id', direct_authorization.id));
    final_balance := public.folio_balance(target_folio_id);
  end if;

  perform public.log_activity(target_stay.hotel_id, 'stay.departure_folio_prepared', 'stay', target_stay.id,
    jsonb_build_object('folio_id', target_folio_id, 'through_business_date', through_date,
      'room_nights_created', created_count, 'balance_kobo', final_balance));
  return final_balance;
end;
$$;

create or replace function public.complete_departure_checkout(
  target_stay_id uuid, room_charges_confirmed boolean, incidental_charges_confirmed boolean,
  key_return_confirmed boolean, guest_details_confirmed boolean, checkout_notes text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare target_stay public.stays; target_folio_id uuid; created_invoice_id uuid; receivable_record public.business_account_receivables; account_record public.business_accounts;
begin
  select * into target_stay from public.stays where id = target_stay_id for update;
  if not found then raise exception 'Stay not found'; end if;
  if not public.has_hotel_permission(target_stay.hotel_id, 'departures.checkout') then raise exception 'Not authorised to complete guest checkout'; end if;
  if not coalesce(room_charges_confirmed, false) or not coalesce(incidental_charges_confirmed, false)
     or not coalesce(key_return_confirmed, false) or not coalesce(guest_details_confirmed, false) then
    raise exception 'Every checkout confirmation must be completed';
  end if;
  select gf.id into target_folio_id from public.guest_folios gf where gf.stay_id = target_stay.id and gf.status = 'open' for update;
  if target_folio_id is null then raise exception 'Open folio not found'; end if;
  if exists (select 1 from public.payment_allocations pa join public.payments p on p.id = pa.payment_id
             where pa.folio_id = target_folio_id and p.status = 'pending_verification') then
    raise exception 'A pending payment must be verified or rejected before checkout';
  end if;
  created_invoice_id := public.checkout_stay(target_stay.id, public.hotel_business_date(target_stay.hotel_id));

  select * into receivable_record from public.business_account_receivables where folio_id = target_folio_id for update;
  if found then
    select * into account_record from public.business_accounts where id = receivable_record.business_account_id;
    update public.business_account_receivables set invoice_id = created_invoice_id where id = receivable_record.id;
    update public.invoices set snapshot = snapshot || jsonb_build_object('business_billing', jsonb_build_object(
      'receivable_id', receivable_record.id, 'receivable_number', receivable_record.receivable_number,
      'business_account_id', account_record.id, 'account_number', account_record.account_number,
      'account_name', coalesce(account_record.trading_name, account_record.legal_name),
      'amount_kobo', (select coalesce(sum(amount_kobo), 0) from public.business_account_receivable_allocations where receivable_id = receivable_record.id),
      'due_date', receivable_record.due_date
    )) where id = created_invoice_id;
    update public.reservation_business_account_authorizations
    set status = 'released', ended_by = auth.uid(), ended_at = now(), end_reason = 'Converted to receivable ' || receivable_record.receivable_number
    where id = receivable_record.authorization_id and status = 'active';
  end if;
  perform public.log_activity(target_stay.hotel_id, 'stay.checkout_checklist_completed', 'stay', target_stay.id,
    jsonb_build_object('invoice_id', created_invoice_id, 'folio_id', target_folio_id, 'room_charges_confirmed', room_charges_confirmed,
      'incidental_charges_confirmed', incidental_charges_confirmed, 'key_return_confirmed', key_return_confirmed,
      'guest_details_confirmed', guest_details_confirmed, 'notes', nullif(trim(checkout_notes), ''),
      'receivable_id', receivable_record.id));
  return created_invoice_id;
end;
$$;

create or replace function public.get_business_receivables(target_hotel_id uuid)
returns table (
  receivable_id uuid, receivable_number text, account_number text, account_name text,
  invoice_number text, folio_number text, principal_kobo bigint, outstanding_kobo bigint,
  due_date date, days_overdue integer, status text, created_at timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.has_hotel_permission(target_hotel_id, 'receivables.read') then raise exception 'Not authorised to view receivables'; end if;
  return query select bar.id, bar.receivable_number, ba.account_number, coalesce(ba.trading_name, ba.legal_name),
    i.invoice_number, gf.folio_number,
    coalesce((select sum(a.amount_kobo) from public.business_account_receivable_allocations a where a.receivable_id = bar.id), 0)::bigint,
    coalesce((select sum(a.amount_kobo) from public.business_account_receivable_allocations a where a.receivable_id = bar.id), 0)::bigint,
    bar.due_date, greatest(public.hotel_business_date(target_hotel_id) - bar.due_date, 0), bar.status, bar.created_at
  from public.business_account_receivables bar
  join public.business_accounts ba on ba.id = bar.business_account_id
  join public.guest_folios gf on gf.id = bar.folio_id
  left join public.invoices i on i.id = bar.invoice_id
  where bar.hotel_id = target_hotel_id order by bar.due_date, bar.created_at;
end;
$$;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on
  (r.code in ('general_manager', 'accountant') and p.code = 'receivables.read')
  or (r.code = 'accountant' and p.code = 'receivables.settle')
on conflict do nothing;

create or replace function public.provision_business_account_permissions(target_hotel_id uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id from public.roles r join public.permissions p on (
    (r.code = 'general_manager' and p.code in ('business_accounts.read', 'business_accounts.manage', 'business_accounts.assign', 'business_accounts.authorize_credit', 'receivables.read'))
    or (r.code = 'accountant' and p.code in ('business_accounts.read', 'receivables.read', 'receivables.settle'))
    or (r.code = 'receptionist' and p.code = 'business_accounts.assign')
  ) where r.hotel_id = target_hotel_id on conflict do nothing;
$$;

revoke all on function public.get_business_receivables(uuid), public.provision_business_account_permissions(uuid) from public, anon;
grant execute on function public.get_business_receivables(uuid) to authenticated;
