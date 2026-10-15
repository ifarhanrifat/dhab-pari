-- Migration 674: remove the separate emergency-admin broadcast system
-- (migration 670), per direct instruction to take it back out. The
-- user's own call after seeing the full picture: committees keep using
-- their existing single-tenant appeals/ilaan system exactly as it
-- already worked before 670 -- no separate login, no cross-tenant
-- broadcast layer. (The unrelated, still-live commercial ilan system,
-- migration 671+, is untouched by this.)

DROP FUNCTION IF EXISTS public.broadcast_emergency_alert(varchar, varchar, text, varchar, text, uuid[], timestamptz);
DROP TABLE IF EXISTS emergency_broadcasts;

DROP POLICY IF EXISTS tenants_emergency_admin_read ON tenants;
DROP FUNCTION IF EXISTS public.is_emergency_admin();
DROP FUNCTION IF EXISTS public.current_emergency_admin_id();
DROP TABLE IF EXISTS emergency_admins;
