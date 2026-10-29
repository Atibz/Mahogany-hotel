import { Mail } from "lucide-react";

import { formatNoShowAllowedAfter, noShowAllowedAfter } from "./no-show-eligibility";
import type { Reservation, ReservationCancellationPolicy } from "./reception-service";

export type ReservationAction = "email" | "billing" | "amend" | "cancel" | "no-show";

export function ReservationActions({
  reservation,
  canManageReservations,
  emailingReservationId,
  cancellationPolicy,
  nowMs,
  onAction,
}: {
  reservation: Reservation;
  canManageReservations: boolean;
  emailingReservationId: string | null;
  cancellationPolicy?: ReservationCancellationPolicy | null;
  nowMs: number;
  onAction: (action: ReservationAction) => void;
}) {
  if (!["pending", "confirmed"].includes(reservation.status)) return null;
  const snapshot = reservation.reservation_cancellation_policy_snapshots;
  const hasCutoffData = Boolean(
    cancellationPolicy || (snapshot?.scheduled_check_in_time && snapshot.no_show_grace_hours != null),
  );
  const cutoff = noShowAllowedAfter(reservation, cancellationPolicy);
  const canMarkNoShow = hasCutoffData && nowMs >= cutoff.getTime();

  return (
    <div className="flex flex-wrap gap-2">
      {canManageReservations && (
        <button
          type="button"
          onClick={() => onAction("email")}
          disabled={emailingReservationId === reservation.id || !reservation.guests?.email}
          title={!reservation.guests?.email ? "Add an email address to the guest profile first" : "Send the guest their arrival details"}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 px-3 py-2 text-xs font-semibold text-amber-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Mail className="size-3.5" />
          {!reservation.guests?.email
            ? "No guest email"
            : emailingReservationId === reservation.id
              ? "Sending…"
              : "Email arrival details"}
        </button>
      )}
      <button type="button" onClick={() => onAction("billing")} className="rounded-lg border border-amber-300 px-3 py-2 text-xs font-semibold text-amber-900">
        Business billing
      </button>
      <button type="button" onClick={() => onAction("amend")} className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold">
        Amend
      </button>
      <button type="button" onClick={() => onAction("cancel")} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700">
        Cancel
      </button>
      <span className="inline-flex flex-col gap-1">
        <button
          type="button"
          onClick={() => onAction("no-show")}
          disabled={!canMarkNoShow}
          aria-label={!canMarkNoShow ? hasCutoffData ? `No-show available ${formatNoShowAllowedAfter(cutoff)} hotel time` : "No-show cutoff is loading" : "Mark no-show"}
          className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        >
          No-show
        </button>
        {!canMarkNoShow && (
          <span className="max-w-48 text-[11px] leading-4 text-stone-600">
            {hasCutoffData ? `Available ${formatNoShowAllowedAfter(cutoff)} (hotel time)` : "Checking no-show cutoff…"}
          </span>
        )}
      </span>
    </div>
  );
}
