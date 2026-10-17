-- Hide a photo while its private storage object is being removed. If either
-- external step fails, the gallery cannot show a row pointing to a lost file.
alter table public.room_photos
  add column deletion_pending_at timestamptz;

create function public.begin_room_photo_removal(target_photo_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare target_photo public.room_photos;
begin
  select * into target_photo from public.room_photos where id = target_photo_id for update;
  if target_photo.id is null then raise exception 'Room photo not found'; end if;
  if not (
    (target_photo.room_type_id is not null and public.has_hotel_permission(target_photo.hotel_id, 'room_types.manage'))
    or (target_photo.room_id is not null and public.has_hotel_permission(target_photo.hotel_id, 'rooms.manage'))
  ) then raise exception 'Not authorised to remove room photos'; end if;
  if target_photo.deletion_pending_at is not null then raise exception 'Room photo removal is already in progress'; end if;
  update public.room_photos set deletion_pending_at = now() where id = target_photo_id;
end;
$$;

create function public.cancel_room_photo_removal(target_photo_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare target_photo public.room_photos;
begin
  select * into target_photo from public.room_photos where id = target_photo_id for update;
  if target_photo.id is null then raise exception 'Room photo not found'; end if;
  if not (
    (target_photo.room_type_id is not null and public.has_hotel_permission(target_photo.hotel_id, 'room_types.manage'))
    or (target_photo.room_id is not null and public.has_hotel_permission(target_photo.hotel_id, 'rooms.manage'))
  ) then raise exception 'Not authorised to restore room photos'; end if;
  if target_photo.deletion_pending_at is null then return; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'room-photos' and name = target_photo.storage_path) then
    raise exception 'The photo file is no longer stored';
  end if;
  update public.room_photos set deletion_pending_at = null where id = target_photo_id;
end;
$$;

revoke all on function public.begin_room_photo_removal(uuid), public.cancel_room_photo_removal(uuid) from public, anon;
grant execute on function public.begin_room_photo_removal(uuid), public.cancel_room_photo_removal(uuid) to authenticated;
