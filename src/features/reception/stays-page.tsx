import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DoorOpen, Plus, Search, TriangleAlert } from "lucide-react";

import { Modal } from "@/components/shared/modal";
import {
  EmptyState,
  PageError,
  PageLoading,
} from "@/components/shared/page-state";
import { formatNaira } from "@/lib/money";

import {
  checkInReservation,
  createWalkInStay,
  type Reservation,
} from "./reception-service";
import { invalidateHotelOperationalQueries } from "./query-invalidation";
import { useActiveHotel, useReservations, useRoomBoard } from "./use-reception";

function localIsoDate() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function StaysPage() {
  const hotel = useActiveHotel();
  const reservations = useReservations(hotel.data?.id);
  const rooms = useRoomBoard(hotel.data?.id);
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isWalkInOpen, setIsWalkInOpen] = useState(false);
  const [walkInRoomId, setWalkInRoomId] = useState("");
  const [walkInDiscount, setWalkInDiscount] = useState("0");
  const [search, setSearch] = useState("");
  const [arrivalFilter, setArrivalFilter] = useState<
    "today" | "late" | "upcoming" | "all"
  >("today");
  const [checkInTarget, setCheckInTarget] = useState<Reservation | null>(null);
  const eligible =
    reservations.data?.filter(
      (reservation) =>
        ["pending", "confirmed"].includes(reservation.status) &&
        reservation.rooms,
    ) ?? [];
  const selectedWalkInRoom = rooms.data?.find(
    (room) => room.id === walkInRoomId,
  );
  const walkInDiscountRate = Number(walkInDiscount);
  const walkInFinalRate = selectedWalkInRoom
    ? Math.round(
        (selectedWalkInRoom.current_rate_kobo * (100 - walkInDiscountRate)) /
          100,
      )
    : 0;

  async function handleCheckIn(reservationId: string) {
    if (!hotel.data) return;
    setBusyId(reservationId);
    setMessage(null);
    try {
      await checkInReservation(reservationId);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["reservations", hotel.data?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["room-board", hotel.data?.id],
        }),
        queryClient.invalidateQueries({ queryKey: ["folios", hotel.data?.id] }),
        invalidateHotelOperationalQueries(queryClient, hotel.data.id),
      ]);
      setMessage(
        "Guest checked in. An open folio and rate period were created.",
      );
      setCheckInTarget(null);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Check-in could not be completed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function handleWalkIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hotel.data) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusyId("walk-in");
    setMessage(null);
    try {
      await createWalkInStay({
        hotelId: hotel.data.id,
        fullName: String(form.get("fullName")),
        phone: String(form.get("phone")),
        email: String(form.get("email")),
        roomId: String(form.get("roomId")),
        checkInDate: String(form.get("checkInDate")),
        checkOutDate: String(form.get("checkOutDate")),
        rateKobo: walkInFinalRate,
      });
      formElement.reset();
      setWalkInRoomId("");
      setWalkInDiscount("0");
      setIsWalkInOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["reservations", hotel.data.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["room-board", hotel.data.id],
        }),
        queryClient.invalidateQueries({ queryKey: ["folios", hotel.data.id] }),
        invalidateHotelOperationalQueries(queryClient, hotel.data.id),
      ]);
      setMessage("Walk-in guest checked in. An open folio was created.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Walk-in check-in could not be completed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  if (hotel.isLoading || reservations.isLoading || rooms.isLoading)
    return <PageLoading />;
  if (hotel.error || reservations.error || rooms.error)
    return <PageError message="Unable to load check-in data." />;
  if (!hotel.data)
    return <EmptyState>No hotel is assigned to your staff account.</EmptyState>;
  const today = localIsoDate();
  const lateArrivals = eligible.filter(
    (reservation) => reservation.check_in_date < today,
  );
  const todayArrivals = eligible.filter(
    (reservation) => reservation.check_in_date === today,
  );
  const upcomingArrivals = eligible.filter(
    (reservation) => reservation.check_in_date > today,
  );
  const visibleArrivals = eligible.filter((reservation) => {
    const matchesSearch =
      `${reservation.reservation_number} ${reservation.guests?.full_name ?? ""} ${reservation.rooms?.room_number ?? ""}`
        .toLowerCase()
        .includes(search.trim().toLowerCase());
    const matchesFilter =
      arrivalFilter === "all" ||
      (arrivalFilter === "today" && reservation.check_in_date === today) ||
      (arrivalFilter === "late" && reservation.check_in_date < today) ||
      (arrivalFilter === "upcoming" && reservation.check_in_date > today);
    return matchesSearch && matchesFilter;
  });

  return (
    <section className="max-w-6xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-amber-800">Reception</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Arrivals and check-in
          </h1>
          <p className="mt-2 text-sm text-stone-600">
            Confirm the guest, assigned room and stay dates before opening a
            folio.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsWalkInOpen(true)}
          className="inline-flex w-fit items-center gap-2 rounded-xl bg-amber-900 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-amber-950"
        >
          <Plus className="size-4" /> Walk-in check-in
        </button>
      </div>
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => setArrivalFilter("today")}
          className={`rounded-2xl border p-4 text-left shadow-sm ${arrivalFilter === "today" ? "border-amber-300 bg-amber-50" : "border-stone-200 bg-white"}`}
        >
          <p className="text-xs text-stone-500">Due today</p>
          <p className="mt-1 text-2xl font-semibold text-amber-900">
            {todayArrivals.length}
          </p>
        </button>
        <button
          type="button"
          onClick={() => setArrivalFilter("late")}
          className={`rounded-2xl border p-4 text-left shadow-sm ${arrivalFilter === "late" ? "border-red-300 bg-red-50" : "border-stone-200 bg-white"}`}
        >
          <p className="text-xs text-stone-500">Late arrivals</p>
          <p className="mt-1 text-2xl font-semibold text-red-700">
            {lateArrivals.length}
          </p>
        </button>
        <button
          type="button"
          onClick={() => setArrivalFilter("upcoming")}
          className={`col-span-2 rounded-2xl border p-4 text-left shadow-sm sm:col-span-1 ${arrivalFilter === "upcoming" ? "border-sky-300 bg-sky-50" : "border-stone-200 bg-white"}`}
        >
          <p className="text-xs text-stone-500">Upcoming</p>
          <p className="mt-1 text-2xl font-semibold text-sky-800">
            {upcomingArrivals.length}
          </p>
        </button>
      </div>
      {message && (
        <p
          className="mt-5 rounded-lg bg-stone-100 p-4 text-sm text-stone-700"
          role="status"
        >
          {message}
        </p>
      )}
      <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-stone-200 bg-white p-3 shadow-sm sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search arrivals</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search guest, reservation or room"
            className="w-full rounded-xl border border-stone-200 bg-stone-50 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-amber-500 focus:bg-white"
          />
        </label>
        <button
          type="button"
          onClick={() => setArrivalFilter("all")}
          className={`rounded-xl px-4 py-2.5 text-sm font-semibold ${arrivalFilter === "all" ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100"}`}
        >
          All arrivals ({eligible.length})
        </button>
      </div>
      <div className="mt-4 space-y-3">
        {!eligible.length ? (
          <EmptyState>
            No confirmed reservations with assigned rooms are ready for
            check-in.
          </EmptyState>
        ) : !visibleArrivals.length ? (
          <EmptyState>No arrivals match this view.</EmptyState>
        ) : (
          visibleArrivals.map((reservation) => (
            <article
              key={reservation.id}
              className={`flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-5 shadow-sm ${reservation.check_in_date < today ? "border-red-200 bg-red-50" : reservation.check_in_date > today ? "border-sky-200 bg-sky-50/60" : "border-stone-200 bg-white"}`}
            >
              <div className="flex min-w-0 items-start gap-3">
                <span
                  className={`grid size-10 shrink-0 place-items-center rounded-xl ${reservation.check_in_date < today ? "bg-red-100 text-red-700" : reservation.check_in_date > today ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-900"}`}
                >
                  {reservation.check_in_date < today ? (
                    <TriangleAlert className="size-5" />
                  ) : (
                    <DoorOpen className="size-5" />
                  )}
                </span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">
                      {reservation.guests?.full_name}
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${reservation.check_in_date < today ? "bg-red-100 text-red-800" : reservation.check_in_date > today ? "bg-sky-100 text-sky-800" : "bg-amber-100 text-amber-900"}`}
                    >
                      {reservation.check_in_date < today
                        ? "Late arrival"
                        : reservation.check_in_date > today
                          ? "Upcoming"
                          : "Due today"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-stone-600">
                    Room {reservation.rooms?.room_number} ·{" "}
                    {reservation.room_types?.name}
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    {reservation.reservation_number} ·{" "}
                    {reservation.check_in_date} to {reservation.check_out_date}
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={
                  busyId === reservation.id || reservation.check_in_date > today
                }
                onClick={() => setCheckInTarget(reservation)}
                className="rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-500"
              >
                {busyId === reservation.id
                  ? "Checking in…"
                  : reservation.check_in_date > today
                    ? "Not due yet"
                    : "Review check-in"}
              </button>
            </article>
          ))
        )}
      </div>
      <Modal
        open={Boolean(checkInTarget)}
        title="Confirm guest check-in"
        onClose={() => !busyId && setCheckInTarget(null)}
      >
        {checkInTarget && (
          <div className="space-y-4">
            {checkInTarget.check_in_date < today && (
              <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                This reservation is overdue. Confirm the guest is arriving now
                before continuing.
              </div>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-2xl bg-stone-50 p-4 text-sm">
              <div className="col-span-2">
                <dt className="text-stone-500">Guest</dt>
                <dd className="font-semibold text-stone-950">
                  {checkInTarget.guests?.full_name}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Room</dt>
                <dd className="font-medium">
                  {checkInTarget.rooms?.room_number} ·{" "}
                  {checkInTarget.room_types?.name}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Rate</dt>
                <dd className="font-medium">
                  {formatNaira(checkInTarget.agreed_rate_kobo)} / night
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Check-in</dt>
                <dd className="font-medium">{checkInTarget.check_in_date}</dd>
              </div>
              <div>
                <dt className="text-stone-500">Check-out</dt>
                <dd className="font-medium">{checkInTarget.check_out_date}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-stone-500">Reservation</dt>
                <dd className="font-medium">
                  {checkInTarget.reservation_number}
                </dd>
              </div>
            </dl>
            <p className="text-sm text-stone-600">
              Confirming will mark the room occupied and create the guest's open
              folio and rate period.
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={Boolean(busyId)}
                onClick={() => setCheckInTarget(null)}
                className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={Boolean(busyId)}
                onClick={() => handleCheckIn(checkInTarget.id)}
                className="rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
              >
                {busyId === checkInTarget.id
                  ? "Checking in…"
                  : "Confirm check-in"}
              </button>
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={isWalkInOpen}
        title="Walk-in check-in"
        onClose={() => setIsWalkInOpen(false)}
      >
        <form onSubmit={handleWalkIn} className="grid gap-3">
          <input
            required
            name="fullName"
            placeholder="Guest full name"
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          />
          <input
            name="phone"
            placeholder="Phone"
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          />
          <input
            name="email"
            type="email"
            placeholder="Email"
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          />
          <label className="text-sm text-stone-600">
            Room
            <select
              required
              name="roomId"
              value={walkInRoomId}
              onChange={(event) => setWalkInRoomId(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5"
            >
              <option value="">Available room and standard rate</option>
              {rooms.data
                ?.filter((room) => room.status === "available")
                .map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.room_number} — {room.room_type_name} —{" "}
                    {formatNaira(room.current_rate_kobo)} / night
                  </option>
                ))}
            </select>
          </label>
          <label className="text-sm text-stone-600">
            Reception discount
            <select
              name="discountRate"
              value={walkInDiscount}
              onChange={(event) => setWalkInDiscount(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5"
            >
              <option value="0">No discount</option>
              <option value="5">5% discount</option>
              <option value="10">10% discount</option>
              <option value="15">15% discount</option>
              <option value="20">20% discount</option>
            </select>
          </label>
          <p className="rounded-lg bg-stone-50 p-3 text-sm text-stone-600">
            Standard rate:{" "}
            {selectedWalkInRoom
              ? formatNaira(selectedWalkInRoom.current_rate_kobo)
              : "Choose a room"}{" "}
            / night
            <br />
            Final rate:{" "}
            <span className="font-semibold text-stone-950">
              {selectedWalkInRoom
                ? formatNaira(walkInFinalRate)
                : "Choose a room"}{" "}
              / night
            </span>
          </p>
          <p className="text-xs text-stone-500">
            A walk-in discount above 20% must be prepared and approved as a
            reservation before check-in.
          </p>
          <label className="text-sm text-stone-600">
            Check-in
            <input
              required
              name="checkInDate"
              type="date"
              defaultValue={today}
              className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5"
            />
          </label>
          <label className="text-sm text-stone-600">
            Check-out
            <input
              required
              name="checkOutDate"
              type="date"
              className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5"
            />
          </label>
          <button
            disabled={busyId === "walk-in" || !selectedWalkInRoom}
            className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busyId === "walk-in" ? "Checking in…" : "Check in walk-in"}
          </button>
        </form>
      </Modal>
    </section>
  );
}
