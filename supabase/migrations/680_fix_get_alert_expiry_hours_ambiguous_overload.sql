-- Migration 680: real bug, live and reported — a super admin couldn't
-- post ANY appeal ("something went wrong") because
-- get_alert_expiry_hours had two overloads that collide:
--   get_alert_expiry_hours(p_alert_type varchar)
--   get_alert_expiry_hours(p_alert_type varchar, p_tenant_id uuid DEFAULT NULL)
-- The second one's default makes it callable with exactly one argument
-- too, so every single-argument call (create_appeal's own call among
-- them) became genuinely ambiguous to Postgres and failed outright.
-- The two-arg version is a strict superset of the one-arg version's
-- logic (same lookup, plus tenant scoping via
-- COALESCE(p_tenant_id, my_tenant_id())) -- dropping the older one-arg
-- overload is a pure fix, not a behavior change: every existing
-- one-argument call site keeps working exactly as before, just
-- properly tenant-scoped now too.

DROP FUNCTION IF EXISTS public.get_alert_expiry_hours(character varying);
