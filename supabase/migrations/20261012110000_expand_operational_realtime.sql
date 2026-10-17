-- Add payment-deposit and approval events used by front-desk and management views.
-- This is additive and safe to retry if either table is already published.
do $$
declare
  target_table text;
  realtime_publication oid;
  tables_to_publish text[] := array[
    'reservation_deposits',
    'finance_approval_requests'
  ];
begin
  select oid into realtime_publication
  from pg_publication
  where pubname = 'supabase_realtime';

  if realtime_publication is null then
    raise notice 'supabase_realtime publication is not present; skipping table registration';
    return;
  end if;

  if exists (
    select 1 from pg_publication where oid = realtime_publication and puballtables
  ) then
    return;
  end if;

  foreach target_table in array tables_to_publish loop
    if to_regclass(format('public.%I', target_table)) is not null
       and not exists (
         select 1 from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = target_table
       ) then
      execute format('alter publication supabase_realtime add table public.%I', target_table);
    end if;
  end loop;
end;
$$;
