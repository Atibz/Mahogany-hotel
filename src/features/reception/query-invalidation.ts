import type { QueryClient, QueryKey } from "@tanstack/react-query";

export function hotelOperationalQueryKeys(hotelId: string): QueryKey[] {
  return [
    ["dashboard", hotelId],
    ["management-dashboard-snapshot", hotelId],
    ["management-dashboard-trend", hotelId],
    ["daily-operational-summary", hotelId],
    ["in-house-room-occupants", hotelId],
    ["departure-queue", hotelId],
    ["night-audit-exceptions", hotelId],
    ["business-day-close-status", hotelId],
  ];
}

export async function invalidateHotelOperationalQueries(
  queryClient: QueryClient,
  hotelId: string,
) {
  await Promise.all(
    hotelOperationalQueryKeys(hotelId).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
}
