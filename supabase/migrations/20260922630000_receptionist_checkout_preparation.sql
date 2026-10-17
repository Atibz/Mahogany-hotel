-- Final folio preparation is part of checkout, not permission to run the
-- hotel-wide night audit. Permit the tightly scoped departure workflow to
-- post its stay's missing nights while removing direct browser access to the
-- lower-level posting function.

do $$
declare
  function_definition text;
  adjusted_definition text;
begin
  select pg_get_functiondef(
    'public.post_room_night(uuid, date)'::regprocedure
  ) into function_definition;

  adjusted_definition := replace(
    function_definition,
    $old$not public.has_hotel_permission(stay_record.hotel_id, 'night_audit.run')$old$,
    $new$not public.has_hotel_permission(stay_record.hotel_id, 'night_audit.run')
     and not public.has_hotel_permission(stay_record.hotel_id, 'departures.checkout')$new$
  );

  if adjusted_definition = function_definition then
    raise exception 'Could not safely update post_room_night authorisation';
  end if;

  execute adjusted_definition;
end;
$$;

-- Callers use the controlled night-audit or departure RPCs. The primitive is
-- deliberately unavailable as a direct client RPC.
revoke all on function public.post_room_night(uuid, date)
  from public, anon, authenticated;
