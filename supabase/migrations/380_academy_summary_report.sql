-- Migration 380: cross-academy summary — fill rate, fee-collection rate,
-- and (for a trainer-salary academy) funding rate, every academy in one
-- table instead of opening each one individually. Same read gate as the
-- rest of academy-fees' admin view (can_access_system('donors_projects')
-- — no manage_parties needed just to look).
--
-- raised_total/spent_total reuse project_income_public/
-- project_expenses_public (378) rather than re-deriving the reversal-pair
-- exclusion here — one place that knows what counts as real money in/out.
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
         JOIN training_enrollments e ON e.id = c.enrollment_id WHERE e.project_id = p.id) AS fees_charged_total,
      (SELECT COALESCE(sum(c.paid_pkr), 0) FROM training_fee_charges c
         JOIN training_enrollments e ON e.id = c.enrollment_id WHERE e.project_id = p.id) AS fees_collected_total,
      (SELECT COALESCE(sum(c.amount_pkr - c.paid_pkr), 0) FROM training_fee_charges c
         JOIN training_enrollments e ON e.id = c.enrollment_id
         WHERE e.project_id = p.id AND c.status <> 'paid' AND c.due_on < (now() AT TIME ZONE 'Asia/Karachi')::date) AS fees_overdue_total,
      (SELECT COALESCE(sum(credit), 0) FROM project_income_public WHERE project_id = p.id) AS raised_total,
      (SELECT COALESCE(sum(debit), 0) FROM project_expenses_public WHERE project_id = p.id) AS spent_total
    FROM projects p
    WHERE p.category IN ('sports', 'training')
  ) x;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION academy_summary_report() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION academy_summary_report() TO authenticated;
