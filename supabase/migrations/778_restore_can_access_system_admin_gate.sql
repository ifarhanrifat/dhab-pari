-- Migration 778: restore the per-user admin gate that can_access_system()
-- silently lost, 2026-11-02 — confirmed live before writing this.
--
-- can_access_system() originally (661) ANDed three things: (1) the
-- caller has an active admin_users row whose role/secondary_role/
-- access_* flags are granted by role_grants_system() for p_system, (2)
-- the caller's tenant has that system's module flag enabled, (3) the
-- caller's tenant is billing_exempt or has an active/trialing/past_due
-- subscription. 671's "reproduced from its real, current body" rewrite
-- (committed on top of 661 in the same migration sequence) dropped (1)
-- and (3) entirely, keeping only (2), and switched the tenant lookup to
-- my_tenant_id() — a function that resolves for ANY signed-in portal
-- user, not just staff. 675 built further on top of 671's already-broken
-- version instead of 661's original. Net effect, live right now: every
-- one of the ~89 RLS policies shaped `tenant_id = my_tenant_id() AND
-- can_access_system(...)` passes for any authenticated portal user on a
-- tenant with that module enabled — no admin_users row required at all.
-- Confirmed read-only in a rolled-back transaction, impersonating a real
-- portal user with zero admin_users rows: they could count all donors,
-- vouchers, ledger_entries, and other riders' ride_bookings.
--
-- Fix, scoped deliberately to the actual security hole: restore part (1)
-- — the tenant lookup now goes through the admin_users row itself, never
-- my_tenant_id() (exactly the vulnerability vector — an ordinary portal
-- user has no admin_users row, so this naturally returns false for
-- them) — and keep part (2), the per-system CASE carried forward from
-- 675 (water_supply/donors_projects/commercial_ilans/marketplace/else
-- true) so none of 671/675's added systems or plan-gating regress.
--
-- Part (3), the billing_exempt/tenant_subscriptions re-check, is
-- deliberately NOT restored here — live subscription-row data wasn't
-- verified before writing this (a read against it was blocked this
-- session), and 661's original was a blunt AND across the whole
-- function: if any live tenant's subscription row doesn't cleanly read
-- as trialing/active/past_due, re-adding it blind would lock that
-- tenant's entire staff out of everything, trading a security bug for
-- an outage. It's also likely superseded already — 628's per-system
-- tenant.*_enabled flags (checked in part 2 above) are what
-- platform_subscribe_tenant actually keeps in sync with plan/billing
-- state now. Follow-up, once subscription data is confirmed clean: a
-- separate migration re-adding that third AND if it's still needed.
--
-- role_grants_system() and admin_user_can_access_system() (675) are
-- untouched — this migration only replaces can_access_system() itself.
--
-- No historical correction needed — this only changes what a future
-- call to can_access_system() returns, nothing it already returned is
-- stored anywhere.

CREATE OR REPLACE FUNCTION public.can_access_system(p_system character varying)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_admin admin_users%ROWTYPE;
  v_tenant tenants%ROWTYPE;
BEGIN
  SELECT * INTO v_admin FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF NOT COALESCE(role_grants_system(v_admin.role, v_admin.secondary_role, v_admin.access_water_supply, v_admin.access_donors_projects, v_admin.access_marketplace, p_system), false) THEN
    RETURN false;
  END IF;

  SELECT * INTO v_tenant FROM tenants WHERE id = v_admin.tenant_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  RETURN COALESCE(
    CASE p_system
      WHEN 'water_supply' THEN v_tenant.water_supply_enabled
      WHEN 'donors_projects' THEN v_tenant.donors_enabled
      WHEN 'commercial_ilans' THEN v_tenant.commercial_ilans_enabled
      WHEN 'marketplace' THEN v_tenant.marketplace_enabled
      ELSE true
    END, false);
END;
$function$;
