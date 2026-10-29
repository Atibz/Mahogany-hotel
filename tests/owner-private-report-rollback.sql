\set ON_ERROR_STOP on
begin;

select id as hotel_id from public.hotels order by created_at limit 1 \gset
select id as owner_role_id from public.roles where hotel_id = :'hotel_id' and code = 'owner' \gset
select id as gm_role_id from public.roles where hotel_id = :'hotel_id' and code = 'general_manager' \gset

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'owner-test-' || gen_random_uuid()::text || '@example.invalid', '', now())
returning id as owner_id \gset
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'gm-test-' || gen_random_uuid()::text || '@example.invalid', '', now())
returning id as gm_id \gset

insert into public.user_roles(profile_id, role_id)
values (:'owner_id', :'owner_role_id'), (:'gm_id', :'gm_role_id');

update public.profiles set full_name = 'Private Owner Test Identity'
where id = :'owner_id';

insert into public.activity_logs(hotel_id, actor_id, action, entity_type, entity_id, metadata)
values (:'hotel_id', :'owner_id', 'privacy.owner_probe', 'test_record', :'owner_id',
  '{"amount_kobo":12345,"private_marker":"owner-secret-test"}'::jsonb)
returning id as owner_log_id \gset

insert into public.business_day_closes(hotel_id, business_date, close_number, snapshot, closed_by)
values (:'hotel_id', '1999-01-01', 'DAC-OWNER-PRIVATE-ROLLBACK', '{"business_date":"1999-01-01"}', :'gm_id')
returning id as close_id \gset
select set_config('test.owner_id', :'owner_id', true),
  set_config('test.gm_id', :'gm_id', true),
  set_config('test.hotel_id', :'hotel_id', true),
  set_config('test.owner_role_id', :'owner_role_id', true),
  set_config('test.close_id', :'close_id', true),
  set_config('test.owner_log_id', :'owner_log_id', true);

do $$
begin
  if (select count(*) from public.owner_daily_close_email_jobs where close_id = current_setting('test.close_id')::uuid) <> 1 then
    raise exception 'Day close did not enqueue exactly one private email job';
  end if;
  if has_table_privilege('authenticated', 'public.owner_daily_close_email_jobs', 'SELECT') then
    raise exception 'Ordinary staff can select private email jobs';
  end if;
  if has_function_privilege('authenticated', 'public.claim_owner_daily_close_email()', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.get_owner_private_daily_movements(uuid,date)', 'EXECUTE') then
    raise exception 'Ordinary staff can invoke private report functions';
  end if;
  if public.get_owner_private_daily_movements(current_setting('test.hotel_id')::uuid, '1999-01-01')
    ->> 'reconciliation_status' is null then
    raise exception 'Private movement summary did not execute';
  end if;
end
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'gm_id', true);
do $$
begin
  if (select count(*) from public.profiles where id = current_setting('test.owner_id')::uuid) <> 0 then
    raise exception 'GM can read Owner profile';
  end if;
  if (select count(*) from public.user_roles where profile_id = current_setting('test.owner_id')::uuid) <> 0 then
    raise exception 'GM can read Owner role assignment';
  end if;
  if (select count(*) from public.roles where id = current_setting('test.owner_role_id')::uuid) <> 0 then
    raise exception 'GM can read Owner role';
  end if;
  if (select count(*) from public.activity_logs where id = current_setting('test.owner_log_id')::uuid) <> 0 then
    raise exception 'GM can read raw Owner audit row';
  end if;
  if not exists (
    select 1 from public.search_activity_register(current_setting('test.hotel_id')::uuid,
      target_action := 'privacy.owner_probe') result
    where result.log_id = current_setting('test.owner_log_id')::uuid
      and result.actor_id is null
      and result.actor_name = 'Restricted administrator'
      and result.entity_id is null
      and result.metadata = '{}'::jsonb
      and result.display_amount_kobo = 12345
  ) then
    raise exception 'GM audit register did not preserve and mask Owner event correctly';
  end if;
  if exists (
    select 1 from public.search_activity_register(current_setting('test.hotel_id')::uuid,
      target_query := 'Private Owner Test Identity', target_action := 'privacy.owner_probe')
  ) or exists (
    select 1 from public.search_activity_register(current_setting('test.hotel_id')::uuid,
      target_query := 'owner-secret-test', target_action := 'privacy.owner_probe')
  ) or exists (
    select 1 from public.search_activity_register(current_setting('test.hotel_id')::uuid,
      target_query := current_setting('test.owner_id'), target_action := 'privacy.owner_probe')
  ) then
    raise exception 'GM can find Owner audit row by hidden identity or evidence';
  end if;
  if (select count(*) from public.profiles where id = current_setting('test.gm_id')::uuid) <> 1 then
    raise exception 'GM cannot read own profile';
  end if;
end
$$;

select set_config('request.jwt.claim.sub', :'owner_id', true);
do $$
begin
  if (select count(*) from public.profiles where id = current_setting('test.owner_id')::uuid) <> 1
    or (select count(*) from public.roles where id = current_setting('test.owner_role_id')::uuid) <> 1
    or (select count(*) from public.user_roles where profile_id = current_setting('test.owner_id')::uuid) <> 1 then
    raise exception 'Owner cannot read own account';
  end if;
  if (select count(*) from public.activity_logs where id = current_setting('test.owner_log_id')::uuid) <> 1 then
    raise exception 'Owner cannot read own raw audit row';
  end if;
  if not exists (
    select 1 from public.search_activity_register(current_setting('test.hotel_id')::uuid,
      target_action := 'privacy.owner_probe') result
    where result.log_id = current_setting('test.owner_log_id')::uuid
      and result.actor_id = current_setting('test.owner_id')::uuid
      and result.actor_name = 'Private Owner Test Identity'
      and result.entity_id = current_setting('test.owner_id')::uuid
      and result.metadata ->> 'private_marker' = 'owner-secret-test'
  ) then
    raise exception 'Owner cannot inspect complete audit evidence';
  end if;
end
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare claimed public.owner_daily_close_email_jobs;
begin
  select * into claimed from public.claim_owner_daily_close_email();
  if claimed.close_id <> current_setting('test.close_id')::uuid or claimed.status <> 'sending' or claimed.attempts <> 1 then
    raise exception 'Private report job was not claimed correctly';
  end if;
end
$$;
rollback;
