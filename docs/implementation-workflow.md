# Mahogany Hotel — Delivery Workflow

**Purpose:** Build a reliable, role-controlled hotel operations system for Mahogany Hotel, Jericho, Ibadan. Follow this order. Do not start a later phase because it looks exciting while an earlier control is unfinished.

## 1. Non-negotiable operating rules

1. Store money as integer kobo; display naira only in the interface.
2. Room revenue is posted nightly. A reservation, check-in, or payment is not room revenue.
3. Payments are separate from charges. A payment cannot edit a charge.
4. Room prices are tax-inclusive. A guest-facing rate of ₦180,000 must result in a ₦180,000 total room charge.
5. Financial history is append-only. Correct with a void, refund, reversal, credit note, or adjustment with a reason and actor.
6. Owner sees every module and all audit activity. GM has broad operational access. Every other role sees only its assigned work.
7. A hidden menu is not security. Database row-level security and database functions must reject unauthorised actions.
8. Do not hard-delete guests, stays, payments, folios, invoices, inventory movements, or audit records.
9. Every database change is a new migration. Never edit a migration that has been applied to a shared database.
10. No production launch until the acceptance tests in Phase 12 pass.

## 2. Delivery discipline for every work item

For each feature, do these steps in order:

1. Write the business rule and the roles allowed to use it.
2. Identify the source tables, documents, and audit event required.
3. Add a new database migration with constraints, RLS, and narrow database functions.
4. Apply and test the migration in a non-production Supabase project first.
5. Build the UI only after the database rule exists.
6. Hide unavailable UI actions, but rely on the database function as final enforcement.
7. Test the happy path, rejection paths, two-user conflict, and role denial.
8. Run `npm run typecheck`, `npm run lint`, and `npm run build`.
9. Update the handoff and this document with the completed migration and test result.

Do not use generic browser `insert`, `update`, or `delete` calls for money, room inventory, reservations, staff roles, or other controlled transitions.

## 3. Role model to implement and test

| Role | Intended access |
| --- | --- |
| Owner | Everything, including audit, reports, staff, settings, and approvals. |
| General Manager | Broad operations, staff administration, approvals, dashboards, and exceptions. |
| Receptionist | Guests, rooms/status, reservations, check-in, selected guest folios; no hotel-wide financial history. |
| Cashier | Payments, receipts, cashier shift, settlement, and selected folio balance; no room rates or staff control. |
| Accountant | Finance, reconciliation, tax, reports, refunds/approved corrections; no routine room assignment. |
| Restaurant/Bar staff | Their own POS and assigned orders only. Do not provision these accounts until POS exists. |
| Storekeeper | Inventory, suppliers, receiving, issues, counts, and stock reports only. |

Create a role test account for every role. For every route and database function, record whether each role is allowed or denied.

## 4. Phase 0 — Stabilise the current foundation

**Goal:** Know exactly what is deployed and stop migration drift.

### Work

- Apply outstanding migrations in timestamp order, including staff reassignment and access restrictions.
- Record each applied migration in Supabase migration history; stop applying SQL ad hoc through copied fragments.
- Update `supabase/README.md` and `docs/codex-handoff.md` so they list all current migrations and current behaviour.
- Set Supabase Auth Site URL and allowed invitation redirect URLs.
- Disable public sign-up. Confirm only Owner/GM can send invitations.
- Configure the first Owner, a GM, Receptionist, Cashier, and Accountant test account.
- Create realistic safe test data: rooms, room types, open reservations, checked-in stays, charges, payments, voids, and refunds.
- Configure a staging project before production data is used.

### Done when

- A new developer can clone the repository, follow one documented path, and reach a working staging system.
- No migration is manually edited after it has been applied.
- All test users can sign in and see only allowed navigation and routes.

## 5. Phase 1 — Finish access control and identity

**Goal:** Make role boundaries real and usable.

### Database

- Review every existing RLS policy table by table. Replace hotel-wide read access where a specific permission is required.
- Add a single permission catalogue and role test matrix; do not rely on scattered hard-coded role names alone.
- Ensure Owner and GM alone manage staff roles, deactivation, and invitations.
- Add a safe forgotten-password flow through Supabase email; users can change their own password after confirming their current password.
- Require MFA for Owner, GM, and Cashier before production.
- Log staff invite, activation, deactivation, role change, password-reset request, and MFA change events.

### UI

- Keep My Profile available to every active user.
- Show a useful restricted-access page rather than blank data or a broken route.
- Remove modules with no usable workflow from roles that do not need them.

### Tests

- For every role: test navigation, a pasted URL, direct database select, and direct controlled-function call.
- Deactivate a user while they are signed in; confirm their next request is denied.
- Confirm an Owner cannot accidentally remove the final Owner account.

### Done when

- A receptionist cannot see hotel-wide money movement even by guessing a URL or calling the API.
- An unauthorised role cannot make a sensitive database change even if the UI is modified in the browser.

## 6. Phase 2 — Cashier shifts, payments, deposits, and documents

**Goal:** Stop cash leakage and make every payment accountable.

### Required workflows

1. **Open cashier shift:** Cashier declares opening float; system creates a numbered shift.
2. **Receive payment:** Record method, amount, reference, receiving staff, timestamp, and applicable folio/reservation/guest credit.
3. **Advance deposit:** Allow a payment before check-in or before charges exist. Hold it as reservation deposit or guest credit, then allocate later.
4. **Transfer/card verification:** Mark pending where appropriate; do not call an unverified transfer cash received.
5. **Receipt:** Produce a per-payment printable/shareable document immediately.
6. **Void/refund:** Require reason, role permission, original-record link, and approval where policy requires it.
7. **Cashier close:** Show expected cash, declared cash, variance, reason, approving manager, and handover/bank-deposit reference.

### Database additions

- Cashier shifts, opening float, closing declaration, cash variance, handover, and deposit records.
- Guest credits/reservation deposits and allocation history.
- Payment verification state where bank transfer or card confirmation is delayed.
- Credit-note workflow for post-checkout refunds; never reopen or rewrite a closed invoice casually.
- Document snapshots for receipts, invoices, refunds, and credit notes.

### Role rules

- Reception may record a payment only if the owner approves that operating model; otherwise route payment intake to Cashier.
- Reception sees only the selected guest’s payment position.
- Cashier sees payment intake and own/current shift.
- Accountant, GM, Owner see reconciliation and full movement.
- Accountant may prepare a refund, void, folio adjustment, charge reversal, or exceptional discount request, but may not approve their own request or execute it without an approval where hotel policy requires one.
- GM may approve routine finance exceptions within a configured limit. Owner approval is required above that limit and for policy-sensitive actions such as post-checkout refunds, material write-offs, and changes to approval limits.

### Finance approval workflow — build before granting correction authority

1. A permitted requester creates an immutable approval request linked to exactly one original record: payment, receipt, folio item, reservation, stay, or cashier shift.
2. The request stores a typed action (`refund`, `void`, `folio_adjustment`, `charge_reversal`, `discount_exception`, `post_checkout_credit_note`, or `cash_variance_write_off`), amount where applicable, reason, supporting reference, requester, and timestamp.
3. The system calculates the required approver from the hotel policy and amount. A requester cannot approve their own request. The original cashier/receiver cannot approve their own related cash exception.
4. An approver may approve or reject once, with a required note. The request records approver, decision, decision time, and any policy-limit result. A pending request can expire or be withdrawn, never silently edited.
5. Only an approved request can call the controlled financial RPC. The executed event must retain the approval request ID in its audit metadata and create the normal append-only correction/refund/void/reversal record.
6. Rejected, expired, withdrawn, approved, and executed requests remain searchable in the financial audit log. No approval record is deleted.

### Approval acceptance criteria

- A direct URL, direct RPC call, or altered browser request cannot bypass a required approval.
- The same request cannot execute twice, and it cannot execute after rejection, expiry, or withdrawal.
- Approval limits are hotel configuration controlled by Owner; changing a limit is audited.
- Owner, GM, and Accountant can see the finance approval queue appropriate to their role; other staff see only their own requests.
- Reports show requested, approved, rejected, and executed finance exceptions with requester, approver, amount, reason, and linked document.

### Done when

- A guest can pay a deposit before check-in.
- Cash paid over a shift can be reconciled to physical cash.
- A receipt is never blank, duplicated, or editable after issue.
- A refund, void, and reversal each have distinct accounting behaviour and audit evidence.

## 7. Phase 3 — Housekeeping and maintenance

**Goal:** Prevent the front desk selling a room that is dirty or faulty.

### Housekeeping workflow

- Add room operational state: vacant clean, vacant dirty, inspected, occupied clean, occupied dirty, out of order, out of service.
- Checkout automatically creates a clean-required task.
- Housekeeper marks clean; supervisor inspects and releases room for sale where policy requires it.
- Record assigned employee, timestamps, notes, linen/amenity issues, and exceptions.

### Maintenance workflow

- Any staff member can raise a maintenance ticket.
- Ticket has room/area, fault, priority, photo optional, reporter, assignee, status, downtime, and completion sign-off.
- A room cannot become sellable until required maintenance and housekeeping sign-offs are complete.
- Maintenance costs and external contractor references are captured for later finance reporting.

### Done when

- A checked-out room is not sellable until cleaning is complete.
- A maintenance block has a ticket and lifecycle, not only a free-text reason.
- Owner dashboard shows dirty rooms and overdue maintenance.

## 8. Phase 4 — Complete front-office reservation and stay lifecycle

**Goal:** Support normal hotel exceptions without staff inventing rules.

### Implement in this order

1. Booking source and source reference: walk-in, phone, WhatsApp, website, corporate, agent, OTA.
2. Reservation deposit/guarantee and due date.
3. **Partially implemented:** Owner/GM-configured cancellation deadline, late-cancellation/no-show fee terms, and no-show grace period. A required Owner/GM confirmation distinguishes approved terms from draft terms; new reservations receive immutable snapshots, and older reservations are explicitly marked as having unknown historical terms. The no-show action is database-blocked until scheduled check-in plus the saved grace period. No financial fee, deposit forfeiture, or refund is automated. **Still required:** guest-facing delivery/acceptance of the approved terms and an independently authorized, append-only cancellation-fee/refund workflow that reconciles to deposits and liabilities.
4. **Operational lists and expected-arrival dashboard alerts implemented. Staff-initiated guest arrival email is implemented:** Reception has due/late/upcoming check-in lists, a controlled departure queue, and room occupant details. The dashboard shows due/overdue arrivals, including unassigned rooms, using the hotel's business date and refreshing once per minute. The Reservations list can send an audited arrival email for a selected pending/confirmed reservation. **Still required:** configure and verify the Resend sender/API secrets, test using a hotel-controlled address, add SMS/WhatsApp only if approved, and complete end-to-end role-based browser testing.
5. Room move with reason, old/new room history, and pricing rule. **Implemented:** Owner, GM, and Reception can move an active stay only to a clean, available, conflict-free room. The stay, folio, and current rate are preserved; the vacated room becomes dirty and receives a housekeeping task; immutable move history and activity-log evidence are recorded.
6. Stay extension with availability check and future rate snapshot. **Implemented:** Owner, GM, and Reception can extend an active stay when the current room remains available. Existing pricing continues by default; only management can apply a different extension rate, effective from the original checkout date. Prior and posted nights remain unchanged, and every extension is audited.
7. Early check-in, late checkout, early departure, and extra-night policies. **Operational controls implemented:** Owner/GM can record standard times and conservative exception rules in an audited settings page. New stay activity captures exact timestamps, and early/late time exceptions, early-departure review, and extra-night approval are enforced in the database. Historical times are not fabricated. Automatic charges remain disabled pending hotel/accountant approval.
8. Corporate/agency accounts, approved credit limits, billing instructions, and direct-bill settlement. **Register, authorisation, checkout transfer, settlement, ageing, statements, and approved company credit corrections implemented:** Owner/GM can maintain audited accounts and approve direct-bill credit within live limits; Reception can attach reference-only accounts but cannot approve credit. Final-folio preparation transfers approved company debt to a distinct receivable without fabricating a payment, and checkout snapshots that liability into the invoice. Accountant/Owner can record controlled partial or full settlement, verification-gated methods require review, and Owner/GM/Accountant can export debtor ageing and account statements. Closed company invoices now receive separate approved credit notes; a paid credit requires a separately approved, bounded refund. Rollback-only fixture and authenticated role click-through tests remain required before client use, as does accountant review of credit-note tax treatment.
9. Group booking only after the individual workflow is solid.

### Done when

- Every reservation status has an explicit next action and audit history.
- Staff cannot overbook a physical room or bypass a room’s maintenance/cleaning status.
- Deposits, cancellation charges, and no-show charges reconcile to the correct folio or credit.

## 9. Phase 5 — Complete night audit and daily close

**Goal:** Turn nightly posting into a controlled end-of-day operation.

### Implement

- Use a manually authorized workflow: Accountant/Owner/GM reviews and approves the current business date; a different authorized Reception/GM/Owner user runs the posting. Automated posting is disabled unless the hotel later explicitly adopts it.
- Add a night-audit dashboard with exceptions: missed charges, failed posts, overdue departures, occupied-without-stay, open cashier shifts, unsettled folios, and unverified payments.
- Require authorised resolution or acknowledgement for each exception.
- Produce a numbered daily audit report: occupancy, arrivals, departures, room revenue posted, taxes, payments by method, refunds, discounts, and outstanding balances.
- Define business-day close and reopen policy. After close, corrections must be append-only and manager-approved.

### Done when

- Night audit can be safely rerun without double posting.
- The approver and executor are independently recorded; one person cannot approve and execute the same date.
- The GM can explain every exception before the next business day is closed.
- Owner receives a concise daily operational summary.

## 10. Phase 6 — Owner dashboard, accountant reports, and audit search

**Goal:** Give management useful information, not decorative charts.

### Owner mobile dashboard

- Occupancy by room type and operational state.
- Arrivals, departures, no-shows, and in-house count.
- Posted room revenue; booked future revenue shown separately.
- Payments by method, outstanding balances, deposits held, refunds, voids, and cash variances.
- High-priority alerts: failed night audit, overdue dirty room, open cashier shift, large refund, unusual discount, and maintenance outage.

### Accountant reports

- Daily revenue by department and tax component.
- Payment-method reconciliation and transfer verification list.
- Cash-shift variance report.
- Deposit/guest-credit liability report.
- Debtor ageing and corporate account statement.
- Refund, adjustment, void, reversal, and discount report with actor/reason.
- Tax report aligned with accountant-approved treatment.
- Finance approval register: pending, approved, rejected, expired, and executed correction/refund/discount requests with requester, approver, linked document, amount, and reason.

### Audit search

- Search by date, user, guest, folio, room, document number, action type, and amount range.
- Owner/GM can review audit evidence; ordinary staff cannot browse it.

## 11. Phase 7 — Restaurant and bar POS

**Precondition:** Phase 2 cash control is complete. Do not build POS first.

### Delivery order

1. Shared catalog foundation: outlets mapped to hotel departments; categories; menu
   items; modifier groups/options; effective-dated price versions. Only controlled,
   audited RPCs may create catalog records. Migration `20261012120000_shared_pos_catalog.sql`
   is deployed. The Owner/GM setup page supports adding catalog records and price
   periods, but does not yet support edit/retire operations and is not a sales ledger.
2. Add order lifecycle and immutable line snapshots. Snapshot item name/code, chosen
   modifiers, unit price, discount, department, service date, tax-rule IDs/rates/bases,
   tax amounts, and totals when a line is posted. Never recalculate posted orders from
   today's menu or tax settings.
3. Integrate payments and guest-folio posting only after the database design proves a
   single sale cannot become duplicate revenue or duplicate payment. Reuse existing
   payments, cashier shifts, folio items, receipts, and finance-approval controls where
   their data model supports it; do not create a second payment ledger by convenience.
4. Build the staff order UI, outlet reporting, print documents, then run local database
   integration tests and two-role browser tests before deploying the completed slice.

KOT/bar tickets are a configurable outlet setting and default off. Keep the workflow
simple until hotel operations confirms its kitchen/bar handoff. POS tax calculation
must use effective-dated database rules and item-level snapshots; do not infer a tax
price treatment from the screen or hard-code rates in React.

### Implement

- Menu, modifiers, price periods, tax treatment, and outlet/department configuration.
- Order lifecycle: open, sent to kitchen/bar, served, settled, voided, refunded.
- KOT/bar ticket workflow if the hotel needs it.
- Guest-room posting only to an open validated folio, with guest/room confirmation.
- Discount/void approval levels and reason capture.
- Separate cashiers or outlet shifts as determined by operating policy.
- POS receipts and daily outlet summary.

### Done when

- A restaurant/bar sale can be paid immediately or posted to a guest folio without duplicate revenue or payment records.
- Void and discount controls meet the same standard as room folio corrections.

## 12. Phase 8 — Inventory, suppliers, and expenses

**Goal:** Link stock movement and cost controls to operations.

### Implement

- Item master, units, categories, reorder levels, suppliers, purchase requests, purchase orders, receiving, invoice matching.
- Stock movement ledger: receiving, issue to outlet, transfer, return, spoilage/waste, stock count adjustment, and reason.
- Periodic physical stock counts and approval of variances.
- Recipe/BOM consumption for restaurant/bar only after basic stock movement works.
- Expense entry, approval, attachment, payment method, and accounting period.

### Done when

- Stock cannot be silently edited.
- Owner can see major stock variance, wastage, and unapproved expenses.

## 13. Phase 9 — Quality, security, and go-live readiness

### Automated testing

Create database and browser tests for every critical rule:

- Night posting idempotency and rate snapshot.
- Tax-inclusive room totals.
- Deposits and payment allocation.
- Cashier shift variance.
- Checkout and invoice snapshot.
- Void/refund/reversal behaviour.
- Every role’s forbidden/allowed routes and functions.
- Housekeeping/maintenance room-sale lock.
- Reservation overlap and room move/extension rules.

### Operational readiness

- Production domain, HTTPS, correct Auth URL configuration, production email sender, and tested invitation flow.
- MFA for sensitive roles.
- Daily database backup, retention policy, and one successful restore drill.
- Error monitoring and alerting for failed Edge Functions, failed cron jobs, and database errors.
- Written SOPs for check-in, payment receipt, cashier close, night audit, room block, refund, and outage fallback.
- Staff training using a training database, not production.
- Pilot for at least two full business weeks with owner/GM daily reconciliation.

### Go-live gate

Do not go live until all of these are true:

- Cash reconciliation balances for the pilot period.
- Every test role passes the permissions matrix.
- A full night audit and next-morning review succeeds repeatedly.
- Printed receipts/invoices are reviewed and approved by management/accountant.
- The accountant approves tax and statutory document treatment.
- Backup restore is proven.
- The hotel has named owners for daily night audit, cash close, housekeeping release, and maintenance closure.

## 14. Work that must not be skipped

- Accountant review of tax, invoice, deposit, cancellation, and refund policy.
- Cashier shift and reconciliation controls.
- Housekeeping room status.
- Database-level permission tests.
- Backup/restore test.
- Training and written procedures.

Skipping any of these does not make the system faster to launch. It makes the launch less controllable.

## Latest implementation checkpoint — 3 October 2026

- Migration `20261003190000_business_receivable_settlement.sql` adds controlled partial/full settlement of approved company receivables through the main payment ledger.
- Accountant and Owner can record company settlement; configured transfer methods remain pending until an authorised finance reviewer verifies or rejects them with a note.
- The database prevents settlement above the remaining balance, including other pending payments.
- A receipt is issued only for a completed or verified payment. Receivable status and ageing update from the net completed-payment balance.
- The Business accounts page now shows receivable actions plus company payment, verification, and receipt history. GM retains broad read/review access without receiving the Accountant's settlement-entry permission.
- Verification completed: local and linked database lint (one pre-existing `next_document_number` unused-parameter warning only), TypeScript, ESLint, production build, 37 automated tests, and an authenticated browser smoke check.
- Migration `20261003200000_business_receivable_reports.sql` adds read-only current/1–30/31–60/61–90/90+ debtor ageing and chronological company statements with running balances and safe CSV exports.
- Report verification completed: local database lint, TypeScript, ESLint, production build, 38 automated tests, deployment to the linked development project, and an authenticated browser smoke check.

## Company credit-note checkpoint — 7 October 2026

- Migration `20261007100000_company_credit_notes.sql` adds separately numbered, append-only company credit notes and company payment refunds behind the existing independent GM/Owner approval queue. The original closed invoice and guest folio remain unchanged.
- Company balances, ageing, statements, and the Business accounts UI now distinguish outstanding debt from a paid company credit. Refunds are limited by both the live credit and the original payment; cash payouts require an open shift, and non-cash payouts require a reference.
- TypeScript, ESLint, production build, 39 automated tests, and local Supabase lint passed; lint reports only the known `next_document_number` unused-parameter warning. The migration applied to local and linked development projects. Read-only catalogue checks confirmed function grants and RLS. A rollback-only local end-to-end test passed for independent credit-note approval, credit-balance calculation, Accountant refund request, Owner refund execution, settled status, refund ledger entry, and unchanged invoice snapshot; all fixture records were rolled back. The linked development project has no company receivables, so a real-data UI click-through remains outstanding. Have the accountant approve statutory credit-note/tax presentation before client handover.
