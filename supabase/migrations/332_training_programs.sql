-- Migration 332: Phase B — in-village training programs, and registration
-- for them. mentor_portal_user_id is optional — a program can be run by an
-- approved mentor (migration 323) or entirely by staff; nothing requires
-- one.
CREATE TABLE IF NOT EXISTS training_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar NOT NULL,
  title_ur varchar,
  description text,
  location varchar,
  start_date date,
  end_date date,
  capacity int,
  category varchar NOT NULL DEFAULT 'freelancing'
    CHECK (category IN ('freelancing', 'vocational', 'academic', 'other')),
  mentor_portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  status varchar NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming', 'ongoing', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_program_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  training_program_id uuid NOT NULL REFERENCES training_programs(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  status varchar NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered', 'attended', 'no_show', 'cancelled')),
  registered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (training_program_id, portal_user_id)
);

ALTER TABLE training_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_program_registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "training_programs_read" ON training_programs FOR SELECT USING (status <> 'cancelled');
CREATE POLICY "training_programs_write" ON training_programs FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

CREATE POLICY "training_registrations_own_read" ON training_program_registrations FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id() OR current_admin_role() IN ('super_admin', 'admin'));
-- A capacity check belongs in a function, not a bare INSERT policy — this
-- keeps "the program is full" as an actual sentence the portal page can
-- show, not a silent RLS rejection.
CREATE OR REPLACE FUNCTION register_for_training_program(p_training_program_id uuid) RETURNS void AS $$
DECLARE
  v_portal_user_id uuid;
  v_capacity int;
  v_registered_count int;
  v_status varchar;
BEGIN
  v_portal_user_id := current_portal_user_id();
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT capacity, status INTO v_capacity, v_status FROM training_programs WHERE id = p_training_program_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Program not found'; END IF;
  IF v_status NOT IN ('upcoming', 'ongoing') THEN RAISE EXCEPTION 'Registration is closed for this program'; END IF;

  IF v_capacity IS NOT NULL THEN
    SELECT count(*) INTO v_registered_count FROM training_program_registrations
      WHERE training_program_id = p_training_program_id AND status = 'registered';
    IF v_registered_count >= v_capacity THEN
      RAISE EXCEPTION 'This program is full';
    END IF;
  END IF;

  INSERT INTO training_program_registrations (training_program_id, portal_user_id)
  VALUES (p_training_program_id, v_portal_user_id)
  ON CONFLICT (training_program_id, portal_user_id) DO UPDATE SET status = 'registered';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION register_for_training_program(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_for_training_program(uuid) TO authenticated;

CREATE POLICY "training_registrations_cancel_own" ON training_program_registrations FOR UPDATE TO authenticated
  USING (portal_user_id = current_portal_user_id())
  WITH CHECK (portal_user_id = current_portal_user_id() AND status = 'cancelled');
CREATE POLICY "training_registrations_admin_manage" ON training_program_registrations FOR UPDATE TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));
