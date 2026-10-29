import { describe, expect, it } from "vitest";

import type { Reservation } from "./reception-service";
import { getRackReservations, getUnassignedRackReservations } from "./reservation-rack-data";

function booking(id: string, values: Partial<Reservation>): Reservation {
  return {
    id,
    status: "confirmed",
    check_in_date: "2026-10-27",
    check_out_date: "2026-10-29",
    room_id: null,
    ...values,
  } as Reservation;
}

describe("reservation rack data", () => {
  it("shows active bookings overlapping the selected window, including unassigned ones", () => {
    const visible = getRackReservations([
      booking("unassigned", {}),
      booking("assigned", { room_id: "room-1" }),
      booking("checked-out", { status: "checked_out" }),
      booking("cancelled", { status: "cancelled" }),
      booking("before", { check_out_date: "2026-10-26" }),
      booking("after", { check_in_date: "2026-11-09" }),
    ], "2026-10-26", "2026-11-09");

    expect(visible.map((reservation) => reservation.id)).toEqual(["unassigned", "assigned"]);
    expect(getUnassignedRackReservations(visible).map((reservation) => reservation.id)).toEqual(["unassigned"]);
  });

  it("orders the unassigned queue by arrival without changing the full rack", () => {
    const visible = [
      booking("later", { check_in_date: "2026-10-30" }),
      booking("earlier", { check_in_date: "2026-10-27" }),
    ];
    expect(getUnassignedRackReservations(visible).map((reservation) => reservation.id)).toEqual(["earlier", "later"]);
    expect(visible.map((reservation) => reservation.id)).toEqual(["later", "earlier"]);
  });
});
