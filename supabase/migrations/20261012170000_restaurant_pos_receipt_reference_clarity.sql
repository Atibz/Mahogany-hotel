-- Keep restaurant POS acknowledgements distinct from statutory/tax documents.
-- Only future receipt numbers change; existing immutable records are untouched.
do $$
declare
  function_oid oid;
  function_definition text;
begin
  function_oid := to_regprocedure('public.record_restaurant_pos_payment(uuid,uuid,bigint,text)');
  if function_oid is null then
    raise exception 'Restaurant POS payment function is missing';
  end if;
  function_definition := pg_get_functiondef(function_oid);
  if position('''FBR''' in function_definition) > 0 then
    execute replace(function_definition, '''FBR''', '''POSR''');
  end if;

  function_oid := to_regprocedure('public.verify_restaurant_pos_payment(uuid,text)');
  if function_oid is null then
    raise exception 'Restaurant POS verification function is missing';
  end if;
  function_definition := pg_get_functiondef(function_oid);
  if position('''FBR''' in function_definition) > 0 then
    execute replace(function_definition, '''FBR''', '''POSR''');
  end if;
end;
$$;
