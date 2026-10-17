-- Optional operational room photography. These are not guest or maintenance-evidence files.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('room-photos', 'room-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.room_photos (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  room_type_id uuid references public.room_types(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete cascade,
  storage_path text not null unique,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint room_photos_one_target check (num_nonnulls(room_type_id, room_id) = 1)
);

create index room_photos_hotel_type_idx on public.room_photos (hotel_id, room_type_id, created_at);
create index room_photos_hotel_room_idx on public.room_photos (hotel_id, room_id, created_at);

create function public.validate_room_photo()
returns trigger language plpgsql security definer set search_path = public as $$
declare target_hotel_id uuid; current_count integer; max_count integer;
begin
  if new.room_type_id is not null then
    select hotel_id into target_hotel_id from public.room_types where id = new.room_type_id for update;
    max_count := 6;
    if new.storage_path <> new.hotel_id::text || '/room-types/' || new.room_type_id::text || '/' || new.id::text || '.jpg'
       and new.storage_path <> new.hotel_id::text || '/room-types/' || new.room_type_id::text || '/' || new.id::text || '.png'
       and new.storage_path <> new.hotel_id::text || '/room-types/' || new.room_type_id::text || '/' || new.id::text || '.webp'
    then raise exception 'Invalid room-type photo path'; end if;
    select count(*) into current_count from public.room_photos where room_type_id = new.room_type_id;
  else
    select hotel_id into target_hotel_id from public.rooms where id = new.room_id for update;
    max_count := 4;
    if new.storage_path <> new.hotel_id::text || '/rooms/' || new.room_id::text || '/' || new.id::text || '.jpg'
       and new.storage_path <> new.hotel_id::text || '/rooms/' || new.room_id::text || '/' || new.id::text || '.png'
       and new.storage_path <> new.hotel_id::text || '/rooms/' || new.room_id::text || '/' || new.id::text || '.webp'
    then raise exception 'Invalid room photo path'; end if;
    select count(*) into current_count from public.room_photos where room_id = new.room_id;
  end if;
  if target_hotel_id is distinct from new.hotel_id then raise exception 'Photo target is not in this hotel'; end if;
  if current_count >= max_count then raise exception 'Photo limit reached'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'room-photos' and name = new.storage_path) then
    raise exception 'Upload the photo before saving its record';
  end if;
  return new;
end;
$$;

create trigger validate_room_photo_before_insert
before insert on public.room_photos for each row execute function public.validate_room_photo();

alter table public.room_photos enable row level security;
create policy room_photos_read on public.room_photos for select to authenticated
using (public.has_hotel_permission(hotel_id, 'rooms.read'));
create policy room_photos_insert on public.room_photos for insert to authenticated
with check (
  created_by = auth.uid() and
  ((room_type_id is not null and public.has_hotel_permission(hotel_id, 'room_types.manage')
    and exists (select 1 from public.room_types t where t.id = room_type_id and t.hotel_id = room_photos.hotel_id))
   or (room_id is not null and public.has_hotel_permission(hotel_id, 'rooms.manage')
    and exists (select 1 from public.rooms r where r.id = room_id and r.hotel_id = room_photos.hotel_id)))
);
create policy room_photos_delete on public.room_photos for delete to authenticated
using (
  (room_type_id is not null and public.has_hotel_permission(hotel_id, 'room_types.manage'))
  or (room_id is not null and public.has_hotel_permission(hotel_id, 'rooms.manage'))
);
grant select, insert, delete on public.room_photos to authenticated;

-- Object names are hotel/target-kind/target-id/photo-id.ext. Staff can view only
-- their hotel's operational photos; only room managers can upload or remove them.
create policy room_photo_objects_read on storage.objects for select to authenticated
using (
  bucket_id = 'room-photos' and
  ((split_part(name, '/', 2) = 'room-types' and exists (
      select 1 from public.room_types t
      where t.id::text = split_part(name, '/', 3)
        and t.hotel_id::text = split_part(name, '/', 1)
        and public.has_hotel_permission(t.hotel_id, 'rooms.read')
    )) or (split_part(name, '/', 2) = 'rooms' and exists (
      select 1 from public.rooms r
      where r.id::text = split_part(name, '/', 3)
        and r.hotel_id::text = split_part(name, '/', 1)
        and public.has_hotel_permission(r.hotel_id, 'rooms.read')
    )))
);
create policy room_photo_objects_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'room-photos' and
  ((split_part(name, '/', 2) = 'room-types' and exists (
      select 1 from public.room_types t
      where t.id::text = split_part(name, '/', 3)
        and t.hotel_id::text = split_part(name, '/', 1)
        and public.has_hotel_permission(t.hotel_id, 'room_types.manage')
    )) or (split_part(name, '/', 2) = 'rooms' and exists (
      select 1 from public.rooms r
      where r.id::text = split_part(name, '/', 3)
        and r.hotel_id::text = split_part(name, '/', 1)
        and public.has_hotel_permission(r.hotel_id, 'rooms.manage')
    )))
);
create policy room_photo_objects_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'room-photos' and
  ((split_part(name, '/', 2) = 'room-types' and exists (
      select 1 from public.room_types t
      where t.id::text = split_part(name, '/', 3)
        and t.hotel_id::text = split_part(name, '/', 1)
        and public.has_hotel_permission(t.hotel_id, 'room_types.manage')
    )) or (split_part(name, '/', 2) = 'rooms' and exists (
      select 1 from public.rooms r
      where r.id::text = split_part(name, '/', 3)
        and r.hotel_id::text = split_part(name, '/', 1)
        and public.has_hotel_permission(r.hotel_id, 'rooms.manage')
    )))
);

revoke all on function public.validate_room_photo() from public, anon, authenticated;
