# Step 0 — Operating Rules Baseline

**Project:** Mahogany Hotel Management System  
**Location:** Jericho, Ibadan, Oyo State, Nigeria  
**Status:** Approved implementation baseline, subject to pre-go-live accountant review  
**Last reviewed:** 2026-09-20

This document defines the rules that later database migrations, application workflows,
reports, and receipts must implement. It deliberately contains no application code.

## 1. Localisation

| Setting | Baseline |
| --- | --- |
| Time zone | `Africa/Lagos` |
| Operating currency | Nigerian naira (`NGN`, symbol `₦`) |
| Money storage | Integer kobo; never floating-point values |
| Money display | Naira formatting in the UI and on printed documents |
| Date/time presentation | West Africa Time, using the hotel time zone |
| Business-day cut-off | 02:00 `Africa/Lagos`, configurable by an authorised manager |

All financial and operational records retain an actual timestamp. Records that affect
daily reports also retain the hotel business date derived from the configured cut-off.

## 2. Room revenue and nightly posting

1. Room revenue is recognised by nightly posting, not at reservation, check-in, payment,
   or checkout.
2. A check-in date of 20 September and a checkout date of 23 September has chargeable
   service dates of 20, 21, and 22 September. The checkout date is not a standard
   chargeable night.
3. A nightly post applies only to an active checked-in stay whose service date is within
   its actual stay dates.
4. Each room-night post creates, in one database transaction:
   - one immutable `room_night_posts` record;
   - one linked room-charge `folio_items` record; and
   - the applicable tax/service-charge snapshots.
5. A database unique constraint on `(stay_id, service_date)` prevents a night from being
   posted twice. The posting function must be idempotent and safe to retry.
6. If an eligible night was missed, checkout posts it before folio settlement.
7. A correction never edits or deletes a posted room-night charge. An authorised user
   creates a separate reversal or adjustment with a reason and audit record.
8. Reservation and stay rates are historical snapshots. A later room-price change does
   not modify booked or posted nights. An approved mid-stay rate change affects only
   later nights through an effective-dated stay-rate period.

## 3. Financial classification

| Measure | Definition |
| --- | --- |
| Posted room revenue | Active room-night charge base amounts for the reporting period; excludes collected taxes |
| Booked/future room revenue | Forecast of eligible, unposted reservation/stay nights; never recognised revenue |
| POS revenue | Finalised restaurant/bar sale base amounts, by department; excludes collected taxes |
| Payments received | Successful cash, POS, transfer, or other payment records; cash-flow, not revenue |
| Outstanding balance | Active folio charges less successful payments, refunds, credits, and authorised reversals |
| Tax liability | Tax collected from guests and awaiting remittance; never hotel revenue |
| Operational net | Posted revenue less recorded expenses; never labelled profit |

Payments remain independent records and are allocated to folios where appropriate. A
payment cannot alter a charge, and a charge cannot be marked paid by changing its amount.

## 4. Initial tax configuration

The tax engine must use effective-dated, database-managed rules. Rates, tax bases, and
price presentation must not be hard-coded in UI components.

| Rule | Initial configuration | Scope |
| --- | --- | --- |
| Federal VAT | 7.5%; included within advertised room rates | Taxable room accommodation and other configured supplies |
| Oyo Hotels Occupancy and Restaurant Consumption Tax | 5% of the consumer amount excluding VAT; included within advertised room rates | Room accommodation and applicable in-house services |
| Service charge | Disabled initially | May be enabled per department with an effective date |

For room accommodation, the guest-facing rate is tax-inclusive: an agreed nightly rate
of ₦180,000 posts a total charge of ₦180,000, never ₦180,000 plus tax. The invoice engine
must snapshot the rule identifier, rate, base, calculated amount, and tax treatment for
every posted room night, POS order item, folio item, and invoice line. Historical documents
are never recalculated after a configuration change.

The precise invoice-base treatment of an optional service charge must be confirmed by the
hotel's accountant before service charge is enabled. The system will support ordered tax
rules and explicit inclusion/exclusion of other charges from a tax base.

## 5. Audit, controls, and records

1. Posted financial records, invoices, payments, expenses, and inventory movements are
   append-only from an ordinary user perspective.
2. Void, refund, reversal, and adjustment operations require a reason, the actor, a
   timestamp, and a link to the original record.
3. Nightly-posting scheduler runs are recorded with business date, start/end time,
   outcome, count of posts, and error detail suitable for technical investigation.
4. Receipt and invoice numbers are generated by a database-scoped sequence and are not
   reused.
5. Receipts show hotel identity, date/time, sequential document number, line items,
   tax lines, total, payment method/reference where applicable, and staff member.
6. Card PANs, CVVs, PINs, and other sensitive payment credentials are never stored.

### Financial correction and discount approval policy

1. A refund, void, folio adjustment, or charge reversal requires a reasoned request and an independent General Manager approval before execution.
2. The requester cannot approve their own financial correction. Owner access remains available for exceptional governance and system recovery, but routine operational approval belongs to the General Manager.
3. Any discount above 20% requires General Manager approval. Owner exception authority remains available. The detailed request, evidence, and approval record must remain in the audit trail.
4. A paid restaurant/bar POS line is never edited in place. A reasoned amount correction is recorded separately and requires an independent General Manager approval. Increases become collectible POS balance; decreases create customer credit. A payout still requires the separate approved refund process, and cannot exceed available order credit.

## 6. Privacy and guest data

The system follows Nigeria Data Protection Act principles: collect only data necessary
for hotel operations or a documented legal obligation; limit staff access by role; keep a
retention policy; log sensitive access/actions; and protect identity documents in private
Storage with restrictive policies.

Initial guest fields are limited to name, phone, email where provided, address/ID fields
only where genuinely required, and operational notes. ID-document uploads are disabled by
default until the hotel adopts a lawful-purpose and retention policy for them.

## 7. Decisions deferred to hotel management/accountant

These are intentionally configurable and must be confirmed before production launch:

1. Standard check-in and checkout times.
2. Deposit percentage and whether it is required by booking source.
3. Cancellation, no-show, refund, and outstanding-balance policies.
4. Early check-in, late checkout, and extra-night charging rules.
5. Room rates are tax-inclusive, as confirmed by the hotel owner. The accountant must
   confirm the final statutory invoice presentation and tax remittance treatment.
6. Whether and where service charge applies.
7. Oyo State registration, remittance calendar, invoice layout, and statutory reporting
   treatment confirmed with the hotel accountant and Oyo State Internal Revenue Service.
8. Guest-information and identification-document retention periods.
9. The business-day close exceptions and acknowledgement policy, including treatment of open cashier shifts, pending transfers, and unsettled folios.

## 8. Sources reviewed

- Nigeria Tax Act 2025: VAT is charged at 7.5%; periodic supplies are treated as
  successive supplies. https://nass.gov.ng/documents/download/11249
- Oyo State Government and Oyo State Internal Revenue Service: Oyo State Hotels
  Occupancy and Restaurant Consumption Tax Law, 2021.
  https://oyostate.gov.ng/bills-and-laws/
  https://bir.oyostate.gov.ng/resources/
- Nigeria Data Protection Commission: Nigeria Data Protection Act compliance guidance,
  including hospitality-sector guidance and data-processing principles.
  https://ndpc.gov.ng/faqs/
  https://www.ndpc.gov.ng/ndpc-brings-data-protection-act-compliance-training-to-hospitality-sector/

This is an engineering baseline, not tax or legal advice. Validate final tax registration,
returns, and invoice treatment with the hotel's accountant and relevant authorities before
production use.
