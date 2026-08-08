-- Migration 159: indexes on columns actually filtered/ordered by in the app
-- (verified against real call sites, not guessed) — bills, payments, donors,
-- and purchases had no supporting index at all despite being queried by
-- consumer_id/bill_id/is_verified/system+status constantly; vouchers had one
-- but on the wrong column combination for how it's actually filtered.
-- All IF NOT EXISTS / additive — no behavior change, safe to push directly.

CREATE INDEX IF NOT EXISTS bills_consumer_idx ON bills(consumer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_bill_idx ON payments(bill_id);
CREATE INDEX IF NOT EXISTS payments_consumer_idx ON payments(consumer_id, created_at DESC);

-- vouchers_system_idx (migration 009) is (system, voucher_date) — doesn't
-- help the .eq('system', system).in('status', [...]).order('created_at')
-- pattern used throughout finance/[system]/page.tsx and reports.
CREATE INDEX IF NOT EXISTS vouchers_system_status_idx ON vouchers(system, status, created_at DESC);

CREATE INDEX IF NOT EXISTS donors_verified_date_idx ON donors(is_verified, date DESC);
CREATE INDEX IF NOT EXISTS purchases_system_status_idx ON purchases(system, status, created_at DESC);

-- Used by finance/[system]/page.tsx to compute each voucher/bill's
-- auto-posted/fully-approved badge (a lookup by reference_id per card).
CREATE INDEX IF NOT EXISTS approval_requests_reference_idx ON approval_requests(reference_id, status);

CREATE INDEX IF NOT EXISTS agenda_meetings_date_idx ON agenda_meetings(meeting_date DESC);
