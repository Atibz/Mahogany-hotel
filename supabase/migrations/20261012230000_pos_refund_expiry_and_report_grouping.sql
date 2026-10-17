-- Tighten the un-deployed POS refund workflow: expired approvals must no
-- longer reserve money, and outlet totals must be grouped consistently.
do $$
declare
  function_oid oid;
  definition text;
  old_text text;
  new_text text;
begin
  function_oid := to_regprocedure('public.request_pos_payment_refund(uuid,bigint,uuid,text,text)');
  if function_oid is null then raise exception 'POS refund requester is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  old_text := '  select coalesce(sum((payload->>''amount_kobo'')::bigint), 0) into reserved_amount';
  new_text := '  update public.finance_approval_requests' || E'\n'
    || '  set status = ''expired''' || E'\n'
    || '  where action_type = ''pos_payment_refund''' || E'\n'
    || '    and target_entity_id = payment_record.id' || E'\n'
    || '    and status in (''pending'', ''approved'')' || E'\n'
    || '    and expires_at <= now();' || E'\n'
    || old_text;
  if position('expires_at <= now()' in definition) = 0 then
    if position(old_text in definition) = 0 then raise exception 'Refund reservation query was not found'; end if;
    definition := replace(definition, old_text, new_text);
  end if;
  old_text := '    and status in (''pending'', ''approved'');';
  new_text := '    and status in (''pending'', ''approved'')' || E'\n    and expires_at > now();';
  if position('and expires_at > now()' in definition) = 0 then
    if position(old_text in definition) = 0 then raise exception 'Refund reservation status filter was not found'; end if;
    definition := replace(definition, old_text, new_text);
  end if;
  execute definition;

  function_oid := to_regprocedure('public.get_pos_refund_sales_summary(uuid,date,date)');
  if function_oid is null then raise exception 'POS refund summary is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  old_text := '  select f.business_date, f.outlet_id, f.outlet_name, f.department_code,';
  new_text := '  select f.business_date, f.outlet_id, max(f.outlet_name), max(f.department_code),';
  if position('max(f.outlet_name)' in definition) = 0 then
    if position(old_text in definition) = 0 then raise exception 'Refund summary projection was not found'; end if;
    definition := replace(definition, old_text, new_text);
  end if;
  old_text := '  group by f.business_date, f.outlet_id, f.outlet_name, f.department_code';
  new_text := '  group by f.business_date, f.outlet_id';
  if position(old_text in definition) > 0 then
    definition := replace(definition, old_text, new_text);
  end if;
  execute definition;
end;
$$;
