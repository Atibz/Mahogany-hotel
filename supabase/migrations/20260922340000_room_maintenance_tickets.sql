-- Maintenance is a tracked operational workflow, not an unstructured room block.

create table public.maintenance_tickets (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  ticket_number text not null,
  description text not null check (length(trim(description)) > 0),
  priority text not null check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  reported_by uuid references public.profiles(id) on delete set null,
  reported_at timestamptz not null default now(),
  assigned_to uuid references public.profiles(id) on delete set null,
  started_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolution_notes text,
  out_of_service_at timestamptz,
  out_of_service_by uuid references public.profiles(id) on delete set null,
  returned_to_service_at timestamptz,
  returned_to_service_by uuid references public.profiles(id) on delete set null,
  unique (hotel_id, ticket_number),
  check ((status <> 'resolved' and status <> 'closed') or (resolved_at is not null and resolved_by is not null and length(trim(coalesce(resolution_notes, ''))) > 0)),
  check (returned_to_service_at is null or out_of_service_at is not null)
);

create unique index maintenance_tickets_one_open_room_idx on public.maintenance_tickets(room_id)
  where status in ('open', 'in_progress');
create index maintenance_tickets_hotel_status_idx on public.maintenance_tickets(hotel_id, status, priority, reported_at desc);

insert into public.permissions (code, name, description) values
  ('maintenance.create', 'Report maintenance faults', 'Report a room fault for operational follow-up.'),
  ('maintenance.read', 'View maintenance tickets', 'View room maintenance tickets.'),
  ('maintenance.manage', 'Manage maintenance tickets', 'Assign, resolve, and release room maintenance tickets.')
on conflict (code) do nothing;

create or replace function public.provision_maintenance_permissions(target_hotel_id uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id from public.roles r join public.permissions p on p.code in ('maintenance.create', 'maintenance.read', 'maintenance.manage')
  where r.hotel_id = target_hotel_id and (
    (r.code = 'receptionist' and p.code in ('maintenance.create', 'maintenance.read'))
    or (r.code = 'general_manager' and p.code in ('maintenance.create', 'maintenance.read', 'maintenance.manage'))
  ) on conflict do nothing;
$$;
select public.provision_maintenance_permissions(id) from public.hotels;

create or replace function public.handle_hotel_maintenance_permission_provisioning()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.provision_maintenance_permissions(new.id); return new; end;
$$;
drop trigger if exists zzzzzzzzz_hotel_maintenance_permissions on public.hotels;
create trigger zzzzzzzzz_hotel_maintenance_permissions after insert on public.hotels
for each row execute function public.handle_hotel_maintenance_permission_provisioning();

create or replace function public.raise_room_maintenance_ticket(target_room_id uuid, fault_description text, fault_priority text default 'normal')
returns uuid language plpgsql security definer set search_path = public as $$
declare target_room public.rooms; ticket_id uuid; ticket_number text;
begin
  select * into target_room from public.rooms where id = target_room_id for update;
  if not found then raise exception 'Room not found'; end if;
  if not public.has_hotel_permission(target_room.hotel_id, 'maintenance.create') then raise exception 'Not authorised to report maintenance faults'; end if;
  if nullif(trim(fault_description), '') is null then raise exception 'A fault description is required'; end if;
  if fault_priority not in ('low', 'normal', 'high', 'urgent') then raise exception 'Maintenance priority is invalid'; end if;
  ticket_number := public.next_document_number(target_room.hotel_id, 'MNT');
  insert into public.maintenance_tickets (hotel_id, room_id, ticket_number, description, priority, reported_by)
  values (target_room.hotel_id, target_room.id, ticket_number, trim(fault_description), fault_priority, auth.uid()) returning id into ticket_id;
  perform public.log_activity(target_room.hotel_id, 'maintenance.reported', 'maintenance_ticket', ticket_id, jsonb_build_object('room_id', target_room.id, 'priority', fault_priority));
  return ticket_id;
end;
$$;

create or replace function public.update_room_maintenance_ticket(target_ticket_id uuid, next_status text, resolution_notes_value text default null)
returns void language plpgsql security definer set search_path = public as $$
declare ticket public.maintenance_tickets;
begin
  select * into ticket from public.maintenance_tickets where id = target_ticket_id for update;
  if not found then raise exception 'Maintenance ticket not found'; end if;
  if not public.has_hotel_permission(ticket.hotel_id, 'maintenance.manage') then raise exception 'Not authorised to manage maintenance tickets'; end if;
  if next_status not in ('in_progress', 'resolved', 'closed') then raise exception 'Maintenance status is invalid'; end if;
  if ticket.status in ('resolved', 'closed') then raise exception 'A resolved maintenance ticket cannot be changed'; end if;
  if next_status in ('resolved', 'closed') and nullif(trim(resolution_notes_value), '') is null then raise exception 'Resolution notes are required'; end if;
  update public.maintenance_tickets set status = next_status, started_at = case when next_status = 'in_progress' then coalesce(started_at, now()) else started_at end,
    resolved_at = case when next_status in ('resolved', 'closed') then now() else null end,
    resolved_by = case when next_status in ('resolved', 'closed') then auth.uid() else null end,
    resolution_notes = case when next_status in ('resolved', 'closed') then trim(resolution_notes_value) else resolution_notes end
  where id = ticket.id;
  perform public.log_activity(ticket.hotel_id, 'maintenance.status_changed', 'maintenance_ticket', ticket.id, jsonb_build_object('status', next_status));
end;
$$;

revoke all on public.maintenance_tickets from public, anon, authenticated;
grant select on public.maintenance_tickets to authenticated;
alter table public.maintenance_tickets enable row level security;
create policy maintenance_tickets_read on public.maintenance_tickets for select to authenticated using (public.has_hotel_permission(hotel_id, 'maintenance.read'));
revoke all on function public.provision_maintenance_permissions(uuid), public.handle_hotel_maintenance_permission_provisioning(), public.raise_room_maintenance_ticket(uuid, text, text), public.update_room_maintenance_ticket(uuid, text, text) from public, anon;
grant execute on function public.raise_room_maintenance_ticket(uuid, text, text), public.update_room_maintenance_ticket(uuid, text, text) to authenticated;
