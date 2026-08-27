-- my_training_fees() (370) built 'due_soon' as a bare jsonb_agg(...) sub-
-- select with no COALESCE, unlike the outer aggregate. Postgres returns
-- NULL, not '[]', when jsonb_agg has zero input rows — true for any
-- enrollment with no due/part_paid charge (fully paid up, or a free
-- enrollment that never got a charge at all, e.g. the two workshop
-- registrants migrated into this system by 370 with fee_amount_pkr = 0).
-- The portal page then does `f.due_soon.length`, which throws on null and
-- breaks the whole /portal/training-programs page for that user.
CREATE OR REPLACE FUNCTION my_training_fees() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'enrollment_id', e.id, 'project_id', e.project_id,
    'program_title', COALESCE(proj.display_name, proj.title), 'batch_label', bat.label, 'student_name', e.student_name,
    'fee_type', e.fee_type, 'monthly_amount_pkr', e.fee_amount_pkr,
    'due_soon', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', c.id, 'due_on', c.due_on, 'amount', c.amount_pkr, 'paid', c.paid_pkr, 'status', c.status
      ) ORDER BY c.due_on), '[]'::jsonb) FROM training_fee_charges c
      WHERE c.enrollment_id = e.id AND c.status IN ('due', 'part_paid')),
    'total_paid', (SELECT COALESCE(SUM(paid_pkr), 0) FROM training_fee_charges WHERE enrollment_id = e.id),
    'total_overdue', (SELECT COALESCE(SUM(amount_pkr - paid_pkr), 0) FROM training_fee_charges
      WHERE enrollment_id = e.id AND status IN ('due', 'part_paid') AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date)
  ) ORDER BY e.enrolled_at DESC), '[]'::jsonb)
  FROM training_enrollments e
  JOIN projects proj ON proj.id = e.project_id
  LEFT JOIN training_batches bat ON bat.id = e.batch_id
  WHERE e.portal_user_id = current_portal_user_id() AND e.status = 'active';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- my_training_academy_roster() (370) has the identical bug in its own
-- 'charges' sub-aggregate (a trainer with a student who has zero charge
-- rows yet would hit the same null.length crash on the collector-side
-- roster screen) — fixed the same way while touching this function.
CREATE OR REPLACE FUNCTION my_training_academy_roster() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'project_id', proj.id, 'program_title', COALESCE(proj.display_name, proj.title),
    'students', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'enrollment_id', en.id, 'student_name', en.student_name, 'batch_label', bat.label, 'participant_type', en.participant_type,
        'fee_type', en.fee_type, 'fee_amount_pkr', en.fee_amount_pkr, 'status', en.status,
        'charges', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', c.id, 'charge_no', c.charge_no, 'due_on', c.due_on,
            'amount_pkr', c.amount_pkr, 'paid_pkr', c.paid_pkr, 'status', c.status
          ) ORDER BY c.charge_no), '[]'::jsonb) FROM training_fee_charges c WHERE c.enrollment_id = en.id)
      ) ORDER BY en.student_name), '[]'::jsonb)
      FROM training_enrollments en LEFT JOIN training_batches bat ON bat.id = en.batch_id
      WHERE en.project_id = proj.id AND en.status = 'active'
    )
  )), '[]'::jsonb)
  FROM projects proj
  JOIN admin_users au ON au.auth_user_id = auth.uid()
  WHERE au.is_active = true AND au.can_collect_payments
    AND proj.id = ANY(au.assigned_training_program_ids);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
