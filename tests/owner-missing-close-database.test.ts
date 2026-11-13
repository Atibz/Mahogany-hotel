import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createReconciliationDatabase } from "./helpers/reconciliation-database";

const hotelId = "10000000-0000-4000-8000-000000000091";
const closedHotelId = "10000000-0000-4000-8000-000000000092";

type Alert = { hotel_id: string; business_date: string; status: string; attempts: number };

describe("private Owner missing-close alert", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createReconciliationDatabase();
    await db.exec(`
      insert into public.hotels(id, legal_name, trading_name, created_at)
      values ('${hotelId}', 'Unclosed Hotel', 'Unclosed Hotel', now() - interval '3 days'),
        ('${closedHotelId}', 'Closed Hotel', 'Closed Hotel', now() - interval '3 days');
      insert into public.hotel_settings(hotel_id) values ('${hotelId}'), ('${closedHotelId}');
      insert into public.business_day_closes(hotel_id, business_date, close_number, snapshot)
      values ('${closedHotelId}',
        public.hotel_calendar_business_date('${closedHotelId}', now()) - 1,
        'DAC-CLOSED-TEST', '{}'::jsonb);
    `);
  }, 60_000);

  afterAll(async () => { await db?.close(); });

  it("queues one alert after the hotel cutoff without alerting an already closed day", async () => {
    const first = await db.query<Alert>("select hotel_id, business_date, status, attempts from public.claim_owner_missing_close_alert()");
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ hotel_id: hotelId, status: "sending", attempts: 1 });
    const expected = await db.query<{ business_date: string }>(
      `select (public.hotel_calendar_business_date('${hotelId}', now()) - 1)::text as business_date`,
    );
    expect(new Date(first.rows[0].business_date).toISOString().slice(0, 10))
      .toBe(expected.rows[0].business_date);

    const second = await db.query("select * from public.claim_owner_missing_close_alert()");
    expect(second.rows).toHaveLength(0);
    const counts = await db.query<{ count: string }>(
      "select count(*)::text as count from public.owner_missing_close_alert_jobs",
    );
    expect(counts.rows[0].count).toBe("1");
  });

  it("resolves a pending alert if the day is closed before delivery", async () => {
    await db.exec(`
      update public.owner_missing_close_alert_jobs
      set status = 'pending', locked_until = null
      where hotel_id = '${hotelId}';
      insert into public.business_day_closes(hotel_id, business_date, close_number, snapshot)
      values ('${hotelId}',
        public.hotel_calendar_business_date('${hotelId}', now()) - 1,
        'DAC-LATE-TEST', '{}'::jsonb);
    `);
    const claimed = await db.query("select * from public.claim_owner_missing_close_alert()");
    expect(claimed.rows).toHaveLength(0);
    const status = await db.query<{ status: string }>(
      `select status from public.owner_missing_close_alert_jobs where hotel_id = '${hotelId}'`,
    );
    expect(status.rows[0].status).toBe("resolved");
  });

  it("hides alert jobs and claim access from browser roles", async () => {
    const access = await db.query<{ table_read: boolean; function_execute: boolean }>(`
      select has_table_privilege('authenticated', 'public.owner_missing_close_alert_jobs', 'SELECT') as table_read,
        has_function_privilege('authenticated', 'public.claim_owner_missing_close_alert()', 'EXECUTE') as function_execute
    `);
    expect(access.rows[0]).toEqual({ table_read: false, function_execute: false });
    await db.exec("set role authenticated");
    try {
      await expect(db.query("select * from public.owner_missing_close_alert_jobs"))
        .rejects.toThrow();
      await expect(db.query("select * from public.claim_owner_missing_close_alert()"))
        .rejects.toThrow();
    } finally {
      await db.exec("reset role");
    }
  });
});
