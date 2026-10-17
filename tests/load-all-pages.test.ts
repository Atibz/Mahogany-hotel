import { describe, expect, it, vi } from "vitest";

import { loadAllPages } from "../src/lib/supabase/load-all-pages";

describe("loadAllPages", () => {
  it("continues past a full first response without dropping older rows", async () => {
    const load = vi.fn(async (from: number, to: number) => ({
      data: ["first", "second", "third", "fourth", "fifth"].slice(from, to + 1),
      error: null,
    }));
    await expect(loadAllPages(load, 2)).resolves.toEqual([
      "first", "second", "third", "fourth", "fifth",
    ]);
    expect(load.mock.calls).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  it("does not silently return an incomplete register when a later page fails", async () => {
    const load = vi.fn(async (from: number) => from === 0
      ? { data: [1, 2], error: null }
      : { data: null, error: { message: "Request failed" } });
    await expect(loadAllPages(load, 2)).rejects.toThrow("Request failed");
  });
});
