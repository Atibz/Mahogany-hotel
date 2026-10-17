-- Rate-change approval: walk-in operations and rate approval are separate permissions.
-- Reception may create walk-ins, but management approves mid-stay rate changes.

insert into public.permissions (code, name, description)
values ('stays.rate_change', 'Approve stay rate changes', 'Approve rate changes that affect future stay nights.')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.hotel_id = '00000000-0000-4000-8000-000000000001'
  and r.code in ('owner', 'general_manager')
  and p.code = 'stays.rate_change'
on conflict do nothing;

create or replace function public.change_stay_rate(
  target_stay_id uuid,
  effective_from_date date,
  new_rate_kobo bigint,
  change_reason text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_stay public.stays;
  previous_period_id uuid;
  new_period_id uuid;
begin
  select * into target_stay from public.stays where id = target_stay_id for update;
  if not found then raise exception 'Stay not found'; end if;
  if not public.has_hotel_permission(target_stay.hotel_id, 'stays.rate_change') then
    raise exception 'Only management can approve stay rate changes';
  end if;
  if target_stay.status <> 'checked_in' then raise exception 'Only active stays can receive a rate change'; end if;
  if effective_from_date <= target_stay.actual_check_in_date then raise exception 'New rate must start after check-in'; end if;
  if effective_from_date >= target_stay.expected_check_out_date then raise exception 'New rate must start before checkout'; end if;
  if new_rate_kobo < 0 then raise exception 'Rate cannot be negative'; end if;
  if nullif(trim(change_reason), '') is null then raise exception 'A reason is required for a rate change'; end if;

  select id into previous_period_id
  from public.stay_rate_periods
  where stay_id = target_stay_id
    and effective_from < effective_from_date
  order by effective_from desc
  limit 1
  for update;

  if previous_period_id is null then raise exception 'No existing rate period found'; end if;

  update public.stay_rate_periods
  set effective_to = effective_from_date - 1
  where id = previous_period_id;

  insert into public.stay_rate_periods (stay_id, effective_from, rate_kobo, reason, approved_by)
  values (target_stay_id, effective_from_date, new_rate_kobo, trim(change_reason), auth.uid())
  returning id into new_period_id;

  perform public.log_activity(target_stay.hotel_id, 'stay.rate_changed', 'stay', target_stay_id,
    jsonb_build_object('effective_from', effective_from_date, 'new_rate_kobo', new_rate_kobo, 'approved_by', auth.uid(), 'reason', trim(change_reason)));
  return new_period_id;
end;
$$;

revoke all on function public.change_stay_rate(uuid, date, bigint, text) from public;
grant execute on function public.change_stay_rate(uuid, date, bigint, text) to authenticated;
