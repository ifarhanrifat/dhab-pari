-- Migration 133: Pledge ("Announce") vs Donate distinction. Until now every
-- `donors` row implicitly assumed a payment attempt already happened
-- (payment_proof_url, even if just a placeholder). A pledge is different —
-- "I intend to donate X" with no payment yet, publicly shown in a project's
-- Announced list, followed up with weekly reminders until paid. Same row
-- throughout its life (pledge -> paid -> verified), not a separate table,
-- since it's the same donation just missing proof initially.

ALTER TABLE donors
  ADD COLUMN IF NOT EXISTS payment_status varchar NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('pledged', 'paid')),
  ADD COLUMN IF NOT EXISTS portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL;

-- Pledging requires login (so there's an identity to follow up with later) —
-- WITH CHECK enforces payment_status='pledged' has no proof yet and is tied
-- to the submitter's own portal_user_id (never someone else's), on top of
-- the existing donors_public_submit gate (is_verified=false, project launched).
CREATE POLICY "donors_portal_pledge_insert" ON donors FOR INSERT TO authenticated
  WITH CHECK (
    is_verified = false AND submitted_via = 'public' AND project_accepts_donations(project_id)
    AND payment_status = 'pledged' AND portal_user_id = current_portal_user_id()
  );

-- Turning a pledge into an actual payment — an RPC rather than a raw UPDATE
-- policy, so only payment_proof_url/payment_method/payment_status can ever
-- change (a raw column-unrestricted UPDATE policy would let the pledger
-- also rewrite amount_pkr/project_id in the same call).
CREATE OR REPLACE FUNCTION submit_pledge_payment(p_donor_id uuid, p_payment_proof_url text, p_payment_method varchar) RETURNS void AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Not logged in'; END IF;
  UPDATE donors SET payment_proof_url = p_payment_proof_url, payment_method = p_payment_method, payment_status = 'paid'
  WHERE id = p_donor_id AND portal_user_id = v_portal_user_id AND payment_status = 'pledged';
  IF NOT FOUND THEN RAISE EXCEPTION 'Pledge not found or already paid'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION submit_pledge_payment(uuid, text, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_pledge_payment(uuid, text, varchar) TO authenticated;

-- donors_public (migration 116) gains payment_status — not sensitive (just
-- pledged-vs-paid), lets the public Announced tab show a finer badge.
DROP VIEW IF EXISTS donors_public;
CREATE VIEW donors_public AS
SELECT id,
       CASE WHEN is_anonymous THEN 'Anonymous' ELSE name END AS name,
       CASE WHEN is_anonymous THEN NULL ELSE name_ur END AS name_ur,
       amount_pkr, date, project_id, donor_type, is_verified, payment_status
FROM donors;

GRANT SELECT ON donors_public TO anon, authenticated;
