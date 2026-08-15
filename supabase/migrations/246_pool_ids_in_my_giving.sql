-- Migration 246: my_pool_commitments()/my_pool_announcements() already return
-- a human-readable named_child/named_student/named_object, but never the raw
-- id — every caller has been matching by name, which breaks the moment two
-- children share a first name. The Kafalat sponsor page needs to reliably
-- tell "I already have a live commitment for THIS child" apart from "for some
-- other child", so hand back the id alongside the label.
CREATE OR REPLACE FUNCTION my_pool_commitments() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'pool', p.name, 'pool_ur', p.name_ur, 'pool_id', p.id,
    'monthly_amount', c.monthly_amount_pkr, 'status', c.status,
    'funded_by', c.funded_by, 'started_on', c.started_on,
    'kafalat_child_id', c.kafalat_child_id, 'wazifa_student_id', c.wazifa_student_id,
    'sadqa_object_id', c.sadqa_object_id,
    'named_child', (SELECT first_name FROM kafalat_children WHERE id = c.kafalat_child_id),
    'named_student', (SELECT full_name FROM wazifa_students WHERE id = c.wazifa_student_id),
    'named_object', (SELECT item_name FROM sadqa_objects WHERE id = c.sadqa_object_id),
    'paid_this_month', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments
                                  WHERE commitment_id = c.id AND status = 'confirmed'
                                    AND for_month = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date), 0),
    'announced_this_month', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments
                                  WHERE commitment_id = c.id AND status = 'announced'
                                    AND for_month = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date), 0),
    'months_given', (SELECT count(DISTINCT for_month) FROM pool_payments
                      WHERE commitment_id = c.id AND status = 'confirmed'),
    'total_given', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments
                              WHERE commitment_id = c.id AND status = 'confirmed'), 0)
  ) ORDER BY c.created_at DESC), '[]'::jsonb)
  FROM pool_commitments c JOIN support_pools p ON p.id = c.pool_id
  WHERE c.portal_user_id = current_portal_user_id()
    AND c.status <> 'cancelled';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION my_pool_announcements() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'pool_id', p.pool_id, 'pool', pl.name, 'pool_ur', pl.name_ur,
    'commitment_id', p.commitment_id,
    'amount', p.amount_pkr, 'is_one_time', p.is_one_time, 'month', p.for_month,
    'status', p.status, 'has_proof', p.proof_url IS NOT NULL,
    'show_name_publicly', p.show_name_publicly, 'announced_at', p.announced_at,
    'kafalat_child_id', p.kafalat_child_id, 'wazifa_student_id', p.wazifa_student_id,
    'sadqa_object_id', p.sadqa_object_id,
    'named_child', (SELECT first_name FROM kafalat_children WHERE id = p.kafalat_child_id),
    'named_student', (SELECT full_name FROM wazifa_students WHERE id = p.wazifa_student_id),
    'named_object', (SELECT item_name FROM sadqa_objects WHERE id = p.sadqa_object_id)
  ) ORDER BY p.announced_at DESC)
  , '[]'::jsonb)
  FROM pool_payments p JOIN support_pools pl ON pl.id = p.pool_id
  WHERE p.announced_by_portal_user_id = current_portal_user_id()
    AND p.status IN ('announced', 'confirmed')
    AND p.announced_at > now() - interval '2 years';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_pool_commitments() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION my_pool_announcements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_pool_commitments() TO authenticated;
GRANT EXECUTE ON FUNCTION my_pool_announcements() TO authenticated;
