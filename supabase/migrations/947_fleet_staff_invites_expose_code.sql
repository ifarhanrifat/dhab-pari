-- Migration 947: small follow-up to 946 — the owner needs to read a
-- pending invite's code back out loud again without regenerating it
-- (the whole point of showing it in the list, not just at the moment
-- of creation). my_fleet_staff_invites didn't return it at all.
CREATE OR REPLACE FUNCTION my_fleet_staff_invites(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', i.id, 'invited_phone', i.invited_phone, 'role', i.role, 'code', i.code, 'created_at', i.created_at, 'expires_at', i.expires_at,
    'redeemed_at', i.redeemed_at, 'redeemed_full_name', pu.full_name
  ) ORDER BY i.created_at DESC), '[]'::jsonb)
  FROM fleet_staff_invites i
  LEFT JOIN portal_users pu ON pu.id = i.redeemed_by_portal_user_id
  WHERE i.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = i.fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;
