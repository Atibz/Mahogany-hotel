import { describe, expect, it } from "vitest";

import { formatNaira, nairaToKobo } from "./money";

describe("money utilities", () => {
  it("stores entered Naira as integer kobo", () => {
    expect(nairaToKobo("1,234.56")).toBe(123_456);
    expect(nairaToKobo("0")).toBe(0);
    expect(nairaToKobo("0.01")).toBe(1);
  });

  it("rounds fractional kobo instead of storing floating-point money", () => {
    expect(nairaToKobo("10.999")).toBe(1_100);
  });

  it.each(["", "not money", "-1", "Infinity"])(
    "rejects invalid monetary input %j",
    (value) => {
      expect(() => nairaToKobo(value)).toThrow(
        "Enter a valid non-negative amount.",
      );
    },
  );

  it("formats kobo as Nigerian Naira without changing its value", () => {
    expect(formatNaira(123_456)).toContain("1,234.56");
    expect(formatNaira(-50_000)).toContain("500");
    expect(formatNaira(null)).toContain("0");
  });
});
