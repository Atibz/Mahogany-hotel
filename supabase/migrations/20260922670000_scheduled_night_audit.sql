-- Automatically run each active hotel's idempotent room-charge posting after
-- that hotel's configured business-day cutoff. One frequent dispatcher is
-- safer than maintaining a separate UTC cron expression for every hotel.

create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.run_due_scheduled_night_audits()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  hotel_record record;
  completed_count integer := 0;
begin
  for hotel_record in
    select
      h.id as hotel_id,
      public.hotel_business_date(h.id) as business_date
    from public.hotels h
    join public.hotel_settings hs on hs.hotel_id = h.id
    where h.active
      and (now() at time zone h.timezone)::time >= hs.business_day_cutoff_time
    order by h.id
  loop
    -- Avoid overlapping dispatcher invocations for the same hotel and date.
    if pg_try_advisory_xact_lock(
      hashtextextended(
        hotel_record.hotel_id::text || ':' || hotel_record.business_date::text,
        0
      )
    ) and not exists (
      select 1
      from public.nightly_posting_runs npr
      where npr.hotel_id = hotel_record.hotel_id
        and npr.service_date = hotel_record.business_date
        and npr.status = 'completed'
    ) then
      begin
        perform public.run_nightly_room_posting(
          hotel_record.hotel_id,
          hotel_record.business_date
        );
        completed_count := completed_count + 1;
      exception when others then
        -- The nested block rolls back the failed posting attempt while this
        -- upsert preserves a manager-visible failure record for safe retry.
        insert into public.nightly_posting_runs (
          hotel_id,
          service_date,
          status,
          posts_created,
          started_at,
          finished_at,
          error_detail,
          initiated_by
        ) values (
          hotel_record.hotel_id,
          hotel_record.business_date,
          'failed',
          0,
          now(),
          now(),
          left(sqlerrm, 2000),
          null
        )
        on conflict (hotel_id, service_date) do update
        set status = 'failed',
            posts_created = 0,
            finished_at = now(),
            error_detail = excluded.error_detail,
            initiated_by = null;
      end;
    end if;
  end loop;

  return completed_count;
end;
$$;

revoke all on function public.run_due_scheduled_night_audits()
  from public, anon, authenticated;

-- Run frequently so a temporary outage at the exact cutoff does not cause a
-- missed hotel day. Completed runs are skipped by the dispatcher.
select cron.schedule(
  'mahogany-due-night-audits',
  '*/5 * * * *',
  'select public.run_due_scheduled_night_audits();'
);

-- pg_cron does not purge its execution history automatically. Retain enough
-- history for operational investigation without allowing unbounded growth.
select cron.schedule(
  'mahogany-cron-history-cleanup',
  '30 3 * * 0',
  $$delete from cron.job_run_details where end_time < now() - interval '90 days';$$
);
