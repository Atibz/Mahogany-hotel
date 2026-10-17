import { describe, expect, it } from "vitest";

import { guestCountError } from "./reservation-validation";

describe("reservation guest capacity", () => {
  it("accepts a party within room capacity", () => {
    expect(guestCountError(1, 1, 2)).toBeNull();
  });

  it("rejects a party above room capacity", () => {
    expect(guestCountError(2, 1, 2)).toBe(
      "This room type allows a maximum of 2 guests.",
    );
  });

  it("requires at least one adult", () => {
    expect(guestCountError(0, 1, 2)).toBe("At least one adult is required.");
  });
});
