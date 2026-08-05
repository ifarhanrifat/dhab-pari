-- Migration 109: Supabase security advisor flagged voucher_counters and
-- complaint_number_counters as public tables with RLS disabled.
--
-- Both are pure internal sequence counters, only ever touched by their
-- SECURITY DEFINER functions (next_voucher_no / next_complaint_number,
-- migrations 009 / 063) — no frontend code reads or writes them directly
-- (confirmed by grep). So unlike every other table in this app, they don't
-- need any read/write policy at all: enabling RLS with zero policies denies
-- all PostgREST access outright, while the counter functions keep working
-- exactly as before since they run as the table owner, which bypasses RLS
-- by default (no FORCE ROW LEVEL SECURITY here) — same reasoning already
-- applied to reminder_queue's missing client write policy in migration 077.

ALTER TABLE voucher_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaint_number_counters ENABLE ROW LEVEL SECURITY;
