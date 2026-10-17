import { describe, expect, it } from "vitest";

import { mergeRecentAndOpenOrders } from "../src/features/pos/order-workspace";

describe("POS order workspace", () => {
  it("keeps older unpaid orders available after the recent-order window is full", () => {
    const recent = Array.from({ length: 60 }, (_, index) => ({
      id: `recent-${index}`, outlet_id: "restaurant",
      created_at: new Date(Date.UTC(2026, 9, 17, 0, index)).toISOString(),
    }));
    const oldOpen = { id: "old-open", outlet_id: "restaurant", created_at: "2026-09-01T00:00:00Z" };
    const orders = mergeRecentAndOpenOrders(recent, [oldOpen], new Set(["restaurant"]));
    expect(orders).toHaveLength(61);
    expect(orders.at(-1)?.id).toBe("old-open");
  });

  it("deduplicates and excludes another outlet", () => {
    const order = { id: "open", outlet_id: "restaurant", created_at: "2026-10-17T12:00:00Z" };
    const bar = { id: "bar", outlet_id: "bar", created_at: "2026-10-17T13:00:00Z" };
    expect(mergeRecentAndOpenOrders([order, bar], [order], new Set(["restaurant"])))
      .toEqual([order]);
  });
});
