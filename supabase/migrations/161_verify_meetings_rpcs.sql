-- Migration 161: one-off verification of the SQL inside get_meetings_core_data
-- and get_meetings_project_activity (160) — a DO block, not a database
-- object, runs once at apply-time and leaves nothing behind. Confirms the
-- jsonb_agg/join logic actually executes against real data (CREATE FUNCTION
-- only checks plpgsql body syntax at creation, not the embedded SQL) before
-- trusting the RPCs from the client. Output goes to `supabase db push`'s
-- own console via RAISE NOTICE.
DO $$
DECLARE
  v_core jsonb;
  v_since timestamptz := now() - interval '30 days';
  v_activity jsonb;
BEGIN
  SELECT jsonb_build_object(
    'meetings', (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.meeting_date DESC), '[]'::jsonb) FROM agenda_meetings m),
    'members', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY c.display_order), '[]'::jsonb) FROM committee_members c),
    'admin_users', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'full_name', a.full_name) ORDER BY a.full_name), '[]'::jsonb) FROM admin_users a WHERE a.is_active = true),
    'items', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.display_order), '[]'::jsonb) FROM agenda_items i),
    'assignees', (SELECT COALESCE(jsonb_agg(to_jsonb(ai)), '[]'::jsonb) FROM agenda_item_assignees ai),
    'complaints', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', co.id, 'incharge_name', au1.full_name)), '[]'::jsonb)
      FROM complaints co LEFT JOIN admin_users au1 ON au1.id = co.assigned_to)
  ) INTO v_core;
  RAISE NOTICE 'CORE_OK keys=% meetings_count=% items_count=%',
    (SELECT jsonb_agg(k) FROM jsonb_object_keys(v_core) k),
    jsonb_array_length(v_core->'meetings'),
    jsonb_array_length(v_core->'items');

  SELECT jsonb_build_object(
    'project_comments', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('projectId', pc.project_id, 'projectTitle', COALESCE(p.title, 'Untitled Project'), 'comments', pc.comments)), '[]'::jsonb)
      FROM (
        SELECT project_id, jsonb_agg(jsonb_build_object('id', id, 'content', content) ORDER BY created_at ASC) AS comments
        FROM project_comments_public WHERE created_at >= v_since GROUP BY project_id
      ) pc LEFT JOIN projects p ON p.id = pc.project_id
    ),
    'project_discussions', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'vote_count', COALESCE(vc.cnt, 0))), '[]'::jsonb)
      FROM projects p
      LEFT JOIN (SELECT project_id, count(*) AS cnt FROM project_votes GROUP BY project_id) vc ON vc.project_id = p.id
      WHERE p.status IN ('upcoming', 'reviewing')
    )
  ) INTO v_activity;
  RAISE NOTICE 'ACTIVITY_OK keys=% discussions_count=%',
    (SELECT jsonb_agg(k) FROM jsonb_object_keys(v_activity) k),
    jsonb_array_length(v_activity->'project_discussions');
END $$;
