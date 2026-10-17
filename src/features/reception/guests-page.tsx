import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GitMerge, Plus, Search, Users, X } from "lucide-react";

import {
  EmptyState,
  PageError,
  PageLoading,
} from "@/components/shared/page-state";
import { Modal } from "@/components/shared/modal";

import {
  anonymiseGuest,
  createGuest,
  deactivateGuest,
  mergeGuests,
  updateGuest,
  type Guest,
} from "./reception-service";
import { useActiveHotel, useGuests } from "./use-reception";

export function GuestsPage() {
  const hotel = useActiveHotel();
  const guests = useGuests(hotel.data?.id);
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editingGuest, setEditingGuest] = useState<Guest | null>(null);
  const [reasonAction, setReasonAction] = useState<{
    type: "deactivate" | "anonymise";
    guestId: string;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [mergeSourceId, setMergeSourceId] = useState("");
  const [mergeSurvivorId, setMergeSurvivorId] = useState("");
  const [isMergeOpen, setIsMergeOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [search, setSearch] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hotel.data) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setIsSaving(true);
    setMessage(null);
    try {
      await createGuest(hotel.data.id, {
        fullName: String(form.get("fullName") ?? ""),
        phone: String(form.get("phone") ?? ""),
        email: String(form.get("email") ?? ""),
      });
      formElement.reset();
      setIsCreateOpen(false);
      setMessage("Guest created.");
      try {
        await queryClient.invalidateQueries({
          queryKey: ["guests", hotel.data.id],
        });
      } catch {
        setMessage(
          "Guest created, but the guest list could not refresh. Refresh the page to see it.",
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `The guest could not be created: ${error.message}`
          : "The guest could not be created. Check the information and your access.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingGuest) return;
    const form = new FormData(event.currentTarget);
    setIsSaving(true);
    setMessage(null);
    try {
      await updateGuest(editingGuest.id, {
        fullName: String(form.get("fullName") ?? ""),
        phone: String(form.get("phone") ?? ""),
        email: String(form.get("email") ?? ""),
      });
      setEditingGuest(null);
      await queryClient.invalidateQueries({
        queryKey: ["guests", hotel.data?.id],
      });
      setMessage("Guest details updated.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Guest details could not be updated.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleReasonAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reasonAction || !reason.trim()) return;
    setIsSaving(true);
    setMessage(null);
    try {
      if (reasonAction.type === "deactivate")
        await deactivateGuest(reasonAction.guestId, reason);
      else await anonymiseGuest(reasonAction.guestId, reason);
      await queryClient.invalidateQueries({
        queryKey: ["guests", hotel.data?.id],
      });
      setMessage(
        reasonAction.type === "deactivate"
          ? "Guest deactivated and retained for historical records."
          : "Guest personal details anonymised and retained for audit history.",
      );
      setReasonAction(null);
      setReason("");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Guest action could not be completed.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleMerge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mergeSourceId || !mergeSurvivorId || mergeSourceId === mergeSurvivorId)
      return;
    const form = new FormData(event.currentTarget);
    const mergeReason = String(form.get("reason") ?? "").trim();
    if (!mergeReason) return;
    setIsSaving(true);
    setMessage(null);
    try {
      await mergeGuests(mergeSurvivorId, mergeSourceId, mergeReason);
      setMergeSourceId("");
      setMergeSurvivorId("");
      setIsMergeOpen(false);
      await queryClient.invalidateQueries({
        queryKey: ["guests", hotel.data?.id],
      });
      setMessage(
        "Guest records merged. Historical reservations now point to the surviving guest.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Guest records could not be merged.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  if (hotel.isLoading || guests.isLoading) return <PageLoading />;
  if (hotel.error || guests.error)
    return (
      <PageError message="Unable to load guests. Apply the reception-core migration and check access." />
    );
  if (!hotel.data)
    return <EmptyState>No hotel is assigned to your staff account.</EmptyState>;
  const visibleGuests = (guests.data ?? []).filter((guest) =>
    `${guest.full_name} ${guest.phone ?? ""} ${guest.email ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  return (
    <section className="max-w-6xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-amber-800">Reception</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Guests</h1>
          <p className="mt-2 text-sm text-stone-600">
            Find guest profiles quickly and keep contact records accurate.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(guests.data?.length ?? 0) > 1 && (
            <button
              type="button"
              onClick={() => setIsMergeOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-xs font-semibold shadow-sm hover:bg-stone-50"
            >
              <GitMerge className="size-4" />
              Merge duplicates
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsCreateOpen((current) => !current)}
            className="inline-flex items-center gap-2 rounded-xl bg-amber-900 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-amber-950"
          >
            {isCreateOpen ? (
              <X className="size-4" />
            ) : (
              <Plus className="size-4" />
            )}
            {isCreateOpen ? "Close form" : "Add guest"}
          </button>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-2 gap-3">
        <article className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-stone-500">Guest profiles</p>
            <Users className="size-4 text-stone-400" />
          </div>
          <p className="mt-2 text-2xl font-semibold">
            {guests.data?.length ?? 0}
          </p>
        </article>
        <article className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-stone-500">
            With contact details
          </p>
          <p className="mt-2 text-2xl font-semibold">
            {guests.data?.filter((guest) => guest.phone || guest.email)
              .length ?? 0}
          </p>
        </article>
      </div>
      {isCreateOpen && (
        <form
          onSubmit={handleSubmit}
          className="mt-7 grid gap-3 rounded-xl border border-stone-200 bg-white p-5 sm:grid-cols-4"
        >
          <input
            required
            name="fullName"
            placeholder="Full name"
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          />
          <input
            name="phone"
            placeholder="Phone"
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          />
          <input
            name="email"
            type="email"
            placeholder="Email"
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          />
          <button
            disabled={isSaving}
            className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {isSaving ? "Saving…" : "Add guest"}
          </button>
          {message && (
            <p className="sm:col-span-4 text-sm text-stone-600" role="status">
              {message}
            </p>
          )}
        </form>
      )}
      {editingGuest && (
        <form
          onSubmit={handleEdit}
          className="mt-4 grid gap-3 rounded-xl border border-amber-200 bg-amber-50 p-5 sm:grid-cols-4"
        >
          <p className="sm:col-span-4 text-sm font-semibold text-amber-950">
            Edit {editingGuest.full_name}
          </p>
          <input
            required
            name="fullName"
            defaultValue={editingGuest.full_name}
            placeholder="Full name"
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          />
          <input
            name="phone"
            defaultValue={editingGuest.phone || ""}
            placeholder="Phone"
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          />
          <input
            name="email"
            type="email"
            defaultValue={editingGuest.email || ""}
            placeholder="Email"
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          />
          <div className="flex gap-2">
            <button
              disabled={isSaving}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditingGuest(null)}
              className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <label className="relative mt-7 block">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search guests by name, phone or email"
          className="w-full rounded-xl border border-stone-200 bg-white py-3 pl-10 pr-3 text-sm shadow-sm"
        />
      </label>
      <div className="mt-3 overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-sm">
        {!guests.data?.length ? (
          <EmptyState>No guest profiles yet.</EmptyState>
        ) : !visibleGuests.length ? (
          <EmptyState>No guests match your search.</EmptyState>
        ) : (
          visibleGuests.map((guest) => (
            <article
              key={guest.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 px-5 py-4 last:border-0"
            >
              <div>
                <p className="font-medium">{guest.full_name}</p>
                <p className="text-sm text-stone-500">
                  {guest.phone || guest.email || "No contact details"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditingGuest(guest)}
                  className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => {
                    setReasonAction({ type: "deactivate", guestId: guest.id });
                    setReason("");
                  }}
                  className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold"
                >
                  Deactivate
                </button>
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => {
                    setReasonAction({ type: "anonymise", guestId: guest.id });
                    setReason("");
                  }}
                  className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700"
                >
                  Anonymise
                </button>
              </div>
            </article>
          ))
        )}
      </div>
      <Modal
        open={Boolean(reasonAction)}
        title={
          reasonAction?.type === "deactivate"
            ? "Deactivate guest"
            : "Anonymise guest"
        }
        onClose={() => setReasonAction(null)}
      >
        <form onSubmit={handleReasonAction}>
          <label className="block text-sm font-medium text-stone-700">
            Reason
            <textarea
              required
              autoFocus
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5"
            />
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setReasonAction(null)}
              className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving || !reason.trim()}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {isSaving ? "Saving…" : "Continue"}
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={isMergeOpen}
        title="Merge duplicate guests"
        onClose={() => setIsMergeOpen(false)}
      >
        <form onSubmit={handleMerge}>
          <label className="block text-sm font-medium text-stone-700">
            Duplicate record
            <select
              required
              value={mergeSourceId}
              onChange={(event) => setMergeSourceId(event.target.value)}
              className="mt-2 block w-full rounded-lg border border-stone-300 px-3 py-2.5"
            >
              <option value="">Select duplicate</option>
              {guests.data
                ?.filter((guest) => guest.id !== mergeSurvivorId)
                .map((guest) => (
                  <option key={guest.id} value={guest.id}>
                    {guest.full_name}
                  </option>
                ))}
            </select>
          </label>
          <label className="mt-4 block text-sm font-medium text-stone-700">
            Surviving record
            <select
              required
              value={mergeSurvivorId}
              onChange={(event) => setMergeSurvivorId(event.target.value)}
              className="mt-2 block w-full rounded-lg border border-stone-300 px-3 py-2.5"
            >
              <option value="">Select survivor</option>
              {guests.data
                ?.filter((guest) => guest.id !== mergeSourceId)
                .map((guest) => (
                  <option key={guest.id} value={guest.id}>
                    {guest.full_name}
                  </option>
                ))}
            </select>
          </label>
          <label className="mt-4 block text-sm font-medium text-stone-700">
            Reason
            <textarea
              required
              name="reason"
              rows={3}
              className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5"
            />
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsMergeOpen(false)}
              className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {isSaving ? "Merging…" : "Merge records"}
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
