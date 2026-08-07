-- Migration 151: "Recent Activity Since Last Meeting" — a time-windowed
-- activity digest for the committee, distinct from the existing agenda
-- panels (Complaints Status, Project Proposals & Discussions), which are
-- *status* snapshots (all currently-open items) not *time-windowed* ones.
-- This unions everything that happened in a window into one chronological
-- feed, so the committee sees what happened between meetings, not just
-- what's still outstanding.
--
-- Staff-only (committee visibility, not public) — same "any active staff
-- member" gate as the blood-donor/job/volunteer moderation reads, not
-- system-scoped since this spans both systems' activity.
CREATE OR REPLACE FUNCTION recent_activity_since(p_since timestamptz) RETURNS TABLE (
  event_type varchar, title text, detail text, actor_name text, created_at timestamptz
) AS $$
  SELECT 'job' AS event_type, jl.headline AS title, jl.category AS detail, jl.contact_name AS actor_name, jl.created_at
  FROM job_listings jl WHERE jl.created_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'volunteer', COALESCE(p.title, 'General — Any Project'), v.message, pu.full_name, v.created_at
  FROM volunteers v
  JOIN portal_users pu ON pu.id = v.portal_user_id
  LEFT JOIN projects p ON p.id = v.project_id
  WHERE v.created_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'comment', p.title, c.content,
    (CASE WHEN c.comment_type = 'system' THEN c.system_label ELSE pu2.full_name END),
    c.created_at
  FROM project_comments c
  JOIN projects p ON p.id = c.project_id
  LEFT JOIN portal_users pu2 ON pu2.id = c.portal_user_id
  WHERE c.created_at >= p_since AND c.is_hidden = false AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'complaint', COALESCE(cp.complaint_number, 'Complaint'), cp.complaint_text, cp.complainant_name, cp.created_at
  FROM complaints cp WHERE cp.created_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'suggestion', 'Suggestion', s.message, COALESCE(s.name, 'Anonymous'), s.created_at
  FROM suggestions s WHERE s.created_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'donation', (CASE WHEN d.is_anonymous THEN 'Anonymous donor' ELSE d.name END),
    'Rs. ' || to_char(d.amount_pkr, 'FM999999999') || CASE WHEN pr.title IS NOT NULL THEN ' - ' || pr.title ELSE '' END,
    (CASE WHEN d.is_anonymous THEN 'Anonymous donor' ELSE d.name END), d.confirmed_at
  FROM donors d
  LEFT JOIN projects pr ON pr.id = d.project_id
  WHERE d.is_verified = true AND d.confirmed_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'proposal', p2.title, 'Rs. ' || to_char(COALESCE(p2.budget_pkr, 0), 'FM999999999'), pu3.full_name, p2.created_at
  FROM projects p2
  JOIN portal_users pu3 ON pu3.id = p2.proposed_by_portal_user_id
  WHERE p2.proposed_by_portal_user_id IS NOT NULL AND p2.created_at >= p_since AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  ORDER BY created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION recent_activity_since(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recent_activity_since(timestamptz) TO authenticated;
