import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CircleCheck,
  Clock3,
  Plus,
  Search,
  Wrench,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { Modal } from "@/components/shared/modal";
import {
  EmptyState,
  PageError,
  PageLoading,
} from "@/components/shared/page-state";
import { useAccess } from "@/features/auth/use-access";

import {
  raiseMaintenanceTicket,
  setMaintenanceRoomOutOfService,
  updateMaintenanceTicket,
  type MaintenanceTicket,
} from "./reception-service";
import {
  useActiveHotel,
  useMaintenanceTickets,
  useRoomBoard,
} from "./use-reception";

const priorityStyle: Record<MaintenanceTicket["priority"], string> = {
  low: "bg-stone-100 text-stone-700",
  normal: "bg-sky-50 text-sky-800",
  high: "bg-amber-100 text-amber-900",
  urgent: "bg-red-100 text-red-800",
};

export function MaintenancePage() {
  const hotel = useActiveHotel();
  const tickets = useMaintenanceTickets(hotel.data?.id);
  const rooms = useRoomBoard(hotel.data?.id);
  const { roleCodes } = useAccess();
  const queryClient = useQueryClient();
  const [reportOpen, setReportOpen] = useState(false);
  const [action, setAction] = useState<{
    ticket: MaintenanceTicket;
    status: "in_progress" | "resolved";
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const canManage =
    roleCodes.includes("owner") || roleCodes.includes("general_manager");
  const roomListUnavailable = Boolean(rooms.error);
  const refreshTickets = () =>
    queryClient.invalidateQueries({
      queryKey: ["maintenance-tickets", hotel.data?.id],
    });

  async function report(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await raiseMaintenanceTicket(
        String(form.get("roomId")),
        String(form.get("description")),
        String(form.get("priority")) as MaintenanceTicket["priority"],
      );
      setReportOpen(false);
      await refreshTickets();
      setMessage("Maintenance ticket reported.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Ticket could not be reported.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function progress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await updateMaintenanceTicket(
        action.ticket.id,
        action.status,
        String(form.get("notes") || ""),
      );
      const completedStatus = action.status;
      setAction(null);
      await refreshTickets();
      setMessage(
        completedStatus === "resolved" ? "Ticket resolved." : "Repair started.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Ticket could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function setOutOfService(
    ticket: MaintenanceTicket,
    outOfService: boolean,
  ) {
    setBusy(true);
    try {
      await setMaintenanceRoomOutOfService(ticket.id, outOfService);
      await Promise.all([
        refreshTickets(),
        queryClient.invalidateQueries({
          queryKey: ["room-board", hotel.data?.id],
        }),
      ]);
      setMessage(
        outOfService
          ? "Room taken out of service."
          : "Room returned to service.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Room service status could not be changed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (hotel.isLoading || tickets.isLoading) return <PageLoading />;
  if (hotel.error || tickets.error)
    return (
      <PageError
        message={
          tickets.error instanceof Error
            ? `Unable to load maintenance tickets: ${tickets.error.message}`
            : "Unable to load maintenance tickets. Check maintenance access."
        }
      />
    );
  if (!hotel.data)
    return <EmptyState>No hotel is assigned to your staff account.</EmptyState>;

  const ticketList = tickets.data ?? [];
  const activeCount = ticketList.filter((ticket) =>
    ["open", "in_progress"].includes(ticket.status),
  ).length;
  const urgentCount = ticketList.filter(
    (ticket) =>
      ["open", "in_progress"].includes(ticket.status) &&
      ["high", "urgent"].includes(ticket.priority),
  ).length;
  const outOfServiceCount = ticketList.filter(
    (ticket) => ticket.out_of_service_at && !ticket.returned_to_service_at,
  ).length;
  const resolvedCount = ticketList.filter(
    (ticket) => ticket.status === "resolved",
  ).length;
  const visibleTickets = ticketList.filter((ticket) => {
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active"
        ? ["open", "in_progress"].includes(ticket.status)
        : ticket.status === statusFilter);
    const matchesPriority =
      priorityFilter === "all" || ticket.priority === priorityFilter;
    const matchesSearch =
      `${ticket.ticket_number} ${ticket.rooms?.room_number ?? ""} ${ticket.description}`
        .toLowerCase()
        .includes(search.toLowerCase());
    return matchesStatus && matchesPriority && matchesSearch;
  });

  return (
    <section className="max-w-6xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-amber-800">Operations</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Maintenance
          </h1>
          <p className="mt-2 text-sm text-stone-600">
            Prioritize room faults, protect availability, and track repairs to
            completion.
          </p>
        </div>
        <button
          type="button"
          disabled={rooms.isLoading || roomListUnavailable}
          onClick={() => setReportOpen(true)}
          className="inline-flex w-fit items-center gap-2 rounded-xl bg-amber-900 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-amber-950 disabled:opacity-60"
        >
          <Plus className="size-4" />
          Report a fault
        </button>
      </div>
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => setStatusFilter("active")}
          className="rounded-2xl border border-amber-100 bg-amber-50/70 p-4 text-left shadow-sm"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs text-amber-800">Active tickets</p>
            <Clock3 className="size-4 text-amber-700" />
          </div>
          <p className="mt-2 text-2xl font-semibold text-amber-950">
            {activeCount}
          </p>
        </button>
        <article className="rounded-2xl border border-red-100 bg-red-50/70 p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs text-red-800">High priority</p>
            <AlertTriangle className="size-4 text-red-600" />
          </div>
          <p className="mt-2 text-2xl font-semibold text-red-900">
            {urgentCount}
          </p>
        </article>
        <article className="rounded-2xl border border-stone-200 bg-stone-100/80 p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs text-stone-600">Out of service</p>
            <Wrench className="size-4 text-stone-500" />
          </div>
          <p className="mt-2 text-2xl font-semibold">{outOfServiceCount}</p>
        </article>
        <button
          type="button"
          onClick={() => setStatusFilter("resolved")}
          className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4 text-left shadow-sm"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs text-emerald-800">Resolved</p>
            <CircleCheck className="size-4 text-emerald-600" />
          </div>
          <p className="mt-2 text-2xl font-semibold text-emerald-900">
            {resolvedCount}
          </p>
        </button>
      </div>
      {roomListUnavailable && (
        <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Tickets are available, but the room list could not load. Refresh
          before reporting a new fault.
        </p>
      )}
      {message && (
        <p
          className="mt-5 rounded-xl bg-stone-100 p-3 text-sm text-stone-700"
          role="status"
        >
          {message}
        </p>
      )}
      <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-stone-200/80 bg-white p-3 shadow-sm sm:flex-row">
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search ticket, room or fault"
            className="w-full rounded-xl border border-stone-200 py-2.5 pl-9 pr-3 text-sm"
          />
        </label>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="rounded-xl border border-stone-200 px-3 py-2.5 text-sm"
        >
          <option value="active">Active tickets</option>
          <option value="all">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
        </select>
        <select
          value={priorityFilter}
          onChange={(event) => setPriorityFilter(event.target.value)}
          className="rounded-xl border border-stone-200 px-3 py-2.5 text-sm"
        >
          <option value="all">All priorities</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
      </div>
      <div className="mt-4 space-y-3">
        {!ticketList.length ? (
          <EmptyState>No maintenance tickets have been reported.</EmptyState>
        ) : !visibleTickets.length ? (
          <EmptyState>No tickets match the selected filters.</EmptyState>
        ) : (
          visibleTickets.map((ticket) => (
            <article
              key={ticket.id}
              className={`rounded-2xl border bg-white p-5 shadow-sm ${ticket.priority === "urgent" ? "border-red-200" : ticket.priority === "high" ? "border-amber-200" : "border-stone-200/80"}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">
                      {ticket.ticket_number} · Room{" "}
                      {ticket.rooms?.room_number ?? "Unknown"}
                    </p>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${priorityStyle[ticket.priority]}`}
                    >
                      {ticket.priority}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-stone-700">
                    {ticket.description}
                  </p>
                  <p className="mt-2 text-xs text-stone-500">
                    Reported {new Date(ticket.reported_at).toLocaleString()}
                  </p>
                  {ticket.out_of_service_at &&
                    !ticket.returned_to_service_at && (
                      <p className="mt-2 text-sm font-semibold text-red-700">
                        Room is out of service
                      </p>
                    )}
                  {ticket.resolution_notes && (
                    <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
                      Resolution: {ticket.resolution_notes}
                    </p>
                  )}
                </div>
                <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold capitalize">
                  {ticket.status.replace("_", " ")}
                </span>
              </div>
              {canManage && ticket.status === "open" && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setAction({ ticket, status: "in_progress" })}
                    className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold"
                  >
                    Start repair
                  </button>
                  <button
                    type="button"
                    disabled={busy || Boolean(ticket.out_of_service_at)}
                    onClick={() => setOutOfService(ticket, true)}
                    className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700"
                  >
                    Take out of service
                  </button>
                </div>
              )}
              {canManage && ticket.status === "in_progress" && (
                <button
                  type="button"
                  onClick={() => setAction({ ticket, status: "resolved" })}
                  className="mt-4 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white"
                >
                  Resolve ticket
                </button>
              )}
              {canManage &&
                ticket.status === "resolved" &&
                ticket.out_of_service_at &&
                !ticket.returned_to_service_at && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setOutOfService(ticket, false)}
                    className="mt-4 rounded-lg bg-amber-900 px-3 py-2 text-xs font-semibold text-white"
                  >
                    Return room to service
                  </button>
                )}
            </article>
          ))
        )}
      </div>
      <Modal
        open={reportOpen}
        title="Report maintenance fault"
        onClose={() => setReportOpen(false)}
      >
        <form onSubmit={report} className="grid gap-3">
          <select
            required
            name="roomId"
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          >
            <option value="">Room</option>
            {rooms.data?.map((room) => (
              <option key={room.id} value={room.id}>
                Room {room.room_number} · {room.room_type_name}
              </option>
            ))}
          </select>
          <select
            name="priority"
            defaultValue="normal"
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
          <textarea
            required
            name="description"
            rows={4}
            placeholder="Describe the fault and guest impact"
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          />
          <FormSubmitButton
            disabled={busy || rooms.isLoading || roomListUnavailable}
            className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
          >
            Report fault
          </FormSubmitButton>
        </form>
      </Modal>
      <Modal
        open={Boolean(action)}
        title={
          action?.status === "resolved"
            ? "Resolve maintenance ticket"
            : "Start repair"
        }
        onClose={() => setAction(null)}
      >
        {action && (
          <form onSubmit={progress} className="grid gap-3">
            {action.status === "resolved" && (
              <textarea
                required
                name="notes"
                rows={4}
                placeholder="Repair work completed and sign-off notes"
                className="rounded-lg border border-stone-300 px-3 py-2.5"
              />
            )}
            {action.status === "in_progress" && (
              <p className="text-sm text-stone-600">
                This records that repair work has started.
              </p>
            )}
            <FormSubmitButton
              disabled={busy}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
            >
              Confirm
            </FormSubmitButton>
          </form>
        )}
      </Modal>
    </section>
  );
}
