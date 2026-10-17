import { useQuery } from "@tanstack/react-query";

import {
  getActiveHotel,
  getArrivalAttention,
  getAllPaymentMethods,
  getAvailableRooms,
  getBusinessDayCloseStatus,
  getCashierShiftHistory,
  getCurrentCashierShift,
  getCurrentNightAuditApproval,
  getDailyOperationalSummary,
  getDailyPaymentReconciliation,
  getDailyRevenueTaxReport,
  getDashboardSnapshot,
  getDepartureQueue,
  getDepositGuestCreditLiabilities,
  getFinanceApprovalRequests,
  getFinanceApprovalRegister,
  getFolioPaymentHistory,
  getFolios,
  getGuests,
  getInHouseRoomOccupants,
  getMaintenanceTickets,
  getManagementDashboardSnapshot,
  getManagementDashboardTrend,
  getNightAuditExceptions,
  getPaymentMethods,
  getPendingPaymentVerifications,
  getReservationDepositHistory,
  getReservationBusinessAccounts,
  getReservationBusinessAuthorizations,
  getReservations,
  getRoomBoard,
  getRoomTypeOccupancy,
  getRoomTypes,
  searchActivityRegister,
  type ActivityRegisterFilters,
} from "./reception-service";

export function useActiveHotel() {
  return useQuery({ queryKey: ["active-hotel"], queryFn: getActiveHotel });
}

export function useRoomBoard(hotelId?: string) {
  return useQuery({
    queryKey: ["room-board", hotelId],
    queryFn: () => getRoomBoard(hotelId!),
    enabled: Boolean(hotelId),
    refetchOnMount: "always",
    refetchInterval: 60_000,
  });
}

export function useInHouseRoomOccupants(hotelId?: string, enabled = true) {
  return useQuery({
    queryKey: ["in-house-room-occupants", hotelId],
    queryFn: () => getInHouseRoomOccupants(hotelId!),
    enabled: Boolean(hotelId) && enabled,
    refetchOnMount: "always",
    refetchInterval: 60_000,
  });
}

export function useDepartureQueue(hotelId?: string) {
  return useQuery({
    queryKey: ["departure-queue", hotelId],
    queryFn: () => getDepartureQueue(hotelId!),
    enabled: Boolean(hotelId),
    refetchInterval: 60_000,
  });
}

export function useArrivalAttention(hotelId?: string, enabled = true) {
  return useQuery({
    queryKey: ["arrival-attention", hotelId],
    queryFn: () => getArrivalAttention(hotelId!),
    enabled: Boolean(hotelId) && enabled,
    refetchOnMount: "always",
    refetchInterval: 60_000,
  });
}

export function useRoomTypeOccupancy(hotelId?: string) {
  return useQuery({
    queryKey: ["room-type-occupancy", hotelId],
    queryFn: () => getRoomTypeOccupancy(hotelId!),
    enabled: Boolean(hotelId),
  });
}

export function useGuests(hotelId?: string) {
  return useQuery({
    queryKey: ["guests", hotelId],
    queryFn: () => getGuests(hotelId!),
    enabled: Boolean(hotelId),
  });
}

export function useRoomTypes(hotelId?: string, includeInactive = false) {
  return useQuery({
    queryKey: ["room-types", hotelId, includeInactive],
    queryFn: () => getRoomTypes(hotelId!, includeInactive),
    enabled: Boolean(hotelId),
  });
}

export function useMaintenanceTickets(hotelId?: string, enabled = true) {
  return useQuery({
    queryKey: ["maintenance-tickets", hotelId],
    queryFn: () => getMaintenanceTickets(hotelId!),
    enabled: Boolean(hotelId) && enabled,
    refetchInterval: 60_000,
  });
}

export function useReservations(hotelId?: string) {
  return useQuery({
    queryKey: ["reservations", hotelId],
    queryFn: () => getReservations(hotelId!),
    enabled: Boolean(hotelId),
  });
}

export function useAvailableRooms(values: {
  hotelId?: string;
  roomTypeId?: string;
  checkInDate?: string;
  checkOutDate?: string;
}) {
  const enabled = Boolean(
    values.hotelId &&
    values.roomTypeId &&
    values.checkInDate &&
    values.checkOutDate &&
    values.checkOutDate > values.checkInDate,
  );
  return useQuery({
    queryKey: [
      "available-rooms",
      values.hotelId,
      values.roomTypeId,
      values.checkInDate,
      values.checkOutDate,
    ],
    queryFn: () =>
      getAvailableRooms({
        hotelId: values.hotelId!,
        roomTypeId: values.roomTypeId!,
        checkInDate: values.checkInDate!,
        checkOutDate: values.checkOutDate!,
      }),
    enabled,
  });
}

export function useFolios(hotelId?: string) {
  return useQuery({
    queryKey: ["folios", hotelId],
    queryFn: () => getFolios(hotelId!),
    enabled: Boolean(hotelId),
  });
}

export function usePaymentMethods(hotelId?: string) {
  return useQuery({
    queryKey: ["payment-methods", hotelId],
    queryFn: () => getPaymentMethods(hotelId!),
    enabled: Boolean(hotelId),
  });
}

export function useAllPaymentMethods(hotelId?: string, enabled = true) {
  return useQuery({
    queryKey: ["all-payment-methods", hotelId],
    queryFn: () => getAllPaymentMethods(hotelId!),
    enabled: Boolean(hotelId) && enabled,
  });
}

export function useFinanceApprovalRequests(hotelId?: string, enabled = true) {
  return useQuery({
    queryKey: ["finance-approval-requests", hotelId],
    queryFn: () => getFinanceApprovalRequests(hotelId!),
    enabled: Boolean(hotelId) && enabled,
    refetchInterval: 60_000,
  });
}

export function useFinanceApprovalRegister(
  hotelId?: string,
  enabled = true,
  fromDate?: string,
  toDate?: string,
) {
  return useQuery({
    queryKey: ["finance-approval-register", hotelId, fromDate, toDate],
    queryFn: () => getFinanceApprovalRegister(hotelId!, fromDate, toDate),
    enabled: Boolean(hotelId) && enabled,
  });
}

export function useDailyPaymentReconciliation(
  hotelId?: string,
  enabled = true,
  businessDate?: string,
) {
  return useQuery({
    queryKey: ["daily-payment-reconciliation", hotelId, businessDate],
    queryFn: () => getDailyPaymentReconciliation(hotelId!, businessDate),
    enabled: Boolean(hotelId) && enabled,
  });
}

export function useDailyRevenueTaxReport(
  hotelId?: string,
  enabled = true,
  businessDate?: string,
) {
  return useQuery({
    queryKey: ["daily-revenue-tax-report", hotelId, businessDate],
    queryFn: () => getDailyRevenueTaxReport(hotelId!, businessDate),
    enabled: Boolean(hotelId) && enabled,
  });
}

export function useDepositGuestCreditLiabilities(
  hotelId?: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ["deposit-guest-credit-liabilities", hotelId],
    queryFn: () => getDepositGuestCreditLiabilities(hotelId!),
    enabled: Boolean(hotelId) && enabled,
  });
}

export function useDailyOperationalSummary(hotelId?: string, enabled = true) {
  return useQuery({
    queryKey: ["daily-operational-summary", hotelId],
    queryFn: () => getDailyOperationalSummary(hotelId!),
    enabled: Boolean(hotelId) && enabled,
    refetchOnMount: "always",
  });
}

export function useNightAuditExceptions(hotelId?: string, enabled = true) {
  return useQuery({
    queryKey: ["night-audit-exceptions", hotelId],
    queryFn: () => getNightAuditExceptions(hotelId!),
    enabled: Boolean(hotelId) && enabled,
    refetchInterval: 60_000,
  });
}

export function useBusinessDayCloseStatus(hotelId?: string, enabled = true) {
  return useQuery({
    queryKey: ["business-day-close-status", hotelId],
    queryFn: () => getBusinessDayCloseStatus(hotelId!),
    enabled: Boolean(hotelId) && enabled,
  });
}

export function useCurrentNightAuditApproval(
  hotelId?: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ["night-audit-approval", hotelId],
    queryFn: () => getCurrentNightAuditApproval(hotelId!),
    enabled: Boolean(hotelId) && enabled,
    refetchInterval: 60_000,
  });
}

export function useCurrentCashierShift(hotelId?: string, enabled = true) {
  return useQuery({
    queryKey: ["current-cashier-shift", hotelId],
    queryFn: () => getCurrentCashierShift(hotelId!),
    enabled: Boolean(hotelId) && enabled,
  });
}

export function useCashierShiftHistory(hotelId?: string, enabled = true) {
  return useQuery({
    queryKey: ["cashier-shift-history", hotelId],
    queryFn: () => getCashierShiftHistory(hotelId!),
    enabled: Boolean(hotelId) && enabled,
  });
}

export function useReservationDepositHistory(
  reservationId?: string,
  hotelId?: string,
) {
  return useQuery({
    queryKey: ["reservation-deposits", hotelId, reservationId],
    queryFn: () => getReservationDepositHistory(reservationId!),
    enabled: Boolean(reservationId) && Boolean(hotelId),
  });
}

export function useReservationBusinessAccounts(hotelId?: string) {
  return useQuery({
    queryKey: ["reservation-business-accounts", hotelId],
    queryFn: () => getReservationBusinessAccounts(hotelId!),
    enabled: Boolean(hotelId),
  });
}

export function useReservationBusinessAuthorizations(hotelId?: string) {
  return useQuery({
    queryKey: ["reservation-business-authorizations", hotelId],
    queryFn: () => getReservationBusinessAuthorizations(hotelId!),
    enabled: Boolean(hotelId),
  });
}

export function useFolioPaymentHistory(folioId?: string, hotelId?: string) {
  return useQuery({
    queryKey: ["folio-payment-history", hotelId, folioId],
    queryFn: () => getFolioPaymentHistory(folioId!),
    enabled: Boolean(folioId) && Boolean(hotelId),
  });
}

export function usePendingPaymentVerifications(
  hotelId?: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ["pending-payment-verifications", hotelId],
    queryFn: () => getPendingPaymentVerifications(hotelId!),
    enabled: Boolean(hotelId) && enabled,
    refetchInterval: 60_000,
  });
}

export function useDashboardSnapshot(hotelId?: string) {
  return useQuery({
    queryKey: ["dashboard", hotelId],
    queryFn: () => getDashboardSnapshot(hotelId!),
    enabled: Boolean(hotelId),
    refetchOnMount: "always",
    refetchInterval: 60_000,
  });
}

export function useManagementDashboard(hotelId?: string, enabled = true) {
  const snapshot = useQuery({
    queryKey: ["management-dashboard-snapshot", hotelId],
    queryFn: () => getManagementDashboardSnapshot(hotelId!),
    enabled: Boolean(hotelId) && enabled,
    refetchOnMount: "always",
    refetchInterval: 60_000,
  });
  const trend = useQuery({
    queryKey: ["management-dashboard-trend", hotelId, 7],
    queryFn: () => getManagementDashboardTrend(hotelId!, 7),
    enabled: Boolean(hotelId) && enabled,
    refetchOnMount: "always",
    refetchInterval: 60_000,
  });
  return { snapshot, trend };
}

export function useActivityRegister(
  hotelId: string | undefined,
  filters: ActivityRegisterFilters,
) {
  return useQuery({
    queryKey: [
      "activity-register",
      hotelId,
      filters.fromDate,
      filters.toDate,
      filters.query,
      filters.action,
      filters.entityType,
      filters.minAmountKobo,
      filters.maxAmountKobo,
      filters.limit,
      filters.offset,
    ],
    queryFn: () => searchActivityRegister(hotelId!, filters),
    enabled: Boolean(hotelId),
  });
}
