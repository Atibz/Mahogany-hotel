-- The controlled departure RPC authorizes Reception with departures.checkout.
-- Its internal checkout primitive must honor that same permission, while
-- retaining stays.checkout for the existing Owner/GM operational workflow.
-- Direct client execution of checkout_stay remains revoked.

do $$
declare
  function_definition text;
  adjusted_definition text;
  old_guard text := $old$
  if not public.has_hotel_permission(target_stay.hotel_id, 'stays.checkout') then
    raise exception 'Not authorised to check out guests';
  end if;$old$;
  new_guard text := $new$
  if not public.has_hotel_permission(target_stay.hotel_id, 'stays.checkout')
     and not public.has_hotel_permission(target_stay.hotel_id, 'departures.checkout') then
    raise exception 'Not authorised to check out guests';
  end if;$new$;
begin
  select pg_get_functiondef('public.checkout_stay(uuid, date)'::regprocedure)
  into function_definition;

  if position(old_guard in function_definition) = 0 then
    raise exception 'Expected checkout authorization guard was not found';
  end if;

  adjusted_definition := replace(function_definition, old_guard, new_guard);
  if adjusted_definition = function_definition then
    raise exception 'Could not update the checkout authorization guard';
  end if;

  execute adjusted_definition;
end;
$$;
