import { Modal } from "@/components/shared/modal";
import { formatNaira } from "@/lib/money";

import { ReservationActions, type ReservationAction } from "./reservation-actions";
import type { Reservation, ReservationBusinessAuthorization, ReservationCancellationPolicy } from "./reception-service";

export function ReservationDetailsModal({
  reservation,
  businessAuthorization,
  canManageReservations,
  emailingReservationId,
  cancellationPolicy,
  nowMs,
  onClose,
  onAction,
}: {
  reservation: Reservation | null;
  businessAuthorization?: ReservationBusinessAuthorization;
  canManageReservations: boolean;
  emailingReservationId: string | null;
  cancellationPolicy?: ReservationCancellationPolicy | null;
  nowMs: number;
  onClose: () => void;
  onAction: (reservation: Reservation, action: ReservationAction) => void;
}) {
  return (
    <Modal open={Boolean(reservation)} title="Reservation details" onClose={onClose}>
      {reservation && (
        <div className="space-y-4">
          <div className="rounded-xl border border-stone-200 bg-stone-50 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-stone-600">
              {reservation.status.replaceAll("_", " ")}
            </p>
            <p className="mt-1 text-lg font-semibold text-stone-950">
              {reservation.guests?.full_name ?? "Guest"}
            </p>
            <p className="mt-1 text-sm text-stone-600">{reservation.reservation_number}</p>
          </div>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-stone-500">Room</dt>
              <dd className="mt-1 font-semibold">{reservation.rooms?.room_number ?? "Unassigned"}</dd>
            </div>
            <div>
              <dt className="text-stone-500">Room type</dt>
              <dd className="mt-1 font-semibold">{reservation.room_types?.name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-stone-500">Check-in</dt>
              <dd className="mt-1 font-semibold">{reservation.check_in_date}</dd>
            </div>
            <div>
              <dt className="text-stone-500">Check-out</dt>
              <dd className="mt-1 font-semibold">{reservation.check_out_date}</dd>
            </div>
            <div>
              <dt className="text-stone-500">Agreed nightly rate</dt>
              <dd className="mt-1 font-semibold">{formatNaira(reservation.agreed_rate_kobo)}</dd>
            </div>
            {businessAuthorization && (
              <div>
                <dt className="text-stone-500">Business billing</dt>
                <dd className="mt-1 font-semibold">
                  {businessAuthorization.account_name} · {businessAuthorization.billing_mode.replaceAll("_", " ")}
                </dd>
              </div>
            )}
          </dl>
          <div className="border-t border-stone-200 pt-4">
            <ReservationActions
              reservation={reservation}
              canManageReservations={canManageReservations}
              emailingReservationId={emailingReservationId}
              cancellationPolicy={cancellationPolicy}
              nowMs={nowMs}
              onAction={(action) => onAction(reservation, action)}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
