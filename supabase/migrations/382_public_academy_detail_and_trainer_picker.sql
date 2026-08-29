-- Migration 382: two gaps found once the academy work actually got used —
--
--   1. Everything built this week (batches, fees, sibling discount,
--      slots, trainer bio) only ever rendered on the portal's Academies
--      catalog, which requires logging in. A visitor evaluating whether
--      to join shouldn't have to create an account first just to see the
--      fee — training_batches_public() and academy_trainers_public() need
--      to work for anon too so the public project detail page can show
--      the same real detail.
--
--   2. Assigning a trainer to an academy lived only on the Members page
--      (admin_users.assigned_training_program_ids), a step removed from
--      where an academy is actually created. The person creating a
--      project usually isn't staff-management-permissioned (RLS on
--      admin_users requires super_admin or admin+invite_users to write,
--      admin-tier to even read) — so this needs its own narrow,
--      SECURITY DEFINER path gated on the same manage_parties permission
--      project editing already requires, not staff invite rights.

GRANT EXECUTE ON FUNCTION training_batches_public() TO anon;

-- A project can also point at an already-published video_content row
-- (the same table the home page's Featured Videos section already
-- reads) — reusing that upload/publish pipeline rather than building a
-- second one. Nullable; most projects leave it unset.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS intro_video_id uuid REFERENCES video_content(id) ON DELETE SET NULL;

-- academy_trainer_candidates(): the narrow admin_users read a project
-- editor actually needs — just enough to populate and pre-select a
-- trainer picker, not the full staff roster RLS would otherwise block
-- them from seeing at all.
CREATE OR REPLACE FUNCTION academy_trainer_candidates() RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(can_access_system('donors_projects'), false) AND COALESCE(current_admin_permission('manage_parties'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', au.id, 'full_name', au.full_name, 'assigned_training_program_ids', au.assigned_training_program_ids
  ) ORDER BY au.full_name), '[]'::jsonb) INTO v_result
  FROM admin_users au WHERE au.is_active = true;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION academy_trainer_candidates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION academy_trainer_candidates() TO authenticated;

-- assign_academy_trainer(): the write side — moves a project id between
-- admin_users.assigned_training_program_ids arrays (removing it from
-- whoever had it, adding it to the new pick), and switches
-- can_collect_payments on for a newly-assigned trainer so the existing
-- fee-collection scoping (367) actually lets them collect for it
-- immediately, without a second manual step on the Members page.
-- p_admin_user_id NULL just unassigns.
CREATE OR REPLACE FUNCTION assign_academy_trainer(p_project_id uuid, p_admin_user_id uuid) RETURNS void AS $$
BEGIN
  IF NOT (COALESCE(can_access_system('donors_projects'), false) AND COALESCE(current_admin_permission('manage_parties'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE admin_users SET assigned_training_program_ids = array_remove(assigned_training_program_ids, p_project_id)
   WHERE p_project_id = ANY(assigned_training_program_ids);

  IF p_admin_user_id IS NOT NULL THEN
    UPDATE admin_users
       SET assigned_training_program_ids = array_append(COALESCE(assigned_training_program_ids, '{}'), p_project_id),
           can_collect_payments = true
     WHERE id = p_admin_user_id
       AND NOT (p_project_id = ANY(COALESCE(assigned_training_program_ids, '{}')));
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION assign_academy_trainer(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION assign_academy_trainer(uuid, uuid) TO authenticated;
