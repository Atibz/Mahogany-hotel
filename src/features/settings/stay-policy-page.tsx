import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, ShieldCheck } from "lucide-react";

import { EmptyState, PageError, PageLoading } from "@/components/shared/page-state";
import {
  getStayLifecyclePolicy,
  updateStayLifecyclePolicy,
  type StayLifecyclePolicy,
} from "@/features/reception/reception-service";
import { useActiveHotel } from "@/features/reception/use-reception";

function timeInputValue(value: string | null, fallback: string) {
  return value?.slice(0, 5) || fallback;
}

export function StayPolicyPage() {
  const hotel = useActiveHotel();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const policy = useQuery({
    queryKey: ["stay-lifecycle-policy", hotel.data?.id],
    queryFn: () => getStayLifecyclePolicy(hotel.data!.id),
    enabled: Boolean(hotel.data?.id),
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hotel.data) return;
    const form = new FormData(event.currentTarget);
    const values: Omit<StayLifecyclePolicy, "hotel_id"> = {
      standard_check_in_time: String(form.get("checkInTime")),
      standard_check_out_time: String(form.get("checkOutTime")),
      early_check_in_policy: String(form.get("earlyCheckIn")) as StayLifecyclePolicy["early_check_in_policy"],
      late_checkout_policy: String(form.get("lateCheckout")) as StayLifecyclePolicy["late_checkout_policy"],
      early_departure_policy: String(form.get("earlyDeparture")) as StayLifecyclePolicy["early_departure_policy"],
      extra_night_policy: String(form.get("extraNight")) as StayLifecyclePolicy["extra_night_policy"],
      stay_policy_notes: String(form.get("notes") ?? "") || null,
    };
    setBusy(true);
    setMessage(null);
    try {
      await updateStayLifecyclePolicy(hotel.data.id, values);
      await queryClient.invalidateQueries({
        queryKey: ["stay-lifecycle-policy", hotel.data.id],
      });
      setMessage("Stay lifecycle policy saved and added to the audit trail.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Policy could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (hotel.isLoading || policy.isLoading) return <PageLoading />;
  if (hotel.error || policy.error) return <PageError message="Unable to load hotel policy." />;
  if (!hotel.data || !policy.data)
    return <EmptyState>Hotel policy is not available.</EmptyState>;

  return (
    <section className="max-w-4xl">
      <p className="text-sm font-medium text-amber-800">Administration</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Stay policy</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
        Define when guests normally arrive and depart, and how reception handles exceptions.
        These settings do not create automatic fees or alter posted charges.
      </p>
      <p className="mt-3 max-w-2xl rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs leading-5 text-sky-900">
        Early/late time exceptions, early-departure review, and extra-night approval are enforced for new stay activity. Historical stays created before timestamp tracking retain their original date-only evidence.
      </p>

      {message && <p role="status" className="mt-5 rounded-xl bg-stone-100 p-4 text-sm">{message}</p>}

      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
        <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <Clock3 className="size-5 text-amber-800" />
            <h2 className="font-semibold">Standard times</h2>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-stone-700">
              Check-in time
              <input required name="checkInTime" type="time" defaultValue={timeInputValue(policy.data.standard_check_in_time, "14:00")} className="mt-2 w-full rounded-xl border border-stone-300 px-3 py-2.5" />
            </label>
            <label className="text-sm font-medium text-stone-700">
              Checkout time
              <input required name="checkOutTime" type="time" defaultValue={timeInputValue(policy.data.standard_check_out_time, "12:00")} className="mt-2 w-full rounded-xl border border-stone-300 px-3 py-2.5" />
            </label>
          </div>
        </div>

        <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-amber-800" />
            <h2 className="font-semibold">Exception handling</h2>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <PolicySelect name="earlyCheckIn" label="Early check-in" defaultValue={policy.data.early_check_in_policy} options={[['disabled','Do not allow'],['manager_override','Require GM approval'],['allow_no_charge','Allow without an automatic fee']]} />
            <PolicySelect name="lateCheckout" label="Late checkout" defaultValue={policy.data.late_checkout_policy} options={[['disabled','Do not allow'],['manager_override','Require GM approval'],['allow_no_charge','Allow without an automatic fee']]} />
            <PolicySelect name="earlyDeparture" label="Early departure" defaultValue={policy.data.early_departure_policy} options={[['manager_review','Require GM review'],['allow_no_penalty','Allow without an automatic penalty']]} />
            <PolicySelect name="extraNight" label="Extra-night pricing" defaultValue={policy.data.extra_night_policy} options={[['standard_stay_rate','Continue the current stay rate'],['manager_rate_approval','Require management rate approval']]} />
          </div>
          <label className="mt-4 block text-sm font-medium text-stone-700">
            Internal policy notes
            <textarea name="notes" rows={4} defaultValue={policy.data.stay_policy_notes ?? ""} placeholder="Record the hotel's approved operational instructions." className="mt-2 w-full rounded-xl border border-stone-300 px-3 py-2.5" />
          </label>
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">
            Monetary penalties, waived nights, and late-checkout fees remain disabled until management and the accountant approve exact charging rules.
          </p>
        </div>

        <div className="flex justify-end">
          <FormSubmitButton disabled={busy} className="rounded-xl bg-amber-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
            {busy ? "Saving policy…" : "Save stay policy"}
          </FormSubmitButton>
        </div>
      </form>
    </section>
  );
}

function PolicySelect({ name, label, defaultValue, options }: { name: string; label: string; defaultValue: string; options: Array<[string, string]> }) {
  return (
    <label className="text-sm font-medium text-stone-700">
      {label}
      <select name={name} defaultValue={defaultValue} className="mt-2 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5">
        {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
    </label>
  );
}
