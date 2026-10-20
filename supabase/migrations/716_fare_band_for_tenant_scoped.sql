-- Migration 716: fare_band_for() was never scoped to the calling
-- tenant, even after migration 699 made fare_bands a per-tenant table
-- (tenant_id added, ON CONFLICT (tenant_id, flow)). Its SELECT policy
-- is `USING (true)` (every tenant's rows are readable by everyone, by
-- design — this is pricing config, not secret data), so a plain
-- `WHERE flow = p_flow` now matches one row per tenant. A plain SQL
-- function silently keeps only the FIRST row of a multi-row result
-- (documented Postgres behavior, no error) — so every call to
-- fare_band_for(), including the one place_trip_offer/create_vehicle_route_self
-- use to compute the real fare ceiling, has been silently reading
-- *some* tenant's numbers, not necessarily the caller's own. Invisible
-- today only because all 3 tenants happen to have identical
-- base/per_km/spread — the instant one committee retunes its own rate
-- via marketplace-reference, every OTHER tenant's drivers would start
-- getting capped by the wrong numbers.
--
-- Same coalesce(my_tenant_id(), <dhab-pari's own id>) fallback already
-- used by every other tenant-scoped helper (migration 570) — so an
-- anonymous/public caller with no tenant context still resolves to
-- dhab-pari exactly as before this existed.
CREATE OR REPLACE FUNCTION fare_band_for(p_flow varchar, p_km decimal) RETURNS jsonb AS $$
  SELECT fare_band(base_pkr, per_km_pkr, p_km, spread)
  FROM fare_bands
  WHERE flow = p_flow
    AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$$ LANGUAGE sql STABLE;
GRANT EXECUTE ON FUNCTION fare_band_for(varchar, decimal) TO authenticated, anon;
