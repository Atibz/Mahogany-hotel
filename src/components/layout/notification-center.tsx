import { Bell, ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useAccess } from "@/features/auth/use-access";
import {
  useActiveHotel,
  useDepartureQueue,
  useFinanceApprovalRequests,
  useMaintenanceTickets,
  useNightAuditExceptions,
  usePendingPaymentVerifications,
  useRoomBoard,
} from "@/features/reception/use-reception";

type AttentionItem = {
  key: string;
  title: string;
  detail: string;
  count: number;
  to: string;
  urgent: boolean;
};

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const hotel = useActiveHotel();
  const { roleCodes, canAccess, isLoading: accessLoading } = useAccess();
  const isFrontDesk = roleCodes.some((role) =>
    ["owner", "general_manager", "receptionist"].includes(role),
  );
  const isManager = roleCodes.some((role) =>
    ["owner", "general_manager"].includes(role),
  );
  const canSeePayments = canAccess("payments");

  const departures = useDepartureQueue(
    isFrontDesk ? hotel.data?.id : undefined,
  );
  const rooms = useRoomBoard(isFrontDesk ? hotel.data?.id : undefined);
  const maintenance = useMaintenanceTickets(hotel.data?.id, isManager);
  const auditExceptions = useNightAuditExceptions(hotel.data?.id, isManager);
  const pendingPayments = usePendingPaymentVerifications(
    hotel.data?.id,
    canSeePayments,
  );
  const approvals = useFinanceApprovalRequests(hotel.data?.id, isManager);

  const items = useMemo<AttentionItem[]>(() => {
    const next: AttentionItem[] = [];
    const departureItems = departures.data ?? [];
    const overdue = departureItems.filter(
      (item) => item.departure_state === "overdue",
    ).length;
    const dueToday = departureItems.filter(
      (item) => item.departure_state === "due_today",
    ).length;
    const dirtyRooms = (rooms.data ?? []).filter(
      (room) => room.status === "dirty",
    ).length;

    if (overdue) {
      next.push({
        key: "overdue-departures",
        title: "Overdue departures",
        detail: `${overdue} checked-in guest${overdue === 1 ? " is" : "s are"} past the expected checkout date.`,
        count: overdue,
        to: "/departures",
        urgent: true,
      });
    }
    if (dueToday) {
      next.push({
        key: "today-departures",
        title: "Departures due today",
        detail: `${dueToday} guest${dueToday === 1 ? " requires" : "s require"} checkout attention today.`,
        count: dueToday,
        to: "/departures",
        urgent: false,
      });
    }
    if (dirtyRooms) {
      next.push({
        key: "dirty-rooms",
        title: "Rooms awaiting housekeeping",
        detail: "Clean and release these rooms before assigning new arrivals.",
        count: dirtyRooms,
        to: "/rooms",
        urgent: false,
      });
    }

    const verificationCount = pendingPayments.data?.length ?? 0;
    if (verificationCount) {
      next.push({
        key: "pending-payments",
        title: "Payments awaiting verification",
        detail:
          "Verify or reject these payments so affected folios can proceed.",
        count: verificationCount,
        to: "/payments",
        urgent: true,
      });
    }

    const pendingApprovals = (approvals.data ?? []).filter(
      (request) => request.status === "pending",
    ).length;
    if (pendingApprovals) {
      next.push({
        key: "pending-approvals",
        title: "Financial approvals pending",
        detail:
          "Review correction or discount requests awaiting a management decision.",
        count: pendingApprovals,
        to: "/payments",
        urgent: true,
      });
    }

    const priorityMaintenance = (maintenance.data ?? []).filter(
      (ticket) =>
        ["open", "in_progress"].includes(ticket.status) &&
        ["high", "urgent"].includes(ticket.priority),
    ).length;
    if (priorityMaintenance) {
      next.push({
        key: "priority-maintenance",
        title: "High-priority maintenance",
        detail: "Review guest impact, repair progress, and room availability.",
        count: priorityMaintenance,
        to: "/maintenance",
        urgent: true,
      });
    }

    for (const exception of auditExceptions.data ?? []) {
      if (!exception.record_count) continue;
      next.push({
        key: `audit-${exception.exception_code}`,
        title: exception.exception_label,
        detail: "Review this exception before the next daily close.",
        count: exception.record_count,
        to: "/folios",
        urgent: exception.exception_code === "failed_night_audits",
      });
    }
    return next;
  }, [
    approvals.data,
    auditExceptions.data,
    departures.data,
    maintenance.data,
    pendingPayments.data,
    rooms.data,
  ]);

  const loading =
    hotel.isLoading ||
    accessLoading ||
    departures.isLoading ||
    rooms.isLoading ||
    maintenance.isLoading ||
    auditExceptions.isLoading ||
    pendingPayments.isLoading ||
    approvals.isLoading;
  const unavailable = Boolean(
    departures.error ||
    rooms.error ||
    maintenance.error ||
    auditExceptions.error ||
    pendingPayments.error ||
    approvals.error,
  );
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return (
    <div className="relative ml-auto">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="relative grid size-10 place-items-center rounded-lg text-stone-700 hover:bg-stone-200"
        aria-label={`Attention centre${total ? `, ${total} active items` : ""}`}
        aria-expanded={open}
      >
        <Bell className="size-5" aria-hidden="true" />
        {total > 0 && (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-red-600 px-1.5 text-center text-[11px] font-bold leading-5 text-white">
            {total > 99 ? "99+" : total}
          </span>
        )}
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close attention centre"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <section className="fixed inset-x-3 top-16 z-40 max-h-[calc(100vh-5rem)] overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-[25rem]">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h2 className="font-semibold">Attention needed</h2>
                <p className="text-xs text-stone-500">
                  Live operational notifications
                </p>
              </div>
              {total > 0 && (
                <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-bold text-red-800">
                  {total}
                </span>
              )}
            </div>
            <div className="max-h-[calc(100vh-10rem)] overflow-y-auto p-2">
              {loading ? (
                <div className="flex items-center gap-2 p-4 text-sm text-stone-600">
                  <LoaderCircle className="size-4 animate-spin" /> Checking the
                  hotel…
                </div>
              ) : unavailable ? (
                <div className="m-2 rounded-lg bg-red-50 p-3 text-sm text-red-800">
                  Some notifications could not be loaded. Refresh and try again.
                </div>
              ) : items.length ? (
                items.map((item) => (
                  <Link
                    key={item.key}
                    to={item.to}
                    onClick={() => setOpen(false)}
                    className="flex items-start gap-3 rounded-lg p-3 hover:bg-stone-50"
                  >
                    <CircleAlert
                      className={`mt-0.5 size-5 shrink-0 ${item.urgent ? "text-red-600" : "text-amber-600"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-semibold">{item.title}</p>
                        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-bold">
                          {item.count}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-stone-600">
                        {item.detail}
                      </p>
                    </div>
                    <ChevronRight className="mt-1 size-4 shrink-0 text-stone-400" />
                  </Link>
                ))
              ) : (
                <p className="p-5 text-center text-sm text-stone-600">
                  Nothing currently requires your attention.
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
