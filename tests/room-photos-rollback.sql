\set ON_ERROR_STOP on

-- Local-only RLS and gallery guard checks. Every fixture is rolled back.
begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('67000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'photo-owner-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('67000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'photo-reception-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('67000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'photo-gm-rollback@test.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());

insert into public.user_roles (profile_id, role_id)
select v.profile_id, r.id from (values
  ('67000000-0000-4000-8000-000000000001'::uuid, 'owner'::text),
  ('67000000-0000-4000-8000-000000000002'::uuid, 'receptionist'::text),
  ('67000000-0000-4000-8000-000000000003'::uuid, 'general_manager'::text)
) v(profile_id, role_code)
join public.roles r on r.hotel_id = '00000000-0000-4000-8000-000000000001' and r.code = v.role_code;

select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000001', true);
set local role authenticated;

insert into storage.objects (bucket_id, name)
select 'room-photos', t.hotel_id::text || '/room-types/' || t.id::text || '/67000000-0000-4000-8000-000000000010.jpg'
from public.room_types t where t.id = '10000000-0000-4000-8000-000000000001';

insert into public.room_photos (id, hotel_id, room_type_id, storage_path)
select '67000000-0000-4000-8000-000000000010', t.hotel_id, t.id,
  t.hotel_id::text || '/room-types/' || t.id::text || '/67000000-0000-4000-8000-000000000010.jpg'
from public.room_types t where t.id = '10000000-0000-4000-8000-000000000001';

insert into storage.objects (bucket_id, name)
select 'room-photos', r.hotel_id::text || '/rooms/' || r.id::text || '/67000000-0000-4000-8000-000000000020.webp'
from public.rooms r where r.id = '20000000-0000-4000-8000-000000000103';

insert into public.room_photos (id, hotel_id, room_id, storage_path)
select '67000000-0000-4000-8000-000000000020', r.hotel_id, r.id,
  r.hotel_id::text || '/rooms/' || r.id::text || '/67000000-0000-4000-8000-000000000020.webp'
from public.rooms r where r.id = '20000000-0000-4000-8000-000000000103';

do $$ begin
  if (select count(*) from public.room_photos where id = '67000000-0000-4000-8000-000000000010') <> 1 then
    raise exception 'Owner could not add a room-type photo';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000003', true);

insert into storage.objects (bucket_id, name)
select 'room-photos', t.hotel_id::text || '/room-types/' || t.id::text || '/67000000-0000-4000-8000-000000000030.png'
from public.room_types t where t.id = '10000000-0000-4000-8000-000000000001';

insert into public.room_photos (id, hotel_id, room_type_id, storage_path)
select '67000000-0000-4000-8000-000000000030', t.hotel_id, t.id,
  t.hotel_id::text || '/room-types/' || t.id::text || '/67000000-0000-4000-8000-000000000030.png'
from public.room_types t where t.id = '10000000-0000-4000-8000-000000000001';

select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000002', true);

do $$ begin
  if (select count(*) from public.room_photos where id in (
      '67000000-0000-4000-8000-000000000010', '67000000-0000-4000-8000-000000000020',
      '67000000-0000-4000-8000-000000000030'
  )) <> 3 then
    raise exception 'Receptionist could not read Owner and GM room photos';
  end if;
  if (select count(*) from storage.objects where bucket_id = 'room-photos'
      and name like '00000000-0000-4000-8000-000000000001/%') <> 3 then
    raise exception 'Receptionist could not read all private photo objects';
  end if;
  begin
    insert into storage.objects (bucket_id, name)
    select 'room-photos', t.hotel_id::text || '/room-types/' || t.id::text || '/67000000-0000-4000-8000-000000000011.jpg'
    from public.room_types t where t.id = '10000000-0000-4000-8000-000000000001';
    raise exception 'Receptionist unexpectedly uploaded a photo';
  exception when insufficient_privilege then null;
  end;
end $$;

do $$ begin
  begin
    perform public.begin_room_photo_removal('67000000-0000-4000-8000-000000000010');
    raise exception 'Receptionist unexpectedly began a photo removal';
  exception when raise_exception then
    if sqlerrm = 'Receptionist unexpectedly began a photo removal' then raise; end if;
  end;
end $$;

do $$ declare deleted_count integer; begin
  delete from public.room_photos where id = '67000000-0000-4000-8000-000000000010';
  get diagnostics deleted_count = row_count;
  if deleted_count <> 0 then raise exception 'Receptionist unexpectedly deleted a photo'; end if;
end $$;

select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000001', true);

select public.begin_room_photo_removal('67000000-0000-4000-8000-000000000010');
do $$ begin
  if not exists (select 1 from public.room_photos
    where id = '67000000-0000-4000-8000-000000000010' and deletion_pending_at is not null) then
    raise exception 'Owner photo was not marked pending removal';
  end if;
end $$;
select public.cancel_room_photo_removal('67000000-0000-4000-8000-000000000010');
do $$ begin
  if not exists (select 1 from public.room_photos
    where id = '67000000-0000-4000-8000-000000000010' and deletion_pending_at is null) then
    raise exception 'Owner could not restore a photo after interrupted removal';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000003', true);
select public.begin_room_photo_removal('67000000-0000-4000-8000-000000000030');
select public.cancel_room_photo_removal('67000000-0000-4000-8000-000000000030');

select set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000001', true);

do $$ begin
  begin
    insert into public.room_photos (id, hotel_id, room_type_id, storage_path) values (
      '67000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001/room-types/10000000-0000-4000-8000-000000000001/other.jpg'
    );
    raise exception 'Mismatched photo path unexpectedly accepted';
  exception when raise_exception then
    if sqlerrm = 'Mismatched photo path unexpectedly accepted' then raise; end if;
  end;
end $$;

rollback;
