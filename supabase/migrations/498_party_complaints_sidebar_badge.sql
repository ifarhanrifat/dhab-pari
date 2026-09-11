-- admin_sidebar_badges (330) — same signature, adds a count for the new
-- marketplace complaints queue (497), open ones only (urgent-and-open
-- weighted the same as any other open one here; the urgency itself is
-- already surfaced by sorting urgent-first on the page itself).
CREATE OR REPLACE FUNCTION admin_sidebar_badges() RETURNS jsonb AS $$
DECLARE
  v_admin uuid;
  v_role varchar;
BEGIN
  SELECT id, role INTO v_admin, v_role
    FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true;
  IF v_admin IS NULL THEN RETURN '{}'::jsonb; END IF;

  RETURN jsonb_build_object(
    'blood_requests', (SELECT count(*) FROM blood_requests WHERE status = 'pending_approval'),
    'approvals',      (SELECT count(*) FROM approval_requests WHERE status = 'pending'),
    'alerts',         (SELECT count(*) FROM notifications WHERE recipient_id = v_admin AND is_read = false),
    'suggestions',    (SELECT count(*) FROM suggestions WHERE status = 'new'),
    'complaints',     (SELECT count(*) FROM complaints WHERE status IN ('open', 'awaiting_verification')),
    'party_complaints', (SELECT count(*) FROM party_complaints WHERE status = 'open'),
    'volunteers',     (SELECT count(*) FROM volunteers WHERE status = 'offered'),
    'connections',    (SELECT count(*) FROM connection_requests WHERE status = 'pending_payment'),
    'payment_claims', (SELECT count(*) FROM bill_payment_claims WHERE status = 'pending'),
    'donors',         (SELECT count(*) FROM donors WHERE payment_status = 'pledged' AND is_verified = false),
    'portal-accounts', (SELECT count(*) FROM portal_users WHERE mentor_status = 'pending')
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
