import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import type { Reservation, ReservationBusinessAuthorization, ReservationCancellationPolicy, RoomBoardItem } from "./reception-service";
import { ReservationDetailsModal } from "./reservation-details-modal";
import type { ReservationAction } from "./reservation-actions";
import { reservationMatchesSearch } from "./reservation-search";
import { getRackReservations, getUnassignedRackReservations } from "./reservation-rack-data";

const WINDOW_DAYS = 14;

function parseDate(value: string) {
  return new Date(`${value}T00:00:00`);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toIsoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function differenceInDays(later: Date, earlier: Date) {
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000);
}

function statusStyle(status: string) {
  if (status === "checked_in")
    return "border-emerald-300 bg-emerald-100 text-emerald-950";
  if (status === "confirmed") return "border-sky-300 bg-sky-100 text-sky-950";
  return "border-amber-300 bg-amber-100 text-amber-950";
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

export function ReservationRack({
  rooms,
  reservations,
  businessAuthorizations,
  canManageReservations,
  emailingReservationId,
  cancellationPolicy,
  nowMs,
  searchTerm,
  onAction,
}: {
  rooms: RoomBoardItem[];
  reservations: Reservation[];
  businessAuthorizations: ReservationBusinessAuthorization[];
  canManageReservations: boolean;
  emailingReservationId: string | null;
  cancellationPolicy?: ReservationCancellationPolicy | null;
  nowMs: number;
  searchTerm: string;
  onAction: (reservation: Reservation, action: ReservationAction) => void;
}) {
  const [windowStart, setWindowStart] = useState(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  });
  const [selected, setSelected] = useState<Reservation | null>(null);
  const dates = useMemo(
    () =>
      Array.from({ length: WINDOW_DAYS }, (_, index) =>
        addDays(windowStart, index),
      ),
    [windowStart],
  );
  const windowEnd = addDays(windowStart, WINDOW_DAYS);
  const rackReservations = getRackReservations(reservations, toIsoDate(windowStart), toIsoDate(windowEnd));
  const matchingRackReservations = rackReservations.filter((reservation) => reservationMatchesSearch(reservation, searchTerm));
  const unassignedReservations = getUnassignedRackReservations(rackReservations);
  const groupedRooms = Object.entries(
    rooms.reduce<Record<string, RoomBoardItem[]>>((groups, room) => {
      (groups[room.room_type_name] ??= []).push(room);
      return groups;
    }, {}),
  ).sort(([left], [right]) => left.localeCompare(right));
  const today = toIsoDate(new Date());

  function bookingsForRoom(roomId: string) {
    return rackReservations.filter(
      (reservation) => reservation.room_id === roomId,
    );
  }

  function resetToToday() {
    const next = new Date();
    next.setHours(0, 0, 0, 0);
    setWindowStart(next);
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-sm">
      <div className="flex flex-col gap-4 border-b border-stone-100 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold text-stone-900">Reservation rack</h2>
          <p className="mt-1 text-xs text-stone-500">
            Room-by-room booking position for the next {WINDOW_DAYS} days
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setWindowStart((date) => addDays(date, -7))}
            className="grid size-9 place-items-center rounded-lg border border-stone-200 hover:bg-stone-50"
            aria-label="Previous week"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            onClick={resetToToday}
            className="rounded-lg border border-stone-200 px-3 py-2 text-xs font-semibold hover:bg-stone-50"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setWindowStart((date) => addDays(date, 7))}
            className="grid size-9 place-items-center rounded-lg border border-stone-200 hover:bg-stone-50"
            aria-label="Next week"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2 border-b border-stone-100 px-4 py-3 text-xs text-stone-600">
        {[
          ["bg-amber-300", "Pending"],
          ["bg-sky-300", "Confirmed"],
          ["bg-emerald-300", "Checked in"],
        ].map(([colour, label]) => (
          <span key={label} className="flex items-center gap-2">
            <span className={`size-2.5 rounded-full ${colour}`} />
            {label}
          </span>
        ))}
      </div>

      {searchTerm.trim() && (
        <p className="border-b border-stone-100 bg-amber-50 px-4 py-3 text-sm text-amber-950" role="status">
          {matchingRackReservations.length
            ? `${matchingRackReservations.length} matching booking(s) in these 14 days. Other bookings remain visible so availability is not misleading.`
            : "No matching active bookings in these 14 days. Other bookings remain visible; switch to List to search full history."}
        </p>
      )}

      <div className="hidden overflow-x-auto lg:block">
        <div className="min-w-[86rem]">
          <div
            className="grid border-b border-stone-200 bg-stone-50/80"
            style={{
              gridTemplateColumns: `10rem repeat(${WINDOW_DAYS}, minmax(5.25rem, 1fr))`,
            }}
          >
            <div className="sticky left-0 z-20 border-r border-stone-200 bg-stone-50 px-4 py-3 text-xs font-semibold text-stone-500">
              Room
            </div>
            {dates.map((date) => {
              const iso = toIsoDate(date);
              return (
                <div
                  key={iso}
                  className={`border-r border-stone-200 px-2 py-2 text-center ${iso === today ? "bg-amber-50" : ""}`}
                >
                  <p className="text-[10px] font-bold uppercase tracking-wide text-stone-400">
                    {new Intl.DateTimeFormat("en", { weekday: "short" }).format(
                      date,
                    )}
                  </p>
                  <p
                    className={`mt-0.5 text-sm font-semibold ${iso === today ? "text-amber-900" : "text-stone-700"}`}
                  >
                    {date.getDate()}
                  </p>
                </div>
              );
            })}
          </div>
          {groupedRooms.map(([roomType, typeRooms]) => (
            <div key={roomType}>
              <div className="border-b border-stone-200 bg-stone-100/80 px-4 py-2 text-xs font-bold uppercase tracking-[0.12em] text-stone-500">
                {roomType} · {typeRooms.length} rooms
              </div>
              {typeRooms
                .sort((a, b) =>
                  a.room_number.localeCompare(b.room_number, undefined, {
                    numeric: true,
                  }),
                )
                .map((room) => (
                  <div
                    key={room.id}
                    className="grid min-h-14 border-b border-stone-100 last:border-b-0"
                    style={{
                      gridTemplateColumns: `10rem repeat(${WINDOW_DAYS}, minmax(5.25rem, 1fr))`,
                    }}
                  >
                    <div className="sticky left-0 z-10 flex items-center justify-between border-r border-stone-200 bg-white px-4 py-2">
                      <span className="text-sm font-semibold">
                        {room.room_number}
                      </span>
                      <span
                        className={`size-2 rounded-full ${room.status === "blocked" ? "bg-stone-400" : room.status === "dirty" ? "bg-rose-400" : "bg-emerald-400"}`}
                      />
                    </div>
                    {dates.map((date, index) => (
                      <div
                        key={toIsoDate(date)}
                        style={{ gridColumn: index + 2 }}
                        className={`border-r border-stone-100 ${toIsoDate(date) === today ? "bg-amber-50/50" : ""}`}
                      />
                    ))}
                    {bookingsForRoom(room.id).map((reservation) => {
                      const start = Math.max(
                        0,
                        differenceInDays(
                          parseDate(reservation.check_in_date),
                          windowStart,
                        ),
                      );
                      const end = Math.min(
                        WINDOW_DAYS,
                        differenceInDays(
                          parseDate(reservation.check_out_date),
                          windowStart,
                        ),
                      );
                      return (
                        <button
                          key={reservation.id}
                          type="button"
                          onClick={() => setSelected(reservation)}
                          style={{
                            gridColumn: `${start + 2} / ${end + 2}`,
                            gridRow: 1,
                          }}
                          className={`z-[1] m-1 min-w-0 truncate rounded-lg border px-2.5 py-2 text-left text-xs font-semibold shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${statusStyle(reservation.status)} ${searchTerm.trim() && reservationMatchesSearch(reservation, searchTerm) ? "ring-2 ring-amber-800" : ""}`}
                          title={`${reservation.guests?.full_name ?? "Guest"} · ${reservation.reservation_number}`}
                        >
                          <span className="block truncate">
                            {reservation.guests?.full_name ??
                              reservation.reservation_number}
                          </span>
                          <span className="block truncate text-[10px] font-medium opacity-70">
                            {reservation.reservation_number}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>

      {unassignedReservations.length > 0 && (
        <div className="hidden border-t border-stone-200 lg:block">
          <div className="bg-amber-50 px-4 py-3">
            <h3 className="text-sm font-semibold text-amber-950">Unassigned reservations · {unassignedReservations.length}</h3>
            <p className="mt-1 text-xs text-amber-900">These bookings overlap the displayed dates but cannot appear on a room row until assigned.</p>
          </div>
          <div className="grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {unassignedReservations.map((reservation) => (
              <button
                key={reservation.id}
                type="button"
                onClick={() => setSelected(reservation)}
                className={`rounded-lg border p-3 text-left text-sm transition hover:shadow-md ${statusStyle(reservation.status)} ${searchTerm.trim() && reservationMatchesSearch(reservation, searchTerm) ? "ring-2 ring-amber-800" : ""}`}
              >
                <span className="block font-semibold">{reservation.guests?.full_name ?? "Guest"} · {reservation.reservation_number}</span>
                <span className="mt-1 block text-xs">{reservation.check_in_date} → {reservation.check_out_date} · {statusLabel(reservation.status)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="divide-y divide-stone-100 lg:hidden">
        {rackReservations.length ? (
          rackReservations
            .sort((a, b) => a.check_in_date.localeCompare(b.check_in_date))
            .map((reservation) => (
              <button
                key={reservation.id}
                type="button"
                onClick={() => setSelected(reservation)}
                className={`flex w-full items-center gap-3 p-4 text-left hover:bg-stone-50 ${searchTerm.trim() && reservationMatchesSearch(reservation, searchTerm) ? "bg-amber-50" : ""}`}
              >
                <span
                  className={`h-12 w-1 shrink-0 rounded-full ${reservation.status === "checked_in" ? "bg-emerald-500" : reservation.status === "confirmed" ? "bg-sky-500" : "bg-amber-500"}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {reservation.guests?.full_name ?? "Guest"} · Room{" "}
                    {reservation.rooms?.room_number ?? "unassigned"}
                  </span>
                  <span className="mt-1 block text-xs text-stone-500">
                    {reservation.check_in_date} → {reservation.check_out_date}
                  </span>
                </span>
                <span className="rounded-full bg-stone-100 px-2 py-1 text-[10px] font-bold capitalize text-stone-600">
                  {statusLabel(reservation.status)}
                </span>
              </button>
            ))
        ) : (
          <p className="p-6 text-center text-sm text-stone-500">
            {searchTerm.trim()
              ? "No matching active bookings in this date window. Switch to List for full history."
              : "No active reservations overlap this date window."}
          </p>
        )}
      </div>

      <ReservationDetailsModal
        reservation={selected}
        businessAuthorization={businessAuthorizations.find((item) => item.reservation_id === selected?.id)}
        canManageReservations={canManageReservations}
        emailingReservationId={emailingReservationId}
        cancellationPolicy={cancellationPolicy}
        nowMs={nowMs}
        onClose={() => setSelected(null)}
        onAction={(reservation, action) => {
          setSelected(null);
          onAction(reservation, action);
        }}
      />
    </section>
  );
}
