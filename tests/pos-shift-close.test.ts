import { describe, expect, it } from "vitest";

import { expectedPosShiftCash, posActionErrorMessage } from "../src/features/pos/shift-close";

describe("POS shift close guidance", () => {
  it("includes the float and all completed cash receipts for this shift, less its cash refunds", () => {
    expect(expectedPosShiftCash(
      { id: "restaurant-shift", opening_float_kobo: 500_000 },
      ["cash", "old-cash"],
      [
        { cashier_shift_id: "restaurant-shift", payment_method_id: "cash", amount_kobo: 2_000_000 },
        { cashier_shift_id: "restaurant-shift", payment_method_id: "old-cash", amount_kobo: 100_000 },
        { cashier_shift_id: "restaurant-shift", payment_method_id: "card", amount_kobo: 800_000 },
        { cashier_shift_id: "bar-shift", payment_method_id: "cash", amount_kobo: 900_000 },
      ],
      [
        { cashier_shift_id: "restaurant-shift", amount_kobo: 250_000 },
        { cashier_shift_id: "bar-shift", amount_kobo: 50_000 },
      ],
    )).toEqual({ opening: 500_000, received: 2_100_000, returned: 250_000, expected: 2_350_000 });
  });

  it("does not discard the message from a plain RPC error object", () => {
    expect(posActionErrorMessage({ code: "P0001", message: "A reason is required when declared cash differs from expected cash" }))
      .toBe("A reason is required when declared cash differs from expected cash");
    expect(posActionErrorMessage(new Error("This restaurant cash shift is already closed")))
      .toBe("This restaurant cash shift is already closed");
  });
});
