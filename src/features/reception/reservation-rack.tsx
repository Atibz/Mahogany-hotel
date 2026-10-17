import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { Modal } from "@/components/shared/modal";
import { formatNaira } from "@/lib/money";

import type { Reservation, RoomBoardItem } from "./reception-service";

const WINDOW_DAYS = 14;
const activeStatuses = new Set(["pending", "confirmed", "checked_in"]);

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
}: {
  rooms: RoomBoardItem[];
  reservations: Reservation[];
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
  const rackReservations = reservations.filter(
    (reservation) =>
      activeStatuses.has(reservation.status) &&
      parseDate(reservation.check_in_date) < windowEnd &&
      parseDate(reservation.check_out_date) > windowStart,
  );
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
                          className={`z-[1] m-1 min-w-0 truncate rounded-lg border px-2.5 py-2 text-left text-xs font-semibold shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${statusStyle(reservation.status)}`}
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

      <div className="divide-y divide-stone-100 lg:hidden">
        {rackReservations.length ? (
          rackReservations
            .sort((a, b) => a.check_in_date.localeCompare(b.check_in_date))
            .map((reservation) => (
              <button
                key={reservation.id}
                type="button"
                onClick={() => setSelected(reservation)}
                className="flex w-full items-center gap-3 p-4 text-left hover:bg-stone-50"
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
            No active reservations overlap this date window.
          </p>
        )}
      </div>

      <Modal
        open={Boolean(selected)}
        title="Reservation details"
        onClose={() => setSelected(null)}
      >
        {selected && (
          <div className="space-y-4">
            <div
              className={`rounded-xl border p-4 ${statusStyle(selected.status)}`}
            >
              <p className="text-xs font-bold uppercase tracking-wide opacity-70">
                {statusLabel(selected.status)}
              </p>
              <p className="mt-1 text-lg font-semibold">
                {selected.guests?.full_name ?? "Guest"}
              </p>
              <p className="mt-1 text-sm">{selected.reservation_number}</p>
            </div>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-stone-500">Room</dt>
                <dd className="mt-1 font-semibold">
                  {selected.rooms?.room_number ?? "Unassigned"}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Room type</dt>
                <dd className="mt-1 font-semibold">
                  {selected.room_types?.name ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Check-in</dt>
                <dd className="mt-1 font-semibold">{selected.check_in_date}</dd>
              </div>
              <div>
                <dt className="text-stone-500">Check-out</dt>
                <dd className="mt-1 font-semibold">
                  {selected.check_out_date}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-stone-500">Agreed nightly rate</dt>
                <dd className="mt-1 font-semibold">
                  {formatNaira(selected.agreed_rate_kobo)}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </Modal>
    </section>
  );
}
