import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOTEL_SCOPED_REALTIME_TABLES,
  subscribeToHotelOperationalChanges,
} from "./hotel-realtime-subscription";

type ChangeCallback = () => void;

function createRealtimeHarness() {
  const listeners: Array<{
    filter: { event: string; schema: string; table: string; filter: string };
    callback: ChangeCallback;
  }> = [];
  const channel = {
    on: vi.fn((_event: string, filter: (typeof listeners)[number]["filter"], callback: ChangeCallback) => {
      listeners.push({ filter, callback });
      return channel;
    }),
    subscribe: vi.fn(() => channel),
  };
  const supabase = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(async () => "ok"),
  };
  const invalidateQueries = vi.fn(async () => undefined);

  return {
    listeners,
    channel,
    supabase,
    queryClient: { invalidateQueries },
    invalidateQueries,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("hotel realtime subscription", () => {
  it("subscribes to each operational table with the hotel's row filter", () => {
    const harness = createRealtimeHarness();

    subscribeToHotelOperationalChanges(
      harness.supabase as never,
      harness.queryClient as never,
      "hotel-123",
    );

    expect(harness.supabase.channel).toHaveBeenCalledWith("hotel-operations:hotel-123");
    expect(harness.channel.subscribe).toHaveBeenCalledOnce();
    expect(harness.listeners.map(({ filter }) => filter.table)).toEqual(HOTEL_SCOPED_REALTIME_TABLES);
    expect(harness.listeners.every(({ filter }) =>
      filter.event === "*" && filter.schema === "public" && filter.filter === "hotel_id=eq.hotel-123",
    )).toBe(true);
  });

  it("debounces bursts and invalidates only the matching hotel's queries", () => {
    vi.useFakeTimers();
    const harness = createRealtimeHarness();

    subscribeToHotelOperationalChanges(
      harness.supabase as never,
      harness.queryClient as never,
      "hotel-123",
      150,
    );

    harness.listeners[0].callback();
    vi.advanceTimersByTime(100);
    harness.listeners[1].callback();
    vi.advanceTimersByTime(149);
    expect(harness.invalidateQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(harness.invalidateQueries).toHaveBeenCalledOnce();
    const filters = harness.invalidateQueries.mock.calls[0][0] as {
      predicate: (query: { queryKey: unknown[] }) => boolean;
    };
    expect(filters.predicate({ queryKey: ["stays", "hotel-123"] })).toBe(true);
    expect(filters.predicate({ queryKey: ["stays", "hotel-456"] })).toBe(false);
  });

  it("clears pending refreshes and removes the channel on cleanup", () => {
    vi.useFakeTimers();
    const harness = createRealtimeHarness();
    const cleanup = subscribeToHotelOperationalChanges(
      harness.supabase as never,
      harness.queryClient as never,
      "hotel-123",
    );

    harness.listeners[0].callback();
    cleanup();
    vi.advanceTimersByTime(200);

    expect(harness.invalidateQueries).not.toHaveBeenCalled();
    expect(harness.supabase.removeChannel).toHaveBeenCalledWith(harness.channel);
  });
});
