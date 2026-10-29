import type { Reservation } from "./reception-service";

const activeStatuses = new Set(["pending", "confirmed", "checked_in"]);

export function getRackReservations(
  reservations: Reservation[],
  windowStart: string,
  windowEnd: string,
) {
  return reservations.filter(
    (reservation) =>
      activeStatuses.has(reservation.status) &&
      reservation.check_in_date < windowEnd &&
      reservation.check_out_date > windowStart,
  );
}

export function getUnassignedRackReservations(reservations: Reservation[]) {
  return reservations
    .filter((reservation) => !reservation.room_id)
    .sort((a, b) => a.check_in_date.localeCompare(b.check_in_date));
}
