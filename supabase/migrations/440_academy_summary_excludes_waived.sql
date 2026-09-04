-- Migration 440: same bug 381 already fixed once for withdrawn
-- enrollments, now for waived charges (438) — fees_overdue_total only
-- checked `status <> 'paid'`, so a charge the committee waived (status =
-- 'waived', nothing left to collect) would still count as overdue
-- revenue on the academy dashboard. fees_charged_total/fees_collected_total
-- deliberately keep counting every status, same as a waived bill's own
-- amount_pkr stays the original gross figure — only "still outstanding"
-- needed the fix.
CREATE OR REPLACE FUNCTION academy_summary_report() RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT COALESCE(can_access_system('donors_projects'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.title), '[]'::jsonb) INTO v_result FROM (
    SELECT
      p.id AS project_id, p.title, p.display_name, p.category, p.status,
      p.funding_model, p.monthly_operating_cost_pkr,
      (SELECT count(*) FROM training_batches b WHERE b.project_id = p.id AND b.status = 'active') AS batches_count,
      (SELECT COALESCE(sum(b.capacity), 0) FROM training_batches b
         WHERE b.project_id = p.id AND b.status = 'active' AND b.capacity IS NOT NULL) AS capacity_total,
      (SELECT count(*) FROM training_enrollments e JOIN training_batches b ON b.id = e.batch_id
         WHERE b.project_id = p.id AND e.status IN ('pending', 'active')) AS filled_total,
      (SELECT COALESCE(sum(c.amount_pkr), 0) FROM training_fee_charges c
         JOIN training_enrollments e ON e.id = c.enrollment_id
         WHERE e.project_id = p.id AND e.status IN ('active', 'completed')) AS fees_charged_total,
      (SELECT COALESCE(sum(c.paid_pkr), 0) FROM training_fee_charges c
         JOIN training_enrollments e ON e.id = c.enrollment_id
         WHERE e.project_id = p.id AND e.status IN ('active', 'completed')) AS fees_collected_total,
      (SELECT COALESCE(sum(c.amount_pkr - c.paid_pkr), 0) FROM training_fee_charges c
         JOIN training_enrollments e ON e.id = c.enrollment_id
         WHERE e.project_id = p.id AND e.status IN ('active', 'completed')
           AND c.status NOT IN ('paid', 'waived') AND c.due_on < (now() AT TIME ZONE 'Asia/Karachi')::date) AS fees_overdue_total,
      (SELECT COALESCE(sum(credit), 0) FROM project_income_public WHERE project_id = p.id) AS raised_total,
      (SELECT COALESCE(sum(debit), 0) FROM project_expenses_public WHERE project_id = p.id) AS spent_total
    FROM projects p
    WHERE p.category IN ('sports', 'training')
  ) x;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
