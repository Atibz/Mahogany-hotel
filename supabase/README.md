# Supabase database setup

This folder is the source of truth for database changes. Apply migrations in timestamp
order; never edit a migration that has been deployed to a shared environment.

## Before running the application

1. Create a Supabase project in the desired region.
2. In Supabase Auth, disable public sign-ups. Staff accounts must be provisioned by an
   authorised administrator.
3. Add the project URL and publishable key to a local `.env`, using `.env.example` as the
   template. Do not expose a service-role key to the frontend.
4. Apply every file under `migrations/` in timestamp order. With a linked project, use
   `supabase db push`; do not paste only a subset of the migration history into a new
   project.
5. For a disposable local database, run `supabase db reset`. The CLI applies every
   migration first and loads `seed.sql` last. Never run the development seed in staging or
   production.
6. Create the first owner account through Supabase Auth's administrative interface, then
   assign its role through the SQL editor:

```sql
insert into public.user_roles (profile_id, role_id)
select p.id, r.id
from public.profiles p
join auth.users u on u.id = p.id
join public.roles r on r.hotel_id = (select id from public.hotels order by created_at limit 1)
where u.email = 'owner@example.com'
  and r.code = 'owner';
```

Replace `owner@example.com` with the real owner account. Use the correct hotel ID if a
future deployment contains more than one hotel. The role-provisioning migration creates
the standard roles for every hotel and gives the assigned Owner full access to that hotel.

## Development seed data

`seed.sql` runs automatically after all migrations during `supabase db reset`. It creates
the development hotel configuration plus three room types, eight rooms, five fictional
guests, five relative-date reservation scenarios, and one open maintenance ticket. Demo
emails use the reserved `.test` domain, no Auth users are created, and no role is assigned
to a real person.

The fixture records use reserved UUIDs and document numbers beginning with `DEMO-` so
they are easy to identify. The reservation dates are calculated from the hotel's business
date whenever a clean reset is performed. Do not run `seed.sql` against staging or
production; create staff test accounts through the Auth invitation workflow instead.

## Tax-inclusive room rates

The hotel’s room rates are tax-inclusive. A rate entered as ₦180,000 posts a total room
charge of ₦180,000, never ₦180,000 plus tax. The folio retains the extracted tax amount
and its rule snapshot for audit and reporting, while the guest-facing total remains the
agreed room price.

## Nightly room-charge scheduler

Migration `20260922670000_scheduled_night_audit.sql` enables Supabase Cron and installs
one five-minute dispatcher for all active hotels. The dispatcher reads each hotel's own
timezone and `business_day_cutoff_time`, obtains a per-hotel/date advisory lock, skips a
date already completed, and safely retries a failed or interrupted run. No hotel UUID or
UTC conversion is hardcoded.

Supabase Cron records each dispatcher execution in `cron.job_run_details`; the application
records the result for each hotel and business date in `nightly_posting_runs`. A weekly
cleanup job retains 90 days of Cron execution history. After deployment, verify the two
jobs under Dashboard -> Integrations -> Cron and confirm the first hotel run in the
application's night-audit report.

## Security model

- RLS is enabled on every current application table.
- Policies default to read-only and are scoped through active staff roles.
- Generic client-side updates/deletes are intentionally unavailable.
- Future modules must use narrowly scoped database functions for sensitive changes,
  especially financial and inventory operations.
- Anonymous callers cannot execute application-owned `SECURITY DEFINER` functions.
  Every staff-facing workflow function must have an explicit `authenticated` grant and
  must enforce its own hotel permission check.
- Receptionists can view payment history only within a selected guest folio. They do
  not receive hotel-wide payment, receipt, invoice, or night-audit access.
- Checkout makes the room `dirty` and creates an open room-turnover task. Owner,
  General Manager, or Reception can mark that task clean; the database rejects
  walk-in and reservation check-in while the room remains dirty.
- Business accounts are RLS-protected. Owner/GM can maintain corporate and agency
  terms through controlled RPCs; Accountant has read-only access. The register does
  not by itself authorise a reservation or folio to consume company credit.
