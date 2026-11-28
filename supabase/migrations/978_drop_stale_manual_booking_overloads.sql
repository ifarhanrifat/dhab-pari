-- Migration 978: real bug caught live while testing 977 — calling
-- record_manual_booking without explicitly naming p_discount_pct/
-- p_discount_value (both optional, defaulted) failed with PGRST203
-- "Could not choose the best candidate function", because migration 976
-- added those two trailing params via CREATE OR REPLACE without first
-- DROPping the previous (17-param, pre-discount) signature. In Postgres a
-- function's identity is its full argument-type list — adding new
-- trailing params, even with defaults, creates a second overload rather
-- than replacing the first, so both the pre-976 and post-976 versions of
-- record_manual_booking have existed side by side ever since, and the
-- same thing happened to record_manual_return_booking. The live app never
-- hit this because its own calls always pass every param including the
-- two new ones, which excludes the old overload from PostgREST's
-- candidate set — but anything that omits them (a future caller, a
-- script, this session's own verification) is ambiguous. Dropping the
-- orphaned pre-976 signatures here, now that 977 is confirmed to be the
-- one remaining real body.
DROP FUNCTION IF EXISTS record_manual_booking(
  uuid, date, int, varchar, decimal, uuid, varchar, varchar, uuid, uuid, int[], varchar, jsonb, numeric, numeric, varchar, uuid
);
DROP FUNCTION IF EXISTS record_manual_return_booking(
  uuid, date, int, varchar, decimal, uuid, varchar, varchar, uuid, int[], varchar, jsonb, uuid
);
