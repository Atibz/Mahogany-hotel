import { expect, it } from "vitest";

import type { Reservation } from "./reception-service";
import { reservationMatchesSearch } from "./reservation-search";

const reservation = {
  reservation_number: "RSV-20261026-0001",
  guests: { full_name: "Ada Okafor" },
  rooms: { room_number: "204" },
} as Reservation;

it("matches reference, guest, and room consistently across both views", () => {
  expect(reservationMatchesSearch(reservation, " RSV-20261026 ")).toBe(true);
  expect(reservationMatchesSearch(reservation, "ada okafor")).toBe(true);
  expect(reservationMatchesSearch(reservation, "204")).toBe(true);
  expect(reservationMatchesSearch(reservation, "unknown")).toBe(false);
  expect(reservationMatchesSearch(reservation, "")).toBe(true);
});
