import { describe, expect, it } from "vitest";

import { auditPaginationLabel } from "./audit-pagination";

describe("audit pagination label", () => {
  it("does not show a false page count while a page is loading", () => {
    expect(auditPaginationLabel(2, 1, true, false)).toBe("Loading page 2…");
  });

  it("shows the actual count after loading and an error state on failure", () => {
    expect(auditPaginationLabel(2, 6, false, false)).toBe("Page 2 of 6");
    expect(auditPaginationLabel(2, 1, false, true)).toBe("Page 2 unavailable");
  });
});
