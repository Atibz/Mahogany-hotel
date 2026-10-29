import { supabase } from "@/lib/supabase/client";
import { loadAllPages } from "@/lib/supabase/load-all-pages";

export type Hotel = { id: string; trading_name: string };

function singleRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
export type StayLifecyclePolicy = {
  hotel_id: string;
  standard_check_in_time: string | null;
  standard_check_out_time: string | null;
  early_check_in_policy: "disabled" | "manager_override" | "allow_no_charge";
  late_checkout_policy: "disabled" | "manager_override" | "allow_no_charge";
  early_departure_policy: "manager_review" | "allow_no_penalty";
  extra_night_policy: "standard_stay_rate" | "manager_rate_approval";
  stay_policy_notes: string | null;
};
export type RoomBoardItem = {
  id: string;
  room_type_id: string;
  room_number: string;
  room_type_name: string;
  size_sqft: number | null;
  capacity: number;
  current_rate_kobo: number;
  status: "available" | "reserved" | "occupied" | "dirty" | "blocked";
  turnover_status: "clean" | "dirty";
  blocked_reason: string | null;
  is_maintenance_out_of_service: boolean;
};
export type InHouseRoomOccupant = {
  stay_id: string;
  room_id: string;
  room_number: string;
  room_type_name: string;
  guest_id: string;
  guest_name: string;
  guest_phone: string | null;
  guest_email: string | null;
  actual_check_in_date: string;
  expected_check_out_date: string;
  business_date: string;
  departure_state: "overdue" | "due_today" | "in_house";
  days_overdue: number;
  folio_id: string;
  folio_number: string;
  balance_kobo: number;
};
export type DepartureQueueItem = {
  stay_id: string;
  room_number: string;
  room_type_name: string;
  guest_name: string;
  guest_phone: string | null;
  guest_email: string | null;
  actual_check_in_date: string;
  expected_check_out_date: string;
  business_date: string;
  departure_state: "overdue" | "due_today" | "upcoming";
  days_overdue: number;
  folio_id: string;
  folio_number: string;
  balance_kobo: number;
  posted_charge_count: number;
  posted_charge_total_kobo: number;
  completed_payment_total_kobo: number;
  pending_payment_count: number;
  pending_payment_total_kobo: number;
  ready_to_checkout: boolean;
  blocking_reason: string | null;
};
export type ArrivalAttentionItem = {
  reservation_id: string;
  reservation_number: string;
  guest_name: string;
  room_number: string | null;
  room_type_name: string;
  check_in_date: string;
  arrival_state: "due_today" | "overdue";
};
export type CheckoutInvoice = {
  invoice_id: string;
  invoice_number: string;
  issued_at: string;
  hotel_name: string;
  snapshot: {
    folio_number: string;
    checkout_date: string;
    scheduled_checkout_date?: string;
    charges: Array<{
      id: string;
      description: string;
      service_date: string | null;
      total_amount_kobo: number;
      status: string;
    }>;
    payments: Array<{
      payment_id: string;
      payment_number: string;
      amount_kobo: number;
      reference: string | null;
      received_at: string;
    }>;
    final_balance_kobo: number;
  };
};
export type RoomTypeOccupancy = {
  room_type_id: string;
  room_type_name: string;
  total_room_count: number;
  active_room_count: number;
  available_room_count: number;
  reserved_room_count: number;
  occupied_room_count: number;
  dirty_room_count: number;
  blocked_room_count: number;
};
export type Guest = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
};
export type RoomType = {
  id: string;
  name: string;
  base_rate_kobo: number;
  capacity: number;
  size_sqft: number | null;
  active: boolean;
};
export type MaintenanceTicket = {
  id: string;
  room_id: string;
  ticket_number: string;
  description: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "in_progress" | "resolved" | "closed";
  reported_at: string;
  resolution_notes: string | null;
  out_of_service_at: string | null;
  returned_to_service_at: string | null;
  rooms: { room_number: string } | null;
};
export type Reservation = {
  id: string;
  reservation_number: string;
  room_type_id: string;
  room_id: string | null;
  status: string;
  check_in_date: string;
  check_out_date: string;
  agreed_rate_kobo: number;
  guests: { full_name: string; email?: string | null } | null;
  rooms: { room_number: string } | null;
  room_types: { name: string } | null;
  reservation_cancellation_policy_snapshots?: ReservationCancellationPolicySnapshot | null;
};
export type ReservationCancellationPolicySnapshot = {
  terms_state: "recorded_at_booking" | "unconfirmed_at_booking" | "legacy_terms_unknown";
  scheduled_check_in_time?: string | null;
  free_cancellation_hours: number | null;
  late_cancellation_charge_nights: number | null;
  no_show_grace_hours: number | null;
  no_show_charge_nights: number | null;
  policy_notes: string | null;
};
export type ReservationCancellationPolicy = {
  hotel_id: string;
  standard_check_in_time?: string | null;
  free_cancellation_hours: number;
  late_cancellation_charge_nights: number;
  no_show_grace_hours: number;
  no_show_charge_nights: number;
  cancellation_policy_notes: string | null;
  cancellation_policy_confirmed: boolean;
};
export type AvailableRoom = {
  id: string;
  room_number: string;
  room_type_name: string;
  current_rate_kobo: number;
};
export type Folio = {
  id: string;
  folio_number: string;
  status: string;
  balance_kobo: number;
  items: {
    id: string;
    description: string;
    service_date: string | null;
    base_amount_kobo: number;
    tax_amount_kobo: number;
    total_amount_kobo: number;
    status: string;
  }[];
  stays: {
    id: string;
    guests: { full_name: string } | null;
    rooms: { room_number: string } | null;
  } | null;
};
export type PaymentMethod = {
  id: string;
  code: string;
  name: string;
  requires_reference: boolean;
  requires_verification: boolean;
  active: boolean;
  display_order: number;
};
export type CashierShift = {
  id: string;
  shift_number: string;
  opening_float_kobo: number;
  expected_cash_kobo: number;
  opened_at: string;
};
export type CashierShiftHistory = {
  id: string;
  shift_number: string;
  business_date: string;
  status: "open" | "closed";
  opening_float_kobo: number;
  expected_cash_kobo: number | null;
  declared_cash_kobo: number | null;
  variance_kobo: number | null;
  variance_reason: string | null;
  handover_reference: string | null;
  opened_at: string;
  closed_at: string | null;
  opened_by_name: string;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  review_notes: string | null;
};
export type ReservationDeposit = {
  deposit_id: string;
  receipt_number: string;
  payment_number: string;
  amount_kobo: number;
  payment_method_name: string;
  reference: string | null;
  status: string;
  received_at: string;
};
export type DashboardSnapshot = {
  payments_today_kobo: number;
  recent_activity: { id: string; action: string; occurred_at: string }[];
  night_audit_status: string | null;
};
export type FolioPaymentHistory = {
  payment_id: string;
  payment_number: string;
  amount_kobo: number;
  allocated_amount_kobo: number;
  status: "completed" | "pending_verification" | "voided" | "refunded";
  reference: string | null;
  received_at: string;
  payment_method_name: string | null;
  receipt_number: string | null;
  receipt_issued_at: string | null;
  receipt_voided_at: string | null;
  void_reason: string | null;
  guest_name: string | null;
  room_number: string | null;
  refunds: {
    id: string;
    refund_number: string;
    amount_kobo: number;
    reason: string;
    refunded_at: string;
  }[];
  is_combined?: boolean;
};

export type CombinedPaymentCandidate = {
  order_id: string;
  order_number: string;
  outlet_id: string;
  outlet_name: string;
  outlet_type: string;
  balance_kobo: number;
};

export type CombinedGuestPayment = {
  payment_id: string;
  payment_number: string;
  received_at: string;
  status: string;
  reference: string | null;
  amount_kobo: number;
  hotel_amount_kobo: number;
  folio_id: string;
  folio_number: string;
  reason: string;
  verbal_approver_name: string;
  review_status: "awaiting_accountant" | "confirmed" | "disputed";
  review_note: string | null;
  orders: { order_id: string; order_number: string; outlet_name: string; amount_kobo: number; settled_kobo: number; settlements: { id: string; amount_kobo: number; evidence_reference: string; reversed: boolean }[] }[];
};

export type PendingPaymentVerification = {
  payment_id: string;
  payment_number: string;
  amount_kobo: number;
  payment_method_name: string;
  reference: string | null;
  received_at: string;
  source: "folio payment" | "reservation deposit";
  folio_number: string | null;
  reservation_number: string | null;
  guest_name: string | null;
};
export type FinanceApprovalRequest = {
  id: string;
  action_type:
    | "void_payment"
    | "refund_payment"
    | "folio_adjustment"
    | "reverse_folio_item"
    | "reservation_discount"
    | "company_credit_note"
    | "company_payment_refund"
    | "pos_payment_refund"
    | "pos_order_line_correction"
    | "combined_payment_refund";
  payload: Record<string, string | number | null>;
  target_entity_type: string;
  reason: string;
  requested_at: string;
  expires_at: string;
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "withdrawn"
    | "executed"
    | "expired";
  decision_note: string | null;
  requested_by: string;
  profiles: { full_name: string | null } | null;
};
export type FinanceApprovalRegisterItem = {
  request_id: string;
  action_type: string;
  status: string;
  target_document: string | null;
  amount_kobo: number | null;
  reference: string | null;
  description: string | null;
  reason: string;
  requested_by_name: string | null;
  requested_at: string;
  expires_at: string;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  executed_by_name: string | null;
  executed_at: string | null;
};
export type DailyPaymentReconciliation = {
  payment_method_name: string;
  settled_kobo: number;
  pending_verification_kobo: number;
  refunded_kobo: number;
  voided_kobo: number;
  net_collected_kobo: number;
};
export type DailyRevenueDepartment = {
  report_date: string;
  department_code: string;
  item_count: number;
  base_amount_kobo: number;
  tax_amount_kobo: number;
  service_charge_amount_kobo: number;
  total_amount_kobo: number;
};
export type DailyTaxBreakdown = {
  report_date: string;
  tax_code: string;
  tax_name: string;
  jurisdiction: string | null;
  amount_kobo: number;
};
export type DailyRevenueTaxReport = {
  departments: DailyRevenueDepartment[];
  taxes: DailyTaxBreakdown[];
};
export type DepositGuestCreditLiability = {
  liability_type: "reservation_deposit" | "guest_credit";
  document_number: string;
  guest_name: string;
  source_status: string;
  liability_status:
    | "held"
    | "pending_verification"
    | "action_required"
    | "credit_balance";
  payment_method_name: string | null;
  reference: string | null;
  amount_kobo: number;
  recorded_at: string;
};
export type NightAuditException = {
  exception_code: string;
  exception_label: string;
  record_count: number;
};
export type BusinessDayCloseStatus = {
  business_date: string;
  posting_status: string | null;
  open_cashier_shifts: number;
  pending_payment_verification: number;
  overdue_departures: number;
  unsettled_open_folios: number;
  overdue_acknowledged: boolean;
  folios_acknowledged: boolean;
  can_close: boolean;
  close_number: string | null;
  closed_at: string | null;
  closed_by_name: string | null;
};
export type DailyCloseReport = {
  hotel: {
    trading_name: string;
    legal_name: string;
    address_line_1: string | null;
    address_line_2: string | null;
    city: string | null;
    state_region: string | null;
  };
  business_date: string;
  close_number?: string;
  closed_at?: string;
  closed_by_name?: string | null;
  operations: {
    scheduled_arrivals: number;
    checked_in_arrivals: number;
    scheduled_departures: number;
    checked_out_departures: number;
    no_shows: number;
    in_house_at_close: number;
  };
  night_audit: {
    status?: string;
    posts_created?: number;
    finished_at?: string;
  };
  revenue_by_department: Array<{
    department_code: string;
    item_count: number;
    base_amount_kobo: number;
    tax_amount_kobo: number;
    service_charge_amount_kobo: number;
    total_amount_kobo: number;
  }>;
  tax_breakdown: Array<{
    tax_code: string;
    tax_name: string;
    jurisdiction: string | null;
    amount_kobo: number;
  }>;
  payments_by_method: Array<{
    payment_method_name: string;
    settled_kobo: number;
    pending_verification_kobo: number;
    refunded_kobo: number;
    voided_kobo: number;
    net_collected_kobo: number;
  }>;
  cashier_shifts: Array<{
    shift_number: string;
    status: string;
    expected_cash_kobo: number | null;
    declared_cash_kobo: number | null;
    variance_kobo: number | null;
    handover_reference: string | null;
  }>;
  corrections: Array<{
    item_type: string;
    description: string;
    amount_kobo: number;
    reason: string | null;
  }>;
  liabilities: Array<{
    liability_type: string;
    document_number: string;
    guest_name: string;
    amount_kobo: number;
    liability_status: string;
  }>;
  outstanding_folios: Array<{ folio_number: string; balance_kobo: number }>;
  acknowledgements: Array<{
    exception_code: string;
    record_count: number;
    reason: string;
    acknowledged_at: string;
    acknowledged_by_name: string | null;
  }>;
};
export type DailyOperationalSummary = {
  business_date: string;
  scheduled_arrivals: number;
  checked_in_arrivals: number;
  scheduled_departures: number;
  checked_out_departures: number;
  in_house_guests: number;
  room_charge_posted_kobo: number;
  night_audit_status: string | null;
  night_audit_posts_created: number | null;
  night_audit_finished_at: string | null;
};
export type ActivityRegisterItem = {
  log_id: string;
  occurred_at: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  display_amount_kobo: number | null;
  total_count: number;
};
export type ActivityRegisterFilters = {
  fromDate?: string;
  toDate?: string;
  query?: string;
  action?: string;
  entityType?: string;
  minAmountKobo?: number;
  maxAmountKobo?: number;
  limit?: number;
  offset?: number;
};
export type ManagementDashboardSnapshot = {
  business_date: string;
  outstanding_folio_kobo: number;
  guest_credit_kobo: number;
  held_deposit_kobo: number;
  future_booked_room_revenue_kobo: number;
  pending_finance_approvals: number;
  refunds_today_count: number;
  refunds_today_kobo: number;
  voids_today_count: number;
  voids_today_kobo: number;
  cash_variance_today_kobo: number;
};
export type ManagementDashboardTrend = {
  business_date: string;
  active_room_count: number;
  occupied_room_count: number;
  occupancy_basis_points: number;
  arrivals: number;
  departures: number;
  no_shows: number;
  room_revenue_kobo: number;
  total_revenue_kobo: number;
  net_collected_kobo: number;
  refunds_kobo: number;
  voided_kobo: number;
  approved_discount_kobo: number;
  cash_variance_kobo: number;
};

function client() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

export async function getActiveHotel(): Promise<Hotel | null> {
  const { data, error } = await client()
    .from("hotels")
    .select("id, trading_name")
    .limit(1)
    .maybeSingle();
  throwIfError(error);
  return data as Hotel | null;
}

export async function getRoomBoard(hotelId: string): Promise<RoomBoardItem[]> {
  const { data, error } = await client()
    .from("room_board")
    .select(
      "id, room_type_id, room_number, room_type_name, size_sqft, capacity, current_rate_kobo, status, turnover_status, blocked_reason, is_maintenance_out_of_service",
    )
    .eq("hotel_id", hotelId)
    .order("room_number");
  throwIfError(error);
  return (data ?? []) as RoomBoardItem[];
}

export async function getInHouseRoomOccupants(
  hotelId: string,
): Promise<InHouseRoomOccupant[]> {
  const { data, error } = await client().rpc("get_in_house_room_occupants", {
    target_hotel_id: hotelId,
  });
  throwIfError(error);
  return (data ?? []) as InHouseRoomOccupant[];
}

export async function getDepartureQueue(
  hotelId: string,
): Promise<DepartureQueueItem[]> {
  const { data, error } = await client().rpc("get_departure_queue", {
    target_hotel_id: hotelId,
  });
  throwIfError(error);
  return (data ?? []) as DepartureQueueItem[];
}

export async function getArrivalAttention(hotelId: string) {
  const { data, error } = await client().rpc("get_arrival_attention", {
    target_hotel_id: hotelId,
  });
  throwIfError(error);
  return (data ?? []) as ArrivalAttentionItem[];
}

export async function completeDepartureCheckout(values: {
  stayId: string;
  roomChargesConfirmed: boolean;
  incidentalChargesConfirmed: boolean;
  keyReturnConfirmed: boolean;
  guestDetailsConfirmed: boolean;
  notes: string;
}) {
  const { data, error } = await client().rpc("complete_departure_checkout", {
    target_stay_id: values.stayId,
    room_charges_confirmed: values.roomChargesConfirmed,
    incidental_charges_confirmed: values.incidentalChargesConfirmed,
    key_return_confirmed: values.keyReturnConfirmed,
    guest_details_confirmed: values.guestDetailsConfirmed,
    checkout_notes: values.notes,
  });
  throwIfError(error);
  return data as string;
}

export async function prepareDepartureFolio(stayId: string) {
  const { data, error } = await client().rpc("prepare_departure_folio", {
    target_stay_id: stayId,
  });
  throwIfError(error);
  return Number(data ?? 0);
}

export async function getCheckoutInvoice(
  invoiceId: string,
): Promise<CheckoutInvoice> {
  const { data, error } = await client().rpc("get_checkout_invoice", {
    target_invoice_id: invoiceId,
  });
  throwIfError(error);
  const invoice = (data ?? [])[0] as CheckoutInvoice | undefined;
  if (!invoice) throw new Error("Invoice not found.");
  return invoice;
}

export async function getRoomTypeOccupancy(
  hotelId: string,
): Promise<RoomTypeOccupancy[]> {
  const { data, error } = await client()
    .from("room_type_occupancy_summary")
    .select(
      "room_type_id, room_type_name, total_room_count, active_room_count, available_room_count, reserved_room_count, occupied_room_count, dirty_room_count, blocked_room_count",
    )
    .eq("hotel_id", hotelId)
    .order("room_type_name");
  throwIfError(error);
  return (data ?? []) as RoomTypeOccupancy[];
}

export async function createRoomType(
  hotelId: string,
  values: {
    name: string;
    description?: string;
    rateKobo: number;
    capacity: number;
    sizeSqft?: number;
  },
) {
  const { data, error } = await client().rpc("create_room_type", {
    target_hotel_id: hotelId,
    type_name: values.name,
    type_description: values.description || null,
    base_rate: values.rateKobo,
    room_capacity: values.capacity,
    type_amenities: [],
    room_size_sqft: values.sizeSqft || null,
  });
  throwIfError(error);
  return data as string;
}

export async function updateRoomType(
  roomTypeId: string,
  values: {
    name: string;
    description?: string;
    rateKobo: number;
    capacity: number;
    sizeSqft?: number;
    active: boolean;
  },
) {
  const { error } = await client().rpc("update_room_type", {
    target_room_type_id: roomTypeId,
    type_name: values.name,
    type_description: values.description || null,
    base_rate: values.rateKobo,
    room_capacity: values.capacity,
    is_active: values.active,
    room_size_sqft: values.sizeSqft || null,
  });
  throwIfError(error);
}

export async function createRoom(
  hotelId: string,
  values: { roomTypeId: string; roomNumber: string; rateOverrideKobo?: number },
) {
  const { data, error } = await client().rpc("create_room", {
    target_hotel_id: hotelId,
    target_room_type_id: values.roomTypeId,
    room_number_value: values.roomNumber,
    rate_override: values.rateOverrideKobo ?? null,
  });
  throwIfError(error);
  return data as string;
}

export async function updateRoom(
  roomId: string,
  values: {
    roomTypeId: string;
    roomNumber: string;
    rateOverrideKobo?: number;
    active: boolean;
  },
) {
  const { error } = await client().rpc("update_room", {
    target_room_id: roomId,
    target_room_type_id: values.roomTypeId,
    room_number_value: values.roomNumber,
    rate_override: values.rateOverrideKobo ?? null,
    room_amenities: [],
    is_active: values.active,
  });
  throwIfError(error);
}

export async function setRoomBlocked(
  roomId: string,
  blocked: boolean,
  reason?: string,
) {
  const { error } = await client().rpc("set_room_blocked", {
    target_room_id: roomId,
    should_block: blocked,
    block_reason: reason || null,
  });
  throwIfError(error);
}

export async function completeRoomTurnover(roomId: string, notes?: string) {
  const { data, error } = await client().rpc("complete_room_turnover", {
    target_room_id: roomId,
    completion_notes_value: notes || null,
  });
  throwIfError(error);
  return data as string;
}

export async function overrideRoomTurnover(roomId: string, reason: string) {
  const { data, error } = await client().rpc("override_room_turnover", {
    target_room_id: roomId,
    override_reason: reason,
  });
  throwIfError(error);
  return data as string;
}

export async function moveInHouseGuest(
  stayId: string,
  roomId: string,
  reason: string,
) {
  const { data, error } = await client().rpc("move_in_house_guest", {
    target_stay_id: stayId,
    target_room_id: roomId,
    move_reason: reason,
  });
  throwIfError(error);
  return data as string;
}

export async function extendInHouseStay(
  stayId: string,
  checkOutDate: string,
  reason: string,
  extensionRateKobo?: number,
) {
  const { data, error } = await client().rpc("extend_in_house_stay", {
    target_stay_id: stayId,
    new_check_out_date: checkOutDate,
    extension_reason: reason,
    new_extension_rate_kobo: extensionRateKobo ?? null,
  });
  throwIfError(error);
  return data as string;
}

export async function getStayLifecyclePolicy(hotelId: string) {
  const { data, error } = await client()
    .from("hotel_settings")
    .select(
      "hotel_id, standard_check_in_time, standard_check_out_time, early_check_in_policy, late_checkout_policy, early_departure_policy, extra_night_policy, stay_policy_notes",
    )
    .eq("hotel_id", hotelId)
    .single();
  throwIfError(error);
  return data as StayLifecyclePolicy;
}

export async function updateStayLifecyclePolicy(
  hotelId: string,
  policy: Omit<StayLifecyclePolicy, "hotel_id">,
) {
  const { error } = await client().rpc("update_stay_lifecycle_policy", {
    target_hotel_id: hotelId,
    check_in_time_value: policy.standard_check_in_time,
    check_out_time_value: policy.standard_check_out_time,
    early_check_in_policy_value: policy.early_check_in_policy,
    late_checkout_policy_value: policy.late_checkout_policy,
    early_departure_policy_value: policy.early_departure_policy,
    extra_night_policy_value: policy.extra_night_policy,
    policy_notes_value: policy.stay_policy_notes,
  });
  throwIfError(error);
}

export async function getMaintenanceTickets(
  hotelId: string,
): Promise<MaintenanceTicket[]> {
  const { data, error } = await client()
    .from("maintenance_tickets")
    .select(
      "id, room_id, ticket_number, description, priority, status, reported_at, resolution_notes, out_of_service_at, returned_to_service_at, rooms!maintenance_tickets_room_id_fkey(room_number)",
    )
    .eq("hotel_id", hotelId)
    .order("reported_at", { ascending: false });
  throwIfError(error);
  return (data ?? []).map((ticket) => ({
    ...ticket,
    rooms: singleRelation(ticket.rooms),
  }));
}

export async function raiseMaintenanceTicket(
  roomId: string,
  description: string,
  priority: MaintenanceTicket["priority"],
) {
  const { data, error } = await client().rpc("raise_room_maintenance_ticket", {
    target_room_id: roomId,
    fault_description: description,
    fault_priority: priority,
  });
  throwIfError(error);
  return data as string;
}

export async function updateMaintenanceTicket(
  ticketId: string,
  status: "in_progress" | "resolved",
  notes?: string,
) {
  const { error } = await client().rpc("update_room_maintenance_ticket", {
    target_ticket_id: ticketId,
    next_status: status,
    resolution_notes_value: notes || null,
  });
  throwIfError(error);
}

export async function setMaintenanceRoomOutOfService(
  ticketId: string,
  outOfService: boolean,
) {
  const { error } = await client().rpc("set_maintenance_room_out_of_service", {
    target_ticket_id: ticketId,
    should_be_out_of_service: outOfService,
  });
  throwIfError(error);
}

export async function getGuests(hotelId: string): Promise<Guest[]> {
  return loadAllPages<Guest>(async (from, to) => {
    const { data, error } = await client()
      .from("guests")
      .select("id, full_name, phone, email")
      .eq("hotel_id", hotelId)
      .eq("active", true)
      .order("full_name")
      .order("id")
      .range(from, to);
    return { data: (data ?? []) as Guest[], error };
  });
}

export async function getRoomTypes(
  hotelId: string,
  includeInactive = false,
): Promise<RoomType[]> {
  const { data, error } = await client()
    .from("room_types")
    .select("id, name, base_rate_kobo, capacity, size_sqft, active")
    .eq("hotel_id", hotelId)
    .or(includeInactive ? "active.eq.true,active.eq.false" : "active.eq.true")
    .order("name");
  throwIfError(error);
  return (data ?? []) as RoomType[];
}

export async function getReservations(hotelId: string): Promise<Reservation[]> {
  return loadAllPages<Reservation>(async (from, to) => {
    const { data, error } = await client()
      .from("reservations")
      .select(
        "id, reservation_number, status, room_type_id, room_id, check_in_date, check_out_date, agreed_rate_kobo, guests(full_name, email), rooms(room_number), room_types(name), reservation_cancellation_policy_snapshots(terms_state, scheduled_check_in_time, free_cancellation_hours, late_cancellation_charge_nights, no_show_grace_hours, no_show_charge_nights, policy_notes)",
      )
      .eq("hotel_id", hotelId)
      .order("check_in_date", { ascending: false })
      .order("id")
      .range(from, to);
    return { data: (data ?? []) as unknown as Reservation[], error };
  });
}

export async function sendArrivalEmail(reservationId: string) {
  const { data, error } = await client().functions.invoke("send-arrival-email", {
    body: { reservationId },
  });
  if (error) {
    const context = "context" in error ? error.context : undefined;
    if (context instanceof Response) {
      const body = await context.clone().json().catch(() => null) as { error?: unknown } | null;
      if (typeof body?.error === "string") throw new Error(body.error);
    }
    throw error;
  }
  return data as { accepted: boolean; recipient: string };
}

export async function getReservationCancellationPolicy(hotelId: string) {
  const { data, error } = await client()
    .from("hotel_settings")
    .select("hotel_id, standard_check_in_time, free_cancellation_hours, late_cancellation_charge_nights, no_show_grace_hours, no_show_charge_nights, cancellation_policy_notes, cancellation_policy_confirmed")
    .eq("hotel_id", hotelId)
    .single();
  throwIfError(error);
  return data as ReservationCancellationPolicy;
}

export async function updateReservationCancellationPolicy(
  hotelId: string,
  policy: Omit<ReservationCancellationPolicy, "hotel_id">,
) {
  const { error } = await client().rpc("update_reservation_cancellation_policy", {
    target_hotel_id: hotelId,
    free_cancellation_hours_value: policy.free_cancellation_hours,
    late_cancellation_charge_nights_value: policy.late_cancellation_charge_nights,
    no_show_grace_hours_value: policy.no_show_grace_hours,
    no_show_charge_nights_value: policy.no_show_charge_nights,
    policy_notes_value: policy.cancellation_policy_notes,
    policy_confirmed_value: policy.cancellation_policy_confirmed,
  });
  throwIfError(error);
}

export async function getAvailableRooms(values: {
  hotelId: string;
  roomTypeId: string;
  checkInDate: string;
  checkOutDate: string;
}): Promise<AvailableRoom[]> {
  const { data, error } = await client().rpc("search_available_rooms", {
    target_hotel_id: values.hotelId,
    target_room_type_id: values.roomTypeId,
    arrival_date: values.checkInDate,
    departure_date: values.checkOutDate,
  });
  throwIfError(error);
  return (data ?? []) as AvailableRoom[];
}

export async function cancelReservation(reservationId: string, reason: string) {
  const { error } = await client().rpc("cancel_reservation", {
    target_reservation_id: reservationId,
    cancellation_reason: reason,
  });
  throwIfError(error);
}

export async function amendReservation(values: {
  reservationId: string;
  roomTypeId: string;
  roomId: string;
  checkInDate: string;
  checkOutDate: string;
  agreedRateKobo: number;
  reason: string;
}) {
  const { error } = await client().rpc("amend_reservation", {
    target_reservation_id: values.reservationId,
    target_room_type_id: values.roomTypeId,
    target_room_id: values.roomId,
    arrival_date: values.checkInDate,
    departure_date: values.checkOutDate,
    agreed_rate: values.agreedRateKobo,
    amendment_reason: values.reason,
  });
  throwIfError(error);
}

export async function markReservationNoShow(
  reservationId: string,
  reason: string,
) {
  const { error } = await client().rpc("mark_reservation_no_show", {
    target_reservation_id: reservationId,
    no_show_reason: reason,
  });
  throwIfError(error);
}

export async function getFolios(hotelId: string): Promise<Folio[]> {
  type FolioRow = Omit<Folio, "balance_kobo" | "items"> & {
    folio_items: Folio["items"];
  };
  const rows = await loadAllPages<FolioRow>(async (from, to) => {
    const { data, error } = await client()
      .from("guest_folios")
      .select(
        "id, folio_number, status, stays(id, guests(full_name), rooms(room_number)), folio_items(id, description, service_date, base_amount_kobo, tax_amount_kobo, total_amount_kobo, status)",
      )
      .eq("hotel_id", hotelId)
      .order("opened_at", { ascending: false })
      .order("id")
      .range(from, to);
    return {
      data: (data ?? []).map((folio): FolioRow => {
        const stay = singleRelation(folio.stays);
        return {
          id: folio.id,
          folio_number: folio.folio_number,
          status: folio.status,
          stays: stay ? {
            id: stay.id,
            guests: singleRelation(stay.guests),
            rooms: singleRelation(stay.rooms),
          } : null,
          folio_items: folio.folio_items ?? [],
        };
      }),
      error,
    };
  });
  const folios = rows.map(
    ({ folio_items, ...folio }) => ({ ...folio, items: folio_items ?? [] }),
  );
  const balanceRows = await Promise.all(
    Array.from({ length: Math.ceil(folios.length / 200) }, (_, index) =>
      folios.slice(index * 200, (index + 1) * 200).map((folio) => folio.id),
    ).map(async (ids) => {
      const { data, error } = await client().rpc("get_folio_balances", {
        target_hotel_id: hotelId,
        target_folio_ids: ids,
      });
      throwIfError(error);
      return (data ?? []) as { folio_id: string; balance_kobo: number }[];
    }),
  );
  const balances = new Map(balanceRows.flat().map((row) => [row.folio_id, Number(row.balance_kobo)]));
  const contextRows = await Promise.all(
    Array.from({ length: Math.ceil(folios.length / 200) }, (_, index) =>
      folios.slice(index * 200, (index + 1) * 200).map((folio) => folio.id),
    ).map(async (ids) => {
      const { data, error } = await client().rpc("get_folio_context", {
        target_hotel_id: hotelId,
        target_folio_ids: ids,
      });
      throwIfError(error);
      return (data ?? []) as {
        folio_id: string;
        stay_id: string;
        guest_name: string;
        room_number: string;
      }[];
    }),
  );
  const contexts = new Map(contextRows.flat().map((row) => [row.folio_id, row]));
  return folios.map((folio) => {
    if (!balances.has(folio.id)) throw new Error(`Balance unavailable for folio ${folio.folio_number}.`);
    const context = contexts.get(folio.id);
    if (!context) throw new Error(`Guest context unavailable for folio ${folio.folio_number}.`);
    return {
      ...folio,
      balance_kobo: balances.get(folio.id)!,
      stays: {
        id: context.stay_id,
        guests: { full_name: context.guest_name },
        rooms: { room_number: context.room_number },
      },
    };
  });
}

export async function getPaymentMethods(
  hotelId: string,
): Promise<PaymentMethod[]> {
  const { data, error } = await client()
    .from("payment_methods")
    .select(
      "id, code, name, requires_reference, requires_verification, active, display_order",
    )
    .eq("hotel_id", hotelId)
    .eq("active", true)
    .order("display_order");
  throwIfError(error);
  return (data ?? []) as PaymentMethod[];
}

export async function getAllPaymentMethods(
  hotelId: string,
): Promise<PaymentMethod[]> {
  const { data, error } = await client()
    .from("payment_methods")
    .select(
      "id, code, name, requires_reference, requires_verification, active, display_order",
    )
    .eq("hotel_id", hotelId)
    .order("display_order");
  throwIfError(error);
  return (data ?? []) as PaymentMethod[];
}

export async function getFinanceApprovalRequests(
  hotelId: string,
): Promise<FinanceApprovalRequest[]> {
  const { data, error } = await client()
    .from("finance_approval_requests")
    .select(
      "id, action_type, target_entity_type, payload, reason, requested_at, expires_at, status, decision_note, requested_by, profiles!finance_approval_requests_requested_by_fkey(full_name)",
    )
    .eq("hotel_id", hotelId)
    .in("status", ["pending", "approved"])
    .order("requested_at");
  throwIfError(error);
  return (data ?? []).map((request) => ({
    ...request,
    profiles: singleRelation(request.profiles),
  }));
}

export async function getFinanceApprovalRegister(
  hotelId: string,
  fromDate?: string,
  toDate?: string,
): Promise<FinanceApprovalRegisterItem[]> {
  const { data, error } = await client().rpc("get_finance_approval_register", {
    target_hotel_id: hotelId,
    target_from_date: fromDate || null,
    target_to_date: toDate || null,
  });
  throwIfError(error);
  return (data ?? []) as FinanceApprovalRegisterItem[];
}

export async function decideFinanceApproval(
  requestId: string,
  approve: boolean,
  note: string,
) {
  const { error } = await client().rpc("decide_finance_approval", {
    target_request_id: requestId,
    approve,
    decision_note_value: note,
  });
  throwIfError(error);
}

export async function executeFinanceApproval(requestId: string) {
  const { error } = await client().rpc("execute_finance_approval", {
    target_request_id: requestId,
  });
  throwIfError(error);
}

export async function getDailyPaymentReconciliation(
  hotelId: string,
  businessDate?: string,
): Promise<DailyPaymentReconciliation[]> {
  const { data, error } = await client().rpc(
    "get_daily_payment_reconciliation",
    { target_hotel_id: hotelId, target_business_date: businessDate || null },
  );
  throwIfError(error);
  return (data ?? []) as DailyPaymentReconciliation[];
}

export async function getDailyRevenueTaxReport(
  hotelId: string,
  businessDate?: string,
): Promise<DailyRevenueTaxReport> {
  const [departmentResult, taxResult] = await Promise.all([
    client().rpc("get_daily_revenue_by_department", {
      target_hotel_id: hotelId,
      target_business_date: businessDate || null,
    }),
    client().rpc("get_daily_tax_breakdown", {
      target_hotel_id: hotelId,
      target_business_date: businessDate || null,
    }),
  ]);
  throwIfError(departmentResult.error);
  throwIfError(taxResult.error);
  return {
    departments: (departmentResult.data ?? []) as DailyRevenueDepartment[],
    taxes: (taxResult.data ?? []) as DailyTaxBreakdown[],
  };
}

export async function getDepositGuestCreditLiabilities(
  hotelId: string,
): Promise<DepositGuestCreditLiability[]> {
  const { data, error } = await client().rpc(
    "get_deposit_guest_credit_liabilities",
    { target_hotel_id: hotelId },
  );
  throwIfError(error);
  return (data ?? []) as DepositGuestCreditLiability[];
}

export async function getNightAuditExceptions(
  hotelId: string,
): Promise<NightAuditException[]> {
  const { data, error } = await client().rpc("get_night_audit_exceptions", {
    target_hotel_id: hotelId,
  });
  throwIfError(error);
  return (data ?? []) as NightAuditException[];
}

export async function getBusinessDayCloseStatus(
  hotelId: string,
): Promise<BusinessDayCloseStatus | null> {
  const { data, error } = await client().rpc("get_business_day_close_status", {
    target_hotel_id: hotelId,
  });
  throwIfError(error);
  return ((data ?? [])[0] as BusinessDayCloseStatus | undefined) ?? null;
}

export async function acknowledgeNightAuditException(
  hotelId: string,
  exceptionCode: "overdue_departures" | "unsettled_open_folios",
  reason: string,
) {
  const { error } = await client().rpc("acknowledge_night_audit_exception", {
    target_hotel_id: hotelId,
    target_exception_code: exceptionCode,
    acknowledgement_reason: reason,
  });
  throwIfError(error);
}

export async function closeCurrentBusinessDay(hotelId: string) {
  const { data, error } = await client().rpc("close_current_business_day", {
    target_hotel_id: hotelId,
  });
  throwIfError(error);
  return data as string;
}

export async function getBusinessDayCloseReport(
  hotelId: string,
  businessDate?: string,
) {
  const { data, error } = await client().rpc("get_business_day_close_report", {
    target_hotel_id: hotelId,
    target_business_date: businessDate ?? null,
  });
  throwIfError(error);
  const row = (data ?? [])[0] as
    | { report: DailyCloseReport; is_closed: boolean }
    | undefined;
  return row ?? null;
}

export async function getDailyOperationalSummary(
  hotelId: string,
): Promise<DailyOperationalSummary> {
  const { data, error } = await client()
    .rpc("get_daily_operational_summary", { target_hotel_id: hotelId })
    .single();
  throwIfError(error);
  return data as DailyOperationalSummary;
}

export async function createPaymentMethod(
  hotelId: string,
  values: {
    code: string;
    name: string;
    requiresReference: boolean;
    requiresVerification: boolean;
    displayOrder?: number;
  },
) {
  const { data, error } = await client().rpc("create_payment_method", {
    target_hotel_id: hotelId,
    method_code: values.code,
    method_name: values.name,
    requires_reference_value: values.requiresReference,
    requires_verification_value: values.requiresVerification,
    display_order_value: values.displayOrder ?? null,
  });
  throwIfError(error);
  return data as string;
}

export async function updatePaymentMethod(
  methodId: string,
  values: {
    code: string;
    name: string;
    requiresReference: boolean;
    requiresVerification: boolean;
    active: boolean;
    displayOrder: number;
  },
) {
  const { error } = await client().rpc("update_payment_method", {
    target_payment_method_id: methodId,
    method_code: values.code,
    method_name: values.name,
    requires_reference_value: values.requiresReference,
    requires_verification_value: values.requiresVerification,
    is_active: values.active,
    display_order_value: values.displayOrder,
  });
  throwIfError(error);
}

export async function getDashboardSnapshot(
  hotelId: string,
): Promise<DashboardSnapshot> {
  const [
    { data: reconciliation, error: paymentError },
    { data: activity, error: activityError },
    { data: audit, error: auditError },
  ] = await Promise.all([
    client().rpc("get_daily_payment_reconciliation", {
      target_hotel_id: hotelId,
      target_business_date: null,
    }),
    client()
      .from("activity_logs")
      .select("id, action, occurred_at")
      .eq("hotel_id", hotelId)
      .order("occurred_at", { ascending: false })
      .limit(6),
    client()
      .from("nightly_posting_runs")
      .select("status")
      .eq("hotel_id", hotelId)
      .order("service_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  throwIfError(paymentError);
  throwIfError(activityError);
  throwIfError(auditError);
  return {
    payments_today_kobo: (reconciliation ?? []).reduce(
      (total: number, method: { net_collected_kobo: number | string }) => total + Number(method.net_collected_kobo),
      0,
    ),
    recent_activity: (activity ?? []) as DashboardSnapshot["recent_activity"],
    night_audit_status: audit?.status ?? null,
  };
}

export async function searchActivityRegister(
  hotelId: string,
  filters: ActivityRegisterFilters,
): Promise<ActivityRegisterItem[]> {
  const { data, error } = await client().rpc("search_activity_register", {
    target_hotel_id: hotelId,
    target_from_date: filters.fromDate || null,
    target_to_date: filters.toDate || null,
    target_query: filters.query?.trim() || null,
    target_action: filters.action?.trim() || null,
    target_entity_type: filters.entityType?.trim() || null,
    target_min_amount_kobo: filters.minAmountKobo ?? null,
    target_max_amount_kobo: filters.maxAmountKobo ?? null,
    target_limit: filters.limit ?? 50,
    target_offset: filters.offset ?? 0,
  });
  throwIfError(error);
  return (data ?? []) as ActivityRegisterItem[];
}

export async function getManagementDashboardSnapshot(
  hotelId: string,
): Promise<ManagementDashboardSnapshot | null> {
  const { data, error } = await client().rpc(
    "get_management_dashboard_snapshot",
    {
      target_hotel_id: hotelId,
    },
  );
  throwIfError(error);
  return ((data ?? [])[0] as ManagementDashboardSnapshot | undefined) ?? null;
}

export async function getManagementDashboardTrend(
  hotelId: string,
  days = 7,
): Promise<ManagementDashboardTrend[]> {
  const { data, error } = await client().rpc("get_management_dashboard_trend", {
    target_hotel_id: hotelId,
    target_days: days,
  });
  throwIfError(error);
  return (data ?? []) as ManagementDashboardTrend[];
}

export async function getFolioPaymentHistory(
  folioId: string,
): Promise<FolioPaymentHistory[]> {
  const { data, error } = await client().rpc("get_folio_payment_history", {
    target_folio_id: folioId,
  });
  throwIfError(error);
  return (data ?? []) as FolioPaymentHistory[];
}

export async function getCombinedPaymentCandidates(folioId: string, orderNumbers: string[]): Promise<CombinedPaymentCandidate[]> {
  const { data, error } = await client().rpc("get_combined_guest_payment_candidates", {
    target_folio_id: folioId, requested_order_numbers: orderNumbers,
  });
  throwIfError(error);
  return (data ?? []) as CombinedPaymentCandidate[];
}

export async function getCombinedGuestPayments(hotelId: string): Promise<CombinedGuestPayment[]> {
  const { data, error } = await client().rpc("get_combined_guest_payments", { target_hotel_id: hotelId });
  throwIfError(error);
  return (data ?? []) as CombinedGuestPayment[];
}

export async function recordCombinedGuestPayment(values: {
  folioId: string;
  paymentMethodId: string;
  hotelAmountKobo: number;
  allocations: { order_id: string; amount_kobo: number }[];
  reference: string;
  accountantName: string;
  reason: string;
}): Promise<string> {
  const { data, error } = await client().rpc("record_combined_guest_payment", {
    target_folio_id: values.folioId,
    target_payment_method_id: values.paymentMethodId,
    hotel_amount_kobo: values.hotelAmountKobo,
    outlet_allocations: values.allocations,
    payment_reference: values.reference,
    verbal_approver_name_value: values.accountantName,
    exception_reason: values.reason,
  });
  throwIfError(error);
  return data as string;
}

export async function reviewCombinedGuestPayment(paymentId: string, decision: "confirmed" | "disputed", note: string) {
  const { error } = await client().rpc("review_combined_guest_payment", {
    target_payment_id: paymentId, decision_value: decision, note_value: note,
  });
  throwIfError(error);
}

export async function recordCombinedGuestPaymentSettlement(values: {
  paymentId: string;
  orderId: string;
  amountKobo: number;
  evidenceReference: string;
  note: string;
}): Promise<string> {
  const { data, error } = await client().rpc("record_combined_guest_payment_settlement", {
    target_payment_id: values.paymentId,
    target_order_id: values.orderId,
    amount_value_kobo: values.amountKobo,
    evidence_value: values.evidenceReference,
    note_value: values.note,
  });
  throwIfError(error);
  return data as string;
}

export async function reverseCombinedGuestPaymentSettlement(settlementId: string, evidenceReference: string, note: string): Promise<void> {
  const { error } = await client().rpc("reverse_combined_guest_payment_settlement", {
    target_settlement_id: settlementId,
    evidence_value: evidenceReference,
    note_value: note,
  });
  throwIfError(error);
}

export async function requestCombinedGuestPaymentRefund(paymentId: string, reason: string, reference: string) {
  const { data, error } = await client().rpc("request_combined_guest_payment_refund", {
    target_payment_id: paymentId, reason_value: reason, payout_reference: reference,
  });
  throwIfError(error);
  return data as string;
}

export async function recordFolioPayment(values: {
  folioId: string;
  paymentMethodId: string;
  amountKobo: number;
  reference?: string;
}) {
  const { data, error } = await client().rpc("record_folio_payment", {
    target_folio_id: values.folioId,
    target_payment_method_id: values.paymentMethodId,
    payment_amount_kobo: values.amountKobo,
    payment_reference: values.reference || null,
  });
  throwIfError(error);
  return data as string;
}

export async function recordReservationDeposit(values: {
  reservationId: string;
  paymentMethodId: string;
  amountKobo: number;
  reference?: string;
}) {
  const { data, error } = await client().rpc("record_reservation_deposit", {
    target_reservation_id: values.reservationId,
    target_payment_method_id: values.paymentMethodId,
    deposit_amount_kobo: values.amountKobo,
    payment_reference: values.reference || null,
  });
  throwIfError(error);
  return data as string;
}

export async function getReservationDepositHistory(
  reservationId: string,
): Promise<ReservationDeposit[]> {
  const { data, error } = await client().rpc(
    "get_reservation_deposit_history",
    { target_reservation_id: reservationId },
  );
  throwIfError(error);
  return (data ?? []) as ReservationDeposit[];
}

export async function getCurrentCashierShift(
  hotelId: string,
): Promise<CashierShift | null> {
  const { data, error } = await client().rpc("current_cashier_shift", {
    target_hotel_id: hotelId,
  });
  throwIfError(error);
  return (data?.[0] ?? null) as CashierShift | null;
}

export async function openCashierShift(
  hotelId: string,
  openingFloatKobo: number,
) {
  const { data, error } = await client().rpc("open_cashier_shift", {
    target_hotel_id: hotelId,
    opening_float_value_kobo: openingFloatKobo,
  });
  throwIfError(error);
  return data as string;
}

export async function closeCashierShift(
  shiftId: string,
  declaredCashKobo: number,
  varianceReason: string | undefined,
  handoverReference: string,
) {
  const { error } = await client().rpc("close_cashier_shift", {
    target_cashier_shift_id: shiftId,
    declared_cash_value_kobo: declaredCashKobo,
    variance_reason_value: varianceReason || null,
    handover_reference_value: handoverReference,
  });
  throwIfError(error);
}

export async function getCashierShiftHistory(
  hotelId: string,
): Promise<CashierShiftHistory[]> {
  const { data, error } = await client().rpc("get_cashier_shift_history", {
    target_hotel_id: hotelId,
  });
  throwIfError(error);
  return (data ?? []) as CashierShiftHistory[];
}

export async function reviewCashierShift(shiftId: string, notes?: string) {
  const { error } = await client().rpc("review_cashier_shift", {
    target_cashier_shift_id: shiftId,
    review_notes_value: notes || null,
  });
  throwIfError(error);
}

export async function voidFolioPayment(paymentId: string, reason: string) {
  const { error } = await client().rpc("request_finance_approval", {
    request_action_type: "void_payment",
    target_id: paymentId,
    amount_kobo: null,
    request_reason: reason,
    request_reference: null,
    request_description: null,
  });
  throwIfError(error);
}

export async function refundFolioPayment(values: {
  paymentId: string;
  amountKobo: number;
  reason: string;
  reference?: string;
}) {
  const { data, error } = await client().rpc("request_finance_approval", {
    request_action_type: "refund_payment",
    target_id: values.paymentId,
    amount_kobo: values.amountKobo,
    request_reason: values.reason,
    request_reference: values.reference || null,
    request_description: null,
  });
  throwIfError(error);
  return data as string;
}

export async function getPendingPaymentVerifications(
  hotelId: string,
): Promise<PendingPaymentVerification[]> {
  const { data, error } = await client().rpc(
    "get_pending_payment_verifications",
    { target_hotel_id: hotelId },
  );
  throwIfError(error);
  return (data ?? []) as PendingPaymentVerification[];
}

export async function verifyPendingPayment(paymentId: string, note: string) {
  const { error } = await client().rpc("verify_pending_payment", {
    target_payment_id: paymentId,
    verification_note_value: note,
  });
  throwIfError(error);
}

export async function rejectPendingPayment(paymentId: string, reason: string) {
  const { error } = await client().rpc("reject_pending_payment", {
    target_payment_id: paymentId,
    rejection_reason: reason,
  });
  throwIfError(error);
}

export async function createFolioAdjustment(values: {
  folioId: string;
  amountKobo: number;
  description: string;
  reason: string;
}) {
  const { data, error } = await client().rpc("request_finance_approval", {
    request_action_type: "folio_adjustment",
    target_id: values.folioId,
    amount_kobo: values.amountKobo,
    request_reason: values.reason,
    request_reference: null,
    request_description: values.description,
  });
  throwIfError(error);
  return data as string;
}

export async function reverseFolioItem(folioItemId: string, reason: string) {
  const { data, error } = await client().rpc("request_finance_approval", {
    request_action_type: "reverse_folio_item",
    target_id: folioItemId,
    amount_kobo: null,
    request_reason: reason,
    request_reference: null,
    request_description: null,
  });
  throwIfError(error);
  return data as string;
}

export async function checkoutStay(stayId: string) {
  const { data, error } = await client().rpc("checkout_stay", {
    target_stay_id: stayId,
  });
  throwIfError(error);
  return data as string;
}

export async function changeStayRate(values: {
  stayId: string;
  effectiveFrom: string;
  rateKobo: number;
  reason: string;
}) {
  const { data, error } = await client().rpc("change_stay_rate", {
    target_stay_id: values.stayId,
    effective_from_date: values.effectiveFrom,
    new_rate_kobo: values.rateKobo,
    change_reason: values.reason,
  });
  throwIfError(error);
  return data as string;
}

export async function createGuest(
  hotelId: string,
  values: { fullName: string; phone?: string; email?: string },
) {
  const { data, error } = await client().rpc("create_guest", {
    target_hotel_id: hotelId,
    guest_full_name: values.fullName,
    guest_phone: values.phone || null,
    guest_email: values.email || null,
  });
  throwIfError(error);
  return data as string;
}

export async function updateGuest(
  guestId: string,
  values: { fullName: string; phone?: string; email?: string },
) {
  const { error } = await client().rpc("update_guest", {
    target_guest_id: guestId,
    guest_full_name: values.fullName,
    guest_phone: values.phone || null,
    guest_email: values.email || null,
  });
  throwIfError(error);
}

export async function deactivateGuest(guestId: string, reason: string) {
  const { error } = await client().rpc("deactivate_guest", {
    target_guest_id: guestId,
    deactivation_reason: reason,
  });
  throwIfError(error);
}

export async function mergeGuests(
  survivorId: string,
  duplicateId: string,
  reason: string,
) {
  const { error } = await client().rpc("merge_guests", {
    target_survivor_id: survivorId,
    target_duplicate_id: duplicateId,
    merge_reason: reason,
  });
  throwIfError(error);
}

export async function anonymiseGuest(guestId: string, reason: string) {
  const { error } = await client().rpc("anonymise_guest", {
    target_guest_id: guestId,
    anonymisation_reason: reason,
  });
  throwIfError(error);
}

export async function createReservation(values: {
  hotelId: string;
  guestId: string;
  roomTypeId: string;
  roomId: string;
  checkInDate: string;
  checkOutDate: string;
  agreedRateKobo: number;
  adultCount: number;
  childCount: number;
  source: string;
  notes: string;
}) {
  const { data, error } = await client().rpc("create_reservation", {
    target_hotel_id: values.hotelId,
    target_guest_id: values.guestId,
    target_room_type_id: values.roomTypeId,
    target_room_id: values.roomId,
    arrival_date: values.checkInDate,
    departure_date: values.checkOutDate,
    agreed_rate: values.agreedRateKobo,
    adult_count: values.adultCount,
    child_count: values.childCount,
    source: values.source,
    reservation_notes: values.notes,
  });
  throwIfError(error);
  return data as string;
}

export type ReservationBusinessAccount = {
  id: string;
  account_number: string;
  account_type: "corporate" | "agency";
  display_name: string;
  direct_billing_enabled: boolean;
  credit_limit_kobo: number;
  credit_exposure_kobo: number;
  available_credit_kobo: number;
  payment_terms_days: number;
};

export type ReservationBusinessAuthorization = {
  authorization_id: string;
  reservation_id: string;
  business_account_id: string;
  account_number: string;
  account_name: string;
  billing_mode: "reference" | "direct_bill";
  authorized_amount_kobo: number;
  instructions_snapshot: string | null;
  authorized_at: string;
};

export async function getReservationBusinessAccounts(hotelId: string) {
  const { data, error } = await client().rpc("get_reservation_business_account_directory", { target_hotel_id: hotelId });
  throwIfError(error);
  return (data ?? []) as ReservationBusinessAccount[];
}

export async function getReservationBusinessAuthorizations(hotelId: string) {
  const { data, error } = await client().rpc("get_reservation_business_authorizations", { target_hotel_id: hotelId });
  throwIfError(error);
  return (data ?? []) as ReservationBusinessAuthorization[];
}

export async function authorizeReservationBusinessAccount(values: {
  reservationId: string;
  businessAccountId: string;
  billingMode: "reference" | "direct_bill";
  authorizedAmountKobo: number;
  reason: string;
}) {
  const { data, error } = await client().rpc("authorize_reservation_business_account", {
    target_reservation_id: values.reservationId,
    target_business_account_id: values.businessAccountId,
    billing_mode_value: values.billingMode,
    authorized_amount_kobo_value: values.authorizedAmountKobo,
    authorization_reason: values.reason,
  });
  throwIfError(error);
  return data as string;
}

export async function revokeReservationBusinessAccount(reservationId: string, reason: string) {
  const { error } = await client().rpc("revoke_reservation_business_account", {
    target_reservation_id: reservationId,
    revocation_reason: reason,
  });
  throwIfError(error);
}

export async function requestReservationDiscount(
  reservationId: string,
  requestedRateKobo: number,
  reason: string,
) {
  const { data, error } = await client().rpc("request_reservation_discount", {
    target_reservation_id: reservationId,
    requested_rate_kobo: requestedRateKobo,
    request_reason: reason,
  });
  throwIfError(error);
  return data as string;
}

export async function createReservationWithDiscountRequest(values: {
  hotelId: string;
  guestId: string;
  roomTypeId: string;
  roomId: string;
  checkInDate: string;
  checkOutDate: string;
  requestedRateKobo: number;
  reason: string;
  adultCount: number;
  childCount: number;
  source: string;
  notes: string;
}) {
  const { data, error } = await client().rpc(
    "create_reservation_with_discount_request",
    {
      target_hotel_id: values.hotelId,
      target_guest_id: values.guestId,
      target_room_type_id: values.roomTypeId,
      target_room_id: values.roomId,
      arrival_date: values.checkInDate,
      departure_date: values.checkOutDate,
      requested_rate_kobo: values.requestedRateKobo,
      request_reason: values.reason,
      adult_count: values.adultCount,
      child_count: values.childCount,
      source: values.source,
      reservation_notes: values.notes,
    },
  );
  throwIfError(error);
  return data as string;
}

export async function checkInReservation(reservationId: string) {
  const { data, error } = await client().rpc("check_in_reservation", {
    target_reservation_id: reservationId,
  });
  throwIfError(error);
  return data as string;
}

export async function createWalkInStay(values: {
  hotelId: string;
  fullName: string;
  phone?: string;
  email?: string;
  roomId: string;
  checkInDate: string;
  checkOutDate: string;
  rateKobo: number;
}) {
  const { data, error } = await client().rpc("create_walk_in_stay", {
    target_hotel_id: values.hotelId,
    guest_full_name: values.fullName,
    guest_phone: values.phone || null,
    guest_email: values.email || null,
    target_room_id: values.roomId,
    check_in_on: values.checkInDate,
    check_out_on: values.checkOutDate,
    agreed_rate: values.rateKobo,
  });
  throwIfError(error);
  return data as string;
}

export async function runNightAudit(hotelId: string) {
  const { data, error } = await client().rpc(
    "run_current_business_date_night_audit",
    { target_hotel_id: hotelId },
  );
  throwIfError(error);
  return data as number;
}

export type CurrentNightAuditApproval = {
  business_date: string;
  approval_id: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_by_role_name: string | null;
  approved_at: string | null;
  executed_by: string | null;
  executed_by_name: string | null;
  executed_by_role_name: string | null;
  executed_at: string | null;
  posting_status: string | null;
  posts_created: number | null;
};

export async function getCurrentNightAuditApproval(
  hotelId: string,
): Promise<CurrentNightAuditApproval | null> {
  const { data, error } = await client().rpc(
    "get_current_night_audit_approval",
    { target_hotel_id: hotelId },
  );
  throwIfError(error);
  return ((data ?? [])[0] as CurrentNightAuditApproval | undefined) ?? null;
}

export async function approveCurrentNightAudit(hotelId: string) {
  const { error } = await client().rpc(
    "approve_current_business_date_night_audit",
    { target_hotel_id: hotelId },
  );
  throwIfError(error);
}
