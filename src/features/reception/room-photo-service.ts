import { supabase } from "@/lib/supabase/client";

const bucket = "room-photos";
const maxBytes = 5 * 1024 * 1024;
const extensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export type RoomPhoto = {
  id: string;
  hotel_id: string;
  room_type_id: string | null;
  room_id: string | null;
  storage_path: string;
  created_at: string;
  deletion_pending_at: string | null;
  url: string | null;
};

export type PhotoTarget = {
  kind: "room-types" | "rooms";
  id: string;
  label: string;
};

function client() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export async function getRoomPhotos(hotelId: string): Promise<RoomPhoto[]> {
  const { data, error } = await client()
    .from("room_photos")
    .select("id, hotel_id, room_type_id, room_id, storage_path, created_at, deletion_pending_at")
    .eq("hotel_id", hotelId)
    .order("created_at");
  if (error) throw new Error(error.message);
  if (!data?.length) return [];
  const visible = data.filter((photo) => !photo.deletion_pending_at);
  if (!visible.length) return data.map((photo) => ({ ...photo, url: null })) as RoomPhoto[];
  const signed = await client().storage.from(bucket).createSignedUrls(visible.map((photo) => photo.storage_path), 3600);
  if (signed.error) throw new Error(signed.error.message);
  const urls = new Map(signed.data?.map((item) => [item.path, item.signedUrl]) ?? []);
  return data.map((photo) => ({ ...photo, url: urls.get(photo.storage_path) ?? null })) as RoomPhoto[];
}

export async function uploadRoomPhoto(hotelId: string, target: PhotoTarget, file: File) {
  const extension = extensions[file.type];
  if (!extension) throw new Error("Choose a JPEG, PNG, or WebP image.");
  if (file.size === 0 || file.size > maxBytes) throw new Error("The image must be between 1 byte and 5 MB.");

  const id = crypto.randomUUID();
  const path = `${hotelId}/${target.kind}/${target.id}/${id}.${extension}`;
  const storage = client().storage.from(bucket);
  const uploaded = await storage.upload(path, file, { contentType: file.type, upsert: false });
  if (uploaded.error) throw new Error(uploaded.error.message);

  const { error } = await client().from("room_photos").insert({
    id,
    hotel_id: hotelId,
    room_type_id: target.kind === "room-types" ? target.id : null,
    room_id: target.kind === "rooms" ? target.id : null,
    storage_path: path,
  });
  if (error) {
    const cleanup = await storage.remove([path]);
    throw new Error(
      cleanup.error
        ? `${error.message} The uploaded file could not be removed; contact an administrator. ${cleanup.error.message}`
        : error.message,
    );
  }
}

export async function deleteRoomPhoto(photo: RoomPhoto) {
  const storage = client().storage.from(bucket);
  if (!photo.deletion_pending_at) {
    const started = await client().rpc("begin_room_photo_removal", { target_photo_id: photo.id });
    if (started.error) throw new Error(started.error.message);
  }
  const removed = await storage.remove([photo.storage_path]);
  if (removed.error) {
    const restored = await client().rpc("cancel_room_photo_removal", { target_photo_id: photo.id });
    if (restored.error) {
      throw new Error(`${removed.error.message} Removal could not be completed or rolled back. Refresh the gallery and retry the pending removal.`);
    }
    throw new Error(`${removed.error.message} The photo was kept; refresh and retry.`);
  }

  const { data, error } = await client().from("room_photos")
    .delete().eq("id", photo.id).eq("hotel_id", photo.hotel_id).select("id");
  if (error || data?.length !== 1) {
    throw new Error(`${error?.message ?? "The photo record was not removed."} The image is hidden; refresh the gallery and finish the pending removal.`);
  }
}
