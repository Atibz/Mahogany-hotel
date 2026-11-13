import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createReconciliationDatabase } from "./helpers/reconciliation-database";

const hotel = "10000000-0000-4000-8000-000000000081";
const otherHotel = "10000000-0000-4000-8000-000000000082";
const accountant = "20000000-0000-4000-8000-000000000081";
const manager = "20000000-0000-4000-8000-000000000082";
const storekeeper = "20000000-0000-4000-8000-000000000083";
const room = "30000000-0000-4000-8000-000000000081";
const item = "40000000-0000-4000-8000-000000000081";

describe("physical operational checks", () => {
  let db: PGlite;
  let location: string;
  async function as(user: string) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    await db.exec("set local role authenticated");
  }
  async function rpc<T>(name: string, args: unknown[]) {
    return (await db.query<{ result: T }>(`select public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) as result`, args)).rows[0].result;
  }
  async function fails(action: () => Promise<unknown>, pattern: RegExp) {
    await db.exec("savepoint expected_failure");
    try { await expect(action()).rejects.toThrow(pattern); }
    finally { await db.exec("rollback to savepoint expected_failure; release savepoint expected_failure"); }
  }
  beforeAll(async () => {
    db = await createReconciliationDatabase();
    await db.exec(`
      insert into public.hotels(id,legal_name,trading_name) values
        ('${hotel}','Check Hotel','Check Hotel'),('${otherHotel}','Other Hotel','Other Hotel');
      insert into public.hotel_settings(hotel_id) values ('${hotel}'),('${otherHotel}');
      insert into auth.users(id,raw_user_meta_data) values
        ('${accountant}','{"full_name":"Accountant"}'),
        ('${manager}','{"full_name":"Manager"}'),
        ('${storekeeper}','{"full_name":"Storekeeper"}');
      insert into public.user_roles(profile_id,role_id)
        select v.id::uuid,r.id from (values
          ('${accountant}','accountant'),('${manager}','general_manager'),('${storekeeper}','storekeeper')) v(id,code)
          join public.roles r on r.hotel_id='${hotel}' and r.code=v.code;
      insert into public.room_types(id,hotel_id,name,base_rate_kobo,capacity)
        values ('30000000-0000-4000-8000-000000000080','${hotel}','Standard',10000,2);
      insert into public.rooms(id,hotel_id,room_type_id,room_number)
        values ('${room}','${hotel}','30000000-0000-4000-8000-000000000080','101');
      insert into public.inventory_items(id,hotel_id,item_code,name,category,base_unit)
        values ('${item}','${hotel}','WATER','Water bottles','Drinks','bottles');
    `);
    location = (await db.query<{ id: string }>(
      "select id from public.inventory_locations where hotel_id=$1 and code='main_store'", [hotel],
    )).rows[0].id;
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  it("records a room discrepancy without changing the stay and requires independent review", async () => {
    await db.exec("begin");
    try {
      await as(accountant);
      const id = await rpc<string>("submit_daily_operational_spot_check", [hotel, "room", room, null, null, true, null, "Physically inspected with supervisor"]);
      const report = await rpc<{ checks: Array<{ id: string; expected_occupied: boolean; observed_occupied: boolean }> }>("get_daily_operational_spot_checks", [hotel]);
      expect(report.checks).toMatchObject([{ id, expected_occupied: false, observed_occupied: true }]);
      await fails(() => rpc("review_daily_operational_spot_check", [id, "confirmed", "Inspected again"]), /Not authorised|Another person/);
      await fails(() => rpc("submit_daily_operational_spot_check", [hotel, "room", room, null, null, false, null, "Duplicate inspection"]), /duplicate key/);
      await as(manager);
      await rpc("review_daily_operational_spot_check", [id, "disputed", "Reception and housekeeping must investigate"]);
      const reviewed = await rpc<{ checks: Array<{ review_status: string }> }>("get_daily_operational_spot_checks", [hotel]);
      expect(reviewed.checks[0].review_status).toBe("disputed");
      await fails(() => rpc("review_daily_operational_spot_check", [id, "confirmed", "Second review"]), /already been reviewed/);
    } finally { await db.exec("rollback; reset role"); }
  });

  it("snapshots stock quantity, rejects cross-hotel targets, and forbids direct browser writes", async () => {
    await db.exec("begin");
    try {
      await as(storekeeper);
      await fails(() => rpc("submit_daily_operational_spot_check", [otherHotel, "stock", null, item, location, null, 2, "Counted by hand"]), /Not authorised/);
      const id = await rpc<string>("submit_daily_operational_spot_check", [hotel, "stock", null, item, location, null, 2, "Counted by hand"]);
      const report = await rpc<{ checks: Array<{ id: string; expected_quantity: number; observed_quantity: number }> }>("get_daily_operational_spot_checks", [hotel]);
      expect(report.checks).toMatchObject([{ id, expected_quantity: 0, observed_quantity: 2 }]);
      await fails(() => db.query("update public.daily_operational_spot_checks set observed_quantity=0 where id=$1", [id]), /permission denied/);
      await as(manager);
      await rpc("review_daily_operational_spot_check", [id, "confirmed", "Count confirmed; investigate missing receipt"]);
    } finally { await db.exec("rollback; reset role"); }
  });

  it("keeps an earlier business date available for a later independent review", async () => {
    await db.exec("begin");
    try {
      await db.exec(`insert into public.daily_operational_spot_checks(
        hotel_id,business_date,kind,room_id,expected_occupied,observed_occupied,evidence_note,submitted_by)
        values ('${hotel}',public.hotel_business_date('${hotel}',now())-1,'room','${room}',false,true,
          'Previous-day inspection','${accountant}')`);
      await as(manager);
      const report = await rpc<{ business_date: string; current_business_date: string; checks: Array<{ id: string }> }>(
        "get_daily_operational_spot_checks", [hotel, (await db.query<{ day: string }>(
          `select (public.hotel_business_date('${hotel}',now())-1)::text as day`,
        )).rows[0].day],
      );
      expect(report.business_date).not.toBe(report.current_business_date);
      expect(report.checks).toHaveLength(1);
      await rpc("review_daily_operational_spot_check", [report.checks[0].id, "disputed", "Investigate yesterday's unregistered occupant"]);
      const reviewed = await rpc<{ checks: Array<{ review_status: string }> }>("get_daily_operational_spot_checks", [hotel, report.business_date]);
      expect(reviewed.checks[0].review_status).toBe("disputed");
    } finally { await db.exec("rollback; reset role"); }
  });
});
