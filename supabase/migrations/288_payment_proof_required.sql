-- Migration 288: a donor's own payment cannot be recorded as sent
-- without a proof attached — enforced where it can't be worked around,
-- not just in the page that happens to ask for it.
--
-- ═════════════════════════════════════════════════════════════════════════
-- What was already true, and what wasn't
-- ═════════════════════════════════════════════════════════════════════════
-- Every donor-facing submission page already refuses to even call the
-- database without a proof: /portal/donate, the public /donate/submit,
-- /portal/statement (settling any pending Kafalat/Wazifa/Esal-e-Sawab
-- pledge), and /portal/water's bill claim all check for it in the
-- browser first. bill_payment_claims.payment_proof_url is already a
-- NOT NULL column, so that one was already hard.
--
-- The other two — donors and pool_payments — were not. A client-side
-- check stops the page's own button; it does not stop a direct call to
-- the same insert/update the page itself is allowed to make (both
-- /portal/donate's simple path and submit_combined_pledge_payment()
-- write to these tables directly, and RLS already lets a portal session
-- do the same). "No one CAN send it without proof" means the database
-- itself has to refuse, not just decline to offer the button.
--
-- What stays untouched, deliberately: a pledge (donors.payment_status =
-- 'pledged', pool_payments.status = 'announced') is a promise, not a
-- payment — no money has moved yet, so there is nothing to photograph.
-- And an admin entering a donation on someone's behalf — cash handed
-- over at the mosque, most commonly — never had a screenshot to attach
-- in the first place; donors.submitted_via already distinguishes that
-- case ('staff') from a donor's own submission ('public'), and
-- pool_payments.announced_by_portal_user_id is null for the same reason
-- when staff record it directly.

CREATE OR REPLACE FUNCTION trg_donors_proof_required() RETURNS trigger AS $$
BEGIN
  IF NEW.submitted_via = 'public' AND NEW.payment_status = 'paid'
     AND (NEW.payment_proof_url IS NULL OR length(trim(NEW.payment_proof_url)) = 0) THEN
    RAISE EXCEPTION 'A payment slip is required before this can be marked as paid.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS donors_proof_required ON donors;
CREATE TRIGGER donors_proof_required
  BEFORE INSERT OR UPDATE ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_donors_proof_required();

CREATE OR REPLACE FUNCTION trg_pool_payments_proof_required() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'confirmed' AND NEW.announced_by_portal_user_id IS NOT NULL
     AND (NEW.proof_url IS NULL OR length(trim(NEW.proof_url)) = 0) THEN
    RAISE EXCEPTION 'A payment slip is required before this can be confirmed.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS pool_payments_proof_required ON pool_payments;
CREATE TRIGGER pool_payments_proof_required
  BEFORE INSERT OR UPDATE ON pool_payments
  FOR EACH ROW EXECUTE FUNCTION trg_pool_payments_proof_required();

-- Already NOT NULL — this closes the one gap a NOT NULL alone leaves,
-- an empty string technically satisfying it.
ALTER TABLE bill_payment_claims DROP CONSTRAINT IF EXISTS bill_payment_claims_proof_not_blank;
ALTER TABLE bill_payment_claims ADD CONSTRAINT bill_payment_claims_proof_not_blank
  CHECK (length(trim(payment_proof_url)) > 0);
