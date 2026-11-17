# Internal daily reconciliation

Apply `20261020120000_internal_daily_reconciliation.sql` before deploying the updated interface. It adds internal evidence records and checked RPCs; it does not post journals, execute bank transfers, modify payments, or rewrite cashier counts.

## Daily workflow

1. Open **Internal balancing** and choose the hotel's payment business date. The server uses the hotel's timezone and cutoff to classify payments and refunds.
2. Set up a named drawer or settlement account for each business line and payment method used. One business line/payment method maps to one internal account. If several outlets share a business line, this account reconciles their combined receipts. Allocate shared bank balances between accounts once; do not repeat the full bank balance for every business line.
3. Assign each already-paid expense to the actual funding account, payment business date, and evidence reference. The date-range summary still groups expenses by incurred date. Daily reconciliation groups them by payment date. Earlier unassigned expenses must be resolved so an unknown outflow is not silently omitted.
4. Document other movements already made, such as bank deposits or external top-ups. Money out is negative; money in is positive. For transfers between internal accounts, enter both sides with a shared evidence reference. Correct a mistaken movement with an opposite entry referencing the original. Do not re-enter sales, refunds, or expenses as other movements.
5. Resolve pending payments, expense reviews, open shifts, unmapped tenders, and unreviewed hotel cashier shifts. POS shifts are reviewed as supporting evidence in the daily sign-off. Shifts are not added to account totals a second time.
6. Enter opening and actual closing balances with cash-count or statement evidence. Previous-day approved closing balances carry into opening balances. Where no preceding approved day exists, the opening reference must establish the starting balance. Card settlement timing and merchant charges must be investigated and explained; they are not silently assumed to be received cash.
7. Explain all shortages/overages and rejected paid expenses, then submit. An Owner or GM other than the submitter, or an Accountant, reviews the evidence and approves or rejects the snapshot. Accountant self-review is explicitly marked in the audit trail. Expense rejection does not imply money was recovered, so rejected paid expenses remain outflows.

Expected closing is opening + completed collections − refunds − funded paid expenses + other movements. Variance is actual closing − expected closing. These balances are not profit or statutory accounts.

## Corrections and evidence

Submitting saves declarations, source rows, expense evidence, movements, shifts, and exception notes. The server calculates expected balances and variances itself. A changed source dataset prevents stale submission or approval. A pending submission must be reviewed and rejected before its funding/movements can change.

Approved versions remain preserved. Later source changes are flagged when viewing a snapshot. Select **Live records**, document the correction, and submit a new version with an explanation. Corrected actual counts can also be submitted with fresh evidence. Every revision needs documented review and retains the preceding approved version's ID. Earlier source changes can affect the next day's carried opening, which should be reconciled again if necessary.

Export the selected snapshot for its signed figures and reviewer IDs, or export the live preview for current source evidence. Preview exports are not signed reports. References identify cash-count sheets, bank statements, and receipts held by the hotel; this feature does not upload or independently verify those documents.

The workflow uses existing finance permissions: payments, POS sales and expense read permissions for visibility, expense submit permission for preparation, and expense review permission for sign-off. Accountant self-review is an explicit exception; other roles cannot review their own submissions. There are no direct authenticated table writes. This is a separate finance reconciliation approval; it does not replace room-night posting approval or automatically close the hotel business day.

For independent room-occupancy observations and physical item/location counts, see [daily physical checks](daily-physical-checks.md). Those spot checks expose discrepancies without changing either ledger and are not a substitute for this money reconciliation.

## Verification

`npm test -- tests/internal-reconciliation-database.test.ts src/features/settings/internal-reconciliation.test.ts src/features/settings/daily-reconciliation.test.ts`

Database tests apply the real migration chain to isolated embedded PostgreSQL and exercise transactions, permissions, totals, source freshness, and approvals. The harness supplies Supabase-owned auth/storage infrastructure and omits the unavailable cron scheduler and unused crypto extension. It does not connect to the live hotel database. Production Supabase deployment and browser smoke checks against its configured schema remain deployment checks.
