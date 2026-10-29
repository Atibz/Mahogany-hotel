import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarRange, List, Plus, X } from "lucide-react";

import { Modal } from "@/components/shared/modal";
import {
  EmptyState,
  PageError,
  PageLoading,
} from "@/components/shared/page-state";
import { useAccess } from "@/features/auth/use-access";
import { formatNaira, nairaToKobo } from "@/lib/money";

import {
  amendReservation,
  authorizeReservationBusinessAccount,
  cancelReservation,
  createReservation,
  createReservationWithDiscountRequest,
  getReservationCancellationPolicy,
  markReservationNoShow,
  recordReservationDeposit,
  sendArrivalEmail,
  type Reservation,
} from "./reception-service";
import {
  useActiveHotel,
  useAvailableRooms,
  useGuests,
  usePaymentMethods,
  useReservationDepositHistory,
  useReservationBusinessAccounts,
  useReservationBusinessAuthorizations,
  useReservations,
  useRoomBoard,
  useRoomTypes,
} from "./use-reception";
import { ReservationRack } from "./reservation-rack";
import { ReservationActions, type ReservationAction } from "./reservation-actions";
import { ReservationDetailsModal } from "./reservation-details-modal";
import { formatNoShowAllowedAfter, noShowAllowedAfter } from "./no-show-eligibility";
import { reservationMatchesSearch } from "./reservation-search";
import { guestCountError } from "./reservation-validation";

function ReservationPolicyNotice({ reservation, kind }: { reservation: Reservation | null; kind: "cancellation" | "no-show" }) {
  if (!reservation) return null;
  const terms = reservation.reservation_cancellation_policy_snapshots;
  if (!terms || terms.terms_state === "legacy_terms_unknown") {
    return <p className="my-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">Cancellation/no-show terms were not recorded when this reservation was made. Do not assume or apply a fee from the current hotel policy. Any deposit remains subject to management review.</p>;
  }
  if (terms.terms_state === "unconfirmed_at_booking") {
    return <p className="my-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">The hotel policy had not been confirmed when this reservation was made. Do not promise or apply a cancellation/no-show fee from these draft values. Any deposit remains subject to management review.</p>;
  }
  const feeNights = kind === "cancellation" ? terms.late_cancellation_charge_nights : terms.no_show_charge_nights;
  const grace = kind === "cancellation" ? terms.free_cancellation_hours : terms.no_show_grace_hours;
  return <p className="my-3 rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs leading-5 text-sky-950">Booking terms: {kind === "cancellation" ? `free cancellation until ${grace} hours before arrival; late-cancellation policy records ${feeNights} night(s)` : `${grace}-hour no-show grace period; recorded no-show policy is ${feeNights} night(s)`}. This is a recorded policy, not an automatic charge, forfeiture, or refund. Review any deposit separately.</p>;
}

export function ReservationsPage() {
  const hotel = useActiveHotel();
  const guests = useGuests(hotel.data?.id);
  const types = useRoomTypes(hotel.data?.id);
  const reservations = useReservations(hotel.data?.id);
  const cancellationPolicy = useQuery({
    queryKey: ["reservation-cancellation-policy", hotel.data?.id],
    queryFn: () => getReservationCancellationPolicy(hotel.data!.id),
    enabled: Boolean(hotel.data?.id),
  });
  const rooms = useRoomBoard(hotel.data?.id);
  const methods = usePaymentMethods(hotel.data?.id);
  const { roleCodes, isLoading: accessLoading } = useAccess();
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const [emailingReservationId, setEmailingReservationId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [roomTypeId, setRoomTypeId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [discountRate, setDiscountRate] = useState("0");
  const [checkInDate, setCheckInDate] = useState("");
  const [checkOutDate, setCheckOutDate] = useState("");
  const [adultCount, setAdultCount] = useState("1");
  const [childCount, setChildCount] = useState("0");
  const [cancellationTarget, setCancellationTarget] =
    useState<Reservation | null>(null);
  const [cancellationReason, setCancellationReason] = useState("");
  const [amendmentTarget, setAmendmentTarget] = useState<Reservation | null>(
    null,
  );
  const [amendmentRoomTypeId, setAmendmentRoomTypeId] = useState("");
  const [amendmentCheckIn, setAmendmentCheckIn] = useState("");
  const [amendmentCheckOut, setAmendmentCheckOut] = useState("");
  const [noShowTarget, setNoShowTarget] = useState<Reservation | null>(null);
  const [noShowReason, setNoShowReason] = useState("");
  const [noShowError, setNoShowError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [depositReservationId, setDepositReservationId] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [depositMethodId, setDepositMethodId] = useState("");
  const [depositReference, setDepositReference] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"rack" | "list">("rack");
  const [selectedReservationId, setSelectedReservationId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [billingTarget, setBillingTarget] = useState<Reservation | null>(null);
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [billingMode, setBillingMode] = useState<"reference" | "direct_bill">("reference");
  const [authorizedCredit, setAuthorizedCredit] = useState("");
  const [billingReason, setBillingReason] = useState("");
  const businessAccounts = useReservationBusinessAccounts(hotel.data?.id);
  const businessAuthorizations = useReservationBusinessAuthorizations(hotel.data?.id);
  const availableRooms = useAvailableRooms({
    hotelId: hotel.data?.id,
    roomTypeId,
    checkInDate,
    checkOutDate,
  });
  const depositHistory = useReservationDepositHistory(
    depositReservationId,
    hotel.data?.id,
  );
  const amendmentRooms = useAvailableRooms({
    hotelId: hotel.data?.id,
    roomTypeId: amendmentRoomTypeId,
    checkInDate: amendmentCheckIn,
    checkOutDate: amendmentCheckOut,
  });
  const availabilityReady = Boolean(
    roomTypeId && checkInDate && checkOutDate && checkOutDate > checkInDate,
  );
  const selectedRoom = availableRooms.data?.find((room) => room.id === roomId);
  const selectedRoomType = types.data?.find((type) => type.id === roomTypeId);
  const capacityError = guestCountError(
    Number(adultCount),
    Number(childCount),
    selectedRoomType?.capacity,
  );
  const discountPercentage = Number(discountRate);
  const finalNightlyRateKobo = selectedRoom
    ? Math.round(
        (selectedRoom.current_rate_kobo * (100 - discountPercentage)) / 100,
      )
    : 0;
  const canReceiveDeposit = roleCodes.some((role) =>
    ["owner", "general_manager", "receptionist", "cashier"].includes(role),
  );
  const canAuthorizeCredit = roleCodes.some((role) => ["owner", "general_manager"].includes(role));
  const canManageReservations = roleCodes.some((role) => ["owner", "general_manager", "receptionist"].includes(role));
  const noShowCutoff = noShowTarget ? noShowAllowedAfter(noShowTarget, cancellationPolicy.data) : null;
  const noShowHasCutoffData = Boolean(
    cancellationPolicy.data || (
      noShowTarget?.reservation_cancellation_policy_snapshots?.scheduled_check_in_time &&
      noShowTarget.reservation_cancellation_policy_snapshots.no_show_grace_hours != null
    ),
  );
  const noShowEligible = noShowHasCutoffData && noShowCutoff !== null && nowMs >= noShowCutoff.getTime();

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  function openReservationAction(reservation: Reservation, action: ReservationAction) {
    if (action === "email") {
      void handleSendArrivalEmail(reservation);
    } else if (action === "billing") {
      const current = businessAuthorizations.data?.find((item) => item.reservation_id === reservation.id);
      setBillingTarget(reservation);
      setBusinessAccountId(current?.business_account_id ?? "");
      setBillingMode(current?.billing_mode ?? "reference");
      setAuthorizedCredit(current?.authorized_amount_kobo ? String(current.authorized_amount_kobo / 100) : "");
      setBillingReason("");
    } else if (action === "amend") {
      setAmendmentTarget(reservation);
      setAmendmentRoomTypeId(reservation.room_type_id);
      setAmendmentCheckIn(reservation.check_in_date);
      setAmendmentCheckOut(reservation.check_out_date);
    } else if (action === "cancel") {
      setCancellationTarget(reservation);
    } else {
      setNoShowTarget(reservation);
      setNoShowReason("");
      setNoShowError(null);
    }
  }

  async function handleSendArrivalEmail(reservation: Reservation) {
    setEmailingReservationId(reservation.id);
    setMessage(null);
    try {
      const result = await sendArrivalEmail(reservation.id);
      setMessage(`Arrival email accepted for delivery to ${result.recipient}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Arrival email could not be sent.");
    } finally {
      setEmailingReservationId(null);
    }
  }

  async function handleBusinessBilling(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!billingTarget || !businessAccountId) return;
    setIsSaving(true);
    setMessage(null);
    try {
      await authorizeReservationBusinessAccount({
        reservationId: billingTarget.id,
        businessAccountId,
        billingMode,
        authorizedAmountKobo: billingMode === "direct_bill" ? nairaToKobo(authorizedCredit) : 0,
        reason: billingReason,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["reservation-business-accounts", hotel.data?.id] }),
        queryClient.invalidateQueries({ queryKey: ["reservation-business-authorizations", hotel.data?.id] }),
      ]);
      setBillingTarget(null);
      setBusinessAccountId("");
      setBillingMode("reference");
      setAuthorizedCredit("");
      setBillingReason("");
      setMessage(billingMode === "direct_bill" ? "Business credit authorised and exposure updated." : "Business account linked for reference billing.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Business billing could not be authorised.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hotel.data || !selectedRoom) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (capacityError) {
      setMessage(capacityError);
      return;
    }
    const reservationDetails = {
      adultCount: Number(adultCount),
      childCount: Number(childCount),
      source: String(form.get("source")),
      notes: String(form.get("notes")),
    };
    try {
      setIsSaving(true);
      setMessage(null);
      const requiresApproval = discountPercentage > 20;
      if (requiresApproval) {
        await createReservationWithDiscountRequest({
          hotelId: hotel.data.id,
          guestId: String(form.get("guestId")),
          roomTypeId: String(form.get("roomTypeId")),
          roomId,
          checkInDate: String(form.get("checkInDate")),
          checkOutDate: String(form.get("checkOutDate")),
          requestedRateKobo: finalNightlyRateKobo,
          reason: String(form.get("discountReason")),
          ...reservationDetails,
        });
      } else {
        await createReservation({
          hotelId: hotel.data.id,
          guestId: String(form.get("guestId")),
          roomTypeId: String(form.get("roomTypeId")),
          roomId,
          checkInDate: String(form.get("checkInDate")),
          checkOutDate: String(form.get("checkOutDate")),
          agreedRateKobo: finalNightlyRateKobo,
          ...reservationDetails,
        });
      }
      formElement.reset();
      setRoomTypeId("");
      setRoomId("");
      setDiscountRate("0");
      setCheckInDate("");
      setCheckOutDate("");
      setAdultCount("1");
      setChildCount("0");
      setShowCreateForm(false);
      await queryClient.invalidateQueries({
        queryKey: ["reservations", hotel.data.id],
      });
      setMessage(
        requiresApproval
          ? "Reservation created at the standard rate. The exceptional discount is awaiting independent GM approval before check-in."
          : "Reservation created and the agreed rate was saved as a snapshot.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Reservation could not be created.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cancellationTarget || !cancellationReason.trim()) return;
    setIsSaving(true);
    try {
      await cancelReservation(cancellationTarget.id, cancellationReason);
      setCancellationTarget(null);
      setCancellationReason("");
      await queryClient.invalidateQueries({
        queryKey: ["reservations", hotel.data?.id],
      });
      setMessage("Reservation cancelled and retained in history.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Reservation could not be cancelled.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleAmend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!amendmentTarget) return;
    const form = new FormData(event.currentTarget);
    setIsSaving(true);
    try {
      await amendReservation({
        reservationId: amendmentTarget.id,
        roomTypeId: amendmentRoomTypeId,
        roomId: String(form.get("roomId")),
        checkInDate: amendmentCheckIn,
        checkOutDate: amendmentCheckOut,
        agreedRateKobo: nairaToKobo(String(form.get("agreedRate"))),
        reason: String(form.get("reason")),
      });
      setAmendmentTarget(null);
      await queryClient.invalidateQueries({
        queryKey: ["reservations", hotel.data?.id],
      });
      setMessage("Reservation amended and the change was recorded.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Reservation could not be amended.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleNoShow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!noShowTarget || !noShowReason.trim()) return;
    if (!noShowEligible) {
      setNoShowError(noShowCutoff && noShowHasCutoffData
        ? `No-show can be recorded from ${formatNoShowAllowedAfter(noShowCutoff)} (hotel time).`
        : "The no-show cutoff is still loading. Please try again shortly.");
      return;
    }
    setIsSaving(true);
    setNoShowError(null);
    try {
      await markReservationNoShow(noShowTarget.id, noShowReason);
      setNoShowTarget(null);
      setNoShowReason("");
      setNoShowError(null);
      await queryClient.invalidateQueries({
        queryKey: ["reservations", hotel.data?.id],
      });
      setMessage("Reservation marked as no-show and retained in history.");
    } catch (error) {
      setNoShowError(
        error instanceof Error
          ? error.message
          : "Reservation could not be marked no-show.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeposit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!depositReservationId || !depositMethodId) return;
    setIsSaving(true);
    try {
      const method = methods.data?.find(
        (candidate) => candidate.id === depositMethodId,
      );
      await recordReservationDeposit({
        reservationId: depositReservationId,
        paymentMethodId: depositMethodId,
        amountKobo: nairaToKobo(depositAmount),
        reference: depositReference,
      });
      setDepositAmount("");
      setDepositMethodId("");
      setDepositReference("");
      await queryClient.invalidateQueries({
        queryKey: ["reservation-deposits", hotel.data?.id, depositReservationId],
      });
      setMessage(
        method?.requires_verification
          ? "Deposit recorded as pending verification. It cannot be used at check-in until finance verifies it."
          : "Deposit received. The original payment will be allocated to the guest folio at check-in.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Deposit could not be received.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  if (
    hotel.isLoading ||
    guests.isLoading ||
    types.isLoading ||
    reservations.isLoading ||
    rooms.isLoading ||
    methods.isLoading ||
    accessLoading
  )
    return <PageLoading />;
  if (
    hotel.error ||
    guests.error ||
    types.error ||
    reservations.error ||
    rooms.error ||
    methods.error
  )
    return (
      <PageError message="Unable to load reservation data. Apply the reservation-workflows migration and check your permissions." />
    );
  if (!hotel.data)
    return <EmptyState>No hotel is assigned to your staff account.</EmptyState>;
  if (!guests.data?.length || !types.data?.length)
    return (
      <EmptyState>
        Create guests and room types before creating reservations.
      </EmptyState>
    );
  const visibleReservations = reservations.data?.filter((reservation) => reservationMatchesSearch(reservation, search));
  const selectedReservation = reservations.data?.find((reservation) => reservation.id === selectedReservationId) ?? null;

  return (
    <section>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-amber-800">Reception</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Reservations
          </h1>
          <p className="mt-2 text-sm text-stone-600">
            Create bookings and see room availability across the calendar.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex w-fit rounded-xl border border-stone-200 bg-white p-1 shadow-sm">
            <button
              type="button"
              onClick={() => setView("rack")}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold ${view === "rack" ? "bg-amber-900 text-white" : "text-stone-600 hover:bg-stone-50"}`}
            >
              <CalendarRange className="size-4" />
              Rack
            </button>
            <button
              type="button"
              onClick={() => setView("list")}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold ${view === "list" ? "bg-amber-900 text-white" : "text-stone-600 hover:bg-stone-50"}`}
            >
              <List className="size-4" />
              List
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowCreateForm((current) => !current)}
            className="inline-flex items-center gap-2 rounded-xl bg-amber-900 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-amber-950"
          >
            {showCreateForm ? (
              <X className="size-4" />
            ) : (
              <Plus className="size-4" />
            )}
            {showCreateForm ? "Close form" : "New reservation"}
          </button>
        </div>
      </div>
      {showCreateForm && (
        <form
          onSubmit={handleSubmit}
          className="mt-7 grid gap-3 rounded-xl border border-stone-200 bg-white p-5 md:grid-cols-3"
        >
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950 md:col-span-3">
            {cancellationPolicy.data?.cancellation_policy_confirmed ? <>Confirmed cancellation terms for this new booking: free cancellation up to {cancellationPolicy.data.free_cancellation_hours} hours before arrival; late-cancellation policy records {cancellationPolicy.data.late_cancellation_charge_nights} night(s). No-show grace period: {cancellationPolicy.data.no_show_grace_hours} hours; recorded no-show policy: {cancellationPolicy.data.no_show_charge_nights} night(s). These terms are snapshotted with the reservation. No fee or refund is automatically applied.</> : <>Cancellation policy is not confirmed by the General Manager. New reservations will be marked as terms-unconfirmed; do not promise or apply a cancellation/no-show fee. Set and confirm terms in Administration → Cancellation policy.</>}
          </div>
          <select
            required
            name="guestId"
            defaultValue=""
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          >
            <option value="" disabled>
              Guest
            </option>
            {guests.data.map((guest) => (
              <option key={guest.id} value={guest.id}>
                {guest.full_name}
              </option>
            ))}
          </select>
          <select
            required
            name="roomTypeId"
            value={roomTypeId}
            onChange={(event) => setRoomTypeId(event.target.value)}
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          >
            <option value="" disabled>
              Room type
            </option>
            {types.data.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
          <select
            required
            name="roomId"
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            disabled={availableRooms.isFetching || !availableRooms.data?.length}
            className="rounded-lg border border-stone-300 px-3 py-2.5"
          >
            <option value="">
              {availableRooms.isFetching
                ? "Checking availability…"
                : "Available room and price"}
            </option>
            {availableRooms.data?.map((room) => (
              <option key={room.id} value={room.id}>
                {room.room_number} — {room.room_type_name} —{" "}
                {formatNaira(room.current_rate_kobo)} / night
              </option>
            ))}
          </select>
          <label className="text-sm text-stone-600">
            Check-in
            <input
              required
              name="checkInDate"
              value={checkInDate}
              onChange={(event) => setCheckInDate(event.target.value)}
              type="date"
              className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5 text-stone-900"
            />
          </label>
          <label className="text-sm text-stone-600">
            Check-out
            <input
              required
              name="checkOutDate"
              value={checkOutDate}
              onChange={(event) => setCheckOutDate(event.target.value)}
              type="date"
              className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5 text-stone-900"
            />
          </label>
          <label className="text-sm text-stone-600">
            Discount
            <select
              name="discountRate"
              value={discountRate}
              onChange={(event) => setDiscountRate(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5"
            >
              <option value="0">No discount</option>
              <option value="5">5% discount</option>
              <option value="10">10% discount</option>
              <option value="15">15% discount</option>
              <option value="20">20% discount</option>
              <option value="25">25% — approval required</option>
              <option value="30">30% — approval required</option>
            </select>
          </label>
          <label className="text-sm text-stone-600">
            Adults
            <input
              required
              name="adultCount"
              type="number"
              min="1"
              step="1"
              value={adultCount}
              onChange={(event) => setAdultCount(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5 text-stone-900"
            />
          </label>
          <label className="text-sm text-stone-600">
            Children
            <input
              required
              name="childCount"
              type="number"
              min="0"
              step="1"
              value={childCount}
              onChange={(event) => setChildCount(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5 text-stone-900"
            />
          </label>
          <label className="text-sm text-stone-600">
            Source
            <select
              required
              name="source"
              defaultValue="Direct"
              className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5"
            >
              <option>Direct</option>
              <option>Telephone</option>
              <option>Website</option>
              <option>Corporate</option>
              <option>Online travel agency</option>
              <option>Walk-in enquiry</option>
            </select>
          </label>
          <label className="text-sm text-stone-600 md:col-span-3">
            Booking note
            <textarea
              name="notes"
              rows={3}
              placeholder="Add arrival details, preferences, or other useful context"
              className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5 text-stone-900"
            />
          </label>
          {capacityError && roomTypeId && (
            <p className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700 md:col-span-3">
              {capacityError}
            </p>
          )}
          <p className="min-w-0 rounded-lg bg-stone-50 p-2.5 text-xs leading-5 text-stone-600">
            Standard:{" "}
            {selectedRoom
              ? formatNaira(selectedRoom.current_rate_kobo)
              : "Choose a room"}{" "}
            / night
            <br />
            Requested:{" "}
            <span className="font-semibold text-stone-950">
              {selectedRoom
                ? formatNaira(finalNightlyRateKobo)
                : "Choose a room"}{" "}
              / night
            </span>
            <br />
            <span className="text-[11px] leading-4">
              Discounts above 20% require GM approval before check-in.
            </span>
          </p>
          {discountPercentage > 20 && (
            <textarea
              required
              name="discountReason"
              rows={3}
              placeholder="Reason and supporting details for the exceptional discount"
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 md:col-span-2"
            />
          )}
          <FormSubmitButton
            disabled={
              isSaving ||
              availableRooms.isFetching ||
              !selectedRoom ||
              Boolean(capacityError)
            }
            className="w-fit justify-self-start rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
          >
            {isSaving ? "Saving…" : "Create reservation"}
          </FormSubmitButton>
          {!availabilityReady && (
            <p className="md:col-span-3 text-sm text-stone-500">
              Choose a room type and valid check-in/check-out dates to search
              available rooms.
            </p>
          )}
          {availabilityReady && availableRooms.isError && (
            <p className="md:col-span-3 text-sm text-red-700">
              Availability could not be checked:{" "}
              {availableRooms.error instanceof Error
                ? availableRooms.error.message
                : "Apply the reservation-workflows migration and check your reservation permission."}
            </p>
          )}
          {availabilityReady &&
            !availableRooms.isFetching &&
            !availableRooms.isError &&
            !availableRooms.data?.length && (
              <p className="md:col-span-3 text-sm text-amber-800">
                No rooms of this type are available for those dates.
              </p>
            )}
          {message && (
            <p className="md:col-span-3 text-sm text-stone-600" role="status">
              {message}
            </p>
          )}
        </form>
      )}
      {message && !showCreateForm && (
        <p className="mt-4 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700" role="status">
          {message}
        </p>
      )}
      <label className="mt-7 block text-sm font-medium text-stone-700" htmlFor="reservation-search">
        Search reservations
      </label>
      <input
        id="reservation-search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search reference, guest, or room"
        className="mt-2 w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5"
      />
      {view === "rack" && (
        <div className="mt-3">
          <ReservationRack
            rooms={rooms.data ?? []}
            reservations={reservations.data ?? []}
            businessAuthorizations={businessAuthorizations.data ?? []}
            canManageReservations={canManageReservations}
            emailingReservationId={emailingReservationId}
            cancellationPolicy={cancellationPolicy.data}
            nowMs={nowMs}
            searchTerm={search}
            onAction={openReservationAction}
          />
        </div>
      )}
      <div className={view === "list" ? "" : "hidden"}>
        <div className="mt-3 overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full min-w-200 text-left text-sm">
            <thead className="bg-stone-50 text-stone-500">
              <tr>
                <th className="px-5 py-3 font-medium">Reference</th>
                <th className="px-5 py-3 font-medium">Guest</th>
                <th className="px-5 py-3 font-medium">Room</th>
                <th className="px-5 py-3 font-medium">Stay</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleReservations?.map((reservation) => (
                <tr key={reservation.id} className="border-t border-stone-100">
                  <td className="px-5 py-3 font-medium">
                    {reservation.reservation_number}
                    {businessAuthorizations.data?.find((item) => item.reservation_id === reservation.id) && (
                      <span className="mt-1 block text-[11px] font-normal text-amber-800">
                        {businessAuthorizations.data.find((item) => item.reservation_id === reservation.id)?.account_name} · {businessAuthorizations.data.find((item) => item.reservation_id === reservation.id)?.billing_mode.replace("_", " ")}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3">{reservation.guests?.full_name}</td>
                  <td className="px-5 py-3">
                    {reservation.rooms?.room_number || "Unassigned"}
                    <span className="mt-1 block text-xs text-stone-500">{reservation.room_types?.name ?? "Room type unavailable"}</span>
                  </td>
                  <td className="px-5 py-3">
                    {reservation.check_in_date} → {reservation.check_out_date}
                    <span className="mt-1 block text-xs text-stone-500">{formatNaira(reservation.agreed_rate_kobo)} / night</span>
                  </td>
                  <td className="px-5 py-3 capitalize">
                    {reservation.status.replace("_", " ")}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedReservationId(reservation.id)}
                        className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-800"
                      >
                        View details
                      </button>
                      <ReservationActions
                        reservation={reservation}
                        canManageReservations={canManageReservations}
                        emailingReservationId={emailingReservationId}
                        cancellationPolicy={cancellationPolicy.data}
                        nowMs={nowMs}
                        onAction={(action) => openReservationAction(reservation, action)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <ReservationDetailsModal
        reservation={selectedReservation}
        businessAuthorization={businessAuthorizations.data?.find((item) => item.reservation_id === selectedReservation?.id)}
        canManageReservations={canManageReservations}
        emailingReservationId={emailingReservationId}
        cancellationPolicy={cancellationPolicy.data}
        nowMs={nowMs}
        onClose={() => setSelectedReservationId(null)}
        onAction={(reservation, action) => {
          setSelectedReservationId(null);
          openReservationAction(reservation, action);
        }}
      />
      <Modal open={Boolean(billingTarget)} title="Business billing" onClose={() => setBillingTarget(null)}>
        {billingTarget && <form onSubmit={handleBusinessBilling} className="grid gap-4">
          <p className="text-sm text-stone-600">{billingTarget.reservation_number} · {billingTarget.guests?.full_name}</p>
          <label className="text-sm font-medium">Corporate or agency account<select required value={businessAccountId} onChange={(event) => setBusinessAccountId(event.target.value)} className="mt-2 w-full rounded-xl border px-3 py-2.5"><option value="">Select an active account</option>{businessAccounts.data?.map((account) => <option key={account.id} value={account.id}>{account.display_name} · {account.account_number}{account.direct_billing_enabled ? ` · ${formatNaira(account.available_credit_kobo)} available` : ""}</option>)}</select></label>
          <label className="text-sm font-medium">Billing treatment<select value={billingMode} onChange={(event) => setBillingMode(event.target.value as "reference" | "direct_bill")} className="mt-2 w-full rounded-xl border px-3 py-2.5"><option value="reference">Reference only — guest remains responsible</option>{canAuthorizeCredit && <option value="direct_bill">Direct bill — reserve approved company credit</option>}</select></label>
          {billingMode === "direct_bill" && <label className="text-sm font-medium">Credit to reserve (naira)<input required type="number" min="0.01" step="0.01" value={authorizedCredit} onChange={(event) => setAuthorizedCredit(event.target.value)} className="mt-2 w-full rounded-xl border px-3 py-2.5" /></label>}
          <label className="text-sm font-medium">Reason and authority<textarea required rows={3} value={billingReason} onChange={(event) => setBillingReason(event.target.value)} placeholder="Record the company instruction, approver, or supporting reference" className="mt-2 w-full rounded-xl border px-3 py-2.5" /></label>
          <p className="rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">This reserves credit only. It does not settle the guest folio or issue a company invoice.</p>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setBillingTarget(null)} className="rounded-xl border px-4 py-2.5 text-sm font-semibold">Cancel</button><FormSubmitButton disabled={isSaving || !businessAccounts.data?.length} className="rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{isSaving ? "Saving…" : "Save business billing"}</FormSubmitButton></div>
        </form>}
      </Modal>
      <Modal
        open={Boolean(cancellationTarget)}
        title="Cancel reservation"
        onClose={() => setCancellationTarget(null)}
      >
        <form onSubmit={handleCancel}>
          <p className="text-sm text-stone-600">
            This reservation will remain in history with a cancelled status.
          </p>
          <ReservationPolicyNotice reservation={cancellationTarget} kind="cancellation" />
          <textarea
            required
            value={cancellationReason}
            onChange={(event) => setCancellationReason(event.target.value)}
            rows={4}
            placeholder="Reason for cancellation"
            className="mt-4 w-full rounded-lg border border-stone-300 px-3 py-2.5"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCancellationTarget(null)}
              className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold"
            >
              Keep reservation
            </button>
            <FormSubmitButton
              disabled={isSaving}
              className="rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              Cancel reservation
            </FormSubmitButton>
          </div>
        </form>
      </Modal>
      <Modal
        open={Boolean(amendmentTarget)}
        title="Amend reservation"
        onClose={() => setAmendmentTarget(null)}
      >
        {amendmentTarget && (
          <form onSubmit={handleAmend} className="grid gap-3">
            <select
              required
              value={amendmentRoomTypeId}
              onChange={(event) => setAmendmentRoomTypeId(event.target.value)}
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            >
              {types.data.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
            <select
              required
              name="roomId"
              defaultValue={amendmentTarget.room_id ?? ""}
              disabled={
                !amendmentRooms.data?.length && !amendmentTarget.room_id
              }
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            >
              <option value="">
                {amendmentRooms.isFetching
                  ? "Checking availability…"
                  : "Available room"}
              </option>
              {amendmentTarget.room_id && (
                <option value={amendmentTarget.room_id}>
                  {amendmentTarget.rooms?.room_number} (current)
                </option>
              )}
              {amendmentRooms.data
                ?.filter((room) => room.id !== amendmentTarget.room_id)
                .map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.room_number}
                  </option>
                ))}
            </select>
            <label className="text-sm text-stone-600">
              Check-in
              <input
                required
                value={amendmentCheckIn}
                onChange={(event) => setAmendmentCheckIn(event.target.value)}
                type="date"
                className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5"
              />
            </label>
            <label className="text-sm text-stone-600">
              Check-out
              <input
                required
                value={amendmentCheckOut}
                onChange={(event) => setAmendmentCheckOut(event.target.value)}
                type="date"
                className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2.5"
              />
            </label>
            <input
              required
              name="agreedRate"
              type="number"
              min="0"
              step="0.01"
              defaultValue={(amendmentTarget.agreed_rate_kobo / 100).toFixed(2)}
              placeholder="Nightly rate (₦)"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <textarea
              required
              name="reason"
              rows={3}
              placeholder="Reason for amendment"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <FormSubmitButton
              disabled={
                isSaving ||
                (!amendmentRooms.data?.length && !amendmentTarget.room_id)
              }
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              Save amendment
            </FormSubmitButton>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(noShowTarget)}
        title="Mark reservation as no-show"
        onClose={() => { setNoShowTarget(null); setNoShowError(null); }}
      >
        <form onSubmit={handleNoShow}>
          <ReservationPolicyNotice reservation={noShowTarget} kind="no-show" />
          {!noShowEligible && (
            <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              {noShowCutoff && noShowHasCutoffData
                ? `No-show becomes available ${formatNoShowAllowedAfter(noShowCutoff)} (hotel time).`
                : "Checking the saved no-show cutoff…"}
            </p>
          )}
          {noShowError && <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{noShowError}</p>}
          <textarea
            required
            value={noShowReason}
            onChange={(event) => setNoShowReason(event.target.value)}
            rows={4}
            placeholder="Reason for no-show"
            className="w-full rounded-lg border border-stone-300 px-3 py-2.5"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setNoShowTarget(null); setNoShowError(null); }}
              className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold"
            >
              Keep reservation
            </button>
            <FormSubmitButton
              disabled={isSaving || !noShowEligible}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              Mark no-show
            </FormSubmitButton>
          </div>
        </form>
      </Modal>
      {canReceiveDeposit && (
        <form
          onSubmit={handleDeposit}
          className="mt-6 grid gap-3 rounded-xl border border-amber-200 bg-amber-50 p-5 md:grid-cols-4"
        >
          <div className="md:col-span-4">
            <h2 className="font-semibold text-amber-950">
              Receive reservation deposit
            </h2>
            <p className="mt-1 text-sm text-amber-900">
              This remains an advance payment until check-in, then moves to the
              guest folio.
            </p>
          </div>
          <select
            required
            value={depositReservationId}
            onChange={(event) => setDepositReservationId(event.target.value)}
            className="rounded-lg border border-amber-200 bg-white px-3 py-2.5"
          >
            <option value="">Reservation</option>
            {reservations.data
              ?.filter((reservation) =>
                ["pending", "confirmed"].includes(reservation.status),
              )
              .map((reservation) => (
                <option key={reservation.id} value={reservation.id}>
                  {reservation.reservation_number} —{" "}
                  {reservation.guests?.full_name || "Guest"}
                </option>
              ))}
          </select>
          <select
            required
            value={depositMethodId}
            onChange={(event) => setDepositMethodId(event.target.value)}
            className="rounded-lg border border-amber-200 bg-white px-3 py-2.5"
          >
            <option value="">Payment method</option>
            {methods.data?.map((method) => (
              <option key={method.id} value={method.id}>
                {method.name}
                {method.requires_verification ? " — verification required" : ""}
              </option>
            ))}
          </select>
          <input
            required
            value={depositAmount}
            onChange={(event) => setDepositAmount(event.target.value)}
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Amount (₦)"
            className="rounded-lg border border-amber-200 bg-white px-3 py-2.5"
          />
          <input
            value={depositReference}
            onChange={(event) => setDepositReference(event.target.value)}
            placeholder="Reference"
            className="rounded-lg border border-amber-200 bg-white px-3 py-2.5"
          />
          <FormSubmitButton
            disabled={
              isSaving ||
              !depositReservationId ||
              !depositMethodId ||
              !depositAmount
            }
            className="w-fit rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {isSaving ? "Recording…" : "Record deposit"}
          </FormSubmitButton>
        </form>
      )}
      {canReceiveDeposit && depositReservationId && (
        <section className="mt-4 rounded-xl border bg-white p-5">
          <h2 className="font-semibold">Deposit receipts</h2>
          {depositHistory.isLoading ? (
            <p className="mt-2 text-sm text-stone-500">Loading deposits…</p>
          ) : depositHistory.data?.length ? (
            <div className="mt-3 space-y-2">
              {depositHistory.data.map((deposit) => (
                <div
                  key={deposit.deposit_id}
                  className="flex flex-wrap justify-between gap-2 rounded-lg bg-stone-50 p-3 text-sm"
                >
                  <span>
                    <b>{deposit.receipt_number}</b> ·{" "}
                    {deposit.payment_method_name}
                    {deposit.reference ? ` · ${deposit.reference}` : ""}
                  </span>
                  <span>
                    {formatNaira(deposit.amount_kobo)} · {deposit.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-stone-500">
              No deposits have been received for this reservation.
            </p>
          )}
        </section>
      )}
    </section>
  );
}
