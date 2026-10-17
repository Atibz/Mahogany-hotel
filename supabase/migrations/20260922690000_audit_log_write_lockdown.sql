-- Audit evidence must only be produced by controlled workflow functions.
-- Direct browser inserts would allow staff to fabricate otherwise plausible
-- entries using their own actor ID.

revoke insert on public.activity_logs from authenticated;
drop policy if exists activity_logs_insert on public.activity_logs;
