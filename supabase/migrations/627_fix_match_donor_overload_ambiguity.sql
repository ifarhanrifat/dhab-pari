-- Migration 626's CREATE OR REPLACE with a different parameter list
-- didn't replace the old single-argument function at all -- Postgres
-- treats a different signature as a new overload, so both
-- match_donor_account_by_phone(varchar) and
-- match_donor_account_by_phone(varchar, uuid) existed simultaneously,
-- making any single-argument call ambiguous (confirmed live: "function
-- match_donor_account_by_phone(unknown) is not unique"). Dropping the old
-- one-argument overload explicitly -- the two-argument version (with
-- p_tenant_id DEFAULT NULL) already serves every existing one-argument
-- call site unchanged.
drop function if exists public.match_donor_account_by_phone(character varying);

-- The new two-argument overload was created fresh (not a true REPLACE of
-- the old one), so it never inherited migration 357's original explicit
-- grants. Restoring them exactly: anon excluded, authenticated allowed —
-- the signup/service-role callers bypass grants entirely regardless, so
-- this only matters for any future direct client-side RPC call.
revoke all on function public.match_donor_account_by_phone(character varying, uuid) from public, anon;
grant execute on function public.match_donor_account_by_phone(character varying, uuid) to authenticated;
