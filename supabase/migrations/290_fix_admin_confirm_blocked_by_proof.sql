-- Migration 290: hotfix — migration 288 blocked an admin confirming a
-- donor's payment, not just a donor's own submission.
--
-- Abdul Hadi (donor and student both) sent Aisha's sponsorship payment;
-- confirming it from the admin Wazifa screen hit "A payment slip is
-- required before this can be marked as paid." The trigger was gated on
-- whether the ROW was originally donor-announced (announced_by_portal_
-- user_id / submitted_via = 'public'), which never changes once set —
-- so it kept firing even when an admin, using their own judgement, is
-- the one confirming it now, exactly the same as admin-entered cash.
--
-- The actual line that matters is who is performing THIS write, not who
-- created the row originally. current_admin_user_id() is null for the
-- donor's own session (/portal/donate's insert, submit_combined_pledge_
-- payment) regardless of which row it's touching, so gating on that
-- instead protects exactly the same thing migration 288 was built for —
-- a donor's own unmediated submission — without catching a staff member
-- confirming a payment through means the app can't see a screenshot for
-- (a phone call, a WhatsApp message outside the upload flow, a donor
-- they already know and trust).

CREATE OR REPLACE FUNCTION trg_donors_proof_required() RETURNS trigger AS $$
BEGIN
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
  IF current_admin_user_id() IS NULL
     AND NEW.status = 'confirmed' AND NEW.announced_by_portal_user_id IS NOT NULL
     AND (NEW.proof_url IS NULL OR length(trim(NEW.proof_url)) = 0) THEN
    RAISE EXCEPTION 'A payment slip is required before this can be confirmed.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
