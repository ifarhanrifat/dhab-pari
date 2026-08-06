-- Migration 128: Water-bill payment claims — a consumer (via the portal)
-- can now submit "I paid this bill" with a receipt/screenshot, for a
-- water_supply accountant to verify, mirroring the donation verification
-- workflow (migration 117) but as a staging table rather than gating
-- `payments`/trg_payment_ledger directly — payments is trusted, staff-
-- entered-fact machinery today, and this only adds a new front door to it
-- rather than changing how it already posts to the ledger. On approval, a
-- real `payments` row is inserted through the exact same shape staff manual
-- entry already uses, so the existing ledger trigger fires unchanged.

-- 1. Storage bucket for bill payment receipts — same privacy shape as
-- donation_receipts (migration 116): not public-read, portal can upload,
-- only water_supply staff can view.
INSERT INTO storage.buckets (id, name, public) VALUES ('bill_payment_proofs', 'bill_payment_proofs', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Portal users can upload bill payment proofs" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'bill_payment_proofs' AND auth.role() = 'authenticated');
CREATE POLICY "Water staff can read bill payment proofs" ON storage.objects FOR SELECT
  USING (bucket_id = 'bill_payment_proofs' AND can_access_system('water_supply'));
CREATE POLICY "Water staff can delete bill payment proofs" ON storage.objects FOR DELETE
  USING (bucket_id = 'bill_payment_proofs' AND can_access_system('water_supply'));

-- 2. The claim itself.
CREATE TABLE IF NOT EXISTS bill_payment_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  consumer_id varchar NOT NULL REFERENCES consumers(consumer_id),
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  payment_method varchar NOT NULL CHECK (payment_method IN ('jazzcash', 'easypaisa', 'bank', 'cash')),
  payment_proof_url text NOT NULL,
  note text,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES admin_users(id),
  reviewed_at timestamptz,
  review_note text,
  created_payment_id uuid REFERENCES payments(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bill_payment_claims_status_idx ON bill_payment_claims(status);

-- consumer_id is locked from the submitter's own linked identity — same
-- reasoning/pattern as trg_complaint_portal_consumer_lock() (migration
-- 122): never trust the client to say whose bill this is.
CREATE OR REPLACE FUNCTION trg_bill_payment_claim_consumer_lock() RETURNS trigger AS $$
BEGIN
  SELECT consumer_id INTO NEW.consumer_id FROM portal_users WHERE id = NEW.portal_user_id;
  IF NEW.consumer_id IS NULL THEN
    RAISE EXCEPTION 'Your account is not linked to a water connection';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bills WHERE id = NEW.bill_id AND consumer_id = NEW.consumer_id) THEN
    RAISE EXCEPTION 'That bill does not belong to your account';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS bill_payment_claim_consumer_lock_trigger ON bill_payment_claims;
CREATE TRIGGER bill_payment_claim_consumer_lock_trigger BEFORE INSERT ON bill_payment_claims
  FOR EACH ROW EXECUTE FUNCTION trg_bill_payment_claim_consumer_lock();

ALTER TABLE bill_payment_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bill_payment_claims_portal_insert" ON bill_payment_claims FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id() AND status = 'pending');
CREATE POLICY "bill_payment_claims_portal_read" ON bill_payment_claims FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());
CREATE POLICY "bill_payment_claims_staff_read" ON bill_payment_claims FOR SELECT TO authenticated
  USING (can_access_system('water_supply'));

-- 3. Approve — creates the real `payments` row (firing trg_payment_ledger
-- unchanged, exactly as staff manual entry already does) and marks the
-- claim approved. Reject just marks it rejected; nothing is posted.
CREATE OR REPLACE FUNCTION approve_bill_payment_claim(p_claim_id uuid, p_review_note text) RETURNS uuid AS $$
DECLARE
  c bill_payment_claims%ROWTYPE;
  v_payment_id uuid;
BEGIN
  IF NOT can_access_system('water_supply') OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to approve payment claims';
  END IF;

  SELECT * INTO c FROM bill_payment_claims WHERE id = p_claim_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Claim not found or already reviewed'; END IF;

  INSERT INTO payments (bill_id, consumer_id, amount_pkr, method, paid_date, note)
  VALUES (c.bill_id, c.consumer_id, c.amount_pkr, c.payment_method, current_date, COALESCE(c.note, 'Submitted via portal, verified by staff'))
  RETURNING id INTO v_payment_id;

  UPDATE bill_payment_claims SET
    status = 'approved', reviewed_by = current_admin_user_id(), reviewed_at = now(),
    review_note = p_review_note, created_payment_id = v_payment_id
  WHERE id = p_claim_id;

  RETURN v_payment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION reject_bill_payment_claim(p_claim_id uuid, p_review_note text) RETURNS void AS $$
BEGIN
  IF NOT can_access_system('water_supply') OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to review payment claims';
  END IF;
  UPDATE bill_payment_claims SET status = 'rejected', reviewed_by = current_admin_user_id(), reviewed_at = now(), review_note = p_review_note
  WHERE id = p_claim_id AND status = 'pending';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION approve_bill_payment_claim(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approve_bill_payment_claim(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION reject_bill_payment_claim(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reject_bill_payment_claim(uuid, text) TO authenticated;
