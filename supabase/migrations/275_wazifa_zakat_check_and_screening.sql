-- Migration 275: the zakat-family check, and giving 'screening' something
-- to actually do.
--
-- 'screening' has existed as an application status since migration 212 and
-- was never once written by any function or button — a status nothing
-- could reach. This is where an application starts: before a verifier goes
-- anywhere, the committee looks at what was declared and checks it against
-- the household register already built for zakat rounds (migration 208/209)
-- — the same list, not a second one kept for Wazifa alone.

-- ── Candidates, not a verdict ─────────────────────────────────────────────
-- A name match is a lead. "Muhammad Iqbal" appears in more than one
-- household in most villages this size — the function surfaces every
-- plausible match with why it matched, and a committee member decides,
-- the same caution this codebase already applies to donor de-duplication.
CREATE OR REPLACE FUNCTION wazifa_check_zakat_family(
  p_father_name varchar, p_mother_name varchar DEFAULT NULL, p_declared_cnic varchar DEFAULT NULL
) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'register_id', id, 'code', code, 'head_name', head_name, 'father_husband_name', father_husband_name,
    'asnaf_category', asnaf_category, 'phone', phone, 'address', address,
    'match_strength', match_strength
  ) ORDER BY match_strength DESC), '[]'::jsonb)
  FROM (
    SELECT id, code, head_name, father_husband_name, asnaf_category, phone, address,
      CASE
        WHEN p_declared_cnic IS NOT NULL AND cnic IS NOT NULL AND trim(cnic) = trim(p_declared_cnic) THEN 3
        WHEN lower(trim(head_name)) = lower(trim(COALESCE(p_father_name, ''))) THEN 2
        WHEN lower(trim(COALESCE(father_husband_name, ''))) = lower(trim(COALESCE(p_father_name, ''))) THEN 2
        WHEN p_mother_name IS NOT NULL AND lower(trim(head_name)) = lower(trim(p_mother_name)) THEN 2
        WHEN p_father_name IS NOT NULL AND head_name ILIKE '%' || p_father_name || '%' THEN 1
        WHEN p_father_name IS NOT NULL AND father_husband_name ILIKE '%' || p_father_name || '%' THEN 1
        ELSE 0
      END AS match_strength
    FROM needs_register
    WHERE status = 'verified'
      AND (
        (p_declared_cnic IS NOT NULL AND cnic = p_declared_cnic)
        OR (p_father_name IS NOT NULL AND (head_name ILIKE '%' || p_father_name || '%' OR father_husband_name ILIKE '%' || p_father_name || '%'))
        OR (p_mother_name IS NOT NULL AND head_name ILIKE '%' || p_mother_name || '%')
      )
  ) x
  WHERE match_strength > 0;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_check_zakat_family(varchar, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_check_zakat_family(varchar, varchar, varchar) TO authenticated;

-- ── Moving an application into screening, with the check run as part of
--    the same action rather than a separate step nobody remembers ────────
CREATE OR REPLACE FUNCTION wazifa_screen_application(p_application_id uuid) RETURNS jsonb AS $$
DECLARE a wazifa_applications%ROWTYPE; s wazifa_students%ROWTYPE; v_candidates jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = 'P0001'; END IF;
  IF a.status NOT IN ('submitted', 'screening') THEN
    RAISE EXCEPTION 'This application has moved past screening already.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO s FROM wazifa_students WHERE id = a.student_id;

  UPDATE wazifa_applications SET status = 'screening' WHERE id = p_application_id;

  v_candidates := wazifa_check_zakat_family(s.father_name, s.mother_name, a.declared_cnic);
  RETURN jsonb_build_object('candidates', v_candidates, 'already_confirmed', s.is_zakat_family);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_screen_application(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_screen_application(uuid) TO authenticated;

-- ── The committee's own decision — the only place is_zakat_family is
--    ever set. Pass p_register_id = NULL to explicitly clear a wrong match
--    rather than leave it ambiguous. ──────────────────────────────────────
CREATE OR REPLACE FUNCTION wazifa_confirm_zakat_match(p_student_id uuid, p_register_id uuid) RETURNS jsonb AS $$
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_register_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM needs_register WHERE id = p_register_id) THEN
    RAISE EXCEPTION 'Household not found on the register.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_students
     SET is_zakat_family = (p_register_id IS NOT NULL),
         zakat_match_register_id = p_register_id,
         zakat_match_confirmed_by = current_admin_user_id(),
         zakat_match_confirmed_at = now()
   WHERE id = p_student_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Student not found' USING ERRCODE = 'P0001'; END IF;

  RETURN jsonb_build_object('ok', true, 'is_zakat_family', p_register_id IS NOT NULL);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_confirm_zakat_match(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_confirm_zakat_match(uuid, uuid) TO authenticated;
