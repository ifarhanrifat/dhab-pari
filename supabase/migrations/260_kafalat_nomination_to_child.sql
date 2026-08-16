-- Migration 260: closing the actual gap — a nomination reaching "Screening"
-- had nowhere to go from there. child_id (on kafalat_nominations) and the
-- 'accepted' status have existed in the schema since migration 211; nothing
-- ever set either. This adds the one function that does: called once the
-- admin actually registers the child (pre-filled from this nomination's own
-- data on the frontend), it links the two records and closes the loop —
-- the nomination can't silently sit in limbo once someone's really been
-- added.
CREATE OR REPLACE FUNCTION kafalat_accept_nomination(p_nomination_id uuid, p_child_id uuid) RETURNS void AS $$
BEGIN
  IF NOT COALESCE(can_access_system('donors_projects'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE kafalat_nominations
     SET status = 'accepted', child_id = p_child_id,
         reviewed_at = now(), reviewed_by = current_admin_user_id()
   WHERE id = p_nomination_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_accept_nomination(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_accept_nomination(uuid, uuid) TO authenticated;

-- kafalat_nominations_with_referrer() (migration 259) also hands back the
-- linked child's code/name once accepted, so an already-registered
-- nomination can show "→ KFL-0002" instead of just a static badge.
CREATE OR REPLACE FUNCTION kafalat_nominations_with_referrer() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', n.id, 'child_name', n.child_name, 'guardian_name', n.guardian_name,
    'approximate_age', n.approximate_age, 'gender', n.gender, 'address_hint', n.address_hint,
    'reason', n.reason, 'status', n.status, 'created_at', n.created_at,
    'referrer_name', COALESCE((SELECT full_name FROM portal_users WHERE id = n.nominated_by_portal_user_id), NULL),
    'referrer_phone', COALESCE(n.nominator_phone, (SELECT mobile FROM portal_users WHERE id = n.nominated_by_portal_user_id)),
    'child_id', n.child_id,
    'child_code', (SELECT code FROM kafalat_children WHERE id = n.child_id)
  ) ORDER BY n.created_at DESC), '[]'::jsonb)
  FROM kafalat_nominations n;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
