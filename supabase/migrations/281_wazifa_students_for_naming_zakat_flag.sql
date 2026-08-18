-- Migration 281: the sponsor-a-student picker needs to know which students
-- are zakat-family, so the portal can hide qarz-e-hasana for them
-- (migration 280) instead of only finding out when the donor's choice is
-- rejected at submission.
CREATE OR REPLACE FUNCTION wazifa_students_for_naming() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'student_id', s.id, 'code', s.code, 'full_name', s.full_name,
    'institution', ap.institution, 'programme', ap.programme, 'level', ap.level,
    'awarded_amount', a.awarded_amount_pkr, 'is_loan', a.is_loan, 'is_zakat_family', s.is_zakat_family,
    'already_named', COALESCE((
      SELECT SUM(p.amount_pkr) FROM pool_payments p
       WHERE p.wazifa_student_id = s.id AND p.status = 'confirmed'
    ), 0)
  ) ORDER BY s.code), '[]'::jsonb)
  FROM wazifa_awards a
  JOIN wazifa_students s ON s.id = a.student_id
  JOIN wazifa_applications ap ON ap.id = a.application_id
  WHERE a.status = 'active';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
