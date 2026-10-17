-- Permission-checked, server-side audit search for management and finance
-- review. The raw activity table remains read-only and RLS protected.

create or replace function public.search_activity_register(
  target_hotel_id uuid,
  target_from_date date default null,
  target_to_date date default null,
  target_query text default null,
  target_action text default null,
  target_entity_type text default null,
  target_min_amount_kobo bigint default null,
  target_max_amount_kobo bigint default null,
  target_limit integer default 50,
  target_offset integer default 0
)
returns table (
  log_id uuid,
  occurred_at timestamptz,
  actor_id uuid,
  actor_name text,
  action text,
  entity_type text,
  entity_id uuid,
  metadata jsonb,
  display_amount_kobo bigint,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  hotel_timezone text;
  from_date date := coalesce(target_from_date, current_date - 30);
  to_date date := coalesce(target_to_date, current_date);
  query_value text := nullif(trim(coalesce(target_query, '')), '');
  row_limit integer := least(greatest(coalesce(target_limit, 50), 1), 100);
  row_offset integer := greatest(coalesce(target_offset, 0), 0);
begin
  if not public.has_hotel_permission(target_hotel_id, 'audit.read') then
    raise exception 'Not authorised to view the audit register';
  end if;
  if from_date > to_date then
    raise exception 'The audit start date cannot be after the end date';
  end if;
  if target_min_amount_kobo is not null
     and target_max_amount_kobo is not null
     and target_min_amount_kobo > target_max_amount_kobo then
    raise exception 'The minimum amount cannot exceed the maximum amount';
  end if;

  select h.timezone into hotel_timezone
  from public.hotels h
  where h.id = target_hotel_id;
  if hotel_timezone is null then raise exception 'Hotel not found'; end if;

  return query
  with filtered as (
    select
      al.id,
      al.occurred_at,
      al.actor_id,
      coalesce(nullif(trim(p.full_name), ''), 'System') as actor_name,
      al.action,
      al.entity_type,
      al.entity_id,
      al.metadata,
      case
        when coalesce(
          al.metadata ->> 'amount_kobo',
          al.metadata ->> 'new_rate_kobo',
          al.metadata ->> 'variance_kobo',
          al.metadata ->> 'declared_cash_kobo',
          al.metadata ->> 'expected_cash_kobo'
        ) ~ '^-?[0-9]+$'
        then coalesce(
          al.metadata ->> 'amount_kobo',
          al.metadata ->> 'new_rate_kobo',
          al.metadata ->> 'variance_kobo',
          al.metadata ->> 'declared_cash_kobo',
          al.metadata ->> 'expected_cash_kobo'
        )::bigint
        else null
      end as display_amount_kobo
    from public.activity_logs al
    left join public.profiles p on p.id = al.actor_id
    where al.hotel_id = target_hotel_id
      and (al.occurred_at at time zone hotel_timezone)::date between from_date and to_date
      and (nullif(trim(coalesce(target_action, '')), '') is null
        or al.action = trim(target_action))
      and (nullif(trim(coalesce(target_entity_type, '')), '') is null
        or al.entity_type = trim(target_entity_type))
      and (query_value is null
        or al.action ilike '%' || query_value || '%'
        or al.entity_type ilike '%' || query_value || '%'
        or coalesce(p.full_name, '') ilike '%' || query_value || '%'
        or coalesce(al.entity_id::text, '') ilike '%' || query_value || '%'
        or al.metadata::text ilike '%' || query_value || '%')
      and ((target_min_amount_kobo is null and target_max_amount_kobo is null) or exists (
        select 1 from jsonb_each_text(al.metadata) amount_entry
        where amount_entry.key like '%\_kobo' escape '\'
          and amount_entry.value ~ '^-?[0-9]+$'
          and (target_min_amount_kobo is null
            or amount_entry.value::numeric >= target_min_amount_kobo)
          and (target_max_amount_kobo is null
            or amount_entry.value::numeric <= target_max_amount_kobo)
      ))
  )
  select
    f.id,
    f.occurred_at,
    f.actor_id,
    f.actor_name,
    f.action,
    f.entity_type,
    f.entity_id,
    f.metadata,
    f.display_amount_kobo,
    count(*) over ()
  from filtered f
  order by f.occurred_at desc, f.id desc
  limit row_limit offset row_offset;
end;
$$;

revoke all on function public.search_activity_register(
  uuid, date, date, text, text, text, bigint, bigint, integer, integer
) from public, anon;
grant execute on function public.search_activity_register(
  uuid, date, date, text, text, text, bigint, bigint, integer, integer
) to authenticated;
