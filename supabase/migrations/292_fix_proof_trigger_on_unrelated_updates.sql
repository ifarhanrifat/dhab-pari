-- Migration 292: the proof-required trigger (288/290) was re-checking on
-- every update to an already-paid row, not just when payment_status or
-- payment_proof_url were actually changing — so an admin trying to
-- unverify a donation to reverse it hit "a payment slip is required",
-- on a row that had nothing to do with a slip at all.
--
-- Found live: Abdul Hadi's donation needed unverifying to reverse it
-- properly, and the update was refused for the same reason a totally
-- unrelated field edit would have been. UPDATE triggers see the whole
-- NEW row regardless of which columns the statement actually touched;
-- the fix is comparing against OLD and only firing when the columns
-- that matter are the ones changing.

CREATE OR REPLACE FUNCTION trg_donors_proof_required() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.payment_status IS NOT DISTINCT FROM NEW.payment_status
     AND OLD.payment_proof_url IS NOT DISTINCT FROM NEW.payment_proof_url THEN
    RETURN NEW;
  END IF;
  IF current_admin_user_id() IS NULL
     AND NEW.submitted_via = 'public' AND NEW.payment_status = 'paid'
     AND (NEW.payment_proof_url IS NULL OR length(trim(NEW.payment_proof_url)) = 0) THEN
    RAISE EXCEPTION 'A payment slip is required before this can be marked as paid.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_pool_payments_proof_required() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status
     AND OLD.proof_url IS NOT DISTINCT FROM NEW.proof_url THEN
    RETURN NEW;
  END IF;
  IF current_admin_user_id() IS NULL
     AND NEW.status = 'confirmed' AND NEW.announced_by_portal_user_id IS NOT NULL
     AND (NEW.proof_url IS NULL OR length(trim(NEW.proof_url)) = 0) THEN
    RAISE EXCEPTION 'A payment slip is required before this can be confirmed.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
