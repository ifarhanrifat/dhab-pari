-- Migration 256: the banking-fee reason behind combined payments — a donor
-- paying a small transfer fee on every JazzCash/Easypaisa/bank send has a
-- real incentive to lump everything into one transaction, and that includes
-- a brand-new donation they're making right now alongside whatever they
-- already owe. submit_combined_pledge_payment() (migration 254) only ever
-- worked on existing pledged/announced rows — extended here to optionally
-- also create and fold in one new donation, atomically, so a partial
-- failure never leaves the new gift recorded without the batch it was
-- meant to travel with (or vice versa).
--
-- Explicit DROP first — CREATE OR REPLACE cannot change an argument list,
-- and leaving the old 4-arg version alongside a new 7-arg one is exactly
-- the "function is not unique" bug this project already hit once with
-- pool_announce()/pool_post_confirmed_payment().
DROP FUNCTION IF EXISTS submit_combined_pledge_payment(uuid[], uuid[], text, varchar);

CREATE OR REPLACE FUNCTION submit_combined_pledge_payment(
  p_donor_ids uuid[], p_pool_payment_ids uuid[], p_proof_url text, p_method varchar,
  p_new_amount decimal DEFAULT NULL, p_new_project_id uuid DEFAULT NULL, p_new_is_anonymous boolean DEFAULT false
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_batch_id uuid := gen_random_uuid();
  v_donor_count int; v_pool_count int; v_new_id uuid;
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
                        amount_pkr, date, payment_method, project_id, is_anonymous,
                        payment_proof_url, is_verified, submitted_via, portal_user_id, payment_batch_id)
    SELECT u.full_name, u.name_ur, u.mobile, u.whatsapp_number, u.father_husband_name, COALESCE(u.donor_type, 'villager'),
           p_new_amount, (now() AT TIME ZONE 'Asia/Karachi')::date, p_method, p_new_project_id, p_new_is_anonymous,
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

REVOKE ALL ON FUNCTION submit_combined_pledge_payment(uuid[], uuid[], text, varchar, decimal, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION submit_combined_pledge_payment(uuid[], uuid[], text, varchar, decimal, uuid, boolean) TO authenticated;
