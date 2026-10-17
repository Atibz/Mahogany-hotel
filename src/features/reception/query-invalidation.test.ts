import { describe, expect, it } from "vitest";

import { hotelOperationalQueryKeys } from "./query-invalidation";

describe("hotel operational query invalidation", () => {
  it("covers every dashboard dataset affected by a check-in", () => {
    expect(hotelOperationalQueryKeys("hotel-1")).toEqual([
      ["dashboard", "hotel-1"],
      ["management-dashboard-snapshot", "hotel-1"],
      ["management-dashboard-trend", "hotel-1"],
      ["daily-operational-summary", "hotel-1"],
      ["in-house-room-occupants", "hotel-1"],
      ["departure-queue", "hotel-1"],
      ["night-audit-exceptions", "hotel-1"],
      ["business-day-close-status", "hotel-1"],
    ]);
  });
});
