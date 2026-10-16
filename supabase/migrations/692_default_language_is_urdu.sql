-- Migration 692: real ask, 2026-10-17 — the app should open in Urdu by
-- default, not flash English first. The frontend (LocaleProvider) now
-- paints Urdu on first render instead of English, which already fixes
-- Dhab Pari itself (its own site_settings.display_language is already
-- 'ur'). But my_language()'s own hardcoded last-resort fallback was
-- still 'en' — Dhab Kalan and Dhab Khushal have no display_language
-- row of their own at all, so any of their users with no personal
-- preference saved would get an Urdu-painted page that then flashed
-- to English once this RPC resolved. Urdu is this product's real
-- default everywhere, not just the one village that happened to set
-- it explicitly, so the fallback itself changes instead of only
-- patching the two tenants missing a row.

CREATE OR REPLACE FUNCTION public.my_language()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT preferred_language FROM admin_users
      WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    (SELECT preferred_language FROM portal_users
      WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    (SELECT value FROM site_settings WHERE tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND key = 'display_language'),
    'ur'
  );
$function$;
