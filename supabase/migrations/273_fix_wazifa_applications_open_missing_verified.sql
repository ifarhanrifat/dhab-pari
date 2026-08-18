-- Migration 273: 'verified' applications were invisible everywhere.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Found investigating a live report: an applicant's file (verified by a
-- committee member on 15 Aug) had disappeared from the admin Applications
-- tab entirely, with no decision possible on it.
-- ═════════════════════════════════════════════════════════════════════════
-- Migration 216 added 'verified' as its own status — "a distinct status
-- between 'somebody has been' and 'the committee has decided'... the
-- committee's own queue to work from," in that migration's words — but
-- never updated public_wazifa_summary()'s applications_open count, and the
-- admin page's own `open` filter (fixed alongside this migration) had the
-- same gap. The moment a verifier recorded their visit, the application
-- fell out of both the count and the list, with nothing left pointing back
-- to it — not stuck in a visible queue, just gone from view.
CREATE OR REPLACE FUNCTION public_wazifa_summary() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'students_supported', (SELECT count(*) FROM wazifa_students WHERE status IN ('awarded', 'studying')),
    'graduated', (SELECT count(*) FROM wazifa_students WHERE status = 'graduated'),
    'girls', (SELECT count(*) FROM wazifa_students WHERE status IN ('awarded', 'studying') AND gender = 'female'),
    'boys', (SELECT count(*) FROM wazifa_students WHERE status IN ('awarded', 'studying') AND gender = 'male'),
    'applications_open', (SELECT count(*) FROM wazifa_applications WHERE status IN ('submitted', 'screening', 'verified', 'interview')),
    'awarded_this_year', (SELECT COALESCE(SUM(awarded_amount_pkr), 0) FROM wazifa_awards
                           WHERE created_at >= date_trunc('year', now())),
    'by_level', (SELECT COALESCE(jsonb_object_agg(level, c), '{}'::jsonb) FROM
                  (SELECT a.level, count(*) c FROM wazifa_applications a
                    JOIN wazifa_awards w ON w.application_id = a.id
                   WHERE w.status = 'active' GROUP BY a.level) x)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
