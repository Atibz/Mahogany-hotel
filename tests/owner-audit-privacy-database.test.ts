import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createReconciliationDatabase } from "./helpers/reconciliation-database";

const hotel = "10000000-0000-4000-8000-000000000011";
const owner = "20000000-0000-4000-8000-000000000011";
const manager = "20000000-0000-4000-8000-000000000012";
const accountant = "20000000-0000-4000-8000-000000000013";
const logId = "30000000-0000-4000-8000-000000000011";

type AuditRow = {
  actor_id: string | null;
  actor_name: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  display_amount_kobo: number;
};

describe("Owner audit identity privacy", () => {
  let db: PGlite;

  async function as(userId: string) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
    await db.exec("set role authenticated");
  }

  async function rawCount() {
    const result = await db.query<{ count: string }>(
      `select count(*)::text as count from public.activity_logs where id = '${logId}'`,
    );
    return Number(result.rows[0].count);
  }

  async function search(query?: string) {
    const text = query
      ? `select * from public.search_activity_register('${hotel}'::uuid,
          target_query := $1, target_action := 'privacy.audit_probe')`
      : `select * from public.search_activity_register('${hotel}'::uuid,
          target_action := 'privacy.audit_probe')`;
    return (await db.query<AuditRow>(text, query ? [query] : [])).rows;
  }

  beforeAll(async () => {
    db = await createReconciliationDatabase();
    await db.exec(`
      insert into public.hotels(id, legal_name, trading_name)
      values ('${hotel}', 'Privacy Test Hotel', 'Privacy Test');
      insert into public.permissions(code, name, description)
      values ('audit.read', 'View audit log', 'View activity history')
      on conflict(code) do nothing;
      select public.provision_hotel_roles('${hotel}');
      insert into auth.users(id, raw_user_meta_data) values
        ('${owner}', '{"full_name":"Private Owner Test Identity"}'),
        ('${manager}', '{"full_name":"Manager"}'),
        ('${accountant}', '{"full_name":"Accountant"}');
      insert into public.user_roles(profile_id, role_id)
      select v.profile_id::uuid, r.id
      from (values ('${owner}', 'owner'), ('${manager}', 'general_manager'),
        ('${accountant}', 'accountant')) v(profile_id, code)
      join public.roles r on r.hotel_id = '${hotel}' and r.code = v.code;
      insert into public.activity_logs(id, hotel_id, actor_id, action, entity_type,
        entity_id, metadata)
      values ('${logId}', '${hotel}', '${owner}', 'privacy.audit_probe',
        'test_record', '${owner}',
        '{"amount_kobo":12345,"private_marker":"owner-secret-test"}');
      insert into public.activity_logs(hotel_id, actor_id, action, entity_type, metadata)
      values ('${hotel}', '${manager}', 'privacy.staff_probe', 'test_record', '{}');
    `);
  }, 60_000);

  afterAll(async () => { await db?.close(); });

  for (const [role, userId] of [["GM", manager], ["Accountant", accountant]] as const) {
    it(`masks Owner-authored evidence from ${role} at both database paths`, async () => {
      await as(userId);
      expect(await rawCount()).toBe(0);
      const ordinary = await db.query<{ actor_id: string }>(
        "select actor_id from public.activity_logs where action = 'privacy.staff_probe'",
      );
      expect(ordinary.rows).toEqual([{ actor_id: manager }]);
      const rows = await search();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_id: null,
        actor_name: "Restricted administrator",
        entity_id: null,
        metadata: {},
        display_amount_kobo: 12345,
      });
      for (const hidden of ["Private Owner Test Identity", "owner-secret-test", owner]) {
        expect(await search(hidden)).toHaveLength(0);
      }
    });
  }

  it("retains the full immutable evidence for the Owner", async () => {
    await as(owner);
    expect(await rawCount()).toBe(1);
    const rows = await search();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: owner,
      actor_name: "Private Owner Test Identity",
      entity_id: owner,
      metadata: { amount_kobo: 12345, private_marker: "owner-secret-test" },
    });
  });
});
