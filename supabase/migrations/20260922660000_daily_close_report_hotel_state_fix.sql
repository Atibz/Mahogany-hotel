-- The hotels table uses `state`; correct the already-deployed report builder
-- without rewriting applied migration history.
do $$
declare
  function_definition text;
begin
  select pg_get_functiondef('public.build_business_day_close_snapshot(uuid, date)'::regprocedure)
  into function_definition;

  if position('h.state_region' in function_definition) = 0 then
    raise exception 'Could not safely locate the daily-close state reference';
  end if;

  function_definition := replace(function_definition, 'h.state_region', 'h.state');
  execute function_definition;
end;
$$;
