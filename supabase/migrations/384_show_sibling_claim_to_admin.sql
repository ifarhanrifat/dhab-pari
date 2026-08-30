-- Migration 384: training_enrollment_requests() didn't return
-- discount_pct/discount_reason at all — so the explicit sibling claim
-- request_training_enrollment() (383) now records was invisible on the
-- admin Pending Requests screen, exactly the review step the whole
-- trust-but-verify design of that claim depends on. Same function
-- signature, just more fields in the jsonb — no overload risk.
CREATE OR REPLACE FUNCTION training_enrollment_requests(p_project_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id, 'student_name', e.student_name, 'student_age', e.student_age,
    'guardian_name', e.guardian_name, 'guardian_whatsapp_number', e.guardian_whatsapp_number,
    'address', e.address, 'sector', e.sector, 'participant_type', e.participant_type,
    'fee_type', e.fee_type, 'fee_amount_pkr', e.fee_amount_pkr,
    'discount_pct', e.discount_pct, 'discount_reason', e.discount_reason,
    'batch_label', bat.label, 'requested_at', e.enrolled_at
  ) ORDER BY e.enrolled_at), '[]'::jsonb)
  FROM training_enrollments e
  LEFT JOIN training_batches bat ON bat.id = e.batch_id
  WHERE e.project_id = p_project_id AND e.status = 'pending'
    AND (COALESCE(current_admin_permission('manage_parties'), false)
         OR current_admin_can_collect_for_training_program(e.project_id));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
