-- An immutable close creates one private email job. No browser role can read
-- jobs, recipient details or delivery failures. Sending is done server-side.
create table public.owner_daily_close_email_jobs (
  id uuid primary key default gen_random_uuid(),
  close_id uuid not null unique references public.business_day_closes(id) on delete restrict,
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index owner_daily_close_email_jobs_pending_idx
  on public.owner_daily_close_email_jobs(next_attempt_at, created_at)
  where status <> 'sent';

alter table public.owner_daily_close_email_jobs enable row level security;
revoke all on public.owner_daily_close_email_jobs from public, anon, authenticated;
grant select, update on public.owner_daily_close_email_jobs to service_role;

create or replace function public.enqueue_owner_daily_close_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.owner_daily_close_email_jobs(close_id, hotel_id)
  values (new.id, new.hotel_id);
  return new;
end;
$$;

create trigger enqueue_owner_daily_close_email_after_close
after insert on public.business_day_closes
for each row execute function public.enqueue_owner_daily_close_email();

create or replace function public.claim_owner_daily_close_email()
returns setof public.owner_daily_close_email_jobs
language sql security definer set search_path = public as $$
  update public.owner_daily_close_email_jobs job
  set status = 'sending', attempts = attempts + 1,
      locked_until = now() + interval '5 minutes', last_error = null
  where job.id = (
    select candidate.id from public.owner_daily_close_email_jobs candidate
    where candidate.next_attempt_at <= now()
      and (candidate.status = 'pending'
        or (candidate.status = 'sending' and candidate.locked_until < now()))
    order by candidate.created_at
    for update skip locked limit 1
  )
  returning job.*;
$$;

revoke all on function public.enqueue_owner_daily_close_email(),
  public.claim_owner_daily_close_email() from public, anon, authenticated;
grant execute on function public.claim_owner_daily_close_email() to service_role;

-- Separate businesses are never folded into hotel revenue. These are
-- collections/refunds and paid expenses by business, as recorded when sent.
create function public.get_owner_private_daily_movements(target_hotel_id uuid, target_date date)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'outlet_collections', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.business) from (
        select event.business,
          sum(event.collected_kobo)::bigint as collected_kobo,
          sum(event.refunded_kobo)::bigint as refunded_kobo
        from (
          select o.outlet_type::text as business, p.amount_kobo as collected_kobo, 0::bigint as refunded_kobo
          from public.pos_order_payments p
          join public.pos_outlets o on o.id = p.outlet_id and o.hotel_id = p.hotel_id
          where p.hotel_id = target_hotel_id and p.status = 'completed'
            and public.hotel_business_date(target_hotel_id, p.received_at) = target_date
            and o.outlet_type in ('restaurant', 'bar')
          union all
          select o.outlet_type::text, 0::bigint, r.amount_kobo
          from public.pos_order_refunds r
          join public.pos_outlets o on o.id = r.outlet_id and o.hotel_id = r.hotel_id
          where r.hotel_id = target_hotel_id
            and public.hotel_business_date(target_hotel_id, r.refunded_at) = target_date
            and o.outlet_type in ('restaurant', 'bar')
        ) event
        group by event.business
      ) x
    ), '[]'::jsonb),
    'paid_expenses', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.business) from (
        select e.department::text as business,
          sum(e.amount_kobo)::bigint as amount_kobo,
          count(*)::bigint as expense_count
        from public.internal_expense_funding f
        join public.operating_expenses e on e.id = f.expense_id and e.hotel_id = f.hotel_id
        where f.hotel_id = target_hotel_id and f.paid_on = target_date
        group by e.department
      ) x
    ), '[]'::jsonb),
    'reconciliation_status', coalesce((
      select r.status::text from public.internal_daily_reconciliations r
      where r.hotel_id = target_hotel_id and r.business_date = target_date
      order by r.submitted_at desc, r.id desc limit 1
    ), 'not submitted')
  );
$$;
revoke all on function public.get_owner_private_daily_movements(uuid, date) from public, anon, authenticated;
grant execute on function public.get_owner_private_daily_movements(uuid, date) to service_role;
