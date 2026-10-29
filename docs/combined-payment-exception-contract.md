# Combined guest payment exception — implementation contract

Status: implemented as an exceptional workflow, subject to role-based acceptance testing. Separate hotel and outlet payment remains the default. The Owner has approved using the outlet display names **6393 Restaurant** and **Gemini Bar & Lounge** for this workflow without waiting for registered-name or other document metadata. These labels identify the two separate businesses for operational purposes; they must not be represented as verified legal names or tax registrations.

## Operating sequence

1. Reception links one open hotel folio to one or more open Restaurant/Bar POS orders and shows the exact hotel and outlet portions. The guest's request for one payment is the exception reason.
2. Reception phones the accountant. Before taking payment, reception records the accountant's identity, time of verbal approval, the linked records, the receiving hotel account/method, and the expected total. This is an **unconfirmed verbal-approval claim**, not an authenticated accountant approval.
3. Reception records the real external payment once. The system atomically links that payment to its hotel-folio portion and each outlet-order portion. The sum of those portions must equal the external payment. A cash payment must use the hotel cashier's open shift; a bank/POS transfer remains unverified until the existing payment-verification control succeeds. No outlet cash shift or second guest payment is created.
4. The guest receives one clearly labelled **payment acknowledgement** from the receiving hotel account, with payment reference, total, and separate breakdowns for Mahogany Hotel, 6393 Restaurant, and/or Gemini Bar & Lounge as applicable. It must not be represented as a tax invoice or a sale by the hotel of the outlet's goods or services. Existing outlet order records remain separate; this workflow does not generate a statutory invoice or make claims about tax treatment.
5. The accountant authenticates later and either confirms the verbal approval and allocations with evidence or flags a dispute. The original claim, collector, timestamps, and decision remain visible. An unresolved/disputed exception blocks daily reconciliation sign-off and appears in attention lists; it does not erase money already received.
6. The outlet order shows the guest-paid portion as **collected by hotel on behalf of outlet** and separately shows the internal settlement due from hotel to outlet. Accountant records the actual later transfer with evidence; it is not a second guest collection or new sale.
7. If an outlet returns a transfer, the accountant records the actual return with evidence against that settlement. The original settlement remains in history. A full guest refund cannot proceed while any outlet settlement remains active.

## Required invariants and tests

- Default direct payments and POS payments are unchanged. Combined collection is a distinct, explicitly selected exception.
- Hotel and outlet records belong to the same hotel, are open and payable, and cannot be over-allocated. One external reference cannot be submitted twice as another combined collection.
- Unverified or voided external payments do not settle guest balances. Voids/refunds/corrections cannot strand an outlet allocation or make a guest balance negative.
- Outlet revenue remains with its originating outlet. Hotel cash-flow records the account that actually received money; internal transfers must not be counted as another guest collection.
- Hotel cashier handover includes the full amount physically received by hotel. Outlet cash handover excludes that amount.
- Accountant confirmation is independent of the receptionist's claim. The claim cannot be edited into a confirmation by reception, and the accountant's decision cannot rewrite the original payment.
- A rollback-only database test must cover separate default payment, combined hotel + restaurant and hotel + bar payments, pending transfer verification, duplicate prevention, wrong-hotel access, role checks, void/refund, daily reconciliation blockers, accountant confirmation, and internal settlement without double counting.

## Document boundary

Do not block implementation on registered-name fields or tax-document wording. The app may use the agreed display names in operational screens and the non-statutory payment acknowledgement. It must **not** invent tax treatment, present that acknowledgement as an invoice, combine separate businesses' sales into hotel revenue, or issue a second guest-payment acknowledgement for the same money. Any statutory documents remain outside this exception workflow until their issuing businesses define them.
