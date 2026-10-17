-- Enforce the policy rules supported by the current date-based stay model.
-- Clock-time rules remain advisory until stays record arrival/departure times.

create or replace function public.enforce_stay_extension_policy()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare policy_value text;
begin
  select extra_night_policy into policy_value
  from public.hotel_settings
  where hotel_id = new.hotel_id;

  if policy_value = 'manager_rate_approval'
     and not public.has_hotel_permission(new.hotel_id, 'settings.manage') then
    raise exception 'This hotel requires Owner or GM approval for every stay extension';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_stay_extension_policy on public.stay_extensions;
create trigger enforce_stay_extension_policy
before insert on public.stay_extensions
for each row execute function public.enforce_stay_extension_policy();

create or replace function public.enforce_early_departure_policy()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare policy_value text;
begin
  if old.status = 'checked_in'
     and new.status = 'checked_out'
     and new.actual_check_out_date < old.expected_check_out_date then
    select early_departure_policy into policy_value
    from public.hotel_settings
    where hotel_id = old.hotel_id;

    if policy_value = 'manager_review'
       and not public.has_hotel_permission(old.hotel_id, 'settings.manage') then
      raise exception 'Early departure requires Owner or GM review';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_early_departure_policy on public.stays;
create trigger enforce_early_departure_policy
before update of status, actual_check_out_date on public.stays
for each row execute function public.enforce_early_departure_policy();

revoke all on function public.enforce_stay_extension_policy(),
  public.enforce_early_departure_policy()
from public, anon, authenticated;
