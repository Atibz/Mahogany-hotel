import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useActionMessage } from "@/components/shared/action-feedback";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BedDouble,
  BrushCleaning,
  CircleOff,
  DoorOpen,
  Images,
  Search,
  Settings2,
  Wrench,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";

import { Modal } from "@/components/shared/modal";
import {
  EmptyState,
  PageError,
  PageLoading,
} from "@/components/shared/page-state";
import { useAccess } from "@/features/auth/use-access";
import { formatNaira } from "@/lib/money";

import {
  completeRoomTurnover,
  createRoom,
  createRoomType,
  extendInHouseStay,
  moveInHouseGuest,
  overrideRoomTurnover,
  setRoomBlocked,
  updateRoom,
  updateRoomType,
  type InHouseRoomOccupant,
  type RoomBoardItem,
  type RoomType,
} from "./reception-service";
import {
  useActiveHotel,
  useInHouseRoomOccupants,
  useMaintenanceTickets,
  useRoomBoard,
  useRoomTypeOccupancy,
  useRoomTypes,
} from "./use-reception";
import { invalidateHotelOperationalQueries } from "./query-invalidation";
import {
  deleteRoomPhoto,
  getRoomPhotos,
  uploadRoomPhoto,
  type PhotoTarget,
  type RoomPhoto,
} from "./room-photo-service";

const statusClass = {
  available: "bg-emerald-50 text-emerald-800",
  reserved: "bg-blue-50 text-blue-800",
  occupied: "bg-amber-50 text-amber-900",
  dirty: "bg-rose-50 text-rose-800",
  blocked: "bg-stone-200 text-stone-700",
};

function PhotoCover({ photo, label, className = "" }: { photo?: RoomPhoto; label: string; className?: string }) {
  return photo?.url ? (
    <img src={photo.url} alt={label} loading="lazy" className={`w-full object-cover ${className}`} />
  ) : (
    <div className={`flex w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-stone-100 to-amber-50 text-stone-500 ${className}`}>
      <BedDouble className="size-7" aria-hidden="true" />
      <span className="text-xs">No photo yet</span>
    </div>
  );
}

export function RoomsPage() {
  const hotel = useActiveHotel();
  const rooms = useRoomBoard(hotel.data?.id);
  const occupancy = useRoomTypeOccupancy(hotel.data?.id);
  const roomTypes = useRoomTypes(hotel.data?.id, true);
  const occupants = useInHouseRoomOccupants(hotel.data?.id);
  const maintenance = useMaintenanceTickets(hotel.data?.id);
  const photos = useQuery({
    queryKey: ["room-photos", hotel.data?.id],
    queryFn: () => getRoomPhotos(hotel.data!.id),
    enabled: Boolean(hotel.data?.id),
    refetchInterval: 45 * 60 * 1000,
  });
  const { roleCodes } = useAccess();
  const queryClient = useQueryClient();
  const [editingRoom, setEditingRoom] = useState<RoomBoardItem | null>(null);
  const [editingType, setEditingType] = useState<RoomType | null>(null);
  const [photoTarget, setPhotoTarget] = useState<PhotoTarget | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMessage, setPhotoMessage] = useActionMessage<string | null>(null);
  const [blockTarget, setBlockTarget] = useState<RoomBoardItem | null>(null);
  const [turnoverTarget, setTurnoverTarget] = useState<RoomBoardItem | null>(
    null,
  );
  const [turnoverOverrideTarget, setTurnoverOverrideTarget] =
    useState<RoomBoardItem | null>(null);
  const [occupantTarget, setOccupantTarget] =
    useState<InHouseRoomOccupant | null>(null);
  const [roomMoveTarget, setRoomMoveTarget] =
    useState<InHouseRoomOccupant | null>(null);
  const [extensionTarget, setExtensionTarget] =
    useState<InHouseRoomOccupant | null>(null);
  const [message, setMessage] = useActionMessage<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showInventorySetup, setShowInventorySetup] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const canManageRooms =
    roleCodes.includes("owner") || roleCodes.includes("general_manager") || roleCodes.includes("accountant");
  const canMoveGuests =
    canManageRooms || roleCodes.includes("receptionist");

  function targetPhotos(target: PhotoTarget) {
    return (photos.data ?? []).filter((photo) =>
      !photo.deletion_pending_at &&
      (target.kind === "room-types" ? photo.room_type_id === target.id : photo.room_id === target.id),
    );
  }

  function coverForRoom(room: RoomBoardItem) {
    return (photos.data ?? []).find((photo) => photo.room_id === room.id && photo.url)
      ?? (photos.data ?? []).find((photo) => photo.room_type_id === room.room_type_id && photo.url);
  }

  async function refreshPhotos() {
    await queryClient.invalidateQueries({ queryKey: ["room-photos", hotel.data?.id] });
  }

  async function handlePhotoUpload(file: File | undefined) {
    if (!file || !hotel.data || !photoTarget) return;
    setPhotoBusy(true);
    setPhotoMessage(null);
    try {
      await uploadRoomPhoto(hotel.data.id, photoTarget, file);
      await refreshPhotos();
      setPhotoMessage("Photo added.");
    } catch (error) {
      setPhotoMessage(error instanceof Error ? error.message : "Photo could not be added.");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handlePhotoDelete(photo: RoomPhoto) {
    setPhotoBusy(true);
    setPhotoMessage(null);
    try {
      await deleteRoomPhoto(photo);
      await refreshPhotos();
      setPhotoMessage("Photo removed.");
    } catch (error) {
      await refreshPhotos();
      setPhotoMessage(error instanceof Error ? error.message : "Photo could not be removed.");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function refresh() {
    if (!hotel.data) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["room-board", hotel.data.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["room-type-occupancy", hotel.data.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["room-types", hotel.data.id],
      }),
      invalidateHotelOperationalQueries(queryClient, hotel.data.id),
    ]);
  }

  async function handleRoomMove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!roomMoveTarget) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage(null);
    try {
      await moveInHouseGuest(
        roomMoveTarget.stay_id,
        String(form.get("roomId")),
        String(form.get("reason")),
      );
      await refresh();
      setRoomMoveTarget(null);
      setMessage(
        `Guest moved from Room ${roomMoveTarget.room_number}. The vacated room is now awaiting housekeeping.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "The room move could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleStayExtension(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!extensionTarget) return;
    const form = new FormData(event.currentTarget);
    const rateValue = String(form.get("extensionRate") ?? "").trim();
    setBusy(true);
    setMessage(null);
    try {
      await extendInHouseStay(
        extensionTarget.stay_id,
        String(form.get("checkOutDate")),
        String(form.get("reason")),
        rateValue ? Math.round(Number(rateValue) * 100) : undefined,
      );
      await refresh();
      setExtensionTarget(null);
      setMessage(`Stay extended for ${extensionTarget.guest_name}.`);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "The stay could not be extended.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateType(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hotel.data) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await createRoomType(hotel.data.id, {
        name: String(form.get("name")),
        description: String(form.get("description")),
        rateKobo: Math.round(Number(form.get("rate")) * 100),
        capacity: Number(form.get("capacity")),
        sizeSqft: Number(form.get("sizeSqft")) || undefined,
      });
      event.currentTarget.reset();
      await refresh();
      setMessage("Room type created.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Room type could not be created.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hotel.data) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await createRoom(hotel.data.id, {
        roomTypeId: String(form.get("roomTypeId")),
        roomNumber: String(form.get("roomNumber")),
        rateOverrideKobo: form.get("rateOverride")
          ? Math.round(Number(form.get("rateOverride")) * 100)
          : undefined,
      });
      event.currentTarget.reset();
      await refresh();
      setMessage("Room created.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Room could not be created.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleEditType(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingType) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await updateRoomType(editingType.id, {
        name: String(form.get("name")),
        description: String(form.get("description")),
        rateKobo: Math.round(Number(form.get("rate")) * 100),
        capacity: Number(form.get("capacity")),
        sizeSqft: Number(form.get("sizeSqft")) || undefined,
        active: form.get("active") === "on",
      });
      setEditingType(null);
      await refresh();
      setMessage("Room type updated.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Room type could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleEditRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingRoom) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await updateRoom(editingRoom.id, {
        roomTypeId: String(form.get("roomTypeId")),
        roomNumber: String(form.get("roomNumber")),
        rateOverrideKobo: form.get("rateOverride")
          ? Math.round(Number(form.get("rateOverride")) * 100)
          : undefined,
        active: form.get("active") === "on",
      });
      setEditingRoom(null);
      await refresh();
      setMessage("Room updated.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Room could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleBlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!blockTarget) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await setRoomBlocked(blockTarget.id, true, String(form.get("reason")));
      setBlockTarget(null);
      await refresh();
      setMessage("Room blocked.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Room could not be blocked.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleUnblock(room: RoomBoardItem) {
    setBusy(true);
    try {
      await setRoomBlocked(room.id, false);
      await refresh();
      setMessage("Room unblocked.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Room could not be unblocked.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleCompleteTurnover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!turnoverTarget) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await completeRoomTurnover(
        turnoverTarget.id,
        String(form.get("notes") || ""),
      );
      const roomNumber = turnoverTarget.room_number;
      setTurnoverTarget(null);
      await refresh();
      setMessage(`Room ${roomNumber} is clean and available for check-in.`);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Room turnover could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleTurnoverOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!turnoverOverrideTarget) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await overrideRoomTurnover(
        turnoverOverrideTarget.id,
        String(form.get("reason")),
      );
      const roomNumber = turnoverOverrideTarget.room_number;
      setTurnoverOverrideTarget(null);
      await refresh();
      setMessage(
        `Management override recorded. Room ${roomNumber} is now available for check-in.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The housekeeping hold could not be overridden.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (
    hotel.isLoading ||
    rooms.isLoading ||
    occupancy.isLoading ||
    roomTypes.isLoading ||
    occupants.isLoading
  )
    return <PageLoading />;
  if (
    hotel.error ||
    rooms.error ||
    occupancy.error ||
    roomTypes.error ||
    occupants.error
  )
    return (
      <PageError message="Unable to load rooms and current occupants. Apply the latest room-management migration and check access." />
    );
  if (!hotel.data)
    return <EmptyState>No hotel is assigned to your staff account.</EmptyState>;

  const roomCounts = {
    total: rooms.data?.length ?? 0,
    available:
      rooms.data?.filter((room) => room.status === "available").length ?? 0,
    occupied:
      rooms.data?.filter((room) => room.status === "occupied").length ?? 0,
    dirty: rooms.data?.filter((room) => room.status === "dirty").length ?? 0,
    unavailable:
      rooms.data?.filter((room) => room.status === "blocked").length ?? 0,
  };
  const visibleRooms = (rooms.data ?? []).filter(
    (room) =>
      (statusFilter === "all" || room.status === statusFilter) &&
      (typeFilter === "all" || room.room_type_id === typeFilter) &&
      `${room.room_number} ${room.room_type_name}`
        .toLowerCase()
        .includes(roomSearch.toLowerCase()),
  );
  return (
    <section>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-amber-800">Operations</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Rooms and housekeeping
          </h1>
          <p className="mt-2 text-sm text-stone-600">
            See room readiness, current occupants, and housekeeping holds at a
            glance.
          </p>
        </div>
        {canManageRooms && (
          <button
            type="button"
            onClick={() => setShowInventorySetup((current) => !current)}
            className="inline-flex w-fit items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-xs font-semibold shadow-sm hover:bg-stone-50"
          >
            {showInventorySetup ? (
              <X className="size-4" />
            ) : (
              <Settings2 className="size-4" />
            )}
            {showInventorySetup ? "Close setup" : "Manage inventory"}
          </button>
        )}
      </div>
      {message && (
        <p
          className="mt-4 rounded-lg bg-stone-100 p-3 text-sm text-stone-700"
          role="status"
        >
          {message}
        </p>
      )}
      {photos.error && (
        <p role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Room photos are unavailable. Room operations still work; check that the room-photo migration has been applied.
        </p>
      )}
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <article className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-stone-500">Total rooms</p>
            <BedDouble className="size-4 text-stone-400" />
          </div>
          <p className="mt-2 text-2xl font-semibold">{roomCounts.total}</p>
        </article>
        <button
          type="button"
          onClick={() => setStatusFilter("available")}
          className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-emerald-800">Available</p>
            <DoorOpen className="size-4 text-emerald-600" />
          </div>
          <p className="mt-2 text-2xl font-semibold text-emerald-900">
            {roomCounts.available}
          </p>
        </button>
        <button
          type="button"
          onClick={() => setStatusFilter("occupied")}
          className="rounded-2xl border border-amber-100 bg-amber-50/70 p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-amber-800">Occupied</p>
            <BedDouble className="size-4 text-amber-700" />
          </div>
          <p className="mt-2 text-2xl font-semibold text-amber-950">
            {roomCounts.occupied}
          </p>
        </button>
        <button
          type="button"
          onClick={() => setStatusFilter("dirty")}
          className="rounded-2xl border border-rose-100 bg-rose-50/70 p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-rose-800">
              Awaiting cleaning
            </p>
            <BrushCleaning className="size-4 text-rose-600" />
          </div>
          <p className="mt-2 text-2xl font-semibold text-rose-900">
            {roomCounts.dirty}
          </p>
        </button>
        <button
          type="button"
          onClick={() => setStatusFilter("blocked")}
          className="col-span-2 rounded-2xl border border-stone-200 bg-stone-100/80 p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md lg:col-span-1"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-stone-600">Unavailable</p>
            <CircleOff className="size-4 text-stone-500" />
          </div>
          <p className="mt-2 text-2xl font-semibold text-stone-800">
            {roomCounts.unavailable}
          </p>
        </button>
      </div>
      {canManageRooms && showInventorySetup && (
        <div className="mt-7 grid gap-4 lg:grid-cols-2">
          <form
            onSubmit={handleCreateType}
            className="grid gap-3 rounded-xl border border-stone-200 bg-white p-5 sm:grid-cols-4"
          >
            <h2 className="sm:col-span-4 font-semibold">Add room type</h2>
            <input
              required
              name="name"
              placeholder="Name"
              className="rounded-lg border border-stone-300 px-3 py-2.5 sm:col-span-2"
            />
            <input
              name="description"
              placeholder="Description"
              className="rounded-lg border border-stone-300 px-3 py-2.5 sm:col-span-2"
            />
            <input
              required
              name="rate"
              type="number"
              min="0"
              step="0.01"
              placeholder="Base rate (₦)"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <input
              required
              name="capacity"
              type="number"
              min="1"
              placeholder="Persons"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <input
              name="sizeSqft"
              type="number"
              min="1"
              placeholder="Size (sq ft)"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <FormSubmitButton
              disabled={busy}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 sm:col-span-2"
            >
              Add room type
            </FormSubmitButton>
          </form>
          <form
            onSubmit={handleCreateRoom}
            className="grid gap-3 rounded-xl border border-stone-200 bg-white p-5 sm:grid-cols-4"
          >
            <h2 className="sm:col-span-4 font-semibold">Add room</h2>
            <input
              required
              name="roomNumber"
              placeholder="Room number"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <select
              required
              name="roomTypeId"
              className="rounded-lg border border-stone-300 px-3 py-2.5 sm:col-span-2"
            >
              <option value="">Room type</option>
              {roomTypes.data
                ?.filter((type) => type.active)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
            </select>
            <input
              name="rateOverride"
              type="number"
              min="0"
              step="0.01"
              placeholder="Override rate (₦)"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <FormSubmitButton
              disabled={busy || !roomTypes.data?.some((type) => type.active)}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 sm:col-span-4"
            >
              Add room
            </FormSubmitButton>
          </form>
        </div>
      )}
      <h2 className="mt-8 text-xl font-semibold">Room types</h2>
      <p className="mt-1 text-sm text-stone-600">
        Nightly room rates include applicable tax.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {!roomTypes.data?.length ? (
          <EmptyState>No room types yet.</EmptyState>
        ) : (
          roomTypes.data.map((type) => (
            <article
              key={type.id}
              className={`overflow-hidden rounded-xl border bg-white ${type.active ? "border-stone-200" : "border-amber-200 bg-amber-50/40"}`}
            >
              {photos.data?.some((photo) => photo.room_type_id === type.id && photo.url) && (
                <button
                  type="button"
                  onClick={() => { setPhotoTarget({ kind: "room-types", id: type.id, label: type.name }); setPhotoMessage(null); }}
                  className="block w-full text-left"
                  aria-label={`View photos for ${type.name}`}
                >
                  <PhotoCover
                    photo={photos.data.find((photo) => photo.room_type_id === type.id && photo.url)}
                    label={`${type.name} room`}
                    className="aspect-[16/9]"
                  />
                </button>
              )}
              <div className="p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold">{type.name}</p>
                {!type.active && (
                  <span className="rounded-full bg-stone-200 px-2 py-1 text-xs font-semibold text-stone-700">
                    Inactive
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-stone-500">
                {type.capacity} persons ·{" "}
                {type.size_sqft ? `${type.size_sqft} sq ft · ` : ""}
                {formatNaira(type.base_rate_kobo)} / night
              </p>
              <button
                type="button"
                onClick={() => { setPhotoTarget({ kind: "room-types", id: type.id, label: type.name }); setPhotoMessage(null); }}
                className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-amber-900 hover:underline"
              >
                <Images className="size-3.5" /> {canManageRooms ? "Manage photos" : "View photos"}
              </button>
              {canManageRooms && (
                <button
                  type="button"
                  onClick={() => setEditingType(type)}
                  className="ml-3 mt-3 rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold"
                >
                  {type.active ? "Edit type" : "Reactivate / edit"}
                </button>
              )}
              </div>
            </article>
          ))
        )}
      </div>
      <h2 className="mt-8 text-xl font-semibold">Room board</h2>
      <p className="mt-1 text-sm text-stone-600">
        Today’s inventory by room type, followed by every individual room.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {occupancy.data?.map((summary) => (
          <article
            key={summary.room_type_id}
            className="rounded-xl border border-stone-200 bg-white p-4"
          >
            <p className="font-semibold">{summary.room_type_name}</p>
            <p className="mt-2 text-2xl font-semibold text-stone-900">
              {summary.total_room_count}
            </p>
            <p className="text-xs text-stone-500">rooms total</p>
            <p className="mt-3 text-sm text-stone-700">
              {summary.available_room_count} available ·{" "}
              {summary.occupied_room_count} occupied
            </p>
            <p className="mt-1 text-xs text-stone-500">
              {summary.reserved_room_count} reserved
              {summary.dirty_room_count > 0
                ? ` · ${summary.dirty_room_count} awaiting housekeeping`
                : ""}
              {summary.blocked_room_count > 0
                ? ` · ${summary.blocked_room_count} blocked`
                : ""}
            </p>
          </article>
        ))}
      </div>
      <section className="mt-7 rounded-xl border border-stone-200 bg-white p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-xl font-semibold">Current occupants</h2>
            <p className="mt-1 text-sm text-stone-600">
              Live check-in, expected checkout, and folio position for every
              occupied room.
            </p>
          </div>
          <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-700">
            {occupants.data?.length ?? 0} in house
          </span>
        </div>
        {!occupants.data?.length ? (
          <div className="mt-4">
            <EmptyState>No guests are currently checked in.</EmptyState>
          </div>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {occupants.data.map((occupant) => (
              <button
                key={occupant.stay_id}
                type="button"
                onClick={() => setOccupantTarget(occupant)}
                className={`rounded-lg border p-4 text-left transition hover:border-amber-500 ${occupant.departure_state === "overdue" ? "border-red-300 bg-red-50" : occupant.departure_state === "due_today" ? "border-amber-300 bg-amber-50" : "border-stone-200 bg-white"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">
                      Room {occupant.room_number} · {occupant.guest_name}
                    </p>
                    <p className="mt-1 text-xs text-stone-600">
                      {occupant.room_type_name}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${occupant.departure_state === "overdue" ? "bg-red-100 text-red-800" : occupant.departure_state === "due_today" ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-800"}`}
                  >
                    {occupant.departure_state === "overdue"
                      ? `${occupant.days_overdue} day${occupant.days_overdue === 1 ? "" : "s"} overdue`
                      : occupant.departure_state === "due_today"
                        ? "Due today"
                        : "In house"}
                  </span>
                </div>
                <p className="mt-3 text-sm text-stone-700">
                  Checked in {occupant.actual_check_in_date} · Checkout{" "}
                  {occupant.expected_check_out_date}
                </p>
                <p
                  className={`mt-2 text-sm font-semibold ${occupant.balance_kobo > 0 ? "text-red-700" : "text-stone-900"}`}
                >
                  {occupant.balance_kobo > 0
                    ? `${formatNaira(occupant.balance_kobo)} due`
                    : occupant.balance_kobo < 0
                      ? `${formatNaira(Math.abs(occupant.balance_kobo))} guest credit`
                      : "Folio settled"}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="mt-7">
        <div className="flex flex-col gap-3 rounded-2xl border border-stone-200/80 bg-white p-3 shadow-sm sm:flex-row">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
            <input
              value={roomSearch}
              onChange={(event) => setRoomSearch(event.target.value)}
              placeholder="Search room number or type"
              className="w-full rounded-xl border border-stone-200 py-2.5 pl-9 pr-3 text-sm"
            />
          </label>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="rounded-xl border border-stone-200 px-3 py-2.5 text-sm"
          >
            <option value="all">All statuses</option>
            <option value="available">Available</option>
            <option value="reserved">Reserved</option>
            <option value="occupied">Occupied</option>
            <option value="dirty">Awaiting cleaning</option>
            <option value="blocked">Unavailable</option>
          </select>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            className="rounded-xl border border-stone-200 px-3 py-2.5 text-sm"
          >
            <option value="all">All room types</option>
            {roomTypes.data
              ?.filter((type) => type.active)
              .map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
          </select>
          {(statusFilter !== "all" || typeFilter !== "all" || roomSearch) && (
            <button
              type="button"
              onClick={() => {
                setStatusFilter("all");
                setTypeFilter("all");
                setRoomSearch("");
              }}
              className="rounded-xl border border-stone-200 px-3 py-2.5 text-xs font-semibold hover:bg-stone-50"
            >
              Clear filters
            </button>
          )}
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
          {!rooms.data?.length ? (
            <EmptyState>No rooms exist yet.</EmptyState>
          ) : (
            visibleRooms.map((room) => {
              const activeMaintenanceTicket = maintenance.data?.find(
                (ticket) =>
                  ticket.room_id === room.id &&
                  ["open", "in_progress"].includes(ticket.status),
              );
              return (
                <article
                  key={room.id}
                  className={`rounded-2xl border bg-white p-3 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md sm:p-4 ${room.status === "dirty" ? "border-rose-200" : room.status === "occupied" ? "border-amber-200" : room.status === "available" ? "border-emerald-100" : "border-stone-200"}`}
                >
                  {coverForRoom(room) && (
                    <button
                      type="button"
                      onClick={() => { setPhotoTarget({ kind: "rooms", id: room.id, label: `Room ${room.room_number}` }); setPhotoMessage(null); }}
                      className="mb-3 block w-full overflow-hidden rounded-xl text-left"
                      aria-label={`View photos for room ${room.room_number}`}
                    >
                      <PhotoCover photo={coverForRoom(room)} label={`Room ${room.room_number}`} className="aspect-[16/9]" />
                    </button>
                  )}
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-xl font-semibold">{room.room_number}</p>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusClass[room.status]}`}
                    >
                      {room.status}
                    </span>
                  </div>
                  <p className="mt-4 text-sm text-stone-600">
                    {room.room_type_name} · {room.capacity} persons
                    {room.size_sqft ? ` · ${room.size_sqft} sq ft` : ""}
                  </p>
                  <p className="mt-1 text-sm font-medium text-stone-900">
                    {formatNaira(room.current_rate_kobo)} / night
                  </p>
                  {activeMaintenanceTicket && (
                    <Link
                      to="/maintenance"
                      className="mt-3 flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-900 hover:bg-orange-100"
                    >
                      <Wrench className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        <span className="block font-semibold">
                          Maintenance{" "}
                          {activeMaintenanceTicket.status.replace("_", " ")}
                        </span>
                        <span className="mt-0.5 line-clamp-2 block">
                          {activeMaintenanceTicket.description}
                        </span>
                      </span>
                    </Link>
                  )}
                  {(room.status === "blocked" || room.status === "dirty") &&
                    room.blocked_reason && (
                      <p className="mt-3 rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-700">
                        <span className="font-semibold">
                          {room.status === "dirty" ? "Status:" : "Reason:"}
                        </span>{" "}
                        {room.blocked_reason}
                      </p>
                    )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => { setPhotoTarget({ kind: "rooms", id: room.id, label: `Room ${room.room_number}` }); setPhotoMessage(null); }}
                      className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold"
                    >
                      {canManageRooms ? "Manage photos" : "View photos"}
                    </button>
                    {room.status === "occupied" && (
                      <button
                        type="button"
                        onClick={() =>
                          setOccupantTarget(
                            occupants.data?.find(
                              (occupant) => occupant.room_id === room.id,
                            ) ?? null,
                          )
                        }
                        className="rounded-lg bg-amber-900 px-3 py-2 text-xs font-semibold text-white"
                      >
                        View occupant
                      </button>
                    )}
                    {room.status === "dirty" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setTurnoverTarget(room)}
                        className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                      >
                        Mark clean
                      </button>
                    )}
                    {canManageRooms && (
                      <>
                        {room.status === "dirty" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setTurnoverOverrideTarget(room)}
                            className="rounded-lg border border-amber-300 px-3 py-2 text-xs font-semibold text-amber-900 disabled:opacity-60"
                          >
                            Override housekeeping hold
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditingRoom(room)}
                          className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold"
                        >
                          Edit
                        </button>
                        {!room.is_maintenance_out_of_service &&
                          (room.status === "blocked" ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleUnblock(room)}
                              className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold"
                            >
                              Unblock
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setBlockTarget(room)}
                              className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700"
                            >
                              Block
                            </button>
                          ))}
                      </>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>
        {rooms.data?.length && !visibleRooms.length ? (
          <div className="mt-4">
            <EmptyState>No rooms match the selected filters.</EmptyState>
          </div>
        ) : null}
      </section>
      <Modal
        open={Boolean(photoTarget)}
        title={`${photoTarget?.label ?? "Room"} photos`}
        onClose={() => { if (!photoBusy) setPhotoTarget(null); }}
        size="wide"
      >
        {photoTarget && (() => {
          const ownPhotos = targetPhotos(photoTarget);
          const pendingPhotos = (photos.data ?? []).filter((photo) =>
            Boolean(photo.deletion_pending_at) &&
            (photoTarget.kind === "room-types" ? photo.room_type_id === photoTarget.id : photo.room_id === photoTarget.id),
          );
          const room = photoTarget.kind === "rooms" ? rooms.data?.find((item) => item.id === photoTarget.id) : undefined;
          const inherited = room ? (photos.data ?? []).filter((photo) => !photo.deletion_pending_at && photo.room_type_id === room.room_type_id) : [];
          const displayPhotos = ownPhotos.length ? ownPhotos : inherited;
          const limit = photoTarget.kind === "room-types" ? 6 : 4;
          return (
            <div>
              <p className="text-sm text-stone-600">
                {photoTarget.kind === "rooms"
                  ? "Room-specific photos take precedence over room-type photos. Photos are optional and do not change room readiness."
                  : "These photos are used for rooms of this type unless a room has its own photos."}
              </p>
              {ownPhotos.length === 0 && inherited.length > 0 && (
                <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Showing room-type photos for this room.</p>
              )}
              {canManageRooms && pendingPhotos.length > 0 && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                  <p className="font-semibold">{pendingPhotos.length} photo removal{pendingPhotos.length === 1 ? "" : "s"} needs to finish.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {pendingPhotos.map((photo) => (
                      <button key={photo.id} type="button" disabled={photoBusy}
                        onClick={() => void handlePhotoDelete(photo)}
                        className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-semibold disabled:opacity-50">
                        Finish removal
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {displayPhotos.length ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {displayPhotos.map((photo, index) => (
                    <div key={photo.id} className="overflow-hidden rounded-xl border border-stone-200">
                      {photo.url ? (
                        <img src={photo.url} alt={`${photoTarget.label} photo ${index + 1}`} className="aspect-[16/10] w-full object-cover" />
                      ) : (
                        <PhotoCover label={`${photoTarget.label} photo unavailable`} className="aspect-[16/10]" />
                      )}
                      <div className="flex items-center justify-between gap-2 p-3 text-xs text-stone-600">
                        <span>{index === 0 ? "Cover photo" : `Photo ${index + 1}`}</span>
                        {canManageRooms && ownPhotos.some((item) => item.id === photo.id) && (
                          <button
                            type="button"
                            disabled={photoBusy}
                            onClick={() => {
                              if (window.confirm("Remove this room photo?")) void handlePhotoDelete(photo);
                            }}
                            className="font-semibold text-red-700 hover:underline disabled:opacity-50"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-4 rounded-xl border border-dashed border-stone-300 p-8 text-center text-sm text-stone-600">No photos yet. Rooms remain fully usable without them.</div>
              )}
              {canManageRooms && (
                <div className="mt-5 rounded-xl border border-stone-200 bg-stone-50 p-4">
                  <label className="block text-sm font-semibold" htmlFor="room-photo-upload">Add a photo ({ownPhotos.length}/{limit})</label>
                  <p className="mt-1 text-xs text-stone-600">JPEG, PNG, or WebP; maximum 5 MB. Do not upload guest details or maintenance evidence here.</p>
                  <input
                    id="room-photo-upload"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={photoBusy || ownPhotos.length >= limit}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      void handlePhotoUpload(file);
                    }}
                    className="mt-3 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-amber-900 file:px-4 file:py-2 file:font-semibold file:text-white disabled:opacity-50"
                  />
                  {ownPhotos.length >= limit && <p className="mt-2 text-xs text-amber-900">Remove a photo before adding another.</p>}
                </div>
              )}
              {photoBusy && <p role="status" className="mt-3 text-sm text-stone-600">Updating photos…</p>}
              {photoMessage && <p role="status" className="mt-3 text-sm text-stone-700">{photoMessage}</p>}
            </div>
          );
        })()}
      </Modal>
      <Modal
        open={Boolean(editingType)}
        title="Edit room type"
        onClose={() => setEditingType(null)}
      >
        {editingType && (
          <form onSubmit={handleEditType} className="grid gap-3">
            <input
              required
              name="name"
              defaultValue={editingType.name}
              placeholder="Name"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <input
              name="description"
              placeholder="Description"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <input
              required
              name="rate"
              type="number"
              min="0"
              step="0.01"
              defaultValue={(editingType.base_rate_kobo / 100).toFixed(2)}
              placeholder="Base rate (₦)"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <input
              required
              name="capacity"
              type="number"
              min="1"
              defaultValue={editingType.capacity}
              placeholder="Persons"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <input
              name="sizeSqft"
              type="number"
              min="1"
              defaultValue={editingType.size_sqft ?? ""}
              placeholder="Size (sq ft)"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                name="active"
                type="checkbox"
                defaultChecked={editingType.active}
              />{" "}
              Active
            </label>
            <FormSubmitButton
              disabled={busy}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
            >
              Save changes
            </FormSubmitButton>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(editingRoom)}
        title="Edit room"
        onClose={() => setEditingRoom(null)}
      >
        {editingRoom && (
          <form onSubmit={handleEditRoom} className="grid gap-3">
            <input
              required
              name="roomNumber"
              defaultValue={editingRoom.room_number}
              placeholder="Room number"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <select
              required
              name="roomTypeId"
              defaultValue={editingRoom.room_type_id}
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            >
              {roomTypes.data?.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
            <input
              name="rateOverride"
              type="number"
              min="0"
              step="0.01"
              placeholder="Override rate (₦)"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <label className="flex items-center gap-2 text-sm">
              <input name="active" type="checkbox" defaultChecked /> Active
            </label>
            <FormSubmitButton
              disabled={busy}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
            >
              Save changes
            </FormSubmitButton>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(blockTarget)}
        title="Block room"
        onClose={() => setBlockTarget(null)}
      >
        {blockTarget && (
          <form onSubmit={handleBlock} className="grid gap-3">
            <p className="text-sm text-stone-600">
              Room {blockTarget.room_number} will be unavailable until it is
              unblocked.
            </p>
            <textarea
              required
              name="reason"
              rows={4}
              placeholder="Reason for blocking"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <FormSubmitButton
              disabled={busy}
              className="rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white"
            >
              Block room
            </FormSubmitButton>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(turnoverTarget)}
        title="Complete room turnover"
        onClose={() => setTurnoverTarget(null)}
      >
        {turnoverTarget && (
          <form onSubmit={handleCompleteTurnover} className="grid gap-3">
            <p className="text-sm text-stone-600">
              Confirm that room {turnoverTarget.room_number} has been cleaned
              and is ready for its next guest.
            </p>
            <textarea
              name="notes"
              rows={3}
              placeholder="Cleaning or inspection notes (optional)"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <FormSubmitButton
              disabled={busy}
              className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white"
            >
              Mark room clean
            </FormSubmitButton>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(turnoverOverrideTarget)}
        title="Override housekeeping hold"
        onClose={() => setTurnoverOverrideTarget(null)}
      >
        {turnoverOverrideTarget && (
          <form onSubmit={handleTurnoverOverride} className="grid gap-3">
            <p className="text-sm text-stone-600">
              Use only after personally confirming room{" "}
              {turnoverOverrideTarget.room_number} is ready. This will be
              recorded as a management override.
            </p>
            <textarea
              required
              name="reason"
              rows={4}
              placeholder="Reason for overriding the housekeeping hold"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <FormSubmitButton
              disabled={busy}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
            >
              Record override and release room
            </FormSubmitButton>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(occupantTarget)}
        title={
          occupantTarget
            ? `Room ${occupantTarget.room_number} occupant`
            : "Room occupant"
        }
        onClose={() => setOccupantTarget(null)}
      >
        {occupantTarget && (
          <div className="space-y-4">
            <div
              className={`rounded-lg border p-4 ${occupantTarget.departure_state === "overdue" ? "border-red-300 bg-red-50" : occupantTarget.departure_state === "due_today" ? "border-amber-300 bg-amber-50" : "border-stone-200 bg-stone-50"}`}
            >
              <p className="font-semibold">{occupantTarget.guest_name}</p>
              <p className="mt-1 text-sm text-stone-600">
                {occupantTarget.room_type_name} · Room{" "}
                {occupantTarget.room_number}
              </p>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-stone-500">Checked in</dt>
                <dd className="font-medium">
                  {occupantTarget.actual_check_in_date}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Expected checkout</dt>
                <dd className="font-medium">
                  {occupantTarget.expected_check_out_date}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Phone</dt>
                <dd className="font-medium">
                  {occupantTarget.guest_phone || "Not recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Email</dt>
                <dd className="break-all font-medium">
                  {occupantTarget.guest_email || "Not recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Folio</dt>
                <dd className="font-medium">
                  <Link
                    to={`/folios?folio=${encodeURIComponent(occupantTarget.folio_id)}`}
                    className="text-amber-800 underline decoration-amber-300 underline-offset-2 hover:text-amber-950"
                    onClick={() => setOccupantTarget(null)}
                  >
                    {occupantTarget.folio_number}
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Balance</dt>
                <dd
                  className={`font-semibold ${occupantTarget.balance_kobo > 0 ? "text-red-700" : ""}`}
                >
                  {occupantTarget.balance_kobo > 0
                    ? `${formatNaira(occupantTarget.balance_kobo)} due`
                    : occupantTarget.balance_kobo < 0
                      ? `${formatNaira(Math.abs(occupantTarget.balance_kobo))} guest credit`
                      : "Settled"}
                </dd>
              </div>
            </dl>
            {occupantTarget.departure_state === "overdue" && (
              <p className="rounded-lg bg-red-100 p-3 text-sm font-semibold text-red-900">
                {occupantTarget.balance_kobo > 0
                  ? "Collect the outstanding payment and complete checkout."
                  : "The expected checkout date has passed. Complete checkout or update the stay."}
              </p>
            )}
            {occupantTarget.departure_state === "due_today" &&
              occupantTarget.balance_kobo > 0 && (
                <p className="rounded-lg bg-amber-100 p-3 text-sm font-semibold text-amber-900">
                  Payment is due before today’s checkout.
                </p>
              )}
            {canMoveGuests && (
              <div className="flex flex-wrap justify-end gap-2 border-t border-stone-200 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setExtensionTarget(occupantTarget);
                    setOccupantTarget(null);
                  }}
                  className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-800 hover:bg-stone-50"
                >
                  Extend stay
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRoomMoveTarget(occupantTarget);
                    setOccupantTarget(null);
                  }}
                  className="rounded-xl border border-amber-800 px-4 py-2.5 text-sm font-semibold text-amber-900 hover:bg-amber-50"
                >
                  Move guest to another room
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(roomMoveTarget)}
        title={roomMoveTarget ? `Move ${roomMoveTarget.guest_name}` : "Move guest"}
        onClose={() => !busy && setRoomMoveTarget(null)}
      >
        {roomMoveTarget && (
          <form onSubmit={handleRoomMove} className="space-y-4">
            <div className="rounded-xl bg-stone-50 p-4 text-sm">
              <p className="font-semibold">
                Current room: {roomMoveTarget.room_number} · {roomMoveTarget.room_type_name}
              </p>
              <p className="mt-1 text-stone-600">
                The existing stay, folio, posted charges, and current nightly rate will be preserved.
                Room {roomMoveTarget.room_number} will be marked dirty for housekeeping.
              </p>
            </div>
            <label className="block text-sm font-medium text-stone-700">
              Destination room
              <select
                required
                name="roomId"
                defaultValue=""
                className="mt-2 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5"
              >
                <option value="">Choose a clean available room</option>
                {rooms.data
                  ?.filter(
                    (room) =>
                      room.id !== roomMoveTarget.room_id &&
                      room.status === "available" &&
                      room.turnover_status === "clean" &&
                      !room.is_maintenance_out_of_service,
                  )
                  .map((room) => (
                    <option key={room.id} value={room.id}>
                      Room {room.room_number} · {room.room_type_name} · {formatNaira(room.current_rate_kobo)} standard rate
                    </option>
                  ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-stone-700">
              Reason for move
              <textarea
                required
                name="reason"
                rows={3}
                placeholder="For example: air-conditioner fault reported by guest"
                className="mt-2 w-full rounded-xl border border-stone-300 px-3 py-2.5"
              />
            </label>
            <p className="text-xs leading-5 text-stone-500">
              A destination with a conflicting reservation will be rejected even if it currently appears available.
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={busy}
                onClick={() => setRoomMoveTarget(null)}
                className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
              >
                Cancel
              </button>
              <FormSubmitButton
                disabled={busy}
                className="rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
              >
                {busy ? "Moving guest…" : "Confirm room move"}
              </FormSubmitButton>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(extensionTarget)}
        title={extensionTarget ? `Extend ${extensionTarget.guest_name}'s stay` : "Extend stay"}
        onClose={() => !busy && setExtensionTarget(null)}
      >
        {extensionTarget && (
          <form onSubmit={handleStayExtension} className="space-y-4">
            <div className="rounded-xl bg-stone-50 p-4 text-sm">
              <p className="font-semibold">
                Room {extensionTarget.room_number} · Current checkout {extensionTarget.expected_check_out_date}
              </p>
              <p className="mt-1 text-stone-600">
                The room will be checked for conflicting reservations before the extension is accepted.
              </p>
            </div>
            <label className="block text-sm font-medium text-stone-700">
              New checkout date
              <input
                required
                name="checkOutDate"
                type="date"
                min={extensionTarget.expected_check_out_date}
                className="mt-2 w-full rounded-xl border border-stone-300 px-3 py-2.5"
              />
            </label>
            {canManageRooms && (
              <label className="block text-sm font-medium text-stone-700">
                Extension nightly rate (optional, naira)
                <input
                  name="extensionRate"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Leave blank to continue the current rate"
                  className="mt-2 w-full rounded-xl border border-stone-300 px-3 py-2.5"
                />
                <span className="mt-1 block text-xs font-normal text-stone-500">
                  A different rate starts on the original checkout date and cannot change posted nights.
                </span>
              </label>
            )}
            <label className="block text-sm font-medium text-stone-700">
              Reason for extension
              <textarea
                required
                name="reason"
                rows={3}
                placeholder="For example: guest requested two additional nights"
                className="mt-2 w-full rounded-xl border border-stone-300 px-3 py-2.5"
              />
            </label>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={busy}
                onClick={() => setExtensionTarget(null)}
                className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
              >
                Cancel
              </button>
              <FormSubmitButton
                disabled={busy}
                className="rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
              >
                {busy ? "Extending stay…" : "Confirm extension"}
              </FormSubmitButton>
            </div>
          </form>
        )}
      </Modal>
    </section>
);
}
