import { describe, expect, it, vi } from "vitest";

import type { ActivityRegisterItem } from "@/features/reception/reception-service";
import { loadMatchingAuditRows } from "./audit-export";

function row(index: number, total: number): ActivityRegisterItem {
  return {
    log_id: String(index), occurred_at: "2026-10-19T12:00:00Z",
    actor_id: null, actor_name: "Owner", action: "test.event",
    entity_type: "test", entity_id: null, metadata: {},
    display_amount_kobo: null, total_count: total,
  };
}

describe("full audit export", () => {
  it("loads all pages with the same applied filters", async () => {
    const all = Array.from({ length: 260 }, (_, index) => row(index, 260));
    const load = vi.fn(async (filters: { offset?: number; limit?: number }) =>
      all.slice(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? 100)),
    );
    const result = await loadMatchingAuditRows({ query: "payment", offset: 50, limit: 50 }, load);
    expect(result).toHaveLength(260);
    expect(load.mock.calls.map(([filters]) => filters)).toEqual([
      { query: "payment", offset: 0, limit: 100 },
      { query: "payment", offset: 100, limit: 100 },
      { query: "payment", offset: 200, limit: 100 },
    ]);
  });

  it("rejects a partial or changed export instead of downloading it", async () => {
    const load = vi.fn(async (filters: { offset?: number }) =>
      filters.offset ? [] : [row(1, 2)],
    );
    await expect(loadMatchingAuditRows({}, load)).rejects.toThrow("changed during export");
  });
});
