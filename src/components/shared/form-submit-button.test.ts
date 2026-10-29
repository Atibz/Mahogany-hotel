import { describe, expect, it } from "vitest";
import { isRequiredTextComplete } from "./form-readiness";

describe("required form text", () => {
  it("keeps submission inactive for empty or whitespace-only values", () => {
    expect(isRequiredTextComplete("", -1)).toBe(false);
    expect(isRequiredTextComplete("   ", -1)).toBe(false);
  });

  it("counts trimmed content against the minimum length", () => {
    expect(isRequiredTextComplete("  ab  ", 3)).toBe(false);
    expect(isRequiredTextComplete("  abc  ", 3)).toBe(true);
  });
});
