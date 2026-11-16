-- Migration 887: HOTFIX — 885 claimed permission grants get logged
-- (commit message said so) but the log_fleet_action call was never
-- actually added to set_fleet_role_permission. Confirmed live via
-- curl: a grant did not appear in fleet_audit_log_recent. Same
-- signature, true replace, one line added.

CREATE OR REPLACE FUNCTION set_fleet_role_permission(p_fleet_id uuid, p_role varchar, p_module varchar, p_can_edit boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_role NOT IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other') THEN RAISE EXCEPTION 'Unknown role.' USING ERRCODE = 'P0001'; END IF;
  IF p_module NOT IN ('staff_payroll', 'cash') THEN RAISE EXCEPTION 'Unknown module.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO fleet_role_permissions (fleet_id, role, module, can_edit, granted_by_portal_user_id)
  VALUES (p_fleet_id, p_role, p_module, p_can_edit, v_portal_user_id)
  ON CONFLICT (fleet_id, role, module) DO UPDATE SET can_edit = EXCLUDED.can_edit, granted_at = now(), granted_by_portal_user_id = EXCLUDED.granted_by_portal_user_id;
  PERFORM log_fleet_action(p_fleet_id, 'role_permission_set', jsonb_build_object('role', p_role, 'module', p_module, 'can_edit', p_can_edit));
END;
$$;
