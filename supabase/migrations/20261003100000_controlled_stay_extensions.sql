-- Extend an active stay without rewriting posted nights or prior rate history.

create table public.stay_extensions (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  stay_id uuid not null references public.stays(id) on delete restrict,
  previous_check_out_date date not null,
  new_check_out_date date not null,
  previous_rate_kobo bigint not null check (previous_rate_kobo >= 0),
  extension_rate_kobo bigint not null check (extension_rate_kobo >= 0),
  reason text not null check (length(trim(reason)) > 0),
  extended_by uuid references public.profiles(id) on delete set null,
  extended_at timestamptz not null default now(),
  check (new_check_out_date > previous_check_out_date)
);

create index stay_extensions_stay_date_idx
  on public.stay_extensions(stay_id, extended_at desc);

insert into public.permissions (code, name, description)
values (
  'stays.extend',
  'Extend active stays',
  'Extend an in-house stay after checking room availability.'
)
on conflict (code) do nothing;

create or replace function public.provision_stay_extension_permission(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.code = 'stays.extend'
  where r.hotel_id = target_hotel_id
    and r.code in ('general_manager', 'receptionist')
  on conflict do nothing;
$$;

select public.provision_stay_extension_permission(id) from public.hotels;

create or replace function public.handle_hotel_stay_extension_permission()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_stay_extension_permission(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzzzzzz_hotel_stay_extension_permission on public.hotels;
create trigger zzzzzzzzzz_hotel_stay_extension_permission
after insert on public.hotels
for each row execute function public.handle_hotel_stay_extension_permission();

create or replace function public.extend_in_house_stay(
  target_stay_id uuid,
  new_check_out_date date,
  extension_reason text,
  new_extension_rate_kobo bigint default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_stay public.stays;
  prior_rate bigint;
  applied_rate bigint;
  extension_id uuid;
begin
  select * into target_stay
  from public.stays
  where id = target_stay_id
  for update;

  if not found then raise exception 'Stay not found'; end if;
  if not public.has_hotel_permission(target_stay.hotel_id, 'stays.extend') then
    raise exception 'Not authorised to extend stays';
  end if;
  if target_stay.status <> 'checked_in' then
    raise exception 'Only an active in-house stay can be extended';
  end if;
  if new_check_out_date <= target_stay.expected_check_out_date then
    raise exception 'New checkout date must be after the current checkout date';
  end if;
  if nullif(trim(extension_reason), '') is null then
    raise exception 'An extension reason is required';
  end if;

  perform 1 from public.rooms where id = target_stay.room_id for update;

  if exists (
    select 1
    from public.reservations rv
    where rv.room_id = target_stay.room_id
      and rv.status in ('pending', 'confirmed')
      and daterange(rv.check_in_date, rv.check_out_date, '[)')
        && daterange(target_stay.expected_check_out_date, new_check_out_date, '[)')
  ) then
    raise exception 'The room has a conflicting reservation during the extension';
  end if;

  select srp.rate_kobo into prior_rate
  from public.stay_rate_periods srp
  where srp.stay_id = target_stay.id
    and srp.effective_from < target_stay.expected_check_out_date
    and (srp.effective_to is null or srp.effective_to >= target_stay.expected_check_out_date - 1)
  order by srp.effective_from desc
  limit 1;
  prior_rate := coalesce(prior_rate, target_stay.agreed_rate_kobo);
  applied_rate := coalesce(new_extension_rate_kobo, prior_rate);

  if applied_rate < 0 then raise exception 'Extension rate cannot be negative'; end if;
  if applied_rate <> prior_rate
     and not public.has_hotel_permission(target_stay.hotel_id, 'stays.rate_change') then
    raise exception 'Only management can approve a different extension rate';
  end if;

  update public.stays
  set expected_check_out_date = new_check_out_date, updated_at = now()
  where id = target_stay.id;

  if applied_rate <> prior_rate then
    perform public.change_stay_rate(
      target_stay.id,
      target_stay.expected_check_out_date,
      applied_rate,
      'Stay extension: ' || trim(extension_reason)
    );
  end if;

  insert into public.stay_extensions (
    hotel_id, stay_id, previous_check_out_date, new_check_out_date,
    previous_rate_kobo, extension_rate_kobo, reason, extended_by
  ) values (
    target_stay.hotel_id, target_stay.id, target_stay.expected_check_out_date,
    new_check_out_date, prior_rate, applied_rate, trim(extension_reason), auth.uid()
  ) returning id into extension_id;

  perform public.log_activity(
    target_stay.hotel_id,
    'stay.extended',
    'stay_extension',
    extension_id,
    jsonb_build_object(
      'stay_id', target_stay.id,
      'room_id', target_stay.room_id,
      'previous_check_out_date', target_stay.expected_check_out_date,
      'new_check_out_date', new_check_out_date,
      'previous_rate_kobo', prior_rate,
      'extension_rate_kobo', applied_rate,
      'reason', trim(extension_reason)
    )
  );

  return extension_id;
end;
$$;

revoke all on public.stay_extensions from public, anon, authenticated;
grant select on public.stay_extensions to authenticated;
alter table public.stay_extensions enable row level security;
create policy stay_extensions_read on public.stay_extensions
for select to authenticated
using (public.has_hotel_permission(hotel_id, 'stays.read'));

revoke all on function public.provision_stay_extension_permission(uuid),
  public.handle_hotel_stay_extension_permission()
from public, anon, authenticated;
revoke all on function public.extend_in_house_stay(uuid, date, text, bigint)
from public, anon;
grant execute on function public.extend_in_house_stay(uuid, date, text, bigint)
to authenticated;
