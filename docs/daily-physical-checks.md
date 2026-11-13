# Daily physical checks

The internal-balancing page now offers room-occupancy spot checks, and the inventory page offers stock-count spot checks. A checker records what they physically observed, with a short evidence note. The database snapshots the corresponding stay-ledger occupancy or item/location stock balance at submission time. A different GM (or Owner) can confirm or dispute the record with a reason. The original observation remains intact, including its date, author, expected value, observed value, and review history.

These checks **do not** create a stay, change a room status, adjust stock, or move money. Investigate a mismatch in the relevant workflow, then enter a separate correcting transaction if justified. A confirmed check means the reviewer examined the observation; it does not mean a discrepancy was automatically resolved.

The interface shows room coverage for the current business date. It does not claim a complete physical audit unless all active rooms have actually been checked. Stock counts are per item and location; uncounted items are not verified. Restaurant/Bar POS deducts stock only for verified recipes; unmapped sales and options remain untracked, so check recipe coverage before interpreting a sales-to-stock comparison. Likewise, an entirely off-system room stay cannot be detected without staff actually inspecting the room.

Use the business-date selector to review an earlier day's observations. New observations can be submitted only for the current business date; an earlier pending observation can still be reviewed later. Expected and observed values in the saved record are the original snapshot, not today's live values.

Suggested daily handoff: Accountant or GM checks rooms using independent housekeeping evidence; Storekeeper counts selected high-risk stock; GM reviews another person's submissions and investigates mismatches. Do not let the person who prepared a check review it. Cash, bank, outlet sales, and expense evidence remains in Daily reconciliation on the internal-balancing page.
