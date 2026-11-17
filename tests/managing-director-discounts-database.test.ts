import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createReconciliationDatabase } from "./helpers/reconciliation-database";

const hotel = "10000000-0000-4000-8000-000000000091";
const receptionist = "20000000-0000-4000-8000-000000000091";
const md = "20000000-0000-4000-8000-000000000092";
const gm = "20000000-0000-4000-8000-000000000093";
const owner = "20000000-0000-4000-8000-000000000094";
const accountant = "20000000-0000-4000-8000-000000000095";
const guest = "30000000-0000-4000-8000-000000000091";
const roomType = "40000000-0000-4000-8000-000000000091";
const room = "50000000-0000-4000-8000-000000000091";

describe("Managing Director and reception discount control", () => {
  let db: PGlite;
  async function as(user: string) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    await db.exec("set local role authenticated");
  }
  async function admin(sql: string, args: unknown[] = []) {
    await db.exec("reset role");
    return db.query(sql, args);
  }
  async function fails(action: () => Promise<unknown>, pattern: RegExp) {
    await db.exec("savepoint expected_failure");
    try { await expect(action()).rejects.toThrow(pattern); }
    finally { await db.exec("rollback to savepoint expected_failure; release savepoint expected_failure"); }
  }
  beforeAll(async () => {
    db = await createReconciliationDatabase();
    await db.exec(`
      insert into public.hotels(id,legal_name,trading_name) values ('${hotel}','MD Test','MD Test');
      insert into public.hotel_settings(hotel_id) values ('${hotel}');
      insert into auth.users(id,raw_user_meta_data) values
        ('${receptionist}','{"full_name":"Reception Test"}'),
        ('${md}','{"full_name":"MD Test"}'),
        ('${gm}','{"full_name":"GM Test"}'),
        ('${owner}','{"full_name":"Owner Test"}'),
        ('${accountant}','{"full_name":"Accountant Test"}');
      insert into public.user_roles(profile_id,role_id)
        select v.id::uuid,r.id from (values
          ('${receptionist}','receptionist'),('${md}','managing_director'),
          ('${gm}','general_manager'),('${owner}','owner'),
          ('${accountant}','accountant')) v(id,code)
          join public.roles r on r.hotel_id='${hotel}' and r.code=v.code;
      insert into public.room_types(id,hotel_id,name,base_rate_kobo,capacity)
        values ('${roomType}','${hotel}','Standard',10000,2);
      insert into public.rooms(id,hotel_id,room_type_id,room_number)
        values ('${room}','${hotel}','${roomType}','101');
      insert into public.guests(id,hotel_id,full_name)
        values ('${guest}','${hotel}','Test Guest');
    `);
  }, 60_000);
  beforeEach(async () => { await db.exec("begin"); });
  afterEach(async () => { await db.exec("rollback; reset role"); });
  afterAll(async () => { await db?.close(); });

  it("provisions MD with GM permissions but no Owner role", async () => {
    const roles = await admin(`select r.code from public.user_roles ur join public.roles r on r.id=ur.role_id
      where ur.profile_id=$1 order by r.code`, [md]);
    expect(roles.rows.map((r) => r.code)).toEqual(["general_manager", "managing_director"]);
    await as(md);
    expect((await db.query("select public.has_hotel_permission($1,'finance_approvals.approve') as allowed", [hotel])).rows[0].allowed).toBe(true);
    expect((await db.query("select public.has_hotel_permission($1,'owner') as allowed", [hotel])).rows[0].allowed).toBe(false);
  });

  it("gives the accountant operational authority without night-audit run or Owner visibility", async () => {
    await as(accountant);
    for (const code of ["staff.manage", "reservations.manage", "inventory.manage", "finance_approvals.approve", "expenses.review"]) {
      expect((await db.query("select public.has_hotel_permission($1,$2) as allowed", [hotel, code])).rows[0].allowed).toBe(true);
    }
    expect((await db.query("select public.has_hotel_permission($1,'night_audit.run') as allowed", [hotel])).rows[0].allowed).toBe(false);
    expect((await db.query("select public.has_hotel_permission($1,'owner') as allowed", [hotel])).rows[0].allowed).toBe(false);
    expect((await db.query("select id from public.profiles where id=$1", [owner])).rows).toHaveLength(0);
    expect((await db.query("select id from public.roles where hotel_id=$1 and code='owner'", [hotel])).rows).toHaveLength(0);
    await fails(() => db.query("select public.set_staff_active($1,false)", [md]), /Only the hotel owner/);
  });

  it("allows an accountant to decide their own finance request with an audit marker", async () => {
    const inserted = await admin(`insert into public.finance_approval_requests
      (hotel_id,action_type,target_entity_type,target_entity_id,payload,reason,requested_by)
      values ($1,'reservation_discount','reservation',$2,'{}','Documented test request',$3)
      returning id`, [hotel, guest, accountant]);
    const id = inserted.rows[0].id;
    await as(accountant);
    await db.query("select public.decide_finance_approval($1,true,$2)", [id, "Evidence and requested amount checked"]);
    const result = await admin("select status, requested_by, decided_by from public.finance_approval_requests where id=$1", [id]);
    expect(result.rows[0]).toMatchObject({ status: "approved", requested_by: accountant, decided_by: accountant });
    const log = await admin(`select metadata->>'self_review' as self_review from public.activity_logs
      where entity_type='finance_approval_request' and entity_id=$1 and action='finance_approval.approved'`, [id]);
    expect(log.rows[0]?.self_review).toBe("true");
  });

  it("prevents GM account and role changes to the MD while allowing the Owner", async () => {
    const role = await admin("select id from public.roles where hotel_id=$1 and code='receptionist'", [hotel]);
    const granted = await admin("select p.code from public.user_roles ur join public.roles r on r.id=ur.role_id join public.role_permissions rp on rp.role_id=r.id join public.permissions p on p.id=rp.permission_id where ur.profile_id=$1 and p.code='staff.manage'", [gm]);
    expect(granted.rows).toHaveLength(1);
    await as(gm);
    expect((await db.query("select public.has_hotel_permission($1,'staff.manage') as allowed", [hotel])).rows[0].allowed).toBe(true);
    await fails(() => db.query("select public.set_staff_active($1,false)", [md]), /Only the hotel owner/);
    await fails(() => db.query("select public.replace_staff_role($1,$2)", [md, role.rows[0].id]), /Only the hotel owner/);
    await fails(() => db.query("select public.assign_staff_role($1,$2)", [md, role.rows[0].id]), /Only the hotel owner/);
    await as(owner);
    await db.query("select public.set_staff_active($1,false)", [md]);
    expect((await admin("select active from public.profiles where id=$1", [md])).rows[0].active).toBe(false);
    await as(owner);
    await db.query("select public.set_staff_active($1,true)", [md]);
    expect((await admin("select active from public.profiles where id=$1", [md])).rows[0].active).toBe(true);
  });

  it("blocks a receptionist direct discount and accepts the request/independent MD approval path", async () => {
      const assignment = await admin("select r.code, p.code as permission from public.user_roles ur join public.roles r on r.id=ur.role_id left join public.role_permissions rp on rp.role_id=r.id left join public.permissions p on p.id=rp.permission_id where ur.profile_id=$1 and p.code like 'reservations.%'", [receptionist]);
      const role = await admin("select r.code from public.user_roles ur join public.roles r on r.id=ur.role_id where ur.profile_id=$1", [receptionist]);
      expect(role.rows).toMatchObject([{ code: 'receptionist' }]);
      expect(assignment.rows.map((row) => row.permission)).toContain('reservations.create');
      await as(receptionist);
      const access = await db.query("select auth.uid() as id, public.has_hotel_permission($1,'reservations.create') as allowed", [hotel]);
      expect(access.rows[0]).toMatchObject({ id: receptionist, allowed: true });
      const args = [hotel, guest, roomType, room, "2026-11-20", "2026-11-22"];
      await fails(() => db.query(
        "select public.create_reservation($1,$2,$3,$4,$5::date,$6::date,9500)", args,
      ), /Reception discounts require independent approval/);
      await fails(() => db.query(
        "select public.create_walk_in_stay($1::uuid,'Walk-in Guest',null,null,$2::uuid,'2026-11-20'::date,'2026-11-22'::date,9500::bigint)", [hotel, room],
      ), /Reception walk-in discounts require an approved reservation/);
      const result = await db.query<{ id: string }>(
        "select public.create_reservation_with_discount_request($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6::date,9500::bigint,'Guest request',1::smallint,0::smallint,'Direct','Approval test') as id", args,
      );
      const reservationId = result.rows[0].id;
      const saved = await admin("select agreed_rate_kobo,booking_source,notes from public.reservations where id=$1", [reservationId]);
      expect(saved.rows[0]).toMatchObject({ agreed_rate_kobo: 10000, booking_source: "Direct", notes: "Approval test" });
      const pending = await admin("select id,status from public.finance_approval_requests where target_entity_id=$1", [reservationId]);
      expect(pending.rows).toHaveLength(1);
      await as(receptionist);
      await fails(() => db.query("select public.decide_finance_approval($1,true,'Self-approved')", [pending.rows[0].id]), /Not authorised|cannot approve your own/i);
      await as(md);
      await db.query("select public.decide_finance_approval($1,true,'Approved by MD')", [pending.rows[0].id]);
      await db.query("select public.execute_finance_approval($1)", [pending.rows[0].id]);
      const applied = await admin("select agreed_rate_kobo from public.reservations where id=$1", [reservationId]);
      expect(applied.rows[0].agreed_rate_kobo).toBe(9500);
  });

  it("amends at standard rate and requests independent approval atomically", async () => {
    await as(receptionist);
    const args = [hotel, guest, roomType, room, "2026-11-25", "2026-11-27"];
    const created = await db.query<{ id: string }>(
      "select public.create_reservation($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6::date,10000::bigint) as id", args);
    const reservationId = created.rows[0].id;
    await fails(() => db.query(
      "select public.amend_reservation($1::uuid,$2::uuid,$3::uuid,'2026-11-25'::date,'2026-11-28'::date,9000::bigint,'Discount requested')",
      [reservationId, roomType, room],
    ), /Reception discounts require independent approval/);
    const request = await db.query<{ id: string }>(
      "select public.amend_reservation_with_discount_request($1::uuid,$2::uuid,$3::uuid,'2026-11-25'::date,'2026-11-28'::date,9000::bigint,'Guest loyalty discount') as id",
      [reservationId, roomType, room],
    );
    const saved = await admin("select agreed_rate_kobo, check_out_date from public.reservations where id=$1", [reservationId]);
    expect(saved.rows[0].agreed_rate_kobo).toBe(10000);
    expect(new Date(saved.rows[0].check_out_date as string).toISOString().slice(0, 10)).toBe("2026-11-28");
    const pending = await admin("select status from public.finance_approval_requests where id=$1", [request.rows[0].id]);
    expect(pending.rows[0].status).toBe("pending");
    await as(md);
    await db.query("select public.decide_finance_approval($1,true,'Approved')", [request.rows[0].id]);
    await db.query("select public.execute_finance_approval($1)", [request.rows[0].id]);
    expect((await admin("select agreed_rate_kobo from public.reservations where id=$1", [reservationId])).rows[0].agreed_rate_kobo).toBe(9000);
  });
});
