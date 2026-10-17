-- Keep an unverified payment distinct from money that has actually settled.
-- This is deliberately a standalone migration: PostgreSQL must commit a new
-- enum value before later migrations can safely use it.

alter type public.payment_status add value if not exists 'pending_verification';
