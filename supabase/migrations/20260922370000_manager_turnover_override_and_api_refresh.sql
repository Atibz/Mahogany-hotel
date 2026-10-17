-- A manager may release a genuinely ready room when the housekeeping handoff
-- was missed. This is deliberately a separate, reasoned, audited exception.

insert into public.permissions (code, name, description)
values ('room_turnover.override', 'Override housekeeping hold', 'Release a dirty room only with a recorded management reason.')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'room_turnover.override'
where r.code = 'general_manager'
on conflict do nothing;

create or replace function public.override_room_turnover(target_room_id uuid, override_reason text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  target_room public.rooms;
  turnover_task public.room_turnover_tasks;
begin
  select * into target_room from public.rooms where id = target_room_id for update;
  if not found then raise exception 'Room not found'; end if;
  if not public.has_hotel_permission(target_room.hotel_id, 'room_turnover.override') then
    raise exception 'Only the owner or general manager may override a housekeeping hold';
  end if;
  if nullif(trim(override_reason), '') is null then raise exception 'A management override reason is required'; end if;
  if target_room.maintenance_ticket_id is not null then raise exception 'A maintenance-controlled room cannot be released through a housekeeping override'; end if;
  if target_room.turnover_status <> 'dirty' then raise exception 'This room is not awaiting housekeeping turnover'; end if;

  select * into turnover_task from public.room_turnover_tasks
  where room_id = target_room.id and status = 'open'
  order by created_at desc limit 1 for update;
  if not found then raise exception 'No open turnover task was found for this room'; end if;

  update public.room_turnover_tasks
  set status = 'completed', completed_at = now(), completed_by = auth.uid(),
      completion_notes = concat_ws(E'\n', completion_notes, '[Management override] ' || trim(override_reason))
  where id = turnover_task.id;
  update public.rooms
  set turnover_status = 'clean', turnover_updated_at = now(), updated_at = now()
  where id = target_room.id;
  perform public.log_activity(target_room.hotel_id, 'room.turnover_overridden', 'room_turnover_task', turnover_task.id,
    jsonb_build_object('room_id', target_room.id, 'reason', trim(override_reason)));
  return turnover_task.id;
end;
$$;

-- Existing GMs receive maintenance grants again, and PostgREST refreshes the
-- room_board definition introduced by the preceding migration.
select public.provision_maintenance_permissions(id) from public.hotels;
notify pgrst, 'reload schema';

revoke all on function public.override_room_turnover(uuid, text) from public, anon;
grant execute on function public.override_room_turnover(uuid, text) to authenticated;
