import { useState } from "react";
import {
  ArrowRight,
  Box,
  BedDouble,
  CalendarCheck,
  CalendarPlus,
  CircleDollarSign,
  DoorOpen,
  Landmark,
  Sparkles,
  TrendingUp,
  Wallet,
  Wrench,
} from "lucide-react";
import { Link } from "react-router-dom";

import { Modal } from "@/components/shared/modal";
import {
  EmptyState,
  PageError,
  PageLoading,
} from "@/components/shared/page-state";
import { useAccess } from "@/features/auth/use-access";
import { formatNaira } from "@/lib/money";
import {
  useActiveHotel,
  useArrivalAttention,
  useDailyOperationalSummary,
  useDashboardSnapshot,
  useFolios,
  useInHouseRoomOccupants,
  useMaintenanceTickets,
  useManagementDashboard,
  useNightAuditExceptions,
  useRoomBoard,
} from "@/features/reception/use-reception";

export function DashboardPage() {
  const hotel = useActiveHotel();
  const { roleCodes, isLoading: accessLoading } = useAccess();
  const canSeeRoomOverview = roleCodes.some((role) =>
    ["owner", "general_manager", "receptionist", "accountant"].includes(role),
  );
  const canSeeFinancialOverview = roleCodes.some((role) =>
    ["owner", "general_manager", "cashier", "accountant"].includes(role),
  );
  const canRecordPayment = roleCodes.some((role) =>
    ["owner", "general_manager", "receptionist", "cashier", "accountant"].includes(role),
  );
  const canSeeManagementSummary = roleCodes.some((role) =>
    ["owner", "general_manager", "accountant"].includes(role),
  );
  const canSeeInventory = roleCodes.some((role) =>
    ["owner", "general_manager", "storekeeper", "accountant"].includes(role),
  );
  const rooms = useRoomBoard(canSeeRoomOverview ? hotel.data?.id : undefined);
  const arrivals = useArrivalAttention(hotel.data?.id, canSeeRoomOverview);
  const occupants = useInHouseRoomOccupants(hotel.data?.id, canSeeRoomOverview);
  const folios = useFolios(
    canSeeFinancialOverview ? hotel.data?.id : undefined,
  );
  const snapshot = useDashboardSnapshot(
    canSeeFinancialOverview ? hotel.data?.id : undefined,
  );
  const dailySummary = useDailyOperationalSummary(
    hotel.data?.id,
    canSeeManagementSummary,
  );
  const auditExceptions = useNightAuditExceptions(
    hotel.data?.id,
    canSeeManagementSummary,
  );
  const maintenance = useMaintenanceTickets(
    hotel.data?.id,
    canSeeManagementSummary,
  );
  const management = useManagementDashboard(
    hotel.data?.id,
    canSeeManagementSummary,
  );
  const [showOccupied, setShowOccupied] = useState(false);
  const [showDirty, setShowDirty] = useState(false);
  if (
    hotel.isLoading ||
    accessLoading ||
    (canSeeRoomOverview && rooms.isLoading) ||
    (canSeeFinancialOverview && (folios.isLoading || snapshot.isLoading)) ||
    (canSeeManagementSummary && dailySummary.isLoading)
  )
    return <PageLoading />;
  if (
    hotel.error ||
    (canSeeRoomOverview && rooms.error) ||
    (canSeeFinancialOverview && (folios.error || snapshot.error)) ||
    (canSeeManagementSummary && dailySummary.error)
  )
    return <PageError message="Unable to load the hotel overview." />;
  if (!hotel.data)
    return <EmptyState>No hotel is assigned to your staff account.</EmptyState>;
  const count = (status: string) =>
    rooms.data?.filter((room) => room.status === status).length ?? 0;
  const occupiedByType = Object.entries(
    (rooms.data ?? [])
      .filter((room) => room.status === "occupied")
      .reduce<
        Record<string, number>
      >((counts, room) => ({ ...counts, [room.room_type_name]: (counts[room.room_type_name] ?? 0) + 1 }), {}),
  );
  const dirtyRooms = (rooms.data ?? []).filter(
    (room) => room.status === "dirty",
  );
  const overdueOccupants = (occupants.data ?? []).filter(
    (occupant) => occupant.departure_state === "overdue",
  );
  const dueTodayWithBalance = (occupants.data ?? []).filter(
    (occupant) =>
      occupant.departure_state === "due_today" && occupant.balance_kobo > 0,
  );
  const charges =
    folios.data
      ?.flatMap((folio) => folio.items)
      .filter((item) => item.status === "posted")
      .reduce((sum, item) => sum + item.total_amount_kobo, 0) ?? 0;
  const outstanding =
    folios.data?.reduce((sum, folio) => sum + folio.balance_kobo, 0) ?? 0;
  const activeMaintenance = (maintenance.data ?? []).filter((ticket) =>
    ["open", "in_progress"].includes(ticket.status),
  );
  const priorityMaintenance = activeMaintenance.filter((ticket) =>
    ["high", "urgent"].includes(ticket.priority),
  );
  const outOfServiceRooms = (rooms.data ?? []).filter(
    (room) => room.is_maintenance_out_of_service,
  );
  const managementAlertsLoading =
    auditExceptions.isLoading ||
    maintenance.isLoading ||
    management.snapshot.isLoading;
  const managementSnapshot = management.snapshot.data;
  const managementAlerts = [
    ...(auditExceptions.error
      ? [
          {
            key: "audit_alerts_unavailable",
            label: "Night-audit alerts unavailable",
            count: null,
            detail:
              "The hotel overview is still available. Refresh once, then check the night-audit permissions if this remains.",
            urgent: true,
            to: "/folios",
          },
        ]
      : []),
    ...(maintenance.error
      ? [
          {
            key: "maintenance_alerts_unavailable",
            label: "Maintenance alerts unavailable",
            count: null,
            detail:
              "The hotel overview is still available. Refresh once, then check maintenance access if this remains.",
            urgent: true,
            to: "/maintenance",
          },
        ]
      : []),
    ...(auditExceptions.data ?? [])
      .filter((item) => item.record_count > 0)
      .map((item) => ({
        key: item.exception_code,
        label: item.exception_label,
        count: item.record_count,
        detail:
          item.exception_code === "failed_night_audits"
            ? "Review the failed run before relying on daily figures."
            : "Resolve or review these records before the next daily close.",
        urgent: item.exception_code === "failed_night_audits",
        to:
          item.exception_code === "unsettled_open_folios" ||
          item.exception_code === "failed_night_audits"
            ? "/folios"
            : "/payments",
      })),
    ...(dirtyRooms.length
      ? [
          {
            key: "dirty_rooms",
            label: "Rooms awaiting housekeeping",
            count: dirtyRooms.length,
            detail:
              "Return cleaned rooms to service before assigning arrivals.",
            urgent: false,
            to: "/rooms",
          },
        ]
      : []),
    ...(priorityMaintenance.length
      ? [
          {
            key: "priority_maintenance",
            label: "High-priority maintenance tickets",
            count: priorityMaintenance.length,
            detail:
              "Review guest impact, repair progress, and room availability.",
            urgent: true,
            to: "/maintenance",
          },
        ]
      : []),
    ...(outOfServiceRooms.length
      ? [
          {
            key: "maintenance_outages",
            label: "Rooms out of service",
            count: outOfServiceRooms.length,
            detail:
              "These rooms remain unavailable until formal maintenance sign-off.",
            urgent: true,
            to: "/maintenance",
          },
        ]
      : []),
    ...(managementSnapshot?.pending_finance_approvals
      ? [
          {
            key: "pending_finance_approvals",
            label: "Finance approvals awaiting action",
            count: managementSnapshot.pending_finance_approvals,
            detail:
              "Review pending or approved requests before they expire or remain unexecuted.",
            urgent: true,
            to: "/payments",
          },
        ]
      : []),
    ...(managementSnapshot?.cash_variance_today_kobo
      ? [
          {
            key: "cash_variance_today",
            label: "Cash variance recorded today",
            count: null,
            detail: `${formatNaira(managementSnapshot.cash_variance_today_kobo)} total absolute variance requires review.`,
            urgent: true,
            to: "/payments",
          },
        ]
      : []),
  ];
  const totalRooms = rooms.data?.length ?? 0;
  const occupiedRooms = count("occupied");
  const occupancyRate = totalRooms
    ? Math.round((occupiedRooms / totalRooms) * 100)
    : 0;
  const trend = management.trend.data ?? [];
  const largestTrendAmount = Math.max(
    1,
    ...trend.flatMap((day) => [
      Math.max(0, day.total_revenue_kobo),
      Math.max(0, day.net_collected_kobo),
    ]),
  );
  const trendTotals = trend.reduce(
    (totals, day) => ({
      revenue: totals.revenue + day.total_revenue_kobo,
      collected: totals.collected + day.net_collected_kobo,
      refunds: totals.refunds + day.refunds_kobo,
      discounts: totals.discounts + day.approved_discount_kobo,
      arrivals: totals.arrivals + day.arrivals,
      departures: totals.departures + day.departures,
      noShows: totals.noShows + day.no_shows,
    }),
    {
      revenue: 0,
      collected: 0,
      refunds: 0,
      discounts: 0,
      arrivals: 0,
      departures: 0,
      noShows: 0,
    },
  );
  const quickActions = [
    ...(canSeeRoomOverview
      ? [
          {
            label: "New reservation",
            detail: "Create and assign a booking",
            to: "/reservations",
            icon: CalendarPlus,
          },
          {
            label: "Check in guest",
            detail: "Process today's arrival",
            to: "/stays",
            icon: DoorOpen,
          },
          {
            label: "Process departure",
            detail: "Review folio and check out",
            to: "/departures",
            icon: CalendarCheck,
          },
        ]
      : []),
    ...(canSeeFinancialOverview
      ? [
          {
            label: canRecordPayment ? "Record payment" : "Review folios",
            detail: canRecordPayment
              ? "Open folios and receipts"
              : "Check balances and receipts",
            to: "/folios",
            icon: CircleDollarSign,
          },
        ]
      : []),
    ...(canSeeManagementSummary
      ? [
          {
            label: "Maintenance",
            detail: "Review active room issues",
            to: "/maintenance",
            icon: Wrench,
          },
        ]
      : []),
    ...(canSeeInventory && !canSeeRoomOverview && !canSeeFinancialOverview
      ? [
          {
            label: "Open inventory",
            detail: "Check stock levels and record a movement",
            to: "/inventory",
            icon: Box,
          },
        ]
      : []),
  ];
  return (
    <section>
      <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-amber-950 via-amber-900 to-stone-900 px-5 py-6 text-white shadow-lg shadow-amber-950/10 sm:px-7 sm:py-7">
        <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div>
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-amber-200">
              <Sparkles className="size-4" /> Live operations
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
              Welcome to {hotel.data.trading_name}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-amber-100/80">
              See what needs attention, understand today's room position, and
              move directly into your next task.
            </p>
          </div>
          {canSeeRoomOverview && (
            <div className="flex items-center gap-4 rounded-2xl bg-white/10 px-4 py-3 ring-1 ring-white/15 backdrop-blur">
              <div className="grid size-11 place-items-center rounded-xl bg-white/10">
                <BedDouble className="size-5" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{occupancyRate}%</p>
                <p className="text-xs text-amber-100/75">
                  Occupancy · {occupiedRooms} of {totalRooms} rooms
                </p>
              </div>
              </div>
            )}
        </div>
      </div>

      {quickActions.length > 0 && (
        <section className="mt-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-stone-800">Quick actions</h2>
            <p className="hidden text-xs text-stone-500 sm:block">
              Common tasks based on your access
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {quickActions.map(({ label, detail, to, icon: Icon }) => (
              <Link
                key={label}
                to={to}
                className="group flex min-h-24 items-start gap-3 rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-md"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-900 transition group-hover:bg-amber-900 group-hover:text-white">
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1 text-sm font-semibold">
                    {label}
                    <ArrowRight className="size-3.5 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
                  </span>
                  <span className="mt-1 block text-xs leading-4 text-stone-500">
                    {detail}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {canSeeRoomOverview && (
        <div className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-5">
          <article className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4 shadow-sm sm:p-5">
            <p className="text-sm text-stone-500">Available rooms</p>
            <p className="mt-2 text-3xl font-semibold text-emerald-800">
              {count("available")}
            </p>
            <p className="mt-1 text-xs text-emerald-700">Ready to sell</p>
          </article>
          <button
            type="button"
            onClick={() => setShowOccupied(true)}
            className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md sm:p-5"
          >
            <p className="text-sm text-amber-900">Occupied rooms</p>
            <p className="mt-2 text-3xl font-semibold">{count("occupied")}</p>
            <p className="mt-1 text-xs text-amber-800">Tap for room types</p>
          </button>
          <button
            type="button"
            onClick={() => setShowDirty(true)}
            className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md sm:p-5"
          >
            <p className="text-sm text-rose-900">Awaiting housekeeping</p>
            <p className="mt-2 text-3xl font-semibold">{count("dirty")}</p>
            <p className="mt-1 text-xs text-rose-800">Tap for room list</p>
          </button>
          <article className="rounded-2xl border border-sky-100 bg-sky-50/70 p-4 shadow-sm sm:p-5">
            <p className="text-sm text-stone-500">Reserved rooms</p>
            <p className="mt-2 text-3xl font-semibold">{count("reserved")}</p>
          </article>
          <article className="rounded-2xl border border-stone-200 bg-stone-100/80 p-4 shadow-sm sm:p-5">
            <p className="text-sm text-stone-500">Blocked rooms</p>
            <p className="mt-2 text-3xl font-semibold">{count("blocked")}</p>
          </article>
        </div>
      )}
      {canSeeFinancialOverview && (
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
          <article className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm">
            <p className="text-sm text-stone-500">Open-folio posted charges</p>
            <p className="mt-2 text-xl font-semibold">{formatNaira(charges)}</p>
          </article>
          <article className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm">
            <p className="text-sm text-stone-500">Net collected today</p>
            <p className="mt-2 text-xl font-semibold">
              {formatNaira(snapshot.data?.payments_today_kobo ?? 0)}
            </p>
          </article>
          <article className="col-span-2 rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm md:col-span-1">
            <p className="text-sm text-stone-500">Outstanding balance</p>
            <p className="mt-2 text-xl font-semibold">
              {formatNaira(outstanding)}
            </p>
          </article>
        </div>
      )}
      {canSeeManagementSummary && (
        <section className="mt-6">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-800">
                Management position
              </p>
              <h2 className="mt-1 text-xl font-semibold">
                Revenue, liabilities, and controls
              </h2>
            </div>
            {managementSnapshot && (
              <p className="text-xs text-stone-500">
                Business date {managementSnapshot.business_date}
              </p>
            )}
          </div>
          {management.snapshot.error ? (
            <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              Management financial indicators could not be loaded. The rest of
              the dashboard remains available.
            </p>
          ) : management.snapshot.isLoading ? (
            <p className="mt-3 rounded-xl bg-white p-4 text-sm text-stone-600">
              Loading management indicators…
            </p>
          ) : managementSnapshot ? (
            <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Link
                to="/folios"
                className="rounded-2xl border border-red-100 bg-red-50/70 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <Wallet className="size-5 text-red-700" />
                <p className="mt-3 text-xs text-stone-500">
                  Outstanding folios
                </p>
                <p className="mt-1 text-xl font-semibold text-red-800">
                  {formatNaira(managementSnapshot.outstanding_folio_kobo)}
                </p>
                <p className="mt-1 text-xs text-red-700">
                  Open supporting records
                </p>
              </Link>
              <Link
                to="/payments"
                className="rounded-2xl border border-sky-100 bg-sky-50/70 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <Landmark className="size-5 text-sky-700" />
                <p className="mt-3 text-xs text-stone-500">Deposits held</p>
                <p className="mt-1 text-xl font-semibold text-sky-800">
                  {formatNaira(managementSnapshot.held_deposit_kobo)}
                </p>
                <p className="mt-1 text-xs text-sky-700">
                  Guest liability, not revenue
                </p>
              </Link>
              <Link
                to="/reservations"
                className="rounded-2xl border border-violet-100 bg-violet-50/70 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <TrendingUp className="size-5 text-violet-700" />
                <p className="mt-3 text-xs text-stone-500">
                  Future booked room value
                </p>
                <p className="mt-1 text-xl font-semibold text-violet-800">
                  {formatNaira(
                    managementSnapshot.future_booked_room_revenue_kobo,
                  )}
                </p>
                <p className="mt-1 text-xs text-violet-700">
                  Not yet earned revenue
                </p>
              </Link>
              <Link
                to="/payments"
                className="rounded-2xl border border-amber-100 bg-amber-50/70 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <CircleDollarSign className="size-5 text-amber-800" />
                <p className="mt-3 text-xs text-stone-500">
                  Refunds and voids today
                </p>
                <p className="mt-1 text-xl font-semibold text-amber-900">
                  {formatNaira(
                    managementSnapshot.refunds_today_kobo +
                      managementSnapshot.voids_today_kobo,
                  )}
                </p>
                <p className="mt-1 text-xs text-amber-800">
                  {managementSnapshot.refunds_today_count} refunds ·{" "}
                  {managementSnapshot.voids_today_count} voids
                </p>
              </Link>
            </div>
          ) : null}
        </section>
      )}
      {canSeeManagementSummary && (
        <section className="mt-6 rounded-2xl border border-stone-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-800">
                Last seven business dates
              </p>
              <h2 className="mt-1 text-lg font-semibold">Trading trend</h2>
              <p className="mt-1 text-sm text-stone-600">
                Posted revenue and net collections are shown separately.
              </p>
            </div>
            <div className="flex gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-stone-600">
                <span className="size-2.5 rounded-sm bg-amber-700" /> Revenue
              </span>
              <span className="flex items-center gap-1.5 text-stone-600">
                <span className="size-2.5 rounded-sm bg-emerald-600" />{" "}
                Collections
              </span>
            </div>
          </div>
          {management.trend.error ? (
            <p className="mt-4 rounded-xl bg-red-50 p-4 text-sm text-red-800">
              Seven-day trading figures could not be loaded.
            </p>
          ) : management.trend.isLoading ? (
            <p className="mt-4 rounded-xl bg-stone-50 p-4 text-sm text-stone-600">
              Loading trading trend…
            </p>
          ) : trend.length ? (
            <>
              <div
                className="mt-5 grid grid-cols-7 gap-2"
                aria-label="Seven-day revenue and collection chart"
              >
                {trend.map((day) => (
                  <div key={day.business_date} className="min-w-0 text-center">
                    <div className="flex h-36 items-end justify-center gap-1 rounded-lg bg-stone-50 px-1.5 pt-2">
                      <div
                        className="w-2.5 min-h-0.5 rounded-t bg-amber-700 sm:w-4"
                        style={{
                          height: `${Math.max(2, (Math.max(0, day.total_revenue_kobo) / largestTrendAmount) * 100)}%`,
                        }}
                        title={`Revenue ${formatNaira(day.total_revenue_kobo)}`}
                      />
                      <div
                        className="w-2.5 min-h-0.5 rounded-t bg-emerald-600 sm:w-4"
                        style={{
                          height: `${Math.max(2, (Math.max(0, day.net_collected_kobo) / largestTrendAmount) * 100)}%`,
                        }}
                        title={`Net collections ${formatNaira(day.net_collected_kobo)}`}
                      />
                    </div>
                    <p className="mt-2 truncate text-[11px] font-medium text-stone-600">
                      {new Intl.DateTimeFormat("en-NG", {
                        weekday: "short",
                      }).format(new Date(`${day.business_date}T12:00:00`))}
                    </p>
                    <p className="text-[10px] text-stone-400">
                      {day.occupied_room_count}/{day.active_room_count} rooms
                    </p>
                  </div>
                ))}
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
                <div className="rounded-xl bg-stone-50 p-3">
                  <p className="text-xs text-stone-500">Revenue posted</p>
                  <p className="mt-1 font-semibold">
                    {formatNaira(trendTotals.revenue)}
                  </p>
                </div>
                <div className="rounded-xl bg-stone-50 p-3">
                  <p className="text-xs text-stone-500">Net collected</p>
                  <p className="mt-1 font-semibold">
                    {formatNaira(trendTotals.collected)}
                  </p>
                </div>
                <Link
                  to="/payments"
                  className="rounded-xl bg-stone-50 p-3 hover:bg-stone-100"
                >
                  <p className="text-xs text-stone-500">Refunds</p>
                  <p className="mt-1 font-semibold">
                    {formatNaira(trendTotals.refunds)}
                  </p>
                </Link>
                <Link
                  to="/payments"
                  className="rounded-xl bg-stone-50 p-3 hover:bg-stone-100"
                >
                  <p className="text-xs text-stone-500">Approved discounts</p>
                  <p className="mt-1 font-semibold">
                    {formatNaira(trendTotals.discounts)}
                  </p>
                </Link>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 rounded-xl border border-stone-200 px-4 py-3 text-sm text-stone-600">
                <span>
                  Arrivals{" "}
                  <b className="text-stone-900">{trendTotals.arrivals}</b>
                </span>
                <span>
                  Departures{" "}
                  <b className="text-stone-900">{trendTotals.departures}</b>
                </span>
                <span>
                  No-shows{" "}
                  <b className="text-stone-900">{trendTotals.noShows}</b>
                </span>
                <span className="text-stone-500">
                  Exact daily occupancy appears beneath each date.
                </span>
              </div>
            </>
          ) : (
            <p className="mt-4 rounded-xl bg-stone-50 p-4 text-sm text-stone-600">
              No trend data is available yet.
            </p>
          )}
        </section>
      )}
      {canSeeManagementSummary && dailySummary.data && (
        <section className="mt-6 rounded-2xl border border-stone-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">Business-day summary</h2>
              <p className="mt-1 text-sm text-stone-600">
                {dailySummary.data.business_date} · Remaining activity is kept
                separate from completed activity.
              </p>
            </div>
            <p className="text-sm font-medium text-stone-700">
              Night audit: {dailySummary.data.night_audit_status ?? "not run"}
            </p>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Link
              to="/stays"
              className="rounded-lg bg-stone-50 p-3 hover:bg-stone-100"
            >
              <p className="text-xs text-stone-500">Arrivals remaining</p>
              <p className="mt-1 text-xl font-semibold">
                {dailySummary.data.scheduled_arrivals}
              </p>
              <p className="mt-1 text-xs text-stone-500">
                Checked in: {dailySummary.data.checked_in_arrivals}
              </p>
            </Link>
            <Link
              to="/departures"
              className="rounded-lg bg-stone-50 p-3 hover:bg-stone-100"
            >
              <p className="text-xs text-stone-500">Departures remaining</p>
              <p className="mt-1 text-xl font-semibold">
                {dailySummary.data.scheduled_departures}
              </p>
              <p className="mt-1 text-xs text-stone-500">
                Checked out: {dailySummary.data.checked_out_departures}
              </p>
            </Link>
            <Link
              to="/rooms"
              className="rounded-lg bg-stone-50 p-3 hover:bg-stone-100"
            >
              <p className="text-xs text-stone-500">In-house stays</p>
              <p className="mt-1 text-xl font-semibold">
                {dailySummary.data.in_house_guests}
              </p>
            </Link>
            <Link
              to="/payments"
              className="rounded-lg bg-stone-50 p-3 hover:bg-stone-100"
            >
              <p className="text-xs text-stone-500">Room charges posted</p>
              <p className="mt-1 text-xl font-semibold">
                {formatNaira(dailySummary.data.room_charge_posted_kobo)}
              </p>
              <p className="mt-1 text-xs text-stone-500">
                Audit posts: {dailySummary.data.night_audit_posts_created ?? 0}
              </p>
            </Link>
          </div>
        </section>
      )}
      {canSeeRoomOverview && (
        <section className="mt-6 rounded-2xl border border-stone-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">Front desk attention</h2>
              <p className="mt-1 text-sm text-stone-600">
                Expected arrivals and departures that need front-desk action.
              </p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${arrivals.error || occupants.error ? "bg-amber-100 text-amber-900" : arrivals.data?.length || overdueOccupants.length || dueTodayWithBalance.length ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"}`}
            >
              {arrivals.isLoading || occupants.isLoading
                ? "Checking front desk"
                : arrivals.error || occupants.error
                  ? "Some alerts unavailable"
                  : (arrivals.data?.length ?? 0) + overdueOccupants.length + dueTodayWithBalance.length
                    ? `${(arrivals.data?.length ?? 0) + overdueOccupants.length + dueTodayWithBalance.length} action${(arrivals.data?.length ?? 0) + overdueOccupants.length + dueTodayWithBalance.length === 1 ? "" : "s"}`
                    : "No front-desk action"}
            </span>
          </div>
          {arrivals.error ? (
            <p className="mt-4 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">
              Expected-arrival alerts could not be loaded. The check-in list remains available.
            </p>
          ) : arrivals.data?.length ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {arrivals.data.map((arrival) => (
                <Link
                  to={arrival.room_number ? "/stays" : "/reservations"}
                  key={arrival.reservation_id}
                  className={`rounded-lg border p-4 transition hover:-translate-y-0.5 hover:shadow-sm ${arrival.arrival_state === "overdue" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">{arrival.guest_name}</p>
                      <p className="mt-1 text-xs text-stone-600">
                        {arrival.room_number ? `Room ${arrival.room_number}` : "Room not assigned"} · {arrival.room_type_name}
                      </p>
                      <p className="mt-1 text-xs text-stone-500">{arrival.reservation_number} · Arrival {arrival.check_in_date}</p>
                    </div>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold">
                      {arrival.arrival_state === "overdue" ? "Overdue arrival" : "Expected today"}
                    </span>
                  </div>
                  <p className="mt-3 text-sm font-semibold text-amber-950">
                    {arrival.room_number ? "Review guest and room for check-in →" : "Assign a room before check-in →"}
                  </p>
                </Link>
              ))}
            </div>
          ) : null}
          {occupants.error ? (
            <p className="mt-4 rounded-lg bg-red-50 p-4 text-sm text-red-800">
              Departure alerts could not be loaded. Refresh once, then check
              that the latest in-house occupant migration is applied.
            </p>
          ) : occupants.isLoading ? (
            <p className="mt-4 rounded-lg bg-stone-50 p-4 text-sm text-stone-600">
              Checking current stays…
            </p>
          ) : overdueOccupants.length > 0 || dueTodayWithBalance.length > 0 ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {[...overdueOccupants, ...dueTodayWithBalance].map((occupant) => (
                <Link
                  to="/departures"
                  key={occupant.stay_id}
                  className={`rounded-lg border p-4 transition hover:-translate-y-0.5 hover:shadow-sm ${occupant.departure_state === "overdue" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">
                        Room {occupant.room_number} · {occupant.guest_name}
                      </p>
                      <p className="mt-1 text-xs text-stone-600">
                        Expected checkout: {occupant.expected_check_out_date}
                      </p>
                    </div>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold">
                      {occupant.departure_state === "overdue"
                        ? `${occupant.days_overdue}d overdue`
                        : "Due today"}
                    </span>
                  </div>
                  <p className="mt-3 text-sm font-semibold text-red-800">
                    {occupant.balance_kobo > 0
                      ? `${formatNaira(occupant.balance_kobo)} due — collect payment and complete checkout.`
                      : occupant.balance_kobo < 0
                        ? `Guest credit ${formatNaira(Math.abs(occupant.balance_kobo))} — resolve credit and complete checkout.`
                        : "Folio settled — complete checkout or update the stay."}
                  </p>
                </Link>
              ))}
            </div>
          ) : arrivals.error ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {[...overdueOccupants, ...dueTodayWithBalance].map((occupant) => (
                <Link
                  to="/departures"
                  key={occupant.stay_id}
                  className={`rounded-lg border p-4 transition hover:-translate-y-0.5 hover:shadow-sm ${occupant.departure_state === "overdue" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">Room {occupant.room_number} · {occupant.guest_name}</p>
                      <p className="mt-1 text-xs text-stone-600">Expected checkout: {occupant.expected_check_out_date}</p>
                    </div>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold">{occupant.departure_state === "overdue" ? `${occupant.days_overdue}d overdue` : "Due today"}</span>
                  </div>
                  <p className="mt-3 text-sm font-semibold text-red-800">
                    {occupant.balance_kobo > 0 ? `${formatNaira(occupant.balance_kobo)} due — collect payment and complete checkout.` : occupant.balance_kobo < 0 ? `Guest credit ${formatNaira(Math.abs(occupant.balance_kobo))} — resolve credit and complete checkout.` : "Folio settled — complete checkout or update the stay."}
                  </p>
                </Link>
              ))}
            </div>
          ) : !arrivals.isLoading && !arrivals.error && !arrivals.data?.length ? (
            <p className="mt-4 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-900">
              No expected arrival or departure currently requires attention.
            </p>
          ) : null}
        </section>
      )}
      {canSeeManagementSummary && (
        <section className="mt-6 rounded-2xl border border-stone-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">Management attention</h2>
              <p className="mt-1 text-sm text-stone-600">
                Live operational conditions that should be reviewed by the GM.
              </p>
            </div>
            <span
              className={
                managementAlerts.length
                  ? "rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900"
                  : "rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800"
              }
            >
              {managementAlertsLoading
                ? "Checking alerts"
                : managementAlerts.length
                  ? `${managementAlerts.length} alert${managementAlerts.length === 1 ? "" : "s"}`
                  : "No active alerts"}
            </span>
          </div>
          {managementAlertsLoading ? (
            <p className="mt-4 rounded-lg bg-stone-50 p-4 text-sm text-stone-600">
              Checking current operational alerts…
            </p>
          ) : managementAlerts.length ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {managementAlerts.map((alert) => (
                <Link
                  to={alert.to}
                  key={alert.key}
                  className={
                    alert.urgent
                      ? "rounded-lg border border-red-200 bg-red-50 p-4 transition hover:-translate-y-0.5 hover:shadow-sm"
                      : "rounded-lg border border-amber-200 bg-amber-50 p-4 transition hover:-translate-y-0.5 hover:shadow-sm"
                  }
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-semibold">{alert.label}</p>
                    {alert.count !== null && (
                      <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold">
                        {alert.count}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-stone-700">{alert.detail}</p>
                </Link>
              ))}
            </div>
          ) : (
            <p className="mt-4 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-900">
              No active operational exception requires management attention.
            </p>
          )}
        </section>
      )}
      <Modal
        open={canSeeRoomOverview && showOccupied}
        title="Occupied rooms by type"
        onClose={() => setShowOccupied(false)}
      >
        {occupiedByType.length ? (
          <div className="space-y-3">
            {occupiedByType.map(([type, total]) => (
              <div
                key={type}
                className="flex justify-between rounded-lg bg-stone-50 p-3"
              >
                <span>{type}</span>
                <b>{total} occupied</b>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-stone-600">
            No rooms are occupied right now.
          </p>
        )}
      </Modal>
      <Modal
        open={canSeeRoomOverview && showDirty}
        title="Rooms awaiting housekeeping"
        onClose={() => setShowDirty(false)}
      >
        {dirtyRooms.length ? (
          <div className="space-y-3">
            {dirtyRooms.map((room) => (
              <div key={room.id} className="rounded-lg bg-rose-50 p-3">
                <p className="font-semibold">Room {room.room_number}</p>
                <p className="mt-1 text-sm text-rose-900">
                  {room.room_type_name} ·{" "}
                  {room.blocked_reason ?? "Awaiting housekeeping turnover"}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-stone-600">
            No rooms are awaiting housekeeping.
          </p>
        )}
      </Modal>
    </section>
  );
}
