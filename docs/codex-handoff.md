# Mahogany Hotel: Coding Agent Handoff

**Date:** 2026-10-12
**Project:** Mahogany Hotel Management System
**Workspace:** `C:\Users\BKM\Desktop\mahogany-hotel`

## Current Position

The project is an operational hotel-management MVP. The foundation, authentication, room management, reservations, stays, folios, nightly posting, settlement workflows, staff invitation, role-aware navigation, cashier shifts, reservation deposits, controlled room-turnover housekeeping, maintenance, daily close, core management/finance reporting, and a foundational automated regression suite exist. Restaurant/Bar POS and an initial inventory quantity register are deployed to the linked development project. Broader inventory purchasing/count workflows, reporting, full database/browser integration testing, and production readiness are not complete.

The approved operating baseline is documented in `docs/step-0-operating-rules.md`. It establishes Africa/Lagos timezone, NGN/kobo storage, 02:00 business-day cutoff, nightly room posting, 7.5% VAT, 5% Oyo tax, append-only financial records, audit requirements, and deferred hotel/accountant decisions.

## Implemented Application Work

### Environment and foundation

- Vite React TypeScript project is configured.
- Tailwind, React Router, TanStack Query, Supabase JS, React Hook Form, Zod, Lucide, and Recharts dependencies are installed.
- ESLint, TypeScript checking, and production build scripts pass.
- `.env.example` uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
- The Supabase client reads `VITE_SUPABASE_PUBLISHABLE_KEY`, with a legacy `VITE_SUPABASE_ANON_KEY` fallback for existing local setups. Only a public browser key belongs in `.env`.
- A stale Vite process previously caused port conflicts. Use one dev server on `http://localhost:5175/`.

### Authentication and shell

- Sign-in, session restoration, sign-out, protected routes, setup state, and inactive-account state exist.
- Responsive application shell and navigation exist.
- A role-filtered, searchable Help panel is available from the app header. Initial guides cover reservations, check-in, occupant lookup, guest payments, checkout, night audit, inventory, Restaurant/Bar POS, and finance reports. It is a static guide-only feature: it does not use AI, access guest/financial records, or perform operations. Policies that remain unconfirmed are explicitly escalated to the GM/Owner.
- The Owner/GM dashboard has live room and financial cards, a business-day operational summary, and a management-attention panel for failed audit runs, open cashier shifts, pending payment verification, unsettled folios, dirty rooms, high-priority maintenance, and maintenance outages. Broader trends and future-revenue charts remain incomplete.
- Staff invitations, password creation, profile/password change, permission-aware navigation, URL guards, and Owner/GM staff administration exist.

### Guests

- Guest creation exists through an audited RPC.
- Guest management migration adds audited edit, deactivate, merge, and anonymise operations.
- Guest records are retained instead of hard deleted.
- Guest management actions require `guests.manage` and are available to owner, general manager, and staff admin roles.
- Guest actions use the shared in-app modal, not browser prompts.

### Rooms and room types

- Room types and rooms have database tables, RLS read policies, room-board view, and derived statuses: available, reserved, occupied, dirty, blocked.
- Management RPCs support create/edit and block/unblock with audit logging.
- Room deactivation is represented by `active = false`; hard deletion is intentionally not supported.
- Room-type capacity is displayed as persons.
- Room types now support optional `size_sqft`, shown in room setup and the room board.
- Room-specific rate overrides are supported.
- The most recent room-size migration preserves the existing `room_board` view column order. This avoids PostgreSQL error `42P16`.
- Checkout atomically marks the room dirty and creates one open turnover task. Owner, General Manager, and Reception can complete it with an auditable clean action. Database check-in guards reject dirty rooms even if a caller bypasses the UI.
- Owner and GM can use a separate, reason-required management override when they personally confirm a dirty room is ready. It completes the open turnover task and logs the exception; a maintenance-controlled room cannot use this override.
- Maintenance tickets can be reported by Reception, GM, or Owner. GM and Owner can progress, resolve, take a room out of service, and formally return it to service. A generic room unblock cannot release a maintenance-controlled room.
- Owner, GM, and Reception can move an active in-house guest to a clean, unblocked, unoccupied room with no reservation conflict for the remaining stay. The original stay, folio, and active rate are preserved; the source room becomes dirty, receives a housekeeping task, and the move is stored in append-only history with its reason and actor.

### Reservations

- Reservation creation stores agreed rate snapshots and uses database overlap protection.
- Date-aware availability search was added.
- Reservation amend, cancel, and no-show workflows require reasons and audit logs.
- Reservation search by reference, guest, or room exists.
- Reservation creation now shows the room standard nightly price, discount selector, and calculated final nightly rate.
- Reception reservation discounts up to and including 20% are permitted. A 25% or 30% choice atomically creates the reservation at its standard rate plus an immutable approval request; the requested rate is applied only after independent GM/Owner approval and execution.
- The reservation create button is intentionally compact and content-width.
- Check-in is blocked while an exceptional reservation discount is pending or approved but not executed. Direct reservation writes and same-day walk-ins cannot bypass the above-20% control; deeper walk-in discounts must be prepared as a reservation before check-in.

### Stays, folios, and night audit

- Reservation check-in creates a stay, first rate period, and open folio.
- Walk-in check-in creates guest, stay, rate period, and folio atomically through an RPC.
- Walk-in modal displays each available room's standard nightly price.
- Walk-in modal lets reception choose 0%, 5%, 10%, or 15% discount and calculates the final nightly rate.
- The shared modal component is viewport-constrained and scrollable.
- Night audit posts room nights idempotently using `(stay_id, service_date)` uniqueness.
- Night audit can only post the hotel’s current business date; the interface no longer accepts an arbitrary posting date.
- The scheduled unattended room-posting job is replaced by a recorded approval gate: Accountant/Owner/GM approves the current business date, then a different authorized Reception/GM/Owner user runs it. The approver cannot execute the same date. Nightly room posting remains idempotent; the separate Owner/GM business-day close remains a distinct step.
- The folios page shows current exceptions and approval/execution identities. Open shifts, pending verification, and posting failures remain visible; existing business-day-close blockers/acknowledgements still apply.
- Owner and GM dashboards include a read-only business-day summary: remaining and completed arrivals/departures, in-house stays, posted room charges, and the current night-audit result. The general finance card uses business-date net collections rather than the browser's calendar date.
- Folio detail displays base, tax, and total lines.
- Future mid-stay rate changes use rate periods and do not alter posted nights.
- Only owner and general manager have `stays.rate_change`; the latest approval migration replaces the earlier RPC permission check.
- Checkout posts missed eligible nights before settlement.
- Early checkout policy is not fully configured; hotel policy must define early-departure charges/refunds.
- Controlled stay extension is implemented. Owner, GM, and Reception can extend an active stay only when its current room has no conflicting reservation. Reception continues the existing rate; Owner/GM may approve a different rate that starts on the original checkout date, without altering posted nights. Each extension has immutable history, a required reason, and audit evidence.
- Automatic Supabase Cron setup is documented but may not yet be configured in the project.

### Payments and checkout

- Payments, payment allocations, receipts, balance calculation, and checkout RPCs exist.
- Cash folio payments and cash reservation deposits require an open personal cashier shift for every recipient, including Owner and GM. Cash refunds are assigned to the open shift of the person paying them out, rather than changing an already closed original shift.
- Bank-transfer payment methods require finance verification. Pending transfers do not reduce folio balances, support checkout, receive official receipts, or become usable reservation deposits. Owner, GM, and Accountant can verify or reject them with an audit note.
- Cashier shift closure now requires a safe-bag or bank-deposit handover reference. Owner and GM can independently review a closed shift; neither its opener nor closer can perform that review. Accountant can view the control log but cannot approve it.
- Owner and GM can administer methods used for future collections from Finance. Method changes are audited; a method used by a payment cannot be renamed, and cash cannot be configured to require verification.
- Voids, refunds, folio adjustments, and charge reversals now require an immutable correction request followed by an independent Owner/GM approval and execution. Accountants and cashiers can view only their own requests; direct correction RPC execution is revoked.
- Owner, GM, and Accountant have a read-only daily payment-method reconciliation that separates settled, pending-verification, refunded, voided, and net-collected amounts using the hotel business date.
- Owner, GM, and Accountant have a searchable 90-business-day finance approval register showing correction status, linked document, amount, reason, requester, approver, executor, decision note, and timestamps. Accountant access is report-only and does not grant approval or execution authority.
- Owner, GM, and Accountant have a current deposit and guest-credit liability report. It separates held deposits, pending verification claims, unresolved cancelled/no-show deposits, and genuine folio credit balances. Unresolved deposits are flagged rather than automatically refunded or forfeited while that policy remains unconfirmed.
- Checkout requires a zero folio balance and creates a receipt record.
- A selected folio payment now opens a printable receipt document with hotel, guest, room, payment, reference, void, and refund context. Printing is isolated to a receipt-only frame, so the payment-history screen is not included. Pending payments explicitly show that a receipt follows verification; an unexpected missing receipt is shown as an exception rather than a dash.
- Receipt presentation and print/download still need management print-layout review. Correction requests, Owner/GM approval and execution controls, the approval register, daily revenue/tax reporting, and deposit-liability reporting are implemented.

## Migration Order

Apply these in Supabase SQL Editor in this order. Do not rerun already-applied migrations blindly. If a duplicate type/table error occurs, verify what is already present first.

1. `supabase/migrations/20260920223000_foundation.sql`
2. `supabase/migrations/20260921090000_reception_core.sql`
3. `supabase/seed.sql` for development only
4. `supabase/migrations/20260921120000_payments_checkout.sql`
5. `supabase/migrations/20260921133000_guest_management.sql`
6. `supabase/migrations/20260921143000_room_management.sql`
7. `supabase/migrations/20260921160000_reservation_workflows.sql`
8. `supabase/migrations/20260921170000_walk_in_stays.sql`
9. `supabase/migrations/20260922100000_stay_rate_and_folio_detail.sql`
10. `supabase/migrations/20260922110000_rate_change_approval.sql`
11. `supabase/migrations/20260922120000_room_size_persons.sql`
12. `supabase/migrations/20260922130000_hotel_role_provisioning.sql`
13. `supabase/migrations/20260922140000_rate_period_integrity.sql`
14. `supabase/migrations/20260922150000_payment_document_integrity.sql`
15. `supabase/migrations/20260922160000_room_type_occupancy_summary.sql`
16. `supabase/migrations/20260922170000_tax_inclusive_room_rates.sql`
17. `supabase/migrations/20260922180000_room_block_reason_board.sql`
18. `supabase/migrations/20260922190000_financial_corrections.sql`
19. `supabase/migrations/20260922200000_missing_payment_receipts.sql`
20. `supabase/migrations/20260922210000_staff_access_management.sql`
21. `supabase/migrations/20260922220000_staff_reassignment.sql`
22. `supabase/migrations/20260922230000_staff_management_owner_gm_only.sql`
23. `supabase/migrations/20260922240000_retire_legacy_staff_admin_role.sql`
24. `supabase/migrations/20260922250000_revoke_anonymous_security_definer_execution.sql`
25. `supabase/migrations/20260922260000_reception_folio_payment_scope.sql`
26. `supabase/migrations/20260922270000_cashier_shifts.sql`
27. `supabase/migrations/20260922280000_cashier_shift_audit_corrections.sql`
28. `supabase/migrations/20260922290000_reservation_deposits.sql`
29. `supabase/migrations/20260922300000_reservation_deposit_history.sql`
30. `supabase/migrations/20260922310000_room_turnover_housekeeping.sql`
31. `supabase/migrations/20260922320000_reservation_deposit_function_fix.sql`
32. `supabase/migrations/20260922330000_walk_in_turnover_lint_cleanup.sql`
33. `supabase/migrations/20260922340000_room_maintenance_tickets.sql`
34. `supabase/migrations/20260922350000_maintenance_out_of_service.sql`
35. `supabase/migrations/20260922360000_operational_control_audit_fixes.sql`
36. `supabase/migrations/20260922370000_manager_turnover_override_and_api_refresh.sql`
37. `supabase/migrations/20260922380000_cash_refund_shift_accountability.sql`
38. `supabase/migrations/20260922390000_incoming_cash_shift_accountability.sql`
39. `supabase/migrations/20260922400000_payment_verification_status.sql`
40. `supabase/migrations/20260922410000_payment_verification_workflow.sql`
41. `supabase/migrations/20260922420000_payment_verification_enum_cast_fix.sql`
42. `supabase/migrations/20260922430000_cashier_shift_handover_review.sql`
43. `supabase/migrations/20260922440000_payment_method_administration.sql`
44. `supabase/migrations/20260922450000_finance_approval_workflow.sql`
45. `supabase/migrations/20260922460000_daily_payment_reconciliation.sql`
46. `supabase/migrations/20260922470000_daily_payment_reconciliation_return_fix.sql`
47. `supabase/migrations/20260922480000_current_business_date_night_audit.sql`
48. `supabase/migrations/20260922490000_night_audit_exception_check.sql`
49. `supabase/migrations/20260922500000_daily_operational_summary.sql`
50. `supabase/migrations/20260922510000_receipt_document_details.sql`
51. `supabase/migrations/20260922520000_finance_approval_register.sql`
52. `supabase/migrations/20260922530000_daily_revenue_tax_report.sql`
53. `supabase/migrations/20260922540000_deposit_guest_credit_liability_report.sql`
54. `supabase/migrations/20260922550000_reservation_discount_approval.sql`
55. `supabase/migrations/20260922560000_discount_approval_register_details.sql`
56. `supabase/migrations/20260922570000_executed_discount_amendment_guard.sql`
57. `supabase/migrations/20260922580000_in_house_occupant_board.sql`
58. `supabase/migrations/20260922590000_overstay_night_audit_catchup.sql`
59. `supabase/migrations/20260922600000_overstay_checkout.sql`
60. `supabase/migrations/20260922610000_departure_checkout_workflow.sql`
61. `supabase/migrations/20260922620000_prepare_departure_folio.sql`
62. `supabase/migrations/20260922630000_receptionist_checkout_preparation.sql`
63. `supabase/migrations/20260922640000_business_day_close.sql`
64. `supabase/migrations/20260922650000_daily_close_report.sql`
65. `supabase/migrations/20260922660000_daily_close_report_hotel_state_fix.sql`
66. `supabase/migrations/20260922670000_scheduled_night_audit.sql`
67. `supabase/migrations/20260922680000_searchable_audit_register.sql`
68. `supabase/migrations/20260922690000_audit_log_write_lockdown.sql`
69. `supabase/migrations/20260922700000_management_dashboard.sql`
70. `supabase/migrations/20260922710000_management_cash_variance_attention.sql`
71. `supabase/migrations/20260922720000_reservation_guest_details_and_capacity.sql`
72. `supabase/migrations/20260922730000_business_date_close_advancement.sql`
73. `supabase/migrations/20261001100000_controlled_room_moves.sql`
74. `supabase/migrations/20261003100000_controlled_stay_extensions.sql`
75. `supabase/migrations/20261003110000_stay_lifecycle_policy_settings.sql`
76. `supabase/migrations/20261003120000_enforce_stay_lifecycle_policy.sql`
77. `supabase/migrations/20261003130000_stay_arrival_departure_timestamps.sql`
78. `supabase/migrations/20261003140000_general_manager_settings_permission.sql`
79. `supabase/migrations/20261003150000_business_account_register.sql`
80. `supabase/migrations/20261003160000_reservation_business_account_authorization.sql`
81. `supabase/migrations/20261003170000_business_account_reservation_directory.sql`
82. `supabase/migrations/20261003180000_direct_bill_receivables.sql`
83. `supabase/migrations/20261003190000_business_receivable_settlement.sql`
84. `supabase/migrations/20261003200000_business_receivable_reports.sql`
85. `supabase/migrations/20261007100000_company_credit_notes.sql`
86. `supabase/migrations/20261007110000_reservation_cancellation_policy.sql`
87. `supabase/migrations/20261007120000_front_desk_arrival_attention.sql`
88. `supabase/migrations/20261007130000_guest_arrival_email.sql`
89. `supabase/migrations/20261012100000_hotel_operational_realtime.sql`
90. `supabase/migrations/20261012110000_expand_operational_realtime.sql`
91. `supabase/migrations/20261012120000_shared_pos_catalog.sql`
92. `supabase/migrations/20261012130000_approval_gated_night_audit.sql`
93. `supabase/migrations/20261012140000_pos_catalog_maintenance_controls.sql`
94. `supabase/migrations/20261012150000_pos_modifier_assignment_soft_retirement.sql`
95. `supabase/migrations/20261012160000_restaurant_pos_sales.sql`
96. `supabase/migrations/20261012170000_restaurant_pos_receipt_reference_clarity.sql`
97. `supabase/migrations/20261012180000_bar_pos_access_scope.sql`
98. `supabase/migrations/20261012190000_operating_expense_register.sql`
99. `supabase/migrations/20261012200000_expense_summary_by_incurred_date.sql`
100. `supabase/migrations/20261012210000_pos_order_modifiers.sql`
101. `supabase/migrations/20261012220000_pos_payment_refunds.sql`
102. `supabase/migrations/20261012230000_pos_refund_expiry_and_report_grouping.sql`
103. `supabase/migrations/20261012240000_pos_refund_summary_ordering_fix.sql`
104. `supabase/migrations/20261012250000_pos_paid_order_line_corrections.sql`
105. `supabase/migrations/20261012260000_pos_correction_operator_request.sql`
106. `supabase/migrations/20261012270000_internal_collection_expense_summary.sql`
107. `supabase/migrations/20261012280000_inventory_suppliers_stock_ledger.sql`
108. `supabase/migrations/20261012290000_inventory_item_validation_lock.sql`
109. `supabase/migrations/20261012300000_inventory_movement_lint_cleanup.sql`
70. `supabase/migrations/20260922710000_management_cash_variance_attention.sql`
71. `supabase/migrations/20260922720000_reservation_guest_details_and_capacity.sql`
72. `supabase/migrations/20260922730000_business_date_close_advancement.sql`
73. `supabase/migrations/20261001100000_controlled_room_moves.sql`
74. `supabase/migrations/20261003100000_controlled_stay_extensions.sql`
75. `supabase/migrations/20261003110000_stay_lifecycle_policy_settings.sql`
76. `supabase/migrations/20261003120000_enforce_stay_lifecycle_policy.sql`
77. `supabase/migrations/20261003130000_stay_arrival_departure_timestamps.sql`
78. `supabase/migrations/20261003140000_general_manager_settings_permission.sql`
79. `supabase/migrations/20261003150000_business_account_register.sql`
80. `supabase/migrations/20261003160000_reservation_business_account_authorization.sql`
81. `supabase/migrations/20261003170000_business_account_reservation_directory.sql`
82. `supabase/migrations/20261003180000_direct_bill_receivables.sql`
83. `supabase/migrations/20261003190000_business_receivable_settlement.sql`
84. `supabase/migrations/20261003200000_business_receivable_reports.sql`
85. `supabase/migrations/20261007100000_company_credit_notes.sql`

The room-size migration originally failed because `CREATE OR REPLACE VIEW` attempted to insert `size_sqft` before existing `current_rate_kobo`. It has been corrected by keeping the existing columns in their original order and appending `size_sqft` and `capacity` at the end.

After seeding and creating the Auth user, assign the development owner role with the idempotent SQL documented in `supabase/README.md`. Never place a service-role key in the frontend.

## Important Database Caveats

- `supabase/config.toml` exists and the local CLI is linked to the remote Supabase project. Remote migration history was repaired and verified on 2026-09-23.
- Application-owned `SECURITY DEFINER` functions are not executable by `anon`; staff workflow functions are explicitly granted only to `authenticated` and enforce internal role checks.
- Later migrations assume earlier tables, functions, seeded roles, and permissions exist.
- The room-size migration replaces `public.room_board`; rerun the corrected full migration if the earlier attempt failed as one transaction. If the `size_sqft` column was created but view replacement failed, the corrected script is still safe because it uses `add column if not exists`.
- The migration adding new `create_room_type` and `update_room_type` signatures does not remove the older function signatures. The frontend uses the new signatures.
- The room-board uses the hotel-local business date for reservation status. Room turnover is a separate clean/dirty state and is deliberately visible as `dirty` ahead of a same-day reservation.
- The current tax implementation displays the configured 7.5% VAT and 5% Oyo tax as separate snapshot amounts, but invoice/receipt presentation remains incomplete.
- The Supabase publishable key is public by design. Do not copy actual `.env` values into this handoff document.

## Validation

The following checks have repeatedly passed after the recent frontend changes:

```text
npm test
npm run typecheck
npm run lint
npm run build
```

The Vitest suite currently runs 81 passing tests covering money conversion/formatting, the role-to-feature access matrix, development-seed safety, dashboard cache invalidation, sign-in accessibility, and static regression contracts for critical migration invariants, including POS refund and approved paid-line correction boundaries. These SQL contract tests protect against accidental removal of controls, but they do not replace executing the workflows against a disposable database.

On 2026-10-03, `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` passed. Supabase database lint passed with only the known pre-existing unused `target_hotel_id` warning in `next_document_number`. Rollback-only live database tests passed for controlled room moves and stay extensions, including housekeeping/audit evidence, availability protection, preserved historical rates, and future-only extension pricing. Both tests confirmed that zero fixture stays persisted after rollback.

A focused permission audit found that the development seed created `settings.manage` after the original GM role-provisioning migration and did not assign it to the seeded GM. Migration `20261003140000` corrects existing hotels and future hotel provisioning, and `supabase/seed.sql` now assigns the permission during clean resets. The database catalogue confirms GM has both `settings.read` and `settings.manage`, authenticated users have SELECT-only access to room-move/extension history, and `anon`/`PUBLIC` have no execution grant on the sensitive workflow RPCs.

Corporate and agency account administration has a controlled foundation. Migration `20261003150000` adds an RLS-protected, append-only-audited business-account register with approved credit limits, payment terms, contacts, billing instructions, lifecycle status, and an explicit direct-billing flag. Owner/GM can create and maintain accounts; Accountant has read/report access plus the narrow settlement-entry permission. The `/business-accounts` UI follows the same boundaries.

Reservations can be linked to active business accounts through immutable authorisation records. Reference-only links remain guest-payable; Owner/GM alone can reserve direct-bill credit. The database validates hotel ownership, reservation state, account status, direct-billing approval, expected room value, and live available credit before accepting an authorisation. Reception receives only a narrow active-account directory and cannot approve company credit.

Approved direct billing now converts the prepared guest-folio balance into a distinct company receivable instead of creating a fake payment. The transfer is idempotent, cannot exceed the approved reservation credit, settles the guest folio for checkout, and is snapshotted into the final invoice in the same transaction. Accountant/Owner can record partial or full company settlement through the main payment ledger; verification-gated payments require an authorised review before a receipt is issued. Owner/GM/Accountant can review and export debtor ageing and chronological company statements with running balances. A closed company invoice can now receive a separately numbered, independently approved credit note without rewriting the original invoice or folio. A resulting paid company credit can be refunded only by a second approved request, bounded by the live credit and original payment. Cash payout requires an open shift; non-cash payout requires a reference.

On 2026-10-07, the company-credit migration was applied to both local Supabase and the linked development project. Read-only catalogue checks confirmed four new RPCs, SELECT-only authenticated access and RLS on credit notes/refunds, and no direct authenticated/anonymous execution of the internal issue/refund functions. A local rollback-only end-to-end transaction passed: an Owner requested a credit note, an independent GM approved and executed it, the balance became a credit, an Accountant requested a refund, the Owner executed it, the receivable settled, and the original invoice snapshot remained unchanged. All test users and transaction rows rolled back. Local Supabase lint passed with only the known pre-existing unused `target_hotel_id` warning in `next_document_number`. There are no company receivables in the linked development database, so a real-data UI click-through is still outstanding. Credit-note tax presentation and legal compliance require the hotel's accountant's approval.

The production build reports a non-blocking large JavaScript chunk warning. The credit-note/refund database path has a successful rollback-only local transaction test; broader cross-feature database coverage and authenticated browser end-to-end tests remain for staging or local fixtures.

## Mandatory Client-Handover Checkpoint

Before Mahogany Hotel is handed to the client or any real hotel operational data is entered, the developer must move from the current single development project to a paid Supabase plan with a separate staging project. Re-run the complete migration history and finance acceptance tests in staging before each production database deployment. Do not treat the current development project as client production.

## Next Recommended Work

### Immediate

1. Test checkout → dirty room → Mark clean → check-in with real staff accounts in the browser.
2. Browser-test a Reception room move and stay extension, verifying the old room enters housekeeping, a conflicting future reservation blocks extension, and folio/history remain intact.
3. Continue the authenticated role-by-role browser acceptance matrix, then implement configurable early check-in, late checkout, and early-departure policies.

### Next product slice: finish night audit and daily close

- Business-day close now hard-blocks open cashier shifts, pending payment verification, and incomplete posting. Overdue departures and unsettled folios require a reasoned Owner/GM acknowledgement tied to the current count.
- Final close is Owner/GM-only, creates an immutable numbered `DAC` record, and has no reopen function. The development project received migration `20260922640000` on 2026-09-27.
- The full daily-close report now previews the open day and stores an immutable numbered snapshot at close, with operational counts, revenue/tax, payments, cashier shifts, corrections, liabilities, outstanding folios, and exception acknowledgements.
- The previously active five-minute scheduled posting dispatcher is unscheduled by migration `20261012130000`; the hosted project must confirm that the job is absent after deployment. Night audit now requires recorded approval and a separate staff executor. Cron history cleanup remains unrelated and is not removed.
- Owner, GM, and Accountant now have a read-only audit register with hotel-local date filtering, free-text evidence search, exact action/entity filters, amount ranges, server-side pagination, and visible-row CSV export. Both the route and database RPC independently enforce access. Direct authenticated inserts into `activity_logs` are revoked, so browser users cannot fabricate audit evidence; controlled workflow functions remain the only writers.
- The Owner/GM dashboard now uses business-date management RPCs rather than summing arbitrary open-folio history. It separates earned revenue, net collections, deposits held, outstanding folios, guest credits, and future booked room value; shows a seven-day revenue/collection and occupancy trend; surfaces refunds, voids, discounts, cash variance, arrivals, departures, and no-shows; and links action figures to their supporting workflows. Cash variance attention totals absolute discrepancies so shortages and overages cannot cancel each other.
- A clean local reset now seeds three room types, eight rooms, five fictional guests, five business-date-relative reservation scenarios, and an open maintenance ticket. Fixtures use reserved UUIDs, `DEMO-` document numbers, and `.test` emails; they create no Auth users or role assignments. The setup guide now correctly requires every migration to run before the seed.
- Reservation and walk-in check-ins now invalidate every affected dashboard dataset, including management position, seven-day trend, business-day summary, occupant/departure attention, and daily-close state. Returning to the dashboard no longer requires a full browser reload to show the completed check-in.
- Docker Desktop and the project-local Supabase CLI are configured. A clean local startup successfully replayed all migrations and the seed on 2026-09-28. The replay exposed and removed an invalid reference to the cloud-only `public.rls_auto_enable()` helper from migration `20260922280000`; local database lint now passes with only the known unused `target_hotel_id` warning in `next_document_number`. The current git-ignored `.env.local` points Vite at the hosted development Supabase project (not the local API); check this before any browser workflow that could write data. Use the `supabase:start`, `supabase:stop`, `supabase:reset`, `supabase:status`, and `supabase:lint` npm scripts for local work.
- Complete management print-layout review of receipts, including void/refund status.
- Controlled in-house room moves are implemented. They preserve the stay, folio, and current rate; reject unsuitable destinations; mark the old room dirty; create a new turnover task; record append-only move history; and invalidate all affected operational dashboards after success.
- Owner/GM now have an audited Stay policy page for standard arrival/departure times and conservative exception handling. New stay activity captures exact arrival/departure timestamps; same-day early check-in and late checkout, early-departure review, and extra-night approval are enforced at the database layer. Historical rows are not assigned invented timestamps. The system deliberately creates no automatic fees until management and the accountant approve exact monetary rules.

### Remaining roadmap

- 2026-10-13 local rollback-only room-turnover integration test passed: checkout closed the stay, created its invoice, marked the room dirty, and opened one turnover task; housekeeping completion recorded the actor and changed the room to clean; a subsequent walk-in check-in succeeded and the completed turnover history remained. The test transaction rolled back and its post-rollback assertions confirmed the Auth user, stay, guest, and invoice fixtures were absent. The room-move and stay-extension rollback-only integration tests were also rerun and passed, including rate/history preservation and audit checks; each reported zero persisted test stays after rollback. The full Vitest suite passed (19 files, 109 tests). A 2026-10-13 authenticated Reception browser review confirmed the room board, occupant details, and room-move/stay-extension forms are accessible; both forms were canceled without submitting. Since `.env.local` points at hosted development and no occupant/stay was identified as a disposable test fixture, no guest or room state was changed. The write-through browser acceptance remains outstanding pending an explicitly designated test stay/room; local database tests cover successful transitions and rollback.
- 2026-10-13 browser acceptance: the authenticated GM reviewed `/expenses` and `/inventory`; inventory access, stock overview, movement history, supplier directory, and the transfer form's distinct source/destination controls loaded. The inventory item, movement, and supplier registers were empty, so no live stock movement could be tested; no inventory records were submitted or changed. The already-configured 6393 Restaurant and Bar outlets were then used for explicitly authorized, clearly labeled ₦100 development POS sales. Restaurant and Bar each received a separate internal `POSR` acknowledgement and their own reconciled cash shift; `/internal-balancing` showed ₦100 in each outlet and ₦0 hotel collections. Persistent test references: bar `POSR-20261013-0000043` / order `FBO-20261013-0000040`; restaurant `POSR-20261013-0000047` / order `FBO-20261013-0000044`. Test catalog entries and transactions remain in the hosted development project and were not deleted or reversed. Outlet labels and business-day summary scoping were corrected and verified in the local GM browser. Actual print preview remains unverified because the in-app browser did not expose it. No tax/statutory receipt behavior was tested or inferred.
- Additional owner dashboard forecasting beyond the completed seven-day management position
- Corporate/agency credit notes and post-settlement correction handling (register, reservation authorisation, live exposure, checkout transfer, invoice snapshot, settlement, ageing, downloadable statements, and collection history are complete)
- Remaining accountant reports (daily revenue/tax, finance approvals, and deposit/guest-credit liabilities are complete)
- Realtime operational updates: publication migrations are deployed to linked development, including reservation deposits and finance approvals. Subscription/debounce coverage passes locally, and folio/deposit history query keys include hotel scope. Authenticated two-session browser verification remains before this item is complete.
- Shared POS foundation and restaurant/bar sales workflows are implemented and their migrations are deployed to linked development (`20261012120000` through `20261012180000`). GM/Owner catalog setup supports reason-required audited edits/soft retirement (`20261012140000`, `20261012150000`). Restaurant and bar orders, tender rows, internal `POSR` acknowledgements, separate outlet cash shifts, transfer verification, and business-date summaries use outlet-type-scoped RLS and RPC checks. Restaurant staff can access restaurant outlets only; bar staff can access bar outlets only; Accountant can review both; Owner/GM retain broad POS access. These ledgers create no hotel payment, folio allocation, hotel receipt, tax calculation, or combined-payment behavior. Use the accountant-approved “6393” POS/tax process until exact tax and reconciliation rules are confirmed. Modifier selection and immutable option/price snapshots are implemented in `20261012210000_pos_order_modifiers.sql`. POS refunds use independent finance approval and append-only outlet-scoped refund records (`20261012220000`–`20261012240000`); they record an approved payout but do not send money, are reported on transaction business date, and reduce the executing cashier's cash shift. Paid POS line corrections are separately recorded, outlet-scoped, reasoned, and independent-approval-only (`20261012250000`–`20261012260000`). Original lines, payments, and acknowledgements remain unchanged; an increase reopens a due balance for collection, while a decrease creates customer credit and cannot itself trigger a payout. POS refund requests and execution are bounded by available order credit. Both correction migrations are applied locally and deployed to linked development; local/linked SQL lint and static tests pass. Read-only remote checks confirm outlet request scope, approval/report integration, and SELECT-only correction-table access. No transaction fixture was available for a full rollback-only workflow test; authenticated browser acceptance remains outstanding.
- Inventory first-slice migrations `20261012280000` and `20261012290000`, plus lint cleanup `20261012300000`, are applied to local Supabase and the linked development project. It provisions Main Store, Hotel Operations, Restaurant, and Bar stock locations; adds an item register, supplier contact register, Main Store reorder alerts, and reasoned append-only receipt/issue/transfer/waste movements. Owner, GM, and Storekeeper can access it; Accountant, Reception, Restaurant, and Bar staff cannot. It records quantities only—no costing, payables, tax, POS consumption, or payment interaction. Read-only linked checks confirmed four inventory tables with RLS enabled, four seeded locations, both permission records, and inventory read/manage permissions for GM and Storekeeper. A reorder level of zero now means alert when the item reaches zero; movement forms constrain location and supplier fields by movement type. A GM browser review confirmed the inventory page and all three sections load, the transfer form excludes its source from the destination choices, and its empty registers are correctly shown; no stock data was changed. On 2026-10-13, the local rollback-only database integration test passed Storekeeper item/supplier creation, stock receipt, transfer, issue, balance reconciliation, transfer-leg consistency, overdraw prevention, unit-integrity protection, and denial of inventory access to Accountant and Reception. The transaction rolled back and its post-rollback assertion confirmed no test fixtures persisted. A 2026-10-13 authenticated Storekeeper browser review confirmed `/inventory` loads; the sidebar exposes Dashboard, Inventory, and Profile; the Add item, Record stock movement, and Add supplier forms expose their expected fields and were closed without saving; the supplier and stock registers correctly display empty states. Direct navigation to `/expenses` displays “This area is not assigned to your role.” No browser console warnings/errors appeared and no inventory data was changed. Ask the hotel about receiving and physical-count approval procedures before building purchase orders, stock counts/variance approvals, costing, or POS integration.
- Operating expense register is implemented and migrations `20261012190000` and `20261012200000` are deployed to linked development. Accountant, GM, and Owner can view/submit already-paid expenses; GM/Owner can independently approve or reject with a required note (self-approval is blocked). The register retains evidence references and audit events and reports by Hotel/Restaurant/Bar and incurred date. It does not send payments, create journal entries, calculate tax, touch hotel payments/folios, or automatically deduct expenses from collections. Supporting documents are referenced, not uploaded. On 2026-10-13, a read-only GM browser review confirmed `/expenses` loads, displays separate Hotel/Restaurant/Bar totals and expense-review sections, and shows the correct empty state for the selected 2026-10-07–2026-10-13 range; no expense records were present. No expense was submitted or changed, and no browser console warnings/errors were recorded. Accountant/Owner view and transaction/approval click-through remain unverified.
- Internal balancing now has a read-only implementation in `20261012270000_internal_collection_expense_summary.sql` and `/internal-balancing`: completed hotel payments (including company-account settlements), restaurant/bar POS collections, their refunds, and recorded expenses are shown separately by Hotel/Restaurant/Bar. Expenses use incurred date as the agreed report basis; expense status is displayed transparently, and the report does not auto-net expense values against collections or call a difference profit. The migration is applied to local Supabase and deployed to the linked development project; the linked migration history was verified after deployment. Local SQL lint passed with only two previously existing warnings (`next_document_number` unused parameter and `add_restaurant_pos_order_item_with_modifiers` unused variable). TypeScript, targeted ESLint, all 84 tests, and the production build passed in the earlier validation run. Read-only browser checks as both Owner and Accountant loaded the report successfully. In the Accountant session, the range 2026-09-22 through 2026-10-12 showed ₦1,142,250 Hotel collections and ₦0 in Restaurant, Bar, and expense rows. An independent read-only linked-database aggregate over the same period matched exactly: 114,225,000 kobo Hotel collections, zero refunds/expenses, and zero Restaurant/Bar collections/refunds/expenses. The linked project has one active Accountant account, and its Accountant role has all required report permissions (`payments.read`, `expenses.read`, `pos.sales.read`). This turn's targeted Vitest rerun was blocked by Windows `spawn EPERM`, and local Postgres was not listening on port 54322. The accountant described the goal as internal balancing only; no inter-account transfer, tax consolidation, or statutory accounting behavior is authorized. In UI labels, prefer “collections/money received” for settled cash and “receivables” for amounts still owed.
- Staff/settings administration UI
- Additional management reports beyond the completed finance, daily-close, and searchable audit registers
- Expand automated coverage beyond the completed foundational unit/contract suite: database integration and authenticated browser end-to-end tests
- Accessibility, print QA, security review, backups, monitoring, and deployment

### 2026-10-14 browser acceptance update

- 2026-10-14 local rollback-only full stay lifecycle test passed (`tests/stay-lifecycle-rollback.sql`). It covered Reception reservation/check-in, Accountant approval plus separate Reception execution of one night audit, rejection of unpaid checkout without changing stay/folio, cashier collection with one receipt, shift close/handover and independent GM review, business-day close/date advance, Reception checkout/invoice, isolation from a second Reception user, and dirty-room turnover. The SQL transaction rolled back and post-rollback assertions found no temporary Auth users, guest, stay, reservation, shift, or payment/receipt fixture. This run exposed two authorization gaps and added migrations `20261014100000_reception_checkout_authorization_fix.sql` (internal checkout recognizes the controlled `departures.checkout` permission) and `20261014110000_departure_invoice_scoped_access.sql` (Reception can retrieve only the invoice issued by their own checkout; no broad invoice-read grant). Both passed local integration/contract tests and were deployed to linked Mahogany project `stccnkqljboazphdbkff` on 2026-10-14 after user confirmation that the target was safe; read-only migration history confirmed both versions applied. Full Vitest suite passed after the fixes (19 files, 112 tests).
- After that change, all ten local rollback-only SQL integration workflows passed together: checkout/turnover, inventory, night audit/daily close, operating-expense approvals, POS outlet separation, reservation workflow, role access, room moves, stay extensions, and the full stay lifecycle. Each workflow rolled back. This is local database regression evidence, not authenticated hosted-browser acceptance. Next verify Reception checkout against a disposable, fully paid hosted test stay: confirm checkout succeeds and displays the invoice to its issuer while another Reception user is denied; do not use a live guest stay or record a payment without explicit designation.
- Checkout-date availability was exercised in the authenticated Owner browser against the linked development project. A clearly labeled test reservation for Room 315 from 2026-10-15 to 2026-10-16 was accepted while the current QA stay was scheduled to check out on 2026-10-15. Attempting to extend that stay through 2026-10-16 was correctly blocked by the conflicting reservation. Only the test reservation (`RSV-20261014-0000050`) was then canceled and retained in history. The existing stay remained in Room 315 with its scheduled 2026-10-15 checkout.
- A follow-up attempt to exercise hosted checkout used the QA guest in Room 315 (`FOL-20261014-0000049`, scheduled checkout 2026-10-15). Opening checkout prepared the current room night and added a ₦95,500 charge; the checkout correctly remained blocked because the folio was unpaid. No payment was recorded and no checkout was completed. The QA stay remains in-house and its folio now has ₦95,500 due. Do not use this stay as a clean/paid test fixture without first resolving the folio through the approved process. The complete checkout → dirty → clean → re-check-in loop has already passed in the local rollback-only integration test; use that isolated test for further transition verification.
- Regression verification after this browser work: `npm test -- --run` passed (19 test files, 110 tests); the local Docker rollback-only `tests/checkout-room-turnover-rollback.sql` passed again and confirmed all fixtures were rolled back; `npm run build` passed. The production bundle still emits the existing >500 kB chunk-size advisory. The authenticated hosted checkout attempt is not a completed checkout acceptance test; payment/receipt behavior and the actual browser turnover loop remain unverified.
- 2026-10-14 local rollback-only reservation lifecycle integration test `tests/reservation-workflow-rollback.sql` passed. It verified availability before creation, creation, overlap rejection by both search and the create RPC, reasoned date amendment, cancellation with retained reason, three audit events, and date release after cancellation. The transaction rolled back and post-rollback assertions confirmed the temporary Auth user and reservation fixture were absent. Reservation role coverage in `tests/role-access-rollback.sql` also passed: GM and Reception can create through the guarded RPC; Accountant is denied; Accountant and Storekeeper lack reservation permissions. No hosted data was accessed or changed.
- 2026-10-14 local rollback-only `tests/stay-lifecycle-rollback.sql` and `tests/checkout-room-turnover-rollback.sql` passed. The former covered payment, one receipt, shift handover, daily close, and checkout; the latter covered checkout, housekeeping release, and next check-in. Both rolled back and verified no fixtures remained. Staff access deactivation/restoration now uses the shared in-app confirmation modal rather than a native browser confirmation; the dialog explains the access/history effect and blocks repeat clicks while saving. Role changes also require explicit confirmation, show old and new roles, explain that access changes immediately, and state the audit behavior. Added three staff-page contract tests. Full Vitest suite passed (20 files, 115 tests), type-check and focused ESLint passed, and production build passed with the existing large-chunk advisory. Hosted browser acceptance remains intentionally skipped; do not alter hosted guest/financial data without a designated disposable fixture.
- A read-only Reception review opened an existing payment receipt and verified the on-screen receipt fields and print control. The user-provided screenshot confirms the native Chromium print dialog opened and displayed a one-page receipt preview with Microsoft Print to PDF selected. The connected in-app browser automation could not surface that native dialog; this was a tooling visibility limitation, not a print failure. Removed the erroneous top-level-window print capability assumption; retained the isolated-frame capability fallback and its contract test. After the correction, type-check, focused ESLint, full build, and Vitest passed (21 files, 118 tests). The user has not confirmed printing/saving the PDF, and no payment or folio state was changed. The existing chunk-size advisory remains.
- Added and passed `tests/pos-refund-correction-rollback.sql` against local Docker Supabase. The rollback-only workflow verified a paid POS order line remains unchanged after a separately approved correction; adjusted order totals reconcile; an over-refund exceeding available customer credit is rejected; an Accountant-requested refund requires independent GM approval; the cash refund is attributed to the GM's outlet shift; the refund report reconciles collections/refunds/net; and hotel payment, allocation, receipt, and folio tables remain unchanged. The test transaction rolled back and post-rollback checks found no fixture users or outlet. Before the final over-refund assertion was added, all 11 local rollback-only SQL scripts passed together; the updated POS workflow then passed again separately. Full Vitest passes (21 files, 118 tests), with TypeScript check and focused ESLint passing. This is local integration evidence; POS refund/correction browser acceptance remains outstanding, and no hosted data was touched.

## Working Rules for the Next Agent

- Preserve the append-only financial model and audit every reversal, cancellation, discount, and approval.
- Use database RPCs for sensitive state transitions; do not add generic browser writes to protected financial tables.
- Keep all modal interactions inside the shared `src/components/shared/modal.tsx` component. Do not use `window.prompt`, `window.confirm`, or `alert`.
- Do not hard-delete guests, rooms, reservations, stays, folios, payments, or posted financial records.
- Use integer kobo for stored money and `formatNaira`/`nairaToKobo` for display and input conversion.
- Preserve historical rate snapshots. New rates must affect only future unposted nights.
- Before applying a new migration, verify its prerequisites and whether it was partially applied.
- Run typecheck and lint after focused changes, then build before handing work back.
