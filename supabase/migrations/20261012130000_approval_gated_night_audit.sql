-- Room-night posting must follow the hotel's accountant-authorized, staff-run
-- process. Retain automatic safeguards and idempotent posting, but remove the
-- unattended scheduler and require a separate authorization for each date.

insert into public.permissions (code, name, description) values
  ('night_audit.approve', 'Approve night audit', 'Authorize room-night posting for the current hotel business date.')
on conflict (code) do nothing;

create or replace function public.provision_night_audit_permissions(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on
    (p.code = 'night_audit.read' and r.code in ('general_manager', 'accountant', 'receptionist'))
    or (p.code = 'night_audit.run' and r.code in ('general_manager', 'receptionist'))
    or (p.code = 'night_audit.approve' and r.code in ('general_manager', 'accountant'))
  where r.hotel_id = target_hotel_id
  on conflict do nothing;

  -- Cashiers are not night auditors. Reception must run the approved audit.
  delete from public.role_permissions rp
  using public.roles r, public.permissions p
  where rp.role_id = r.id and rp.permission_id = p.id
    and r.hotel_id = target_hotel_id and r.code = 'cashier'
    and p.code = 'night_audit.run';
$$;

select public.provision_night_audit_permissions(id) from public.hotels;

create or replace function public.handle_hotel_night_audit_permission_provisioning()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_hotel_roles(new.id);
  perform public.provision_night_audit_permissions(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzzzzzzz_night_audit_permissions on public.hotels;
create trigger zzzzzzzzzzz_night_audit_permissions
after insert on public.hotels
for each row execute function public.handle_hotel_night_audit_permission_provisioning();

create table public.night_audit_approvals (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  business_date date not null,
  approved_by uuid not null references public.profiles(id) on delete restrict,
  approved_at timestamptz not null default now(),
  executed_by uuid references public.profiles(id) on delete restrict,
  executed_at timestamptz,
  unique (hotel_id, business_date),
  check ((executed_by is null) = (executed_at is null)),
  check (executed_by is null or executed_by <> approved_by)
);

create index night_audit_approvals_hotel_date_idx
  on public.night_audit_approvals(hotel_id, business_date desc);

revoke all on public.night_audit_approvals from public, anon, authenticated;
grant select on public.night_audit_approvals to authenticated;
alter table public.night_audit_approvals enable row level security;
create policy night_audit_approvals_read on public.night_audit_approvals
for select to authenticated
using (public.has_hotel_permission(hotel_id, 'night_audit.read'));

create or replace function public.approve_current_business_date_night_audit(target_hotel_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  current_business_date date;
  approval_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication is required to approve night audit'; end if;
  if not public.has_hotel_permission(target_hotel_id, 'night_audit.approve') then
    raise exception 'Not authorised to approve night audit';
  end if;

  current_business_date := public.hotel_business_date(target_hotel_id);
  if current_business_date > public.hotel_business_date(target_hotel_id, now()) then
    raise exception 'The current business date is not yet eligible for night audit';
  end if;
  if exists (select 1 from public.nightly_posting_runs npr
      where npr.hotel_id = target_hotel_id and npr.service_date = current_business_date
        and npr.status = 'completed') then
    raise exception 'Room-night posting is already complete for this business date';
  end if;
  if exists (select 1 from public.business_day_closes bdc
      where bdc.hotel_id = target_hotel_id and bdc.business_date = current_business_date) then
    raise exception 'This business date is already closed';
  end if;
  if exists (select 1 from public.night_audit_approvals naa
      where naa.hotel_id = target_hotel_id and naa.business_date = current_business_date) then
    raise exception 'Night audit has already been approved for this business date';
  end if;

  insert into public.night_audit_approvals (hotel_id, business_date, approved_by)
  values (target_hotel_id, current_business_date, auth.uid())
  returning id into approval_id;

  perform public.log_activity(target_hotel_id, 'night_audit.approved', 'night_audit_approval', approval_id,
    jsonb_build_object('business_date', current_business_date));
  return approval_id;
end;
$$;

create or replace function public.get_current_night_audit_approval(target_hotel_id uuid)
returns table (
  business_date date, approval_id uuid, approved_by_name text, approved_at timestamptz,
  executed_by_name text, executed_at timestamptz, posting_status text, posts_created integer
)
language plpgsql stable security definer set search_path = public
as $$
declare current_business_date date := public.hotel_business_date(target_hotel_id);
begin
  if not public.has_hotel_permission(target_hotel_id, 'night_audit.read') then
    raise exception 'Not authorised to view night-audit approval status';
  end if;
  return query
  select current_business_date, naa.id, approver.full_name, naa.approved_at,
    executor.full_name, naa.executed_at, npr.status::text, npr.posts_created
  from (select 1) seed
  left join public.night_audit_approvals naa
    on naa.hotel_id = target_hotel_id and naa.business_date = current_business_date
  left join public.profiles approver on approver.id = naa.approved_by
  left join public.profiles executor on executor.id = naa.executed_by
  left join public.nightly_posting_runs npr
    on npr.hotel_id = target_hotel_id and npr.service_date = current_business_date;
end;
$$;

create or replace function public.run_current_business_date_night_audit(target_hotel_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  current_business_date date;
  approval_record public.night_audit_approvals;
  created_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication is required to run night audit'; end if;
  if not public.has_hotel_permission(target_hotel_id, 'night_audit.run') then
    raise exception 'Not authorised to run night audit';
  end if;
  current_business_date := public.hotel_business_date(target_hotel_id);
  if current_business_date > public.hotel_business_date(target_hotel_id, now()) then
    raise exception 'The next business date has started, but its night audit is not due yet';
  end if;

  select * into approval_record from public.night_audit_approvals
  where hotel_id = target_hotel_id and business_date = current_business_date
  for update;
  if not found then raise exception 'The accountant or manager must approve this business date before posting'; end if;
  if approval_record.executed_at is not null then raise exception 'The approved night audit has already been executed'; end if;
  if approval_record.approved_by = auth.uid() then raise exception 'The person who approved night audit cannot execute it'; end if;

  created_count := public.run_nightly_room_posting(target_hotel_id, current_business_date);
  update public.night_audit_approvals
  set executed_by = auth.uid(), executed_at = now()
  where id = approval_record.id;
  perform public.log_activity(target_hotel_id, 'night_audit.executed', 'night_audit_approval', approval_record.id,
    jsonb_build_object('business_date', current_business_date, 'room_nights_created', created_count));
  return created_count;
end;
$$;

-- Remove the live unattended dispatcher. A manual authorization and an
-- independent staff execution are now required before any new nightly post.
do $$
declare scheduled_job_id bigint;
begin
  for scheduled_job_id in
    select jobid from cron.job where jobname = 'mahogany-due-night-audits'
  loop
    perform cron.unschedule(scheduled_job_id);
  end loop;
end;
$$;

create or replace function public.run_due_scheduled_night_audits()
returns integer language plpgsql security definer set search_path = public
as $$
begin
  raise exception 'Automatic night-audit posting is disabled; use the approved staff workflow';
end;
$$;

revoke all on function public.provision_night_audit_permissions(uuid),
  public.handle_hotel_night_audit_permission_provisioning(),
  public.approve_current_business_date_night_audit(uuid),
  public.get_current_night_audit_approval(uuid),
  public.run_due_scheduled_night_audits() from public, anon;
revoke all on function public.approve_current_business_date_night_audit(uuid),
  public.get_current_night_audit_approval(uuid),
  public.run_current_business_date_night_audit(uuid) from public, anon;
grant execute on function public.approve_current_business_date_night_audit(uuid),
  public.get_current_night_audit_approval(uuid),
  public.run_current_business_date_night_audit(uuid) to authenticated;
