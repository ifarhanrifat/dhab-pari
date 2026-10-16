-- Migration 684: caught live testing 683, same bug class as 680 --
-- CREATE OR REPLACE with new trailing DEFAULT params creates a SECOND
-- overload alongside the original exact-arity one, it does not replace
-- it. The 2-argument form (uuid, boolean) was left behind, making every
-- 2-argument call (every "go offline" call, and the trips page's own
-- import of this RPC before any UI even picks up the new lat/lng
-- params) genuinely ambiguous against the new 4-argument form.

DROP FUNCTION IF EXISTS public.set_vehicle_online_status(uuid, boolean);
