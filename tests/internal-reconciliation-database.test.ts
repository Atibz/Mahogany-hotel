import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createReconciliationDatabase } from "./helpers/reconciliation-database";
import type { AccountDeclaration, DailyReconciliation, ReconciliationSource } from "../src/features/settings/internal-reconciliation";

const hotel = "10000000-0000-4000-8000-000000000001";
const otherHotel = "10000000-0000-4000-8000-000000000002";
const accountant = "20000000-0000-4000-8000-000000000001";
const manager = "20000000-0000-4000-8000-000000000002";
const cashier = "20000000-0000-4000-8000-000000000003";
const cash = "30000000-0000-4000-8000-000000000001";
const bank = "30000000-0000-4000-8000-000000000002";
const otherCash = "30000000-0000-4000-8000-000000000003";
const folio = "40000000-0000-4000-8000-000000000005";
const restaurant = "50000000-0000-4000-8000-000000000001";
const bar = "50000000-0000-4000-8000-000000000002";
const date = "2000-01-10";

describe("daily reconciliation database", () => {
  let db: PGlite;
  let hotelCash: string;
  let restaurantCash: string;
  let barCash: string;
  async function value<T>(sql: string, args: unknown[] = []): Promise<T> {
    return (await db.query<{ value: T }>(sql, args)).rows[0].value;
  }
  async function rpc<T>(name: string, args: unknown[]) {
    return value<T>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as value`, args);
  }
  async function as(user: string) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    await db.exec("set local role authenticated");
  }
  async function admin(sql: string, args: unknown[] = []) {
    await db.exec("reset role");
    return args.length ? db.query(sql, args) : db.exec(sql);
  }
  const report = (on = date, targetHotel = hotel) => rpc<DailyReconciliation>("get_internal_daily_reconciliation", [targetHotel, on]);
  const source = async (on = date) => (await report(on)).source;
  function declarations(s: ReconciliationSource, change = 0): AccountDeclaration[] {
    return s.accounts.map((a) => ({ account_id: a.id, opening_kobo: a.previous_closing_kobo ?? 10000,
      closing_kobo: (a.previous_closing_kobo ?? 10000) + a.collections_kobo - a.refunds_kobo - a.expenses_kobo + a.movements_kobo + change,
      evidence_reference: "Count and bank statement verified", variance_note: change ? "Documented shortage investigated" : "" }));
  }
  const submit = async (s: ReconciliationSource, d = declarations(s), note = "") => rpc<string>("submit_internal_daily_reconciliation", [hotel, s.business_date, JSON.stringify(d), note, JSON.stringify(s)]);
  async function fails(action: () => Promise<unknown>, message: RegExp) {
    await db.exec("savepoint expected_failure");
    try { await expect(action()).rejects.toThrow(message); }
    finally { await db.exec("rollback to savepoint expected_failure; release savepoint expected_failure"); }
  }
  async function expense(status: "approved" | "rejected" | "pending_review" = "approved") {
    const id = await rpc<string>("submit_operating_expense", [hotel, "hotel", "Supplies", "Already paid supplies", "Supplier", 12000, "Cash", "Receipt-001", "2000-01-09"]);
    if (status !== "pending_review") {
      await as(manager); await rpc("review_operating_expense", [id, status, "Independent receipt review"]); await as(accountant);
    }
    return id;
  }
  beforeAll(async () => {
    db = await createReconciliationDatabase();
    await db.exec(`
      insert into public.hotels(id, legal_name, trading_name) values ('${hotel}', 'Test Hotel', 'Test'), ('${otherHotel}', 'Other Hotel', 'Other');
      insert into public.hotel_settings(hotel_id) values ('${hotel}'), ('${otherHotel}');
      insert into auth.users(id, raw_user_meta_data) values ('${accountant}', '{"full_name":"Accountant"}'), ('${manager}', '{"full_name":"Manager"}'), ('${cashier}', '{"full_name":"Cashier"}');
      insert into public.user_roles(profile_id, role_id) select v.profile_id::uuid, r.id from (values
        ('${accountant}', 'accountant'), ('${manager}', 'general_manager'), ('${cashier}', 'cashier')) v(profile_id, code)
        join public.roles r on r.hotel_id = '${hotel}' and r.code = v.code;
      insert into public.payment_methods(id, hotel_id, code, name) values ('${cash}', '${hotel}', 'cash', 'Cash'), ('${bank}', '${hotel}', 'bank_transfer', 'Bank transfer'), ('${otherCash}', '${otherHotel}', 'cash', 'Cash')
        on conflict(hotel_id,code) do update set id=excluded.id,name=excluded.name;
      insert into public.room_types(id, hotel_id, name, base_rate_kobo, capacity) values ('40000000-0000-4000-8000-000000000001', '${hotel}', 'Test', 10000, 1);
      insert into public.rooms(id, hotel_id, room_type_id, room_number) values ('40000000-0000-4000-8000-000000000002', '${hotel}', '40000000-0000-4000-8000-000000000001', '101');
      insert into public.guests(id, hotel_id, full_name) values ('40000000-0000-4000-8000-000000000003', '${hotel}', 'Test Guest');
      insert into public.stays(id, hotel_id, guest_id, room_id, actual_check_in_date, expected_check_out_date, agreed_rate_kobo) values
        ('40000000-0000-4000-8000-000000000004', '${hotel}', '40000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000002', '2000-01-01', '2000-01-20', 10000);
      insert into public.guest_folios(id, hotel_id, stay_id, folio_number) values ('${folio}', '${hotel}', '40000000-0000-4000-8000-000000000004', 'TEST-FOLIO');
      insert into public.departments(hotel_id, code, name) values ('${hotel}', 'restaurant', 'Restaurant'), ('${hotel}', 'bar', 'Bar');
      insert into public.pos_outlets(id, hotel_id, code, name, outlet_type, department_code) values ('${restaurant}', '${hotel}', 'restaurant', 'Restaurant', 'restaurant', 'restaurant'), ('${bar}', '${hotel}', 'bar', 'Bar', 'bar', 'bar');
    `);
  }, 60_000);
  beforeEach(async () => {
    await db.exec("begin"); await as(accountant);
    hotelCash = await rpc("create_internal_funding_account", [hotel, "hotel", cash, "Hotel cash drawer"]);
    restaurantCash = await rpc("create_internal_funding_account", [hotel, "restaurant", cash, "Restaurant cash drawer"]);
    barCash = await rpc("create_internal_funding_account", [hotel, "bar", cash, "Bar cash drawer"]);
  });
  afterEach(async () => { await db.exec("rollback; reset role"); });
  afterAll(async () => { await db?.close(); });

  it("applies the real migration chain and exposes checked RPCs only", async () => {
    const result = await db.query<{ allowed: boolean }>(`select has_function_privilege('authenticated',
      'public.get_internal_daily_reconciliation(uuid,date)', 'EXECUTE') as allowed`);
    expect(result.rows[0].allowed).toBe(true);
    const helpers = await db.query<{ allowed: boolean }>(`select has_function_privilege('authenticated',
      'public.build_internal_reconciliation_source(uuid,date)', 'EXECUTE') as allowed`);
    expect(helpers.rows[0].allowed).toBe(false);
    const writes = await db.query<{ allowed: boolean }>(`select has_table_privilege('authenticated',
      'public.internal_daily_reconciliations', 'UPDATE') as allowed`);
    expect(writes.rows[0].allowed).toBe(false);
  });

  it("blocks unauthorised roles, anonymous access, foreign hotels and payment methods", async () => {
    await fails(() => report(date, otherHotel), /Not authorised/);
    await fails(() => rpc("create_internal_funding_account", [hotel, "hotel", otherCash, "Foreign bank"]), /belonging to this hotel/);
    await as(cashier); await fails(() => report(), /Not authorised/);
    await as(""); await fails(() => report(), /Not authorised/);
  });

  it("separates business lines and counts hotel refunds on their payout date", async () => {
    await admin(`insert into public.payments(hotel_id, payment_number, payment_method_id, amount_kobo, status, received_at) values
      ('${hotel}', 'CURRENT', '${cash}', 100000, 'completed', '2000-01-10T12:00:00Z'),
      ('${hotel}', 'PRIOR', '${cash}', 20000, 'refunded', '2000-01-09T12:00:00Z')`);
    await admin(`insert into public.payment_refunds(hotel_id, refund_number, payment_id, folio_id, amount_kobo, reason, refunded_at)
      select '${hotel}', 'REFUND', id, '${folio}', 3000, 'Refund evidence', '2000-01-10T12:00:00Z' from public.payments where payment_number = 'PRIOR'`);
    for (const [outlet, amount, number] of [[restaurant, 40000, "REST"], [bar, 25000, "BAR"]] as const) {
      await admin(`insert into public.pos_orders(hotel_id, outlet_id, order_number, business_date, service_mode, outlet_name_snapshot, department_code_snapshot)
        values ($1,$2,$3,$4,'dine_in',$3,$3)`, [hotel, outlet, number, date]);
      await admin(`insert into public.pos_order_payments(hotel_id,outlet_id,order_id,payment_number,payment_method_id,payment_method_name_snapshot,amount_kobo,status,received_at)
        select hotel_id,outlet_id,id,$1,$2,'Cash',$3,'completed','2000-01-10T12:00:00Z' from public.pos_orders where order_number=$1`, [number, cash, amount]);
    }
    await as(accountant);
    const s = await source();
    expect(s.accounts.find((a) => a.id === hotelCash)).toMatchObject({ collections_kobo: 100000, refunds_kobo: 3000 });
    expect(s.accounts.find((a) => a.id === restaurantCash)?.collections_kobo).toBe(40000);
    expect(s.accounts.find((a) => a.id === barCash)?.collections_kobo).toBe(25000);
    const previous = await source("2000-01-09");
    expect(previous.accounts.find((a) => a.id === hotelCash)).toMatchObject({ collections_kobo: 20000, refunds_kobo: 0 });
  });

  it("uses the actual expense payment date and prevents cross-line funding", async () => {
    const id = await expense();
    expect((await source()).blockers.unfunded_expenses).toBe(1);
    await fails(() => rpc("record_internal_expense_funding", [id, restaurantCash, date, "Receipt evidence"]), /business line/);
    await rpc("record_internal_expense_funding", [id, hotelCash, date, "Receipt evidence"]);
    expect((await source()).accounts.find((a) => a.id === hotelCash)?.expenses_kobo).toBe(12000);
    expect((await source("2000-01-09")).accounts.find((a) => a.id === hotelCash)?.expenses_kobo).toBe(0);
  });

  it("permits accountant self-review of an already-paid expense and records the exception", async () => {
    await as(accountant);
    const id = await rpc<string>("submit_operating_expense", [hotel, "hotel", "Supplies", "Paid office supplies", "Supplier", 12000, "Cash", "Receipt-SELF", "2000-01-09"]);
    await rpc("review_operating_expense", [id, "approved", "Checked original supplier receipt"]);
    const reviewed = await admin("select status, submitted_by, reviewed_by from public.operating_expenses where id=$1", [id]);
    expect(reviewed.rows[0]).toMatchObject({ status: "approved", submitted_by: accountant, reviewed_by: accountant });
    const log = await admin(`select metadata->>'self_review' as self_review from public.activity_logs
      where entity_type='operating_expense' and entity_id=$1 and action='expense.approved'`, [id]);
    expect(log.rows[0]?.self_review).toBe("true");
  });

  it("keeps POS refunds on the payout date and in the originating outlet business line", async () => {
    await admin(`
      insert into public.pos_orders(id,hotel_id,outlet_id,order_number,business_date,service_mode,outlet_name_snapshot,department_code_snapshot)
        values ('60000000-0000-4000-8000-000000000001','${hotel}','${restaurant}','REST-REFUND','2000-01-09','dine_in','Restaurant','restaurant');
      insert into public.pos_order_payments(id,hotel_id,outlet_id,order_id,payment_number,payment_method_id,payment_method_name_snapshot,amount_kobo,status,received_at)
        values ('60000000-0000-4000-8000-000000000002','${hotel}','${restaurant}','60000000-0000-4000-8000-000000000001','REST-PAY','${cash}','Cash',40000,'completed','2000-01-09T12:00:00Z');
      insert into public.finance_approval_requests(id,hotel_id,action_type,target_entity_type,target_entity_id,payload,reason,requested_by)
        values ('60000000-0000-4000-8000-000000000003','${hotel}','pos_payment_refund','pos_payment','60000000-0000-4000-8000-000000000002','{}','Refund requested','${accountant}');
      insert into public.pos_order_refunds(hotel_id,outlet_id,order_id,payment_id,approval_request_id,refund_number,order_number_snapshot,outlet_name_snapshot,department_code_snapshot,payment_number_snapshot,amount_kobo,payment_method_id,payment_method_name_snapshot,reason,refunded_at)
        values ('${hotel}','${restaurant}','60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000003','POS-REFUND','REST-REFUND','Restaurant','restaurant','REST-PAY',6000,'${cash}','Cash','Refund evidence','2000-01-10T12:00:00Z');
    `);
    await as(accountant); const s = await source();
    expect(s.accounts.find((a) => a.id === restaurantCash)).toMatchObject({ collections_kobo: 0, refunds_kobo: 6000 });
    expect(s.accounts.find((a) => a.id === hotelCash)?.refunds_kobo).toBe(0);
    expect(s.accounts.find((a) => a.id === barCash)?.refunds_kobo).toBe(0);
    expect((await source("2000-01-09")).accounts.find((a) => a.id === restaurantCash)).toMatchObject({ collections_kobo: 40000, refunds_kobo: 0 });
  });

  it("reconciles bank receipts separately from cash and excludes voided payments", async () => {
    const bankAccount = await rpc<string>("create_internal_funding_account", [hotel, "hotel", bank, "Hotel bank settlement"]);
    await admin(`insert into public.payments(hotel_id,payment_number,payment_method_id,amount_kobo,status,received_at,voided_at,void_reason) values
      ('${hotel}','BANK','${bank}',50000,'completed','2000-01-10T12:00:00Z',null,null),
      ('${hotel}','VOID','${cash}',9000,'voided','2000-01-10T12:00:00Z',now(),'Payment not received')`);
    await as(accountant); const s = await source();
    expect(s.accounts.find((a) => a.id === bankAccount)?.collections_kobo).toBe(50000);
    expect(s.accounts.find((a) => a.id === hotelCash)?.collections_kobo).toBe(0);
    expect(s.events.some((e) => e.status === "voided")).toBe(true);
    expect(s.blockers.unmapped_payments).toBe(0);
  });

  it("blocks future report dates and duplicate account routes", async () => {
    await fails(() => source("2999-01-01"), /Invalid reconciliation business date/);
    await fails(() => rpc("create_internal_funding_account", [hotel, "hotel", cash, "Duplicate drawer"]), /unique constraint/);
  });

  it("blocks pending payments, unmapped tenders, pending expenses, and open shifts", async () => {
    await admin(`insert into public.payments(hotel_id,payment_number,payment_method_id,amount_kobo,status,received_at)
      values ('${hotel}','PENDING','${bank}',1000,'pending_verification','2000-01-10T12:00:00Z');
      insert into public.cashier_shifts(hotel_id,shift_number,business_date,opened_by) values ('${hotel}','OPEN','2000-01-09','${cashier}')`);
    await as(accountant); await expense("pending_review");
    const s = await source();
    expect(s.blockers).toMatchObject({ pending_payments: 1, unmapped_payments: 1, pending_expenses: 1, unfunded_expenses: 1, open_shifts: 1 });
    await fails(() => submit(s), /Resolve all reconciliation blockers/);
  });

  it("requires independent hotel shift review and never adds shift floats twice", async () => {
    await admin(`insert into public.cashier_shifts(hotel_id,shift_number,business_date,opened_by,status,opening_float_kobo,expected_cash_kobo,declared_cash_kobo,variance_kobo,closed_by,closed_at,handover_reference)
      values ('${hotel}','CLOSED','${date}','${cashier}','closed',5000,5000,5000,0,'${cashier}',now(),'HANDOVER')`);
    await as(accountant); const s = await source();
    expect(s.blockers.unreviewed_hotel_shifts).toBe(1);
    expect(s.accounts.find((a) => a.id === hotelCash)?.collections_kobo).toBe(0);
    await fails(() => submit(s), /blockers/);
  });

  it("keeps rejected paid expenses in outflows and requires an exception explanation", async () => {
    const id = await expense("rejected");
    await rpc("record_internal_expense_funding", [id, hotelCash, date, "Bank receipt"]);
    const s = await source(); const d = declarations(s).map((item) => ({ ...item, opening_kobo: 20000, closing_kobo: item.closing_kobo + 10000 }));
    expect(s.accounts.find((a) => a.id === hotelCash)?.expenses_kobo).toBe(12000);
    await fails(() => submit(s, d), /Explain rejected paid expenses/);
    await expect(submit(s, d, "Payment disputed; recovery under investigation")).resolves.toBeTypeOf("string");
  });

  it("derives expected and variance amounts on the server and requires evidence", async () => {
    await rpc("record_internal_fund_movement", [hotelCash, date, -5000, "Deposit slip", "Cash deposited outside this app"]);
    const s = await source(); const d = declarations(s, -100);
    await fails(() => submit(s, d.map((item) => ({ ...item, evidence_reference: "" }))), /evidence/);
    await fails(() => submit(s, d.map((item) => ({ ...item, variance_note: "" }))), /Explain every/);
    const id = await submit(s, d.map((item) => ({ ...item, expected_kobo: 999999, variance_kobo: 0 })));
    const r = (await report()).history.find((r) => r.id === id)!;
    expect(r.declarations.find((item) => item.account_id === hotelCash)).toMatchObject({ expected_kobo: 5000, closing_kobo: 4900, variance_kobo: -100 });
  });

  it("rejects missing, duplicate, fractional and unsafe declarations", async () => {
    const s = await source(); const d = declarations(s);
    await fails(() => submit(s, d.slice(1)), /every funding account/);
    await fails(() => submit(s, [d[0], d[0], d[2]]), /every funding account/);
    await fails(() => submit(s, d.map((item) => ({ ...item, opening_kobo: 0.5 }))), /whole kobo/);
    await fails(() => submit(s, d.map((item) => ({ ...item, opening_kobo: Number.MAX_SAFE_INTEGER + 1 }))), /precision/);
  });

  it("rejects stale submissions and stale approvals while permitting rejection and resubmission", async () => {
    const stale = await source();
    await rpc("record_internal_fund_movement", [hotelCash, date, 100, "Deposit", "External top-up"]);
    await fails(() => submit(stale), /Source records changed/);
    const id = await submit(await source());
    await admin(`insert into public.payments(hotel_id,payment_number,payment_method_id,amount_kobo,status,received_at)
      values ('${hotel}','LATE','${cash}',1000,'completed','2000-01-10T12:00:00Z')`);
    await as(manager);
    await fails(() => rpc("review_internal_daily_reconciliation", [id, "approved", "Checked"]), /Source records changed/);
    await rpc("review_internal_daily_reconciliation", [id, "rejected", "Late payment requires correction"]);
    await as(accountant); await expect(submit(await source())).resolves.toBeTypeOf("string");
  });

  it("enforces independent approval, single pending submission, and immutable signed versions", async () => {
    const s = await source(); const id = await submit(s);
    await fails(() => submit(s), /unique constraint/);
    await fails(() => rpc("record_internal_fund_movement", [hotelCash, date, 100, "Evidence", "Top-up"]), /Reject the pending/);
    await as(manager);
    await rpc("review_internal_daily_reconciliation", [id, "approved", "Independent count verified"]);
    await fails(() => rpc("review_internal_daily_reconciliation", [id, "rejected", "Change of mind"]), /Only submitted/);
    await fails(() => db.query("update public.internal_daily_reconciliations set review_note = 'tampered' where id = $1", [id]), /permission denied/);
    const signed = (await report()).history[0];
    await as(accountant); const unchanged = await source(); await fails(() => submit(unchanged), /Explain the correction/);
    await rpc("record_internal_fund_movement", [hotelCash, date, 100, "Late deposit evidence", "Correct omitted top-up"]);
    const revision = await submit(await source(), declarations(await source()), "Correct omitted top-up");
    await as(manager); await rpc("review_internal_daily_reconciliation", [revision, "approved", "Correction independently verified"]);
    const history = (await report()).history;
    expect(history.filter((r) => r.status === "approved")).toHaveLength(2);
    expect(history.find((r) => r.id === id)).toEqual(signed);
  });

  it("prevents a GM from reviewing their own submission", async () => {
    await as(manager); const id = await submit(await source());
    await fails(() => rpc("review_internal_daily_reconciliation", [id, "approved", "Self review"]), /Only the accountant may review their own reconciliation/);
    await fails(() => rpc("review_internal_daily_reconciliation", [id, "rejected", "Self rejection"]), /Only the accountant may review their own reconciliation/);
  });

  it("allows accountant self-review with an audit marker", async () => {
    await as(accountant); const id = await submit(await source());
    await rpc("review_internal_daily_reconciliation", [id, "approved", "Checked against cash count evidence"]);
    const signed = (await report()).history.find((record) => record.id === id);
    expect(signed?.status).toBe("approved");
    expect(signed?.reviewed_by).toBe(accountant);
    const logged = await admin(`select metadata->>'self_review' = 'true' as value
      from public.activity_logs where entity_type = 'internal_daily_reconciliation' and entity_id = $1
      and action = 'internal_reconciliation.approved' order by occurred_at desc limit 1`, [id]);
    expect(logged.rows[0]?.value).toBe(true);
  });

  it("carries prior approved closing balances and permits evidence-based corrections to actual counts", async () => {
    const s = await source("2000-01-09"); const id = await submit(s);
    await as(manager); await rpc("review_internal_daily_reconciliation", [id, "approved", "Verified previous day"]);
    await as(accountant); const next = await source();
    expect(next.accounts.every((a) => a.previous_closing_kobo === 10000)).toBe(true);
    await fails(() => submit(next, declarations(next).map((d) => ({ ...d, opening_kobo: 0 }))), /Opening balance must match/);
    const nextId = await submit(next); await as(manager); await rpc("review_internal_daily_reconciliation", [nextId, "approved", "Verified day"]);
    await as(accountant); const unchanged = await source();
    await fails(() => submit(unchanged, declarations(unchanged), "No change"), /already approved/);
    await expect(submit(unchanged, declarations(unchanged, -100), "Count evidence corrected after recount")).resolves.toBeTypeOf("string");
  });

  it("classifies timestamps using the hotel's cutoff rather than the browser date", async () => {
    await admin(`insert into public.payments(hotel_id,payment_number,payment_method_id,amount_kobo,status,received_at)
      values ('${hotel}','CUTOFF','${cash}',1234,'completed','2000-01-10T00:30:00Z')`);
    await as(accountant);
    expect((await source()).accounts.find((a) => a.id === hotelCash)?.collections_kobo).toBe(0);
    expect((await source("2000-01-09")).accounts.find((a) => a.id === hotelCash)?.collections_kobo).toBe(1234);
  });
});
