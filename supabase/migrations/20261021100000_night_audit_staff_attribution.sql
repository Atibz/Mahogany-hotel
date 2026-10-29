-- Expose the approver identity for the UI separation-of-duties rule and
-- identify both people on the current business date's night-audit status.
-- The execution RPC still enforces the rule independently of the UI.
drop function public.get_current_night_audit_approval(uuid);

create function public.get_current_night_audit_approval(target_hotel_id uuid)
returns table (
  business_date date,
  approval_id uuid,
  approved_by uuid,
  approved_by_name text,
  approved_by_role_name text,
  approved_at timestamptz,
  executed_by uuid,
  executed_by_name text,
  executed_by_role_name text,
  executed_at timestamptz,
  posting_status text,
  posts_created integer
)
language plpgsql stable security definer set search_path = public
as $$
declare current_business_date date := public.hotel_business_date(target_hotel_id);
begin
  if not public.has_hotel_permission(target_hotel_id, 'night_audit.read') then
    raise exception 'Not authorised to view night-audit approval status';
  end if;

  return query
  select current_business_date, naa.id, naa.approved_by,
    coalesce(nullif(btrim(approver.full_name), ''), approver_auth.email::text),
    approver_roles.role_names, naa.approved_at,
    naa.executed_by,
    coalesce(nullif(btrim(executor.full_name), ''), executor_auth.email::text),
    executor_roles.role_names, naa.executed_at,
    npr.status::text, npr.posts_created
  from (select 1) seed
  left join public.night_audit_approvals naa
    on naa.hotel_id = target_hotel_id and naa.business_date = current_business_date
  left join public.profiles approver on approver.id = naa.approved_by
  left join auth.users approver_auth on approver_auth.id = naa.approved_by
  left join lateral (
    select string_agg(distinct r.name, ', ' order by r.name) as role_names
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.hotel_id = target_hotel_id
    where ur.profile_id = naa.approved_by
  ) approver_roles on true
  left join public.profiles executor on executor.id = naa.executed_by
  left join auth.users executor_auth on executor_auth.id = naa.executed_by
  left join lateral (
    select string_agg(distinct r.name, ', ' order by r.name) as role_names
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.hotel_id = target_hotel_id
    where ur.profile_id = naa.executed_by
  ) executor_roles on true
  left join public.nightly_posting_runs npr
    on npr.hotel_id = target_hotel_id and npr.service_date = current_business_date;
end;
$$;

revoke all on function public.get_current_night_audit_approval(uuid) from public, anon;
grant execute on function public.get_current_night_audit_approval(uuid) to authenticated;
notify pgrst, 'reload schema';
