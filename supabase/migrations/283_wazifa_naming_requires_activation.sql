-- Migration 283: a student is not "live" for public sponsorship the moment
-- the committee decides — only once the arrangement is actually running.
--
-- ═════════════════════════════════════════════════════════════════════════
-- The bug
-- ═════════════════════════════════════════════════════════════════════════
-- wazifa_students_for_naming() checked wazifa_awards.status = 'active',
-- which has been true from the instant of decision since migration 212 —
-- it was never meant to gate "has an agreement been signed," it just
-- happens to default to 'active' immediately. The standard track's real
-- activation gate (installment_active, migration 269/278) was added
-- later and this function was never updated to check it — so a student
-- like Muhammad Azan, decided but never sent an agreement, has been
-- showing to every donor as sponsorable since the day the committee
-- picked an amount.
--
-- "Live" now means: the standard track's agreement has actually been
-- signed and activated, or the zakat track's committee has actually
-- started funding them (an interim grant exists) — not merely decided.
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
  WHERE a.status = 'active'
    AND (
      a.installment_active
      OR EXISTS (SELECT 1 FROM wazifa_interim_grant g WHERE g.award_id = a.id)
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
