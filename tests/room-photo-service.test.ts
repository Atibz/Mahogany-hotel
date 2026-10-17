import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
  createSignedUrls: vi.fn(),
  insert: vi.fn(),
  fromTable: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabase: {
    storage: { from: () => ({ upload: mocks.upload, remove: mocks.remove, createSignedUrls: mocks.createSignedUrls }) },
    from: mocks.fromTable,
    rpc: mocks.rpc,
  },
}));

import { deleteRoomPhoto, getRoomPhotos, uploadRoomPhoto, type RoomPhoto } from "../src/features/reception/room-photo-service";

const hotelId = "00000000-0000-4000-8000-000000000001";
const target = { kind: "room-types" as const, id: "10000000-0000-4000-8000-000000000001", label: "Deluxe" };

describe("room photo upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upload.mockResolvedValue({ error: null });
    mocks.remove.mockResolvedValue({ error: null });
    mocks.insert.mockResolvedValue({ error: null });
    mocks.fromTable.mockReturnValue({ insert: mocks.insert });
  });

  it("rejects unsupported or oversized files before upload", async () => {
    await expect(uploadRoomPhoto(hotelId, target, { type: "image/svg+xml", size: 200 } as File))
      .rejects.toThrow("JPEG, PNG, or WebP");
    await expect(uploadRoomPhoto(hotelId, target, { type: "image/png", size: 5 * 1024 * 1024 + 1 } as File))
      .rejects.toThrow("5 MB");
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("uploads to a hotel-and-type-scoped path before saving metadata", async () => {
    const file = { type: "image/webp", size: 900 } as File;
    await uploadRoomPhoto(hotelId, target, file);
    expect(mocks.upload).toHaveBeenCalledOnce();
    const path = mocks.upload.mock.calls[0][0] as string;
    expect(path).toMatch(/^00000000-0000-4000-8000-000000000001\/room-types\/10000000-0000-4000-8000-000000000001\/[0-9a-f-]+\.webp$/);
    expect(mocks.upload.mock.calls[0][1]).toBe(file);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ hotel_id: hotelId, room_type_id: target.id, room_id: null, storage_path: path }));
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("cleans up the uploaded object if saving metadata fails", async () => {
    mocks.insert.mockResolvedValue({ error: { message: "Photo limit reached" } });
    await expect(uploadRoomPhoto(hotelId, target, { type: "image/jpeg", size: 800 } as File))
      .rejects.toThrow("Photo limit reached");
    expect(mocks.remove).toHaveBeenCalledWith([mocks.upload.mock.calls[0][0]]);
  });

  it("signs private gallery images in one batch", async () => {
    const rows = [
      { id: "a", hotel_id: hotelId, room_type_id: target.id, room_id: null, storage_path: "first.jpg", created_at: "2026-10-17" },
      { id: "b", hotel_id: hotelId, room_type_id: target.id, room_id: null, storage_path: "second.jpg", created_at: "2026-10-17" },
    ];
    mocks.fromTable.mockReturnValue({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }),
    });
    mocks.createSignedUrls.mockResolvedValue({
      data: [
        { path: "second.jpg", signedUrl: "signed-second" },
        { path: "first.jpg", signedUrl: "signed-first" },
      ],
      error: null,
    });
    const photos = await getRoomPhotos(hotelId);
    expect(mocks.createSignedUrls).toHaveBeenCalledWith(["first.jpg", "second.jpg"], 3600);
    expect(photos.map((photo) => photo.url)).toEqual(["signed-first", "signed-second"]);
  });

  it("does not expose an image while removal is pending", async () => {
    mocks.fromTable.mockReturnValue({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({
        data: [{ id: "pending", hotel_id: hotelId, room_type_id: target.id, room_id: null,
          storage_path: "pending.jpg", created_at: "2026-10-17", deletion_pending_at: "2026-10-17T12:00:00Z" }],
        error: null,
      }) }) }),
    });
    const photos = await getRoomPhotos(hotelId);
    expect(photos[0].url).toBeNull();
    expect(mocks.createSignedUrls).not.toHaveBeenCalled();
  });
});

describe("room photo deletion", () => {
  const photo: RoomPhoto = {
    id: "photo-1", hotel_id: hotelId, room_type_id: target.id, room_id: null,
    storage_path: `${hotelId}/room-types/${target.id}/photo-1.jpg`, created_at: "2026-10-17T00:00:00Z", deletion_pending_at: null, url: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.remove.mockResolvedValue({ error: null });
    mocks.rpc.mockResolvedValue({ error: null });
  });

  it("leaves the file untouched if the pending-deletion marker cannot be saved", async () => {
    mocks.rpc.mockResolvedValue({ error: { message: "Not authorised" } });
    await expect(deleteRoomPhoto(photo)).rejects.toThrow("Not authorised");
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("cancels the hidden state when object removal fails", async () => {
    mocks.remove.mockResolvedValue({ error: { message: "Storage unavailable" } });
    await expect(deleteRoomPhoto(photo)).rejects.toThrow("The photo was kept");
    expect(mocks.rpc).toHaveBeenCalledWith("begin_room_photo_removal", { target_photo_id: photo.id });
    expect(mocks.rpc).toHaveBeenCalledWith("cancel_room_photo_removal", { target_photo_id: photo.id });
  });

  it("hides the gallery row before removing the file, then finalizes the row", async () => {
    mocks.fromTable.mockReturnValue({
      delete: () => ({ eq: () => ({ eq: () => ({ select: async () => ({ data: [{ id: photo.id }], error: null }) }) }) }),
    });
    await deleteRoomPhoto(photo);
    expect(mocks.rpc).toHaveBeenCalledWith("begin_room_photo_removal", { target_photo_id: photo.id });
    expect(mocks.remove).toHaveBeenCalledWith([photo.storage_path]);
  });

  it("can finish an interrupted deletion without repeating its initial transition", async () => {
    mocks.fromTable.mockReturnValue({
      delete: () => ({ eq: () => ({ eq: () => ({ select: async () => ({ data: [{ id: photo.id }], error: null }) }) }) }),
    });
    await deleteRoomPhoto({ ...photo, deletion_pending_at: "2026-10-17T12:00:00Z" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith([photo.storage_path]);
  });
});
