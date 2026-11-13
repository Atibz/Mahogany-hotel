-- A missed manual close cannot create the normal Owner report job. Queue one
-- private alert for the most recently completed hotel-calendar business date.
-- The scheduler calls this only with a service-role key; no staff role can see
-- the queue or discover the private report recipient from it.
create table public.owner_missing_close_alert_jobs (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  business_date date not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'resolved')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (hotel_id, business_date)
);

create index owner_missing_close_alert_jobs_pending_idx
  on public.owner_missing_close_alert_jobs(next_attempt_at, created_at)
  where status in ('pending', 'sending');

alter table public.owner_missing_close_alert_jobs enable row level security;
revoke all on public.owner_missing_close_alert_jobs from public, anon, authenticated;
grant select, update on public.owner_missing_close_alert_jobs to service_role;

create function public.claim_owner_missing_close_alert()
returns setof public.owner_missing_close_alert_jobs
language plpgsql security definer set search_path = public as $$
begin
  -- Use the physical hotel calendar, not the operating date advanced by an
  -- early close. Before the cutoff, yesterday's operating date is still due.
  insert into public.owner_missing_close_alert_jobs (hotel_id, business_date)
  select h.id, public.hotel_calendar_business_date(h.id, now()) - 1
  from public.hotels h
  join public.hotel_settings hs on hs.hotel_id = h.id
  where h.active
    and (h.created_at at time zone h.timezone)::date
      <= public.hotel_calendar_business_date(h.id, now()) - 1
    and not exists (
      select 1 from public.business_day_closes c
      where c.hotel_id = h.id
        and c.business_date = public.hotel_calendar_business_date(h.id, now()) - 1
    )
  on conflict (hotel_id, business_date) do nothing;

  -- A late close before delivery makes the pending warning obsolete. Sent
  -- warnings remain in history; they are never rewritten as if unsent.
  update public.owner_missing_close_alert_jobs j set status = 'resolved',
    locked_until = null
  where j.status = 'pending'
    and exists (
      select 1 from public.business_day_closes c
      where c.hotel_id = j.hotel_id and c.business_date = j.business_date
    );

  return query
  update public.owner_missing_close_alert_jobs j
  set status = 'sending', attempts = attempts + 1,
      locked_until = now() + interval '5 minutes', last_error = null
  where j.id = (
    select candidate.id from public.owner_missing_close_alert_jobs candidate
    where candidate.next_attempt_at <= now()
      and (candidate.status = 'pending'
        or (candidate.status = 'sending' and candidate.locked_until < now()))
      and not exists (
        select 1 from public.business_day_closes c
        where c.hotel_id = candidate.hotel_id
          and c.business_date = candidate.business_date
      )
    order by candidate.created_at
    for update skip locked limit 1
  )
  returning j.*;
end;
$$;

revoke all on function public.claim_owner_missing_close_alert()
  from public, anon, authenticated;
grant execute on function public.claim_owner_missing_close_alert() to service_role;
