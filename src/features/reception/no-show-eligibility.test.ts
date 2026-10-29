import { describe, expect, it } from "vitest";

import { formatNoShowAllowedAfter, noShowAllowedAfter } from "./no-show-eligibility";

describe("no-show cutoff", () => {
  it("uses the booking snapshot and crosses midnight in hotel time", () => {
    const cutoff = noShowAllowedAfter({
      check_in_date: "2026-10-27",
      reservation_cancellation_policy_snapshots: {
        terms_state: "recorded_at_booking",
        scheduled_check_in_time: "14:00:00",
        no_show_grace_hours: 12,
        no_show_charge_nights: 0,
        free_cancellation_hours: 24,
        late_cancellation_charge_nights: 0,
        policy_notes: null,
      },
    }, { standard_check_in_time: "15:00:00", no_show_grace_hours: 24 });

    expect(cutoff.toISOString()).toBe("2026-10-28T01:00:00.000Z");
    expect(formatNoShowAllowedAfter(cutoff)).toContain("28 Oct 2026");
  });

  it("uses current hotel settings for a legacy booking", () => {
    const cutoff = noShowAllowedAfter(
      { check_in_date: "2026-10-27", reservation_cancellation_policy_snapshots: null },
      { standard_check_in_time: "15:30:00", no_show_grace_hours: 2 },
    );
    expect(cutoff.toISOString()).toBe("2026-10-27T16:30:00.000Z");
  });

  it("matches the database defaults and respects zero grace hours", () => {
    expect(noShowAllowedAfter({ check_in_date: "2026-10-27" }).toISOString())
      .toBe("2026-10-28T01:00:00.000Z");
    expect(noShowAllowedAfter(
      { check_in_date: "2026-10-27" },
      { standard_check_in_time: null, no_show_grace_hours: 0 },
    ).toISOString()).toBe("2026-10-27T13:00:00.000Z");
  });
});
