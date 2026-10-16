-- Migration 679: real bug found live -- "why ilan belt is not running."
-- commercial_ilans' public/authenticated display policies (671) used
-- request_tenant_id() with no fallback, unlike every other public-belt
-- policy in this schema (news_ticker, emergency_broadcasts before it
-- was removed) which all COALESCE to the Dhab Pari UUID when the
-- x-tenant-id header isn't set -- true for the bare apex domain
-- (dhabpari.com, no subdomain), which is exactly where this was tested.
-- request_tenant_id() returning NULL made `NULL = ANY(...)` evaluate to
-- NULL (not true) instead of ever matching, so the row was invisible to
-- every anonymous visitor on the main domain, full stop.

DROP POLICY IF EXISTS commercial_ilans_display_public ON commercial_ilans;
CREATE POLICY commercial_ilans_display_public ON commercial_ilans
  FOR SELECT TO anon
  USING (
    status = 'approved' AND is_paused = false
    AND starts_at <= now() AND ends_at > now()
    AND COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) = any(target_tenant_ids)
  );

DROP POLICY IF EXISTS commercial_ilans_display_authenticated ON commercial_ilans;
CREATE POLICY commercial_ilans_display_authenticated ON commercial_ilans
  FOR SELECT TO authenticated
  USING (
    status = 'approved' AND is_paused = false
    AND starts_at <= now() AND ends_at > now()
    AND COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) = any(target_tenant_ids)
  );
