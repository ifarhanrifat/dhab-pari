-- Migration 257: what the donor accountant actually needs to answer "are
-- these 3 really the same payment" — one screen per batch, the real slip,
-- and every item it covers, instead of piecing it together across up to
-- four different admin pages (donors + 3 Collections tabs) using nothing
-- but a count badge on each.

-- Every open batch with more than one item — a batch of exactly one is just
-- an ordinary single payment and already fully visible on its own page;
-- this view exists specifically for the case that needs explaining.
CREATE OR REPLACE FUNCTION pending_payment_batches() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'batch_id', batch_id, 'donor_name', donor_name, 'proof_url', proof_url,
    'method', method, 'total', total, 'count', cnt, 'earliest', earliest
  ) ORDER BY earliest DESC), '[]'::jsonb)
  FROM (
    SELECT payment_batch_id AS batch_id,
           (array_agg(donor_name ORDER BY at))[1] AS donor_name,
           (array_agg(proof_url ORDER BY at))[1] AS proof_url,
           (array_agg(method ORDER BY at))[1] AS method,
           sum(amount) AS total, count(*) AS cnt, min(at) AS earliest
    FROM (
      SELECT payment_batch_id, name AS donor_name, payment_proof_url AS proof_url,
             payment_method AS method, amount_pkr AS amount, created_at AS at
        FROM donors WHERE payment_batch_id IS NOT NULL AND payment_status = 'paid' AND NOT is_verified
      UNION ALL
      SELECT p.payment_batch_id,
             COALESCE((SELECT full_name FROM portal_users WHERE id = p.announced_by_portal_user_id),
                       (SELECT donor_name FROM pool_commitments WHERE id = p.commitment_id)),
             p.proof_url, p.method, p.amount_pkr, p.announced_at
        FROM pool_payments p WHERE p.payment_batch_id IS NOT NULL AND p.status = 'announced'
    ) rows
    GROUP BY payment_batch_id
  ) grouped
  WHERE cnt > 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- The line items for one batch, once an accountant opens it — donor.id for
-- confirm_donation()/decline, pool.id for pool_confirm_payment()/
-- pool_decline_announcement(), so the "Confirm All" button on the admin
-- page can loop the same two RPCs already trusted for a single item.
CREATE OR REPLACE FUNCTION payment_batch_items(p_batch_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'kind'), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('kind', 'donor', 'id', id, 'amount', amount_pkr,
      'label', 'General giving' || COALESCE(' — ' || notes, '')) AS item
    FROM donors WHERE payment_batch_id = p_batch_id AND payment_status = 'paid' AND NOT is_verified
    UNION ALL
    SELECT jsonb_build_object('kind', 'pool', 'id', p.id, 'amount', p.amount_pkr,
      'label', pl.name || COALESCE(
        (SELECT ' — ' || first_name FROM kafalat_children WHERE id = p.kafalat_child_id),
        (SELECT ' — ' || full_name FROM wazifa_students WHERE id = p.wazifa_student_id),
        (SELECT ' — ' || item_name FROM sadqa_objects WHERE id = p.sadqa_object_id), '')) AS item
    FROM pool_payments p JOIN support_pools pl ON pl.id = p.pool_id
    WHERE p.payment_batch_id = p_batch_id AND p.status = 'announced'
  ) x;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pending_payment_batches() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION payment_batch_items(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pending_payment_batches() TO authenticated;
GRANT EXECUTE ON FUNCTION payment_batch_items(uuid) TO authenticated;
