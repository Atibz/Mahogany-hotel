import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createReconciliationDatabase } from "./helpers/reconciliation-database";

const hotel = "11000000-0000-4000-8000-000000000011";
const gm = "21000000-0000-4000-8000-000000000011";
const restaurant = "31000000-0000-4000-8000-000000000011";
const bar = "31000000-0000-4000-8000-000000000012";
const item = "41000000-0000-4000-8000-000000000011";
const drink = "41000000-0000-4000-8000-000000000012";
const option = "41000000-0000-4000-8000-000000000013";
const stock = "51000000-0000-4000-8000-000000000011";

describe("POS recipe-driven stock movements", () => {
  let db: PGlite;
  let restaurantLocation: string;
  let barLocation: string;
  async function query<T>(sql: string, params: unknown[] = []) {
    await db.exec("reset role");
    return (await db.query<T>(sql, params)).rows;
  }
  async function asGm() {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [gm]);
    await db.exec("set local role authenticated");
  }
  async function configure(kind: string, id: string, components: object[]) {
    await asGm();
    await db.query("select public.configure_pos_stock_components($1,$2,$3,$4,$5)",
      [kind, id, "automatic", JSON.stringify(components), "Verified test portion sheet"]);
  }
  async function balance(location: string) {
    const rows = await query<{ balance: string }>(
      "select coalesce(sum(quantity_delta),0)::text as balance from public.inventory_movements where item_id=$1 and location_id=$2", [stock, location]);
    return Number(rows[0].balance);
  }
  async function order(outlet = restaurant) {
    const rows = await query<{ id: string }>(`insert into public.pos_orders(hotel_id,outlet_id,order_number,business_date,service_mode,outlet_name_snapshot,department_code_snapshot)
      values ($1,$2,'TEST-' || gen_random_uuid(),current_date,'takeaway','Test outlet','restaurant') returning id`, [hotel, outlet]);
    return rows[0].id;
  }
  async function line(orderId: string, menuItem = item, outlet = restaurant, quantity = 2) {
    const rows = await query<{ id: string }>(`insert into public.pos_order_lines(hotel_id,outlet_id,order_id,menu_item_id,item_code_snapshot,item_name_snapshot,unit_price_kobo,base_unit_price_kobo,quantity)
      values ($1,$2,$3,$4,'test','Test item',10000,10000,$5) returning id`, [hotel, outlet, orderId, menuItem, quantity]);
    return rows[0].id;
  }
  beforeAll(async () => {
    db = await createReconciliationDatabase();
    await query(`insert into public.hotels(id,legal_name,trading_name) values ($1,'Test Hotel','Test Hotel')`, [hotel]);
    await query("insert into public.hotel_settings(hotel_id) values ($1)", [hotel]);
    await query("insert into auth.users(id,raw_user_meta_data) values ($1,'{\"full_name\":\"GM\"}')", [gm]);
    await query(`insert into public.user_roles(profile_id,role_id) select $1,r.id from public.roles r where r.hotel_id=$2 and r.code='general_manager'`, [gm, hotel]);
    await query(`insert into public.departments(hotel_id,code,name) values ($1,'restaurant','Restaurant'),($1,'bar','Bar')`, [hotel]);
    await query(`insert into public.pos_outlets(id,hotel_id,code,name,outlet_type,department_code) values
      ($1,$3,'restaurant','Restaurant','restaurant','restaurant'),($2,$3,'bar','Bar','bar','bar')`, [restaurant, bar, hotel]);
    await query(`insert into public.pos_menu_categories(id,hotel_id,outlet_id,code,name) values
      ('71000000-0000-4000-8000-000000000011',$1,$2,'food','Food'),
      ('71000000-0000-4000-8000-000000000012',$1,$3,'drinks','Drinks')`, [hotel, restaurant, bar]);
    await query(`insert into public.pos_menu_items(id,hotel_id,outlet_id,category_id,code,name) values
      ($1,$3,$4,'71000000-0000-4000-8000-000000000011','meal','Meal'),
      ($2,$3,$5,'71000000-0000-4000-8000-000000000012','drink','Drink')`, [item, drink, hotel, restaurant, bar]);
    await query(`insert into public.pos_menu_item_prices(hotel_id,outlet_id,menu_item_id,amount_kobo,effective_from)
      values ($1,$2,$3,10000,current_date)`, [hotel, restaurant, item]);
    await query(`insert into public.pos_modifier_groups(id,hotel_id,outlet_id,code,name) values
      ('81000000-0000-4000-8000-000000000011',$1,$2,'extras','Extras')`, [hotel, restaurant]);
    await query(`insert into public.pos_modifier_options(id,hotel_id,outlet_id,modifier_group_id,code,name) values
      ($1,$2,$3,'81000000-0000-4000-8000-000000000011','extra','Extra')`, [option, hotel, restaurant]);
    await query(`insert into public.inventory_items(id,hotel_id,item_code,name,category,base_unit) values
      ($1,$2,'ingredient','Ingredient','Food','portions')`, [stock, hotel]);
    const locations = await query<{ id: string; code: string }>("select id,code from public.inventory_locations where hotel_id=$1", [hotel]);
    restaurantLocation = locations.find((location) => location.code === "restaurant")!.id;
    barLocation = locations.find((location) => location.code === "bar")!.id;
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  it("deducts base and modifier once, then restores the exact movements on void", async () => {
    await db.exec("begin");
    try {
      await query(`insert into public.inventory_movements(hotel_id,item_id,location_id,movement_type,quantity_delta,reason)
        values ($1,$2,$3,'receipt',10,'Opening test stock')`, [hotel, stock, restaurantLocation]);
      await configure("menu_item", item, [{ item_id: stock, quantity: 1 }]);
      await configure("modifier_option", option, [{ item_id: stock, quantity: 0.5 }]);
      const id = await order();
      const lineId = await line(id);
      await query(`insert into public.pos_order_line_modifiers(hotel_id,outlet_id,order_line_id,modifier_group_id,modifier_option_id,group_code_snapshot,group_name_snapshot,option_code_snapshot,option_name_snapshot,price_delta_kobo)
        values ($1,$2,$3,'81000000-0000-4000-8000-000000000011',$4,'extras','Extras','extra','Extra',0)`, [hotel, restaurant, lineId, option]);
      expect(await balance(restaurantLocation)).toBe(7);
      expect((await query<{ count: string }>("select count(*)::text as count from public.inventory_movements where pos_order_id=$1 and movement_type='pos_sale'", [id]))[0].count).toBe("2");
      await configure("menu_item", item, [{ item_id: stock, quantity: 2 }]);
      await query(`update public.pos_orders set status='voided',voided_at=now(),void_reason='Test void',voided_by=$2 where id=$1`, [id, gm]);
      expect(await balance(restaurantLocation)).toBe(10);
      expect((await query<{ count: string }>("select count(*)::text as count from public.inventory_movements where pos_order_id=$1 and movement_type='pos_void'", [id]))[0].count).toBe("2");
    } finally { await db.exec("rollback"); }
  });

  it("rejects insufficient outlet stock without leaving an order line or movement", async () => {
    await db.exec("begin");
    try {
      await configure("menu_item", item, [{ item_id: stock, quantity: 1 }]);
      const id = await order();
      await db.exec("savepoint rejected_sale");
      await expect(line(id)).rejects.toThrow(/Insufficient .* stock/i);
      await db.exec("rollback to savepoint rejected_sale; release savepoint rejected_sale");
      expect((await query<{ count: string }>("select count(*)::text as count from public.pos_order_lines where order_id=$1", [id]))[0].count).toBe("0");
      expect((await query<{ count: string }>("select count(*)::text as count from public.inventory_movements where pos_order_id=$1", [id]))[0].count).toBe("0");
      expect(await balance(barLocation)).toBe(0);
    } finally { await db.exec("rollback"); }
  });

  it("leaves unconfigured sales visibly untracked and never draws restaurant stock for bar sales", async () => {
    await db.exec("begin");
    try {
      const id = await order(bar);
      const lineId = await line(id, drink, bar, 1);
      const rows = await query<{ stock_tracking_mode_snapshot: string }>("select stock_tracking_mode_snapshot from public.pos_order_lines where id=$1", [lineId]);
      expect(rows[0].stock_tracking_mode_snapshot).toBe("unconfigured");
      expect(await balance(restaurantLocation)).toBe(0);
      expect(await balance(barLocation)).toBe(0);
    } finally { await db.exec("rollback"); }
  });

  it("deducts stock through the authenticated POS order RPC, not only direct inserts", async () => {
    await db.exec("begin");
    try {
      await query(`insert into public.inventory_movements(hotel_id,item_id,location_id,movement_type,quantity_delta,reason)
        values ($1,$2,$3,'receipt',5,'Opening test stock')`, [hotel, stock, restaurantLocation]);
      await configure("menu_item", item, [{ item_id: stock, quantity: 1 }]);
      await asGm();
      const created = await db.query<{ id: string }>("select public.create_restaurant_pos_order($1,'takeaway',null,'Test guest') as id", [restaurant]);
      const id = created.rows[0].id;
      await db.query("select public.add_restaurant_pos_order_item($1,$2,2::smallint)", [id, item]);
      expect(await balance(restaurantLocation)).toBe(3);
      expect((await query<{ count: string }>("select count(*)::text as count from public.inventory_movements where pos_order_id=$1 and movement_type='pos_sale'", [id]))[0].count).toBe("1");
    } finally { await db.exec("rollback; reset role"); }
  });

  it("reports tracked, unconfigured add-on, usage, and physical variance separately", async () => {
    await db.exec("begin");
    try {
      await query(`insert into public.inventory_movements(hotel_id,item_id,location_id,movement_type,quantity_delta,reason)
        values ($1,$2,$3,'receipt',5,'Opening test stock')`, [hotel, stock, restaurantLocation]);
      await configure("menu_item", item, [{ item_id: stock, quantity: 1 }]);
      const id = await order();
      const lineId = await line(id);
      await query(`insert into public.pos_order_line_modifiers(hotel_id,outlet_id,order_line_id,modifier_group_id,modifier_option_id,group_code_snapshot,group_name_snapshot,option_code_snapshot,option_name_snapshot,price_delta_kobo)
        values ($1,$2,$3,'81000000-0000-4000-8000-000000000011',$4,'extras','Extras','extra','Extra',0)`, [hotel, restaurant, lineId, option]);
      await query(`insert into public.daily_operational_spot_checks(hotel_id,business_date,kind,item_id,location_id,expected_quantity,observed_quantity,evidence_note,submitted_by)
        values ($1,current_date,'stock',$2,$3,3,2,'Physical test count',$4)`, [hotel, stock, restaurantLocation, gm]);
      await asGm();
      const rows = await db.query<{ report: {
        outlets: { menu_automatic_units: number; option_unconfigured_units: number }[];
        usage: { item_id: string; quantity: number }[];
        physical_counts: { expected_quantity: number; observed_quantity: number }[];
      } }>("select public.get_pos_stock_coverage_report($1,current_date) as report", [hotel]);
      const restaurantRow = rows.rows[0].report.outlets.find((row) => Number(row.menu_automatic_units) === 2);
      expect(restaurantRow).toMatchObject({ menu_automatic_units: 2, option_unconfigured_units: 2 });
      expect(rows.rows[0].report.usage).toMatchObject([{ item_id: stock, quantity: 2 }]);
      expect(rows.rows[0].report.physical_counts).toMatchObject([{ expected_quantity: 3, observed_quantity: 2 }]);
      await db.query("select set_config('request.jwt.claim.sub','',true)");
      await db.exec("savepoint unauthorized_report");
      await expect(db.query("select public.get_pos_stock_coverage_report($1,current_date)", [hotel]))
        .rejects.toThrow(/Not authorised/);
      await db.exec("rollback to savepoint unauthorized_report; release savepoint unauthorized_report");
    } finally { await db.exec("rollback; reset role"); }
  });
});
