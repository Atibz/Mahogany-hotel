import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createReconciliationDatabase } from "./helpers/reconciliation-database";

const hotel = "10000000-0000-4000-8000-000000000011";
const otherHotel = "10000000-0000-4000-8000-000000000012";
const restaurantStaff = "20000000-0000-4000-8000-000000000011";
const receptionist = "20000000-0000-4000-8000-000000000012";
const barStaff = "20000000-0000-4000-8000-000000000013";
const room = "30000000-0000-4000-8000-000000000011";
const stay = "40000000-0000-4000-8000-000000000011";
const restaurant = "50000000-0000-4000-8000-000000000011";
const bar = "50000000-0000-4000-8000-000000000012";

describe("room-linked outlet orders and checkout", () => {
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
  async function rpc<T>(name: string, args: unknown[]) {
    return (await db.query<{ result: T }>(`select public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) as result`, args)).rows[0].result;
  }
  async function rpcRows<T>(name: string, args: unknown[]) {
    return (await db.query<T>(`select * from public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")})`, args)).rows;
  }
  async function fails(action: () => Promise<unknown>, pattern: RegExp) {
    await db.exec("savepoint expected_failure");
    try { await expect(action()).rejects.toThrow(pattern); }
    finally { await db.exec("rollback to savepoint expected_failure; release savepoint expected_failure"); }
  }
  async function createLinkedOrder(outlet = restaurant) {
    return rpc<string>("create_room_linked_pos_order", [outlet, "takeaway", null, null, stay, "101"]);
  }
  async function addLine(orderId: string) {
    await admin(`insert into public.pos_order_lines(hotel_id,outlet_id,order_id,menu_item_id,item_code_snapshot,item_name_snapshot,unit_price_kobo,base_unit_price_kobo,quantity)
      values ($1,$2,$3,'60000000-0000-4000-8000-000000000011','meal','Meal',10000,10000,1)`, [hotel, restaurant, orderId]);
  }
  beforeAll(async () => {
    db = await createReconciliationDatabase();
    await db.exec(`
      insert into public.hotels(id,legal_name,trading_name) values
        ('${hotel}','Hotel One','Hotel One'),('${otherHotel}','Hotel Two','Hotel Two');
      insert into public.hotel_settings(hotel_id) values ('${hotel}'),('${otherHotel}');
      insert into auth.users(id,raw_user_meta_data) values
        ('${restaurantStaff}','{"full_name":"Restaurant Staff"}'),
        ('${receptionist}','{"full_name":"Receptionist"}'),
        ('${barStaff}','{"full_name":"Bar Staff"}');
      insert into public.user_roles(profile_id,role_id)
        select v.id::uuid,r.id from (values
          ('${restaurantStaff}','restaurant_staff'),('${receptionist}','receptionist'),('${barStaff}','bar_staff')) v(id,code)
          join public.roles r on r.hotel_id='${hotel}' and r.code=v.code;
      insert into public.room_types(id,hotel_id,name,base_rate_kobo,capacity)
        values ('30000000-0000-4000-8000-000000000010','${hotel}','Standard',10000,2);
      insert into public.rooms(id,hotel_id,room_type_id,room_number)
        values ('${room}','${hotel}','30000000-0000-4000-8000-000000000010','101');
      insert into public.guests(id,hotel_id,full_name)
        values ('30000000-0000-4000-8000-000000000012','${hotel}','Test Guest');
      insert into public.stays(id,hotel_id,guest_id,room_id,actual_check_in_date,expected_check_out_date,agreed_rate_kobo)
        values ('${stay}','${hotel}','30000000-0000-4000-8000-000000000012','${room}',current_date,current_date+2,10000);
      insert into public.departments(hotel_id,code,name) values
        ('${hotel}','restaurant','Restaurant'),('${hotel}','bar','Bar');
      insert into public.pos_outlets(id,hotel_id,code,name,outlet_type,department_code) values
        ('${restaurant}','${hotel}','restaurant','6393 Restaurant','restaurant','restaurant'),
        ('${bar}','${hotel}','bar','Gemini Bar','bar','bar');
      insert into public.pos_menu_categories(id,hotel_id,outlet_id,code,name)
        values ('60000000-0000-4000-8000-000000000010','${hotel}','${restaurant}','meals','Meals');
      insert into public.pos_menu_items(id,hotel_id,outlet_id,category_id,code,name)
        values ('60000000-0000-4000-8000-000000000011','${hotel}','${restaurant}','60000000-0000-4000-8000-000000000010','meal','Meal');
    `);
  }, 60_000);
  beforeEach(async () => { await db.exec("begin"); await as(restaurantStaff); });
  afterEach(async () => { await db.exec("rollback; reset role"); });
  afterAll(async () => { await db?.close(); });

  it("verifies only a specified occupied room for the permitted outlet", async () => {
    const occupant = await rpcRows<{ stay_id: string; guest_name: string }>("get_pos_room_occupant", [restaurant, "101"]);
    expect(occupant).toMatchObject([{ stay_id: stay, guest_name: "Test Guest" }]);
    expect(await rpcRows("get_pos_room_occupant", [restaurant, "999"])).toEqual([]);
    await fails(() => rpcRows("get_pos_room_occupant", [bar, "101"]), /Not authorised/);
    await as(barStaff);
    expect(await rpcRows("get_pos_room_occupant", [bar, "101"])).toMatchObject([{ stay_id: stay }]);
    await as(receptionist);
    await fails(() => rpcRows("get_pos_room_occupant", [restaurant, "101"]), /Not authorised/);
  });

  it("requires current occupant and preserves outlet separation", async () => {
    await fails(() => rpc("create_room_linked_pos_order", [restaurant, "takeaway", null, null, stay, "999"]), /occupant changed/i);
    await fails(() => createLinkedOrder(bar), /Not authorised/);
    const id = await createLinkedOrder();
    const order = await admin("select stay_id,room_number_snapshot,outlet_id,guest_label from public.pos_orders where id=$1", [id]);
    expect(order.rows[0]).toMatchObject({ stay_id: stay, room_number_snapshot: "101", outlet_id: restaurant, guest_label: "Test Guest" });
  });

  it("shows unpaid room orders to Reception and blocks checkout until paid", async () => {
    const id = await createLinkedOrder();
    await addLine(id);
    await as(receptionist);
    const holds = await rpcRows<{ order_id: string; balance_kobo: number; outlet_name: string }>("get_room_pos_checkout_holds", [hotel]);
    expect(holds).toMatchObject([{ order_id: id, balance_kobo: 10000, outlet_name: "6393 Restaurant" }]);
    await fails(() => admin("update public.stays set status='checked_out' where id=$1", [stay]), /unsettled Restaurant or Bar orders/);
    await admin(`insert into public.payment_methods(id,hotel_id,code,name) values
      ('70000000-0000-4000-8000-000000000011',$1,'cash','Cash') on conflict(hotel_id,code) do nothing`, [hotel]);
    const method = (await admin("select id from public.payment_methods where hotel_id=$1 and code='cash'", [hotel])).rows[0].id;
    await admin(`insert into public.pos_order_payments(hotel_id,outlet_id,order_id,payment_number,payment_method_id,payment_method_name_snapshot,amount_kobo,status)
      values ($1,$2,$3,'TEST-PENDING',$4,'Cash',10000,'pending_verification')`, [hotel, restaurant, id, method]);
    expect(await rpcRows("get_room_pos_checkout_holds", [hotel])).toMatchObject([{ pending_kobo: 10000 }]);
    await fails(() => admin("update public.stays set status='checked_out' where id=$1", [stay]), /unsettled Restaurant or Bar orders/);
    await admin("update public.pos_order_payments set status='voided',voided_at=now(),void_reason='Not received' where payment_number='TEST-PENDING'");
    await admin(`insert into public.pos_order_payments(hotel_id,outlet_id,order_id,payment_number,payment_method_id,payment_method_name_snapshot,amount_kobo,status)
      values ($1,$2,$3,'TEST-PAY',$4,'Cash',10000,'completed')`, [hotel, restaurant, id, method]);
    expect(await rpcRows("get_room_pos_checkout_holds", [hotel])).toEqual([]);
    await admin("update public.stays set status='checked_out' where id=$1", [stay]);
    await fails(() => addLine(id), /after the guest checked out/);
  });

  it("does not let outlet staff read checkout holds and does not block for walk-in orders", async () => {
    await fails(() => rpcRows("get_room_pos_checkout_holds", [hotel]), /Not authorised/);
    const id = await rpc<string>("create_restaurant_pos_order", [restaurant, "takeaway", null, "Walk-in guest"]);
    await addLine(id);
    await admin("update public.stays set status='checked_out' where id=$1", [stay]);
  });
});
