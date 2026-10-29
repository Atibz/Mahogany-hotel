import type { Reservation, ReservationCancellationPolicy } from "./reception-service";

// Mirrors mark_reservation_no_show(): the hotel currently operates in Africa/Lagos
// (UTC+1 year-round), with 14:00 and 12 hours as the database fallbacks.
export function noShowAllowedAfter(
  reservation: Pick<Reservation, "check_in_date" | "reservation_cancellation_policy_snapshots">,
  policy?: Pick<ReservationCancellationPolicy, "standard_check_in_time" | "no_show_grace_hours"> | null,
): Date {
  const snapshot = reservation.reservation_cancellation_policy_snapshots;
  const checkInTime = snapshot?.scheduled_check_in_time ?? policy?.standard_check_in_time ?? "14:00";
  const graceHours = snapshot?.no_show_grace_hours ?? policy?.no_show_grace_hours ?? 12;
  const [year, month, day] = reservation.check_in_date.split("-").map(Number);
  const [hour, minute] = checkInTime.split(":").map(Number);

  return new Date(Date.UTC(year, month - 1, day, hour, minute) + (graceHours - 1) * 3_600_000);
}

export function formatNoShowAllowedAfter(date: Date): string {
  return new Intl.DateTimeFormat("en-NG", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
