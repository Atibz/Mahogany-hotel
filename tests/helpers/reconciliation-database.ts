import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

// Apply the real application migrations. Only Supabase-owned infrastructure is
// replaced: auth identity, storage metadata, and the unavailable cron scheduler.
// pgcrypto is omitted because PostgreSQL provides gen_random_uuid natively and
// these tests do not use encryption. No finance schema/function is mocked.
export async function createReconciliationDatabase() {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}', email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    create schema cron;
    create table cron.job(jobid bigint, jobname text);
    create function cron.unschedule(bigint) returns boolean language sql as $$ select true $$;
  `);
  const directory = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));
  try {
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      if (name === "20260922670000_scheduled_night_audit.sql") continue;
      const sql = readFileSync(`${directory}/${name}`, "utf8").replace("create extension if not exists pgcrypto;", "");
      try { await db.exec(sql); } catch (error) { throw new Error(`Migration ${name}: ${String(error)}`, { cause: error }); }
    }
    return db;
  } catch (error) { await db.close(); throw error; }
}
