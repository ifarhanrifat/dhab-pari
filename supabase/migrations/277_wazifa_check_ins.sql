-- Migration 277: a phone call to the institute or hostel is its own kind
-- of evidence, worth keeping a record of — separate from who got paid.
--
-- Payment routing (institute vs student vs hostel) tells you where the
-- money went, not whether the student is still there. A zakat-track
-- interim grant can run for up to a year before the next verification
-- visit would naturally happen — this is the lighter, faster check in
-- between: ring the number the applicant themselves gave (migration 274),
-- ask, and write down what was said. It is what wazifa_stop_interim_grant
-- (migration 276) is meant to be used against — a real report, not a
-- hunch.
CREATE TABLE IF NOT EXISTS wazifa_check_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES wazifa_awards(id) ON DELETE CASCADE,
  method varchar NOT NULL CHECK (method IN ('phone_institute', 'phone_hostel', 'phone_student', 'visit')),
  confirmed boolean NOT NULL,
  note text,
  checked_on date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Karachi')::date,
  checked_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazifa_check_ins_award_idx ON wazifa_check_ins(award_id, checked_on);

ALTER TABLE wazifa_check_ins ENABLE ROW LEVEL SECURITY;
CREATE POLICY wazifa_check_ins_admin ON wazifa_check_ins FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));
-- Read-only for the student it's about — the same transparency this
-- codebase already gives a Kafalat sponsor over their own spending record.
CREATE POLICY wazifa_check_ins_own ON wazifa_check_ins FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
                  WHERE a.id = wazifa_check_ins.award_id AND s.portal_user_id = current_portal_user_id()));

CREATE OR REPLACE FUNCTION wazifa_record_check_in(
  p_award_id uuid, p_method varchar, p_confirmed boolean, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM wazifa_awards WHERE id = p_award_id) THEN
    RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001';
  END IF;
  IF NOT p_confirmed AND trim(COALESCE(p_note, '')) = '' THEN
    RAISE EXCEPTION 'If this could not be confirmed, write what was actually said.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO wazifa_check_ins (award_id, method, confirmed, note, checked_by)
  VALUES (p_award_id, p_method, p_confirmed, p_note, current_admin_user_id())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('check_in_id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_record_check_in(uuid, varchar, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_record_check_in(uuid, varchar, boolean, text) TO authenticated;
