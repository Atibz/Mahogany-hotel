import type { Reservation } from "./reception-service";

export function reservationMatchesSearch(reservation: Reservation, searchTerm: string) {
  const term = searchTerm.trim().toLocaleLowerCase();
  if (!term) return true;
  return `${reservation.reservation_number} ${reservation.guests?.full_name ?? ""} ${reservation.rooms?.room_number ?? ""}`
    .toLocaleLowerCase()
    .includes(term);
}
