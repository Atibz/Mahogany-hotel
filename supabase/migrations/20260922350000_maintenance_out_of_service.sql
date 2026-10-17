-- A maintenance ticket can control a room's out-of-service lock without
-- overwriting an unrelated manual block or bypassing existing reservations.

alter table public.rooms add column if not exists maintenance_ticket_id uuid references public.maintenance_tickets(id) on delete restrict;
create unique index if not exists rooms_maintenance_ticket_idx on public.rooms(maintenance_ticket_id) where maintenance_ticket_id is not null;

create or replace function public.set_maintenance_room_out_of_service(target_ticket_id uuid, should_be_out_of_service boolean)
returns void language plpgsql security definer set search_path = public as $$
declare ticket public.maintenance_tickets; target_room public.rooms;
begin
  select * into ticket from public.maintenance_tickets where id = target_ticket_id for update;
  if not found then raise exception 'Maintenance ticket not found'; end if;
  if not public.has_hotel_permission(ticket.hotel_id, 'maintenance.manage') then raise exception 'Not authorised to control room service status'; end if;
  select * into target_room from public.rooms where id = ticket.room_id for update;
  if not found then raise exception 'Room not found'; end if;
  if should_be_out_of_service then
    if ticket.status not in ('open', 'in_progress') then raise exception 'Only an active maintenance ticket can take a room out of service'; end if;
    if target_room.maintenance_ticket_id is not null then raise exception 'This room is already out of service for maintenance'; end if;
    if target_room.blocked_at is not null then raise exception 'This room already has a separate operational block'; end if;
    if exists (select 1 from public.stays where room_id = target_room.id and status = 'checked_in') then raise exception 'Move or check out the active guest before taking this room out of service'; end if;
    if exists (select 1 from public.reservations where room_id = target_room.id and status in ('pending', 'confirmed') and check_out_date > public.hotel_business_date(ticket.hotel_id)) then raise exception 'Reassign or amend future reservations before taking this room out of service'; end if;
    update public.rooms set maintenance_ticket_id = ticket.id, blocked_at = now(), blocked_reason = 'Maintenance: ' || ticket.ticket_number || ' — ' || ticket.description, updated_at = now() where id = target_room.id;
    update public.maintenance_tickets set out_of_service_at = now(), out_of_service_by = auth.uid() where id = ticket.id;
    perform public.log_activity(ticket.hotel_id, 'maintenance.room_taken_out_of_service', 'maintenance_ticket', ticket.id, jsonb_build_object('room_id', target_room.id));
  else
    if ticket.status <> 'resolved' then raise exception 'Resolve the maintenance ticket before returning the room to service'; end if;
    if target_room.maintenance_ticket_id is distinct from ticket.id then raise exception 'This ticket does not control the current room block'; end if;
    update public.rooms set maintenance_ticket_id = null, blocked_at = null, blocked_reason = null, updated_at = now() where id = target_room.id;
    update public.maintenance_tickets set returned_to_service_at = now(), returned_to_service_by = auth.uid(), status = 'closed' where id = ticket.id;
    perform public.log_activity(ticket.hotel_id, 'maintenance.room_returned_to_service', 'maintenance_ticket', ticket.id, jsonb_build_object('room_id', target_room.id));
  end if;
end;
$$;

revoke all on function public.set_maintenance_room_out_of_service(uuid, boolean) from public, anon;
grant execute on function public.set_maintenance_room_out_of_service(uuid, boolean) to authenticated;
