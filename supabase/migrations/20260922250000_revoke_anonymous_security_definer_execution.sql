-- SECURITY DEFINER application functions must never be callable through the
-- anonymous API. Each affected function was verified to have an explicit
-- authenticated grant before this migration was created. Extension-owned
-- functions are deliberately excluded.

do $$
declare function_signature text;
begin
  for function_signature in
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not exists (
        select 1
        from pg_depend d
        join pg_extension e on e.oid = d.refobjid
        where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid
          and d.deptype = 'e'
      )
  loop
    execute format('revoke execute on function %s from public, anon', function_signature);
  end loop;
end;
$$;
