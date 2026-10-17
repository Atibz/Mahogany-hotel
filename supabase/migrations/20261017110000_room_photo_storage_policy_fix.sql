-- Qualify the object path: room_types also has a `name` column.
drop policy room_photo_objects_read on storage.objects;
drop policy room_photo_objects_insert on storage.objects;
drop policy room_photo_objects_delete on storage.objects;

create policy room_photo_objects_read on storage.objects for select to authenticated
using (
  bucket_id = 'room-photos' and
  ((split_part(storage.objects.name, '/', 2) = 'room-types' and exists (
      select 1 from public.room_types t
      where t.id::text = split_part(storage.objects.name, '/', 3)
        and t.hotel_id::text = split_part(storage.objects.name, '/', 1)
        and public.has_hotel_permission(t.hotel_id, 'rooms.read')
    )) or (split_part(storage.objects.name, '/', 2) = 'rooms' and exists (
      select 1 from public.rooms r
      where r.id::text = split_part(storage.objects.name, '/', 3)
        and r.hotel_id::text = split_part(storage.objects.name, '/', 1)
        and public.has_hotel_permission(r.hotel_id, 'rooms.read')
    )))
);

create policy room_photo_objects_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'room-photos' and
  ((split_part(storage.objects.name, '/', 2) = 'room-types' and exists (
      select 1 from public.room_types t
      where t.id::text = split_part(storage.objects.name, '/', 3)
        and t.hotel_id::text = split_part(storage.objects.name, '/', 1)
        and public.has_hotel_permission(t.hotel_id, 'room_types.manage')
    )) or (split_part(storage.objects.name, '/', 2) = 'rooms' and exists (
      select 1 from public.rooms r
      where r.id::text = split_part(storage.objects.name, '/', 3)
        and r.hotel_id::text = split_part(storage.objects.name, '/', 1)
        and public.has_hotel_permission(r.hotel_id, 'rooms.manage')
    )))
);

create policy room_photo_objects_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'room-photos' and
  ((split_part(storage.objects.name, '/', 2) = 'room-types' and exists (
      select 1 from public.room_types t
      where t.id::text = split_part(storage.objects.name, '/', 3)
        and t.hotel_id::text = split_part(storage.objects.name, '/', 1)
        and public.has_hotel_permission(t.hotel_id, 'room_types.manage')
    )) or (split_part(storage.objects.name, '/', 2) = 'rooms' and exists (
      select 1 from public.rooms r
      where r.id::text = split_part(storage.objects.name, '/', 3)
        and r.hotel_id::text = split_part(storage.objects.name, '/', 1)
        and public.has_hotel_permission(r.hotel_id, 'rooms.manage')
    )))
);
