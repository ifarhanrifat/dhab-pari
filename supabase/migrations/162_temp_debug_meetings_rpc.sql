-- Migration 162: TEMPORARY, unguarded copies of get_meetings_core_data/
-- get_meetings_project_activity (160) so their real JSON output shape can
-- be inspected via the service-role key (which has no user session to pass
-- the real functions' auth.uid()-based check) — no real browser session
-- available to test with otherwise. Dropped again in the very next
-- migration once inspected; never left reachable.
CREATE OR REPLACE FUNCTION get_meetings_core_data_unchecked() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
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
    'current_admin_id', NULL
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION _debug_get_meetings_core_data() RETURNS jsonb AS $$
  SELECT get_meetings_core_data_unchecked();
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION _debug_get_meetings_core_data() TO service_role;
