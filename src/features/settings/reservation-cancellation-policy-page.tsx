import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { EmptyState, PageError, PageLoading } from "@/components/shared/page-state";
import {
  getReservationCancellationPolicy,
  updateReservationCancellationPolicy,
  type ReservationCancellationPolicy,
} from "@/features/reception/reception-service";
import { useActiveHotel } from "@/features/reception/use-reception";

export function ReservationCancellationPolicyPage() {
  const hotel = useActiveHotel();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const policy = useQuery({
    queryKey: ["reservation-cancellation-policy", hotel.data?.id],
    queryFn: () => getReservationCancellationPolicy(hotel.data!.id),
    enabled: Boolean(hotel.data?.id),
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hotel.data) return;
    const form = new FormData(event.currentTarget);
    const values: Omit<ReservationCancellationPolicy, "hotel_id"> = {
      free_cancellation_hours: Number(form.get("freeCancellationHours")),
      late_cancellation_charge_nights: Number(form.get("lateCancellationNights")),
      no_show_grace_hours: Number(form.get("noShowGraceHours")),
      no_show_charge_nights: Number(form.get("noShowNights")),
      cancellation_policy_notes: String(form.get("notes") ?? "").trim() || null,
      cancellation_policy_confirmed: form.get("confirmPolicy") === "on",
    };
    setBusy(true);
    setMessage(null);
    try {
      await updateReservationCancellationPolicy(hotel.data.id, values);
      await queryClient.invalidateQueries({ queryKey: ["reservation-cancellation-policy", hotel.data.id] });
      setMessage("Policy saved. It applies to new reservations only; existing bookings keep their recorded terms.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Policy could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (hotel.isLoading || policy.isLoading) return <PageLoading />;
  if (hotel.error || policy.error) return <PageError message="Unable to load cancellation policy." />;
  if (!hotel.data || !policy.data) return <EmptyState>Cancellation policy is not available.</EmptyState>;

  return (
    <section className="max-w-4xl">
      <p className="text-sm font-medium text-amber-800">Administration</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Cancellation &amp; no-show policy</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
        Set the hotel&apos;s guest-facing terms. They are snapshotted when each reservation is created, so later edits never rewrite an existing booking.
      </p>
      <p className={`mt-4 rounded-xl border p-3 text-sm ${policy.data.cancellation_policy_confirmed ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-950"}`}>
        {policy.data.cancellation_policy_confirmed ? "Current policy is confirmed for new bookings." : "Policy is not confirmed. New bookings will be marked unconfirmed; staff must not promise or apply these draft terms."}
      </p>
      {message && <p role="status" className="mt-5 rounded-xl bg-stone-100 p-4 text-sm">{message}</p>}
      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
        <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2"><ShieldCheck className="size-5 text-amber-800" /><h2 className="font-semibold">Guest terms</h2></div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <NumberInput name="freeCancellationHours" label="Free cancellation deadline (hours before arrival)" min={0} max={720} defaultValue={policy.data.free_cancellation_hours} />
            <NumberInput name="lateCancellationNights" label="Late-cancellation charge (nights)" min={0} max={30} step="0.5" defaultValue={policy.data.late_cancellation_charge_nights} />
            <NumberInput name="noShowGraceHours" label="No-show grace period (hours after scheduled check-in)" min={0} max={72} defaultValue={policy.data.no_show_grace_hours} />
            <NumberInput name="noShowNights" label="No-show charge (nights)" min={0} max={30} step="0.5" defaultValue={policy.data.no_show_charge_nights} />
          </div>
          <label className="mt-4 block text-sm font-medium text-stone-700">
            Policy wording / conditions
            <textarea name="notes" rows={4} defaultValue={policy.data.cancellation_policy_notes ?? ""} placeholder="State how guests are informed, any exceptions, and who can approve a waiver." className="mt-2 w-full rounded-xl border border-stone-300 px-3 py-2.5" />
          </label>
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-950">
            A zero-night fee means no fee is specified. These values are policy records only: they do not charge a guest, forfeit a deposit, create a receivable, or issue a refund. Any financial action must use its separately authorized workflow. Confirm the wording with hotel leadership and the accountant before using it in guest confirmations.
          </p>
          <label className="mt-4 flex items-start gap-3 rounded-xl border border-stone-200 p-3 text-sm leading-5 text-stone-700">
            <input required type="checkbox" name="confirmPolicy" defaultChecked={false} className="mt-1 size-4 accent-amber-900" />
            <span>I confirm hotel management has approved these exact guest-facing cancellation and no-show terms and that they will be disclosed before the guest confirms the reservation.</span>
          </label>
        </div>
        <div className="flex justify-end"><FormSubmitButton disabled={busy} className="rounded-xl bg-amber-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{busy ? "Saving policy…" : "Save cancellation policy"}</FormSubmitButton></div>
      </form>
    </section>
  );
}

function NumberInput({ name, label, min, max, step = "1", defaultValue }: { name: string; label: string; min: number; max: number; step?: string; defaultValue: number }) {
  return <label className="text-sm font-medium text-stone-700">{label}<input required type="number" name={name} min={min} max={max} step={step} defaultValue={defaultValue} className="mt-2 w-full rounded-xl border border-stone-300 px-3 py-2.5" /></label>;
}
