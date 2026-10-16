-- Migration 681: real ask, live — "can a click on those news and
-- alerts and sponsored add click can be land to its actual place like
-- this vehicle that created route will get the click navigate to that
-- page where user can book ride?"
--
-- A commercial ilan already carries vehicle_route_id/vehicle_trip_offer_id
-- (671/677) — no schema change needed there, AnnouncementBar just needs
-- to select them and compute the real booking URL.
--
-- An appeal's only structured destination today is a linked project —
-- my_appeals()/public_appeals() never returned project_id at all, so
-- there was nothing to link to even for a 'project' kind appeal.
-- News ticker items have no structured destination in the schema
-- (plain text only) and are left as-is here -- a genuine gap, not an
-- oversight, flagged rather than guessed at.

-- Reproduced from its real, current body (the first attempt at this
-- migration truncated mid-fetch and would have silently dropped the
-- audience-targeting CASE and ORDER BY entirely -- caught before
-- applying by re-fetching the full definition). Only change: project_id
-- added to the return columns and the SELECT list. A changed RETURNS
-- TABLE shape needs DROP first -- CREATE OR REPLACE alone refuses it.
DROP FUNCTION IF EXISTS public.my_appeals();
CREATE OR REPLACE FUNCTION public.my_appeals()
 RETURNS TABLE(id uuid, kind text, severity text, title_en text, title_ur text, body_en text, body_ur text, contact_number text, created_at timestamp with time zone, project_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE u portal_users%ROWTYPE;
BEGIN
  SELECT * INTO u FROM portal_users WHERE auth_user_id = auth.uid() AND is_active = true;
  IF u.id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT a.id, a.kind::text, a.severity::text, a.title_en::text, a.title_ur::text,
         a.body_en, a.body_ur, a.contact_number::text, a.created_at, a.project_id
    FROM appeals a
   WHERE a.tenant_id = u.tenant_id
     AND a.status = 'active'
     AND a.starts_at <= now()
     AND (a.expires_at IS NULL OR a.expires_at > now())
     AND CASE a.audience
       WHEN 'everyone'  THEN true
       WHEN 'consumers' THEN u.consumer_id IS NOT NULL
       WHEN 'donors'    THEN u.donor_account_id IS NOT NULL
       WHEN 'villagers' THEN COALESCE(u.donor_type, 'villager') = 'villager'
       WHEN 'overseas'  THEN u.donor_type = 'overseas'
                             AND (cardinality(a.audience_countries) = 0
                                  OR u.country = ANY (a.audience_countries))
       ELSE false
     END
   ORDER BY CASE a.severity WHEN 'emergency' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
            a.created_at DESC;
END;
$function$;

DROP FUNCTION IF EXISTS public.public_appeals();
CREATE OR REPLACE FUNCTION public.public_appeals()
 RETURNS TABLE(id uuid, kind text, severity text, title_en text, title_ur text, body_en text, body_ur text, contact_number text, created_at timestamp with time zone, project_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.id, a.kind::text, a.severity::text, a.title_en::text, a.title_ur::text,
         a.body_en, a.body_ur, a.contact_number::text, a.created_at, a.project_id
    FROM appeals a
   WHERE a.tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
     AND a.status = 'active'
     AND a.is_public
     AND a.starts_at <= now()
     AND (a.expires_at IS NULL OR a.expires_at > now())
   ORDER BY CASE a.severity WHEN 'emergency' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
            a.created_at DESC;
$function$;
