-- Migration 376: donation-target picker redesign.
--
-- The donate forms (/portal/donate and /donate/submit) are getting a
-- categorised, "amount still needed" picker instead of a flat project
-- <select>, with کمیٹی اکاؤنٹ (Main) as the default instead of the old
-- unconditional "General Fund" text option — see the app-side changes
-- alongside this migration (src/lib/donationTargets.ts).
--
-- ═════════════════════════════════════════════════════════════════════════
-- 1. A reliable way to find کمیٹی اکاؤنٹ (Main)
-- ═════════════════════════════════════════════════════════════════════════
-- unlisted (365) isn't specific enough — a one-off fundraiser an admin
-- wants kept off the public projects listing is unlisted too, for a
-- completely unrelated reason. This is a dedicated flag, exactly one row
-- true at a time, enforced by the partial unique index below.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_committee_main boolean NOT NULL DEFAULT false;

UPDATE projects SET is_committee_main = true
 WHERE unlisted = true AND title = 'کمیٹی اکاؤنٹ (Main)' AND category = 'other';

CREATE UNIQUE INDEX IF NOT EXISTS projects_one_committee_main
  ON projects (is_committee_main) WHERE is_committee_main;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. submit_combined_pledge_payment gains an optional fund_type
-- ═════════════════════════════════════════════════════════════════════════
-- The picker can now point a donation at a restricted fund (Zakat, Ushr,
-- Sadqa, Kafalat, Esal-e-Sawab — see donors.fund_type, migration 209)
-- instead of a project. A new DEFAULT'd trailing param keeps every
-- existing call (which never set one) working unchanged, defaulting to
-- 'general' exactly as before. project_id is forced NULL alongside
-- zakat/ushr here too — belt and braces alongside trg_donors_fund_rules,
-- since this path builds the row itself rather than letting the trigger
-- catch a bad combination after the fact.
CREATE OR REPLACE FUNCTION submit_combined_pledge_payment(
  p_donor_ids uuid[], p_pool_payment_ids uuid[], p_proof_url text, p_method varchar,
  p_new_amount decimal DEFAULT NULL, p_new_project_id uuid DEFAULT NULL, p_new_is_anonymous boolean DEFAULT false,
  p_new_fund_type varchar DEFAULT 'general'
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_batch_id uuid := gen_random_uuid();
  v_donor_count int; v_pool_count int; v_new_id uuid;
  v_project_id uuid := CASE WHEN p_new_fund_type IN ('zakat', 'ushr') THEN NULL ELSE p_new_project_id END;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Not logged in' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(array_length(p_donor_ids, 1), 0) = 0 AND COALESCE(array_length(p_pool_payment_ids, 1), 0) = 0
     AND COALESCE(p_new_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Nothing to submit' USING ERRCODE = 'P0001';
  END IF;

  UPDATE donors SET payment_proof_url = p_proof_url, payment_method = p_method,
                     payment_status = 'paid', payment_batch_id = v_batch_id
   WHERE id = ANY(p_donor_ids) AND portal_user_id = v_portal_user_id AND payment_status = 'pledged';
  GET DIAGNOSTICS v_donor_count = ROW_COUNT;

  UPDATE pool_payments SET proof_url = p_proof_url, method = p_method, payment_batch_id = v_batch_id
   WHERE id = ANY(p_pool_payment_ids) AND announced_by_portal_user_id = v_portal_user_id AND status = 'announced';
  GET DIAGNOSTICS v_pool_count = ROW_COUNT;

  IF COALESCE(p_new_amount, 0) > 0 THEN
    INSERT INTO donors (name, name_ur, phone, whatsapp_number, father_husband_name, donor_type,
                        amount_pkr, date, payment_method, project_id, fund_type, is_anonymous,
                        payment_proof_url, is_verified, submitted_via, portal_user_id, payment_batch_id)
    SELECT u.full_name, u.name_ur, u.mobile, u.whatsapp_number, u.father_husband_name, COALESCE(u.donor_type, 'villager'),
           p_new_amount, (now() AT TIME ZONE 'Asia/Karachi')::date, p_method, v_project_id, p_new_fund_type, p_new_is_anonymous,
           p_proof_url, false, 'public', u.id, v_batch_id
      FROM portal_users u WHERE u.id = v_portal_user_id
    RETURNING id INTO v_new_id;
  END IF;

  IF v_donor_count + v_pool_count = 0 AND v_new_id IS NULL THEN
    RAISE EXCEPTION 'Nothing matched — already paid or not yours' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('batch_id', v_batch_id, 'donor_count', v_donor_count, 'pool_count', v_pool_count, 'new_donor_id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION submit_combined_pledge_payment(uuid[], uuid[], text, varchar, decimal, uuid, boolean, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION submit_combined_pledge_payment(uuid[], uuid[], text, varchar, decimal, uuid, boolean, varchar) TO authenticated;
