-- Migration 338: homepage counts for the mentorship program cards.
-- SECURITY DEFINER for the same reason as blood_group_counts (migration
-- 188) and homepage_stats (150) — mentor_directory is authenticated-only
-- (migration 323) and portal_users has no public read at all, so an
-- anonymous homepage visitor needs a function that hands back counts
-- only, never a row.
CREATE OR REPLACE FUNCTION career_program_counts() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'mentors_available', (SELECT count(*) FROM portal_users WHERE mentor_status = 'approved' AND mentor_available = true AND is_active = true),
    'institutes', (SELECT count(*) FROM institutes WHERE is_active = true),
    'training_programs_open', (SELECT count(*) FROM training_programs WHERE status IN ('upcoming', 'ongoing')),
    'talent_showcased', (SELECT count(*) FROM talent_showcases WHERE is_published = true)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION career_program_counts() TO anon, authenticated;
