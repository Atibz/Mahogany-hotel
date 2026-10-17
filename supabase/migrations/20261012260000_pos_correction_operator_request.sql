-- POS outlet staff may submit, but not approve or execute, a paid-line
-- correction request. Keep the grant scoped to their outlet's create access.
do $$
declare
  function_oid oid;
  definition text;
  old_text text;
  new_text text;
begin
  function_oid := to_regprocedure('public.request_pos_order_line_correction(uuid,uuid,bigint,text,text)');
  if function_oid is null then raise exception 'POS line-correction requester is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  if position('has_pos_outlet_permission(order_record.hotel_id, order_record.outlet_id, ''create'')' in definition) = 0 then
    old_text := '  if not public.has_hotel_permission(order_record.hotel_id, ''finance_approvals.request'') then';
    new_text := '  if not public.has_hotel_permission(order_record.hotel_id, ''finance_approvals.request'')' || E'\n'
      || '      and not public.has_pos_outlet_permission(order_record.hotel_id, order_record.outlet_id, ''create'') then';
    if position(old_text in definition) = 0 then raise exception 'Expected POS correction requester permission check was not found'; end if;
    definition := replace(definition, old_text, new_text);
    execute definition;
  end if;
end;
$$;
