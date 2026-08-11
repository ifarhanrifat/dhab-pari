-- Migration 193: actually keep anon out of the blood and badge functions.
--
-- Migrations 189, 190 and 191 all ended with `REVOKE ALL ON FUNCTION ... FROM
-- PUBLIC` followed by `GRANT ... TO authenticated`, on the assumption that this
-- left anon with nothing. It does not. Supabase ships
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
--
-- so every new function is granted to anon *explicitly, by name*, and revoking
-- from PUBLIC does not touch an explicit role grant. Migration 190 — whose
-- entire purpose was to close this on eligible_blood_donors — changed nothing.
--
-- Verified with the anon key after 192: all eight blood functions and both
-- badge functions were reachable. None of them leaked, because each one guards
-- itself (auth.uid() is NULL for anon, so the permission checks refuse and
-- eligible_blood_donors returns no rows) — the defence in depth held. But
-- "reachable and refused" is not what the migrations claimed, and it leaves the
-- internal guard as the only thing standing between an anonymous caller and
-- these bodies.
--
-- REVOKE names anon directly. PUBLIC stays in the list because it costs
-- nothing and covers a role added later.
REVOKE ALL ON FUNCTION eligible_blood_donors(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION approve_blood_request(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION cancel_blood_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fulfil_blood_request(uuid, uuid[], date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION set_blood_request_paused(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION post_blood_request_ticker(uuid, varchar) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION post_blood_thanks_ticker(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION respond_to_blood_request(uuid, varchar) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION admin_sidebar_badges() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION portal_sidebar_badges() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION eligible_blood_donors(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION approve_blood_request(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION cancel_blood_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION fulfil_blood_request(uuid, uuid[], date) TO authenticated;
GRANT EXECUTE ON FUNCTION set_blood_request_paused(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION post_blood_request_ticker(uuid, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION post_blood_thanks_ticker(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION respond_to_blood_request(uuid, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_sidebar_badges() TO authenticated;
GRANT EXECUTE ON FUNCTION portal_sidebar_badges() TO authenticated;

-- Deliberately NOT revoked — these two are the public face of the feature and
-- must stay callable by a signed-out visitor:
--   blood_group_counts()    eight rows of integers, no identity
--   submit_blood_request()  the open request form, throttled inside
