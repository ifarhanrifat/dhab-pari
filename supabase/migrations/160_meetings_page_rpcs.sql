-- Migration 160: fold the Meetings & Agenda page's load() from 12 separate
-- round trips down to a small, reviewable number of RPCs, same "compute
-- server-side, return one payload" pattern already proven by
-- homepage_stats()/recent_activity_since() — not one giant catch-all
-- function (harder to verify correctness of, harder to reason about later),
-- two narrowly-scoped ones instead:
--   1. get_meetings_core_data() — meetings, members, admin users, agenda
--      items, assignees, complaints (6 queries -> 1).
--   2. get_meetings_project_activity(p_since) — new project comments since
--      the window (grouped per project) + projects still under community
--      discussion with their live vote/comment counts (3 queries -> 1).
-- recent_activity_since() (151) is untouched and still called separately —
-- it's already a single proven call, no benefit to folding it in and real
-- risk in re-deriving its logic a second time.
--
-- Same "any active staff member" gate as recent_activity_since (this page
-- isn't scoped to one system's role the way /admin/finance/[system] is).

CREATE OR REPLACE FUNCTION get_meetings_core_data() RETURNS jsonb AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN jsonb_build_object(
    'meetings', (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.meeting_date DESC), '[]'::jsonb) FROM agenda_meetings m),
    'members', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'name_ur', c.name_ur, 'position', c.position, 'position_ur', c.position_ur,
        'phone', c.phone, 'admin_user_id', c.admin_user_id, 'proxy_admin_user_id', c.proxy_admin_user_id,
        'uses_smartphone', c.uses_smartphone, 'handles_non_whatsapp_notice', c.handles_non_whatsapp_notice
      ) ORDER BY c.display_order), '[]'::jsonb) FROM committee_members c),
    'admin_users', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'full_name', a.full_name) ORDER BY a.full_name), '[]'::jsonb) FROM admin_users a WHERE a.is_active = true),
    'items', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.display_order), '[]'::jsonb) FROM agenda_items i),
    'assignees', (SELECT COALESCE(jsonb_agg(to_jsonb(ai)), '[]'::jsonb) FROM agenda_item_assignees ai),
    'complaints', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', co.id, 'complaint_number', co.complaint_number, 'complainant_name', co.complainant_name, 'sector', co.sector,
        'complaint_text', co.complaint_text, 'status', co.status, 'assigned_to', co.assigned_to, 'resolved_by', co.resolved_by,
        'resolved_at', co.resolved_at, 'created_at', co.created_at,
        'incharge_name', au1.full_name, 'resolved_by_name', au2.full_name
      ) ORDER BY co.created_at DESC), '[]'::jsonb)
      FROM complaints co
      LEFT JOIN admin_users au1 ON au1.id = co.assigned_to
      LEFT JOIN admin_users au2 ON au2.id = co.resolved_by
    ),
    'current_admin_id', (SELECT id FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION get_meetings_core_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_meetings_core_data() TO authenticated;

CREATE OR REPLACE FUNCTION get_meetings_project_activity(p_since timestamptz) RETURNS jsonb AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN jsonb_build_object(
    'project_comments', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'projectId', pc.project_id, 'projectTitle', COALESCE(p.title, 'Untitled Project'), 'comments', pc.comments
        )), '[]'::jsonb)
      FROM (
        SELECT project_id, jsonb_agg(jsonb_build_object(
            'id', id, 'username', username, 'content', content, 'comment_type', comment_type, 'created_at', created_at
          ) ORDER BY created_at ASC) AS comments
        FROM project_comments_public
        WHERE created_at >= p_since
        GROUP BY project_id
      ) pc
      LEFT JOIN projects p ON p.id = pc.project_id
    ),
    'project_discussions', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', p.id, 'title', p.title, 'status', p.status, 'vote_target', p.vote_target,
          'vote_count', COALESCE(vc.cnt, 0), 'comments', COALESCE(cc.comments, '[]'::jsonb)
        ) ORDER BY p.created_at DESC), '[]'::jsonb)
      FROM projects p
      LEFT JOIN (SELECT project_id, count(*) AS cnt FROM project_votes GROUP BY project_id) vc ON vc.project_id = p.id
      LEFT JOIN (
        SELECT project_id, jsonb_agg(jsonb_build_object(
            'username', username, 'content', content, 'comment_type', comment_type, 'created_at', created_at
          ) ORDER BY created_at ASC) AS comments
        FROM project_comments_public GROUP BY project_id
      ) cc ON cc.project_id = p.id
      WHERE p.status IN ('upcoming', 'reviewing')
    )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION get_meetings_project_activity(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_meetings_project_activity(timestamptz) TO authenticated;
