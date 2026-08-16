-- Migration 254: one bank transfer covering several separate pledges — a
-- donor with a Kafalat share for two children plus a Wazifa share who sends
-- one lump sum rather than three transfers. Each pledge/announcement still
-- posts to its own correct fund account when confirmed individually
-- (nothing about fund segregation changes, this is purely a matching aid);
-- payment_batch_id just marks which rows share one real-world payment, so
-- the accountant sees "these three are covered by the same Rs 10,000 slip"
-- instead of three unexplained amounts.
ALTER TABLE donors ADD COLUMN IF NOT EXISTS payment_batch_id uuid;
ALTER TABLE pool_payments ADD COLUMN IF NOT EXISTS payment_batch_id uuid;

CREATE INDEX IF NOT EXISTS donors_payment_batch_idx ON donors(payment_batch_id) WHERE payment_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pool_payments_payment_batch_idx ON pool_payments(payment_batch_id) WHERE payment_batch_id IS NOT NULL;

-- The donor-side action from /portal/statement's combined "Pay Now" — same
-- ownership/status rules as submit_pledge_payment()/pool_submit_pledge_payment()
-- individually, just applied to everything the donor ticked at once, all
-- stamped with one shared batch id.
CREATE OR REPLACE FUNCTION submit_combined_pledge_payment(
  p_donor_ids uuid[], p_pool_payment_ids uuid[], p_proof_url text, p_method varchar
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_batch_id uuid := gen_random_uuid();
  v_donor_count int; v_pool_count int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Not logged in' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(array_length(p_donor_ids, 1), 0) = 0 AND COALESCE(array_length(p_pool_payment_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Nothing selected' USING ERRCODE = 'P0001';
  END IF;

  UPDATE donors SET payment_proof_url = p_proof_url, payment_method = p_method,
                     payment_status = 'paid', payment_batch_id = v_batch_id
   WHERE id = ANY(p_donor_ids) AND portal_user_id = v_portal_user_id AND payment_status = 'pledged';
  GET DIAGNOSTICS v_donor_count = ROW_COUNT;

  UPDATE pool_payments SET proof_url = p_proof_url, method = p_method, payment_batch_id = v_batch_id
   WHERE id = ANY(p_pool_payment_ids) AND announced_by_portal_user_id = v_portal_user_id AND status = 'announced';
  GET DIAGNOSTICS v_pool_count = ROW_COUNT;

  IF v_donor_count + v_pool_count = 0 THEN
    RAISE EXCEPTION 'Nothing matched — already paid or not yours' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('batch_id', v_batch_id, 'donor_count', v_donor_count, 'pool_count', v_pool_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION submit_combined_pledge_payment(uuid[], uuid[], text, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION submit_combined_pledge_payment(uuid[], uuid[], text, varchar) TO authenticated;

-- pool_announcement_queue() (migration 241) gains payment_batch_id so the
-- Collections screens can group and show "part of a combined Rs X payment"
-- instead of several unexplained amounts that happen to share a proof photo.
CREATE OR REPLACE FUNCTION pool_announcement_queue() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'pool_id', pl.id, 'pool_code', pl.code, 'pool', pl.name, 'donor_name',
    COALESCE((SELECT full_name FROM portal_users WHERE id = p.announced_by_portal_user_id),
             (SELECT donor_name FROM pool_commitments WHERE id = p.commitment_id)),
    'donor_phone',
    COALESCE((SELECT mobile FROM portal_users WHERE id = p.announced_by_portal_user_id),
             (SELECT donor_phone FROM pool_commitments WHERE id = p.commitment_id)),
    'amount', p.amount_pkr, 'is_one_time', p.is_one_time, 'month', p.for_month,
    'proof_url', p.proof_url, 'announced_at', p.announced_at, 'payment_batch_id', p.payment_batch_id
  ) ORDER BY p.announced_at), '[]'::jsonb)
  FROM pool_payments p JOIN support_pools pl ON pl.id = p.pool_id
  WHERE p.status = 'announced';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
