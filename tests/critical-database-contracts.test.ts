import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationDirectory = join(projectRoot, "supabase", "migrations");
const migrations = readdirSync(migrationDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(migrationDirectory, name), "utf8"))
  .join("\n");
const reservationCancellationMigration = readFileSync(
  join(migrationDirectory, "20261007110000_reservation_cancellation_policy.sql"),
  "utf8",
);
const arrivalAttentionMigration = readFileSync(
  join(migrationDirectory, "20261007120000_front_desk_arrival_attention.sql"),
  "utf8",
);
const guestArrivalEmailMigration = readFileSync(
  join(migrationDirectory, "20261007130000_guest_arrival_email.sql"),
  "utf8",
);
const guestArrivalEmailFunction = readFileSync(
  join(projectRoot, "supabase", "functions", "send-arrival-email", "index.ts"),
  "utf8",
);

describe("critical database contracts", () => {
  it("prevents duplicate room-night charges and duplicate daily posting runs", () => {
    expect(migrations).toMatch(/unique\s*\(stay_id,\s*service_date\)/i);
    expect(migrations).toMatch(/unique\s*\(hotel_id,\s*service_date\)/i);
  });

  it("prevents overlapping assigned reservations at the database layer", () => {
    expect(migrations).toContain("reservations_assigned_room_no_overlap");
    expect(migrations).toMatch(/exclude\s+using\s+gist/i);
    expect(migrations).toContain(
      "daterange(check_in_date, check_out_date, '[)')",
    );
  });

  it("stores positive integer payment amounts and keeps refunds separately", () => {
    expect(migrations).toMatch(
      /amount_kobo bigint not null check \(amount_kobo > 0\)/i,
    );
    expect(migrations).toContain(
      "create table if not exists public.payment_refunds",
    );
    expect(migrations).toMatch(
      /refund cannot exceed the original payment amount/i,
    );
  });

  it("settles company receivables through controlled ledger payments", () => {
    expect(migrations).toContain(
      "create table public.business_account_receivable_payments",
    );
    expect(migrations).toContain(
      "Payment exceeds the remaining company balance, including pending payments",
    );
    expect(migrations).toContain(
      "Verified payment would exceed the remaining company balance",
    );
    expect(migrations).toMatch(
      /if initial_status = 'completed' then[\s\S]{0,350}insert into public\.receipts/i,
    );
    expect(migrations).toContain(
      "public.refresh_business_receivable_status(target_receivable.id)",
    );
    expect(migrations).toContain(
      "public.business_receivable_outstanding(bar.id)",
    );
    expect(migrations).toMatch(
      /grant execute on function public\.record_business_receivable_payment\(uuid, uuid, bigint, text\)[\s\S]{0,250}to authenticated/i,
    );
  });

  it("keeps company invoice corrections approved, bounded, and separate from guest folios", () => {
    expect(migrations).toContain("create table public.business_account_credit_notes");
    expect(migrations).toContain("approval_request_id uuid not null unique");
    expect(migrations).toContain("Credit note exceeds the remaining invoiced company amount");
    expect(migrations).toContain("Refund exceeds the available company credit balance");
    expect(migrations).toContain("Refund exceeds the original company payment");
    expect(migrations).toContain("(folio_id is null and business_receivable_id is not null)");
    expect(migrations).toContain("when 'company_credit_note' then perform public.issue_approved_business_credit_note(r.id)");
    expect(migrations).toContain("when 'company_payment_refund' then perform public.refund_approved_company_payment(r.id)");
    expect(migrations).toMatch(/revoke all on function public\.business_receivable_signed_balance\(uuid\),[\s\S]{0,180}public\.refund_approved_company_payment\(uuid\) from public, anon, authenticated/i);
  });

  it("provides read-only company ageing and statements without widening authority", () => {
    expect(migrations).toContain(
      "create or replace function public.get_business_receivable_ageing",
    );
    expect(migrations).toContain(
      "create or replace function public.get_business_account_statement",
    );
    expect(migrations).toMatch(
      /as_of_date - bar\.due_date between 1 and 30/i,
    );
    expect(migrations).toMatch(
      /as_of_date - bar\.due_date between 61 and 90/i,
    );
    expect(migrations).toMatch(
      /sum\(e\.debit_kobo - e\.credit_kobo\) over/i,
    );
    expect(migrations).toMatch(
      /if not public\.has_hotel_permission\(target_account\.hotel_id, 'receivables\.read'\)/i,
    );
    expect(migrations).toMatch(
      /grant execute on function public\.get_business_receivable_ageing\(uuid, date\)[\s\S]{0,180}to authenticated/i,
    );
  });

  it("keeps direct audit-log writes unavailable to browser users", () => {
    expect(migrations).toContain(
      "revoke insert on public.activity_logs from authenticated",
    );
    expect(migrations).toContain(
      "drop policy if exists activity_logs_insert on public.activity_logs",
    );
    expect(migrations).toMatch(
      /revoke all on function[\s\S]{0,250}public\.log_activity\(uuid, text, text, uuid, jsonb\) from public/i,
    );
  });

  it("keeps arbitrary-date night posting internal and exposes the controlled wrapper", () => {
    expect(migrations).toContain(
      "revoke all on function public.run_nightly_room_posting(uuid, date) from authenticated",
    );
    expect(migrations).toContain(
      "grant execute on function public.run_current_business_date_night_audit(uuid) to authenticated",
    );
  });

  it("requires controlled checkout and dirty-room turnover", () => {
    expect(migrations).toContain(
      "target_balance := public.folio_balance(target_folio.id)",
    );
    expect(migrations).toMatch(/if target_balance\s*<>\s*0 then/i);
    expect(migrations).toContain("room_turnover_status', 'dirty'");
    expect(migrations).toMatch(/turnover_status\s*<>\s*'clean'/i);
  });

  it("allows Reception's controlled departure permission through internal checkout", () => {
    expect(migrations).toMatch(
      /not public\.has_hotel_permission\(target_stay\.hotel_id, 'stays\.checkout'\)[\s\S]{0,150}and not public\.has_hotel_permission\(target_stay\.hotel_id, 'departures\.checkout'\)/i,
    );
    expect(migrations).toMatch(
      /revoke all on function public\.checkout_stay\(uuid, date\) from authenticated/i,
    );
  });

  it("lets Reception read only invoices issued by their own controlled checkout", () => {
    expect(migrations).toMatch(
      /has_hotel_permission\(target_hotel_id, 'departures\.checkout'\)[\s\S]{0,180}invoice_issuer_id = auth\.uid\(\)/i,
    );
    expect(migrations).toMatch(
      /revoke all on function public\.get_checkout_invoice\(uuid\) from public, anon/i,
    );
  });

  it("retains independent approval controls for financial corrections", () => {
    expect(migrations).toMatch(
      /cannot approve your own financial correction request/i,
    );
    expect(migrations).toMatch(/only the independent approver may execute/i);
    expect(migrations).toContain("finance_approval.executed");
  });

  it("does not allow ordinary authenticated users to call internal scheduler functions", () => {
    expect(migrations).toMatch(
      /revoke all on function public\.run_due_scheduled_night_audits\(\)\s+from public, anon, authenticated/i,
    );
  });

  it("advances the operating date after close without reclassifying historical transactions", () => {
    expect(migrations).toMatch(
      /select max\(bdc\.business_date\) \+ 1[\s\S]{0,150}from public\.business_day_closes bdc/i,
    );
    expect(migrations).toContain(
      "public.hotel_business_date(target_hotel_id, now())",
    );
    expect(migrations).toMatch(
      /operating_business_date\s*>\s*calendar_business_date/i,
    );
    expect(migrations).toContain(
      "The next business date has started, but its night audit is not due yet",
    );
  });

  it("moves in-house guests without rewriting rates and dirties the vacated room", () => {
    expect(migrations).toContain("create table public.stay_room_moves");
    expect(migrations).toContain("Destination room must be clean before a room move");
    expect(migrations).toContain("preserved_rate_kobo");
    expect(migrations).toMatch(
      /update public\.rooms[\s\S]{0,180}turnover_status = 'dirty'/i,
    );
    expect(migrations).toContain("'stay.room_moved'");
  });

  it("extends active stays without changing posted nights or bypassing availability", () => {
    expect(migrations).toContain("create table public.stay_extensions");
    expect(migrations).toContain(
      "The room has a conflicting reservation during the extension",
    );
    expect(migrations).toMatch(
      /daterange\(target_stay\.expected_check_out_date, new_check_out_date, '\[\)'\)/i,
    );
    expect(migrations).toContain("public.change_stay_rate(");
    expect(migrations).toContain(
      "Only management can approve a different extension rate",
    );
    expect(migrations).toContain("'stay.extended'");
  });

  it("offers future reservations on an active guest's checkout date but blocks same-day occupancy", () => {
    expect(migrations).toContain("active_stay.expected_check_out_date");
    expect(migrations).toContain(
      "The room is occupied during the requested dates",
    );
    expect(migrations).toContain(
      "arrival_date > public.hotel_business_date(target_hotel_id) or not exists",
    );
    expect(migrations).toContain(
      "The room has a conflicting reservation during the extension",
    );
  });

  it("keeps unapproved stay-exception fees disabled and policy changes audited", () => {
    expect(migrations).toContain("early_check_in_policy");
    expect(migrations).toContain("late_checkout_policy");
    expect(migrations).toContain("early_departure_policy");
    expect(migrations).toContain("extra_night_policy");
    expect(migrations).toContain("'settings.stay_lifecycle_policy_updated'");
    expect(migrations).toContain("Not authorised to manage hotel policy");
    expect(migrations).toContain(
      "This hotel requires Owner or GM approval for every stay extension",
    );
    expect(migrations).toContain("Early departure requires Owner or GM review");
    expect(migrations).toContain("actual_check_in_at timestamptz");
    expect(migrations).toContain("actual_check_out_at timestamptz");
    expect(migrations).toContain("Early check-in requires Owner or GM approval");
    expect(migrations).toContain("Late checkout requires Owner or GM approval");
    expect(migrations).toContain(
      "provision_general_manager_settings_permission",
    );
  });

  it("snapshots reservation cancellation terms and never silently moves money", () => {
    expect(reservationCancellationMigration).toContain("reservation_cancellation_policy_snapshots");
    expect(reservationCancellationMigration).toContain("legacy_terms_unknown");
    expect(reservationCancellationMigration).toContain("unconfirmed_at_booking");
    expect(reservationCancellationMigration).toContain("policy_confirmed_value is distinct from true");
    expect(reservationCancellationMigration).toContain("Reservation policy snapshots are immutable");
    expect(reservationCancellationMigration).toContain("settings.reservation_cancellation_policy_updated");
    expect(reservationCancellationMigration).toContain("No-show can only be recorded after the scheduled check-in time and hotel grace period");
    expect(reservationCancellationMigration).toContain("has_hotel_permission(target_hotel_id, 'settings.manage')");
    expect(reservationCancellationMigration).not.toMatch(/insert into public\.payment_refunds/i);
    expect(reservationCancellationMigration).not.toMatch(/set status\s*=\s*'refunded'/i);
  });

  it("limits front-desk arrival alerts to actionable reservations on the hotel business date", () => {
    expect(arrivalAttentionMigration).toContain("public.hotel_business_date(target_hotel_id)");
    expect(arrivalAttentionMigration).toContain("reservations.read");
    expect(arrivalAttentionMigration).toContain("r.status in ('pending', 'confirmed')");
    expect(arrivalAttentionMigration).toContain("r.check_in_date <= target_business_date");
    expect(arrivalAttentionMigration).toContain("left join public.rooms");
    expect(arrivalAttentionMigration).toContain("arrival_state");
  });

  it("authorizes and deduplicates staff-initiated guest arrival email delivery", () => {
    expect(guestArrivalEmailMigration).toContain("reservations.manage");
    expect(guestArrivalEmailMigration).toContain("booking.status not in ('pending', 'confirmed')");
    expect(guestArrivalEmailMigration).toContain("booking.check_in_date < booking.business_date");
    expect(guestArrivalEmailMigration).toContain("This guest does not have an email address on file");
    expect(guestArrivalEmailMigration).toMatch(/where status in \('sending', 'sent'\)/i);
    expect(guestArrivalEmailMigration).toContain("reservation.arrival_email_sent");
    expect(guestArrivalEmailMigration).toContain("reservation.arrival_email_failed");
    expect(guestArrivalEmailMigration).toContain("revoke all on public.guest_email_deliveries from public, anon, authenticated");
  });

  it("keeps guest recipient selection server-side and uses provider idempotency", () => {
    expect(guestArrivalEmailFunction).toContain('"claim_guest_arrival_email"');
    expect(guestArrivalEmailFunction).toContain('to: [booking.guest_email]');
    expect(guestArrivalEmailFunction).toContain('"Idempotency-Key": idempotencyKey');
    expect(guestArrivalEmailFunction).toContain('Deno.env.get("RESEND_API_KEY")');
    expect(guestArrivalEmailFunction).toContain('Deno.env.get("ARRIVAL_EMAIL_FROM")');
    expect(guestArrivalEmailFunction).not.toContain("body.recipient");
  });
});
