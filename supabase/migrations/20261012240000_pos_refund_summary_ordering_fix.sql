-- The summary groups by outlet identity, so order by the grouped identity too.
do $$
declare
  function_oid oid;
  definition text;
  old_text text := '  order by f.business_date desc, f.outlet_name';
  new_text text := '  order by f.business_date desc, f.outlet_id';
begin
  function_oid := to_regprocedure('public.get_pos_refund_sales_summary(uuid,date,date)');
  if function_oid is null then raise exception 'POS refund summary is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  if position(new_text in definition) = 0 then
    if position(old_text in definition) = 0 then raise exception 'Expected refund summary ordering was not found'; end if;
    execute replace(definition, old_text, new_text);
  end if;
end;
$$;
