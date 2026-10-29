# Private Owner day-close email

The Owner account remains an emergency approval backup. Staff instructions route routine work to the GM/accountant. The Owner account and this report delivery are not listed in staff administration. Actual Owner actions are still recorded in immutable audit history.

Migration `20261027100000` prevents GM/Accountant direct reads of Owner-authored activity rows. Their searchable audit register still shows that an action occurred, its time, type, and displayed amount, but returns a restricted actor label and omits actor ID, entity ID, and free-form evidence for those rows. It also prevents searches over the hidden fields. The Owner retains complete audit access. This does not anonymise a deliberate Owner approval in another operational screen; keep routine approvals with the GM/accountant and preserve truthful approval evidence.

## What triggers the report

Closing a business day inserts one private outbox job in `owner_daily_close_email_jobs`. The email uses that close's stored snapshot. It also retrieves separate restaurant/bar collections and expenses grouped by **payment date** at send time. It does not combine those businesses with hotel revenue, and it does not claim collections equal bank settlement.

The report is **not sent by the receptionist's browser**. A scheduled server-to-server invocation must call `send-owner-daily-close` until pending jobs are processed. An open/unclosed day has no report job. Arrange a missing-close alert separately before client handover; otherwise a skipped close could suppress the day's email.

## Private deployment checklist

1. Apply the two 2026-10-26 migrations in order, after the existing migrations. Do not paste individual migration bodies repeatedly into the SQL editor.
2. Configure Edge Function secrets: `RESEND_API_KEY`, `OWNER_REPORT_EMAIL_FROM` (verified sender on a domain the hotel controls), and a new random `OWNER_REPORT_CRON_SECRET` of at least 32 characters. Do not put the secret or the recipient in frontend env files or Git.
3. Deploy `send-owner-daily-close` with JWT verification disabled as set in `supabase/config.toml`.
4. Configure a private scheduler (for example Supabase Cron + pg_net with the token stored in Vault) to POST to `https://<project-ref>.supabase.co/functions/v1/send-owner-daily-close` every five minutes with header `x-owner-report-token: <secret>`. Do not expose that schedule, token, or email address in a staff UI. A scheduler response of `processed: 0` means the queue is empty.
5. Confirm there is exactly one active Owner role assignment whose Auth user has the intended email address. The function refuses to send if this is ambiguous. Staff invitations cannot assign this role.
6. On a test close, confirm one job, one email to that address, correct hotel/date/amounts, and status `sent`. Test a rejected provider response and retry without duplicate mail. Only a database administrator should inspect delivery jobs.

The provider's accepted response is **not proof of inbox delivery**. Verify delivery in the email provider and the Owner's inbox; monitor bounces. Keep a secure on-call process for queued failures. A person with database-administrator or provider access may still discover the Owner account or email, so “discreet” here means hidden from ordinary staff access, not invisible to trusted infrastructure administrators.
