\set ON_ERROR_STOP on

-- Read-only authorization assertions with a temporary folio. The fixture is
-- rolled back, including its users, stay, and folio.
begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('65000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'folio-context-accountant@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('65000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'folio-context-storekeeper@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());

insert into public.user_roles (profile_id, role_id)
select fixture.profile_id, role_record.id
from (values
  ('65000000-0000-4000-8000-000000000001'::uuid, 'accountant'),
  ('65000000-0000-4000-8000-000000000002'::uuid, 'storekeeper')
) as fixture(profile_id, role_code)
join public.roles role_record
  on role_record.hotel_id = '00000000-0000-4000-8000-000000000001'
 and role_record.code = fixture.role_code;

insert into public.stays (
  id, hotel_id, guest_id, room_id, actual_check_in_date,
  expected_check_out_date, agreed_rate_kobo
)
select '65000000-0000-4000-8000-000000000003',
       '00000000-0000-4000-8000-000000000001', g.id, r.id,
       current_date, current_date + 1, 4500000
from public.guests g cross join public.rooms r
where g.hotel_id = '00000000-0000-4000-8000-000000000001'
  and r.hotel_id = g.hotel_id
order by g.id, r.id
limit 1;

insert into public.guest_folios (id, hotel_id, stay_id, folio_number)
values (
  '65000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000003',
  'TEST-FOLIO-CONTEXT'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '65000000-0000-4000-8000-000000000001', true);

do $$
declare result record;
begin
  if (select count(*) from public.stays where id = '65000000-0000-4000-8000-000000000003') <> 0 then
    raise exception 'Accountant unexpectedly has direct stay access';
  end if;
  select * into result from public.get_folio_context(
    '00000000-0000-4000-8000-000000000001',
    array['65000000-0000-4000-8000-000000000004'::uuid]
  );
  if result.folio_id is distinct from '65000000-0000-4000-8000-000000000004'::uuid
     or result.stay_id is distinct from '65000000-0000-4000-8000-000000000003'::uuid
     or result.guest_name is null or result.room_number is null then
    raise exception 'Accountant could not identify an authorised folio';
  end if;
  if exists (
    select 1 from public.get_folio_context(
      '00000000-0000-4000-8000-000000000001',
      array['65000000-0000-4000-8000-000000000099'::uuid]
    )
  ) then raise exception 'Unknown folio leaked context'; end if;
  if has_function_privilege('anon', 'public.get_folio_context(uuid,uuid[])', 'EXECUTE') then
    raise exception 'Anonymous execution was granted';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '65000000-0000-4000-8000-000000000002', true);
do $$
begin
  begin
    perform public.get_folio_context(
      '00000000-0000-4000-8000-000000000001',
      array['65000000-0000-4000-8000-000000000004'::uuid]
    );
    raise exception 'Storekeeper unexpectedly read folio context';
  exception when raise_exception then
    if sqlerrm <> 'Not authorised to view folio context' then raise; end if;
  end;
end $$;

rollback;
