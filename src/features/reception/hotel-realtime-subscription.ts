import type { QueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

export const HOTEL_SCOPED_REALTIME_TABLES = [
  "rooms",
  "room_types",
  "reservations",
  "stays",
  "guest_folios",
  "folio_items",
  "payments",
  "payment_allocations",
  "reservation_deposits",
  "payment_refunds",
  "receipts",
  "cashier_shifts",
  "finance_approval_requests",
  "room_turnover_tasks",
  "maintenance_tickets",
  "nightly_posting_runs",
  "activity_logs",
] as const;

/** Listen for hotel changes and invalidate only cached queries scoped to that hotel. */
export function subscribeToHotelOperationalChanges(
  supabase: Pick<SupabaseClient, "channel" | "removeChannel">,
  queryClient: Pick<QueryClient, "invalidateQueries">,
  hotelId: string,
  debounceMs = 150,
) {
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const channel = supabase.channel(`hotel-operations:${hotelId}`);

  for (const table of HOTEL_SCOPED_REALTIME_TABLES) {
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table, filter: `hotel_id=eq.${hotelId}` },
      () => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          void queryClient.invalidateQueries({
            predicate: (query) => query.queryKey.includes(hotelId),
          });
        }, debounceMs);
      },
    );
  }

  void channel.subscribe();

  return () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    void supabase.removeChannel(channel);
  };
}
