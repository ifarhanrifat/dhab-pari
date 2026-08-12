-- Migration 211: Kafalat — sponsoring a school child.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Safeguarding comes first, because the harm here is to children
-- ═════════════════════════════════════════════════════════════════════════
-- A village site that publishes photographs of poor children, with their
-- names, beside the words "cannot afford school", does real damage to those
-- children in a place where everyone knows everyone. The sponsorship sector
-- learned this the hard way and its rules are strict: no last names, no
-- identifying details, photographs only with written guardian consent, and no
-- direct contact between sponsor and family.
--
-- So: children are never listed publicly. Sponsors see a first name behind a
-- login. Admin and accounting screens see a code — KFL-0007 — and nothing
-- else. The guardian can switch off display at any moment and it takes effect
-- immediately, without anyone having to be asked.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Designated, pooled, or shares
-- ═════════════════════════════════════════════════════════════════════════
-- If the money follows one named child and that sponsor stops paying in
-- October, a child is out of school in October. The large organisations avoid
-- this by pooling sponsor money rather than spending it literally on the one
-- child — and are mostly vague about saying so.
--
-- This does it the honest way. A sponsor takes a SHARE of a named child; the
-- money lands in the Kafalat pool; the share is recorded as an attribution
-- and a commitment. A lapsed sponsor does not put a child out of school —
-- the pool covers while the committee finds a replacement share. The page
-- says exactly that, which is the part the sector usually leaves out.

CREATE SEQUENCE IF NOT EXISTS kafalat_code_seq START 1;
CREATE OR REPLACE FUNCTION next_kafalat_code() RETURNS varchar AS $$
  SELECT 'KFL-' || lpad(nextval('kafalat_code_seq')::text, 4, '0');
$$ LANGUAGE sql;

CREATE TABLE IF NOT EXISTS kafalat_children (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar NOT NULL UNIQUE DEFAULT next_kafalat_code(),

  -- ── Identity ───────────────────────────────────────────────────────────
  -- first_name is the most a sponsor ever sees. full_name and everything
  -- under it is coordinator-only.
  first_name varchar NOT NULL,
  first_name_ur varchar,
  full_name varchar NOT NULL,
  guardian_name varchar NOT NULL,
  guardian_relation varchar CHECK (guardian_relation IN ('mother', 'father', 'grandparent',
                                                          'uncle', 'aunt', 'sibling', 'other')),
  guardian_phone varchar,
  guardian_cnic varchar,
  address text,
  date_of_birth date,
  gender varchar CHECK (gender IN ('male', 'female')),
  is_orphan boolean NOT NULL DEFAULT false,
  orphan_type varchar CHECK (orphan_type IN ('father_deceased', 'mother_deceased', 'both_deceased')),
  register_id uuid REFERENCES needs_register(id) ON DELETE SET NULL,

  -- ── Schooling ──────────────────────────────────────────────────────────
  school_name varchar,
  current_class varchar,
  -- Drives the transport line. A child walking to the village primary school
  -- has no transport cost; a child going to Chakwal, nine kilometres away,
  -- costs about Rs 4,000 a month — which is more than the school fee and is
  -- the single biggest reason a village child stops at primary.
  school_location varchar NOT NULL DEFAULT 'village'
    CHECK (school_location IN ('village', 'chakwal', 'other')),
  school_distance_km decimal,

  -- ── Consent and safeguarding ───────────────────────────────────────────
  guardian_consent_signed boolean NOT NULL DEFAULT false,
  guardian_consent_at timestamptz,
  guardian_consent_url text,
  -- A child with no photo must not be disadvantaged, so the sponsor view
  -- falls back to initials and nobody is told why.
  photo_consent boolean NOT NULL DEFAULT false,
  photo_url text,
  -- Withdrawable at any time by the guardian, effective immediately.
  do_not_display boolean NOT NULL DEFAULT false,

  status varchar NOT NULL DEFAULT 'nominated'
    CHECK (status IN ('nominated', 'screening', 'verified', 'active', 'graduated',
                      'withdrawn', 'declined', 'left_village')),
  decline_reason text,
  joined_on date,
  ended_on date,
  ended_reason text,

  notes text,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kafalat_children_status_idx ON kafalat_children(status);

-- ── The package, built from lines rather than typed as one number ────────
-- So a sponsor can see exactly what their money buys, and the committee can
-- defend every rupee of it at a meeting.
CREATE TABLE IF NOT EXISTS kafalat_package_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id uuid NOT NULL REFERENCES kafalat_children(id) ON DELETE CASCADE,
  academic_year varchar NOT NULL,
  category varchar NOT NULL
    CHECK (category IN ('school_fee', 'uniform', 'books', 'transport',
                        'pocket_money', 'medical', 'exam_fee', 'tuition', 'other')),
  description varchar,
  annual_amount_pkr decimal NOT NULL DEFAULT 0 CHECK (annual_amount_pkr >= 0),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kafalat_package_child_idx ON kafalat_package_lines(child_id, academic_year);

-- Indicative annual figures for a Chakwal village child. The committee edits
-- them per child — these only decide what the form is prefilled with.
INSERT INTO site_settings (key, value) VALUES
  ('kafalat_default_school_fee', '24000'),
  ('kafalat_default_uniform', '8000'),
  ('kafalat_default_books', '6000'),
  ('kafalat_default_pocket_money', '12000'),
  ('kafalat_default_medical', '4000'),
  ('kafalat_default_exam_fee', '3000'),
  -- Nothing for a child at the village school; Rs 4,000 a month for the run
  -- into Chakwal.
  ('kafalat_transport_village', '0'),
  ('kafalat_transport_chakwal', '48000'),
  -- Below this a child ends up with forty micro-sponsors and an
  -- administrative problem nobody can carry.
  ('kafalat_min_share_percent', '10'),
  ('kafalat_renewal_reminder_month', '2')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION kafalat_default_package(p_child_id uuid, p_academic_year varchar)
RETURNS void AS $$
DECLARE
  c kafalat_children%ROWTYPE;
  v_transport decimal;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_transport := CASE c.school_location
    WHEN 'village' THEN setting_text('kafalat_transport_village', '0')::decimal
    WHEN 'chakwal' THEN setting_text('kafalat_transport_chakwal', '48000')::decimal
    ELSE setting_text('kafalat_transport_chakwal', '48000')::decimal
  END;

  INSERT INTO kafalat_package_lines (child_id, academic_year, category, annual_amount_pkr) VALUES
    (p_child_id, p_academic_year, 'school_fee',   setting_text('kafalat_default_school_fee', '24000')::decimal),
    (p_child_id, p_academic_year, 'uniform',      setting_text('kafalat_default_uniform', '8000')::decimal),
    (p_child_id, p_academic_year, 'books',        setting_text('kafalat_default_books', '6000')::decimal),
    (p_child_id, p_academic_year, 'transport',    v_transport),
    (p_child_id, p_academic_year, 'pocket_money', setting_text('kafalat_default_pocket_money', '12000')::decimal),
    (p_child_id, p_academic_year, 'medical',      setting_text('kafalat_default_medical', '4000')::decimal),
    (p_child_id, p_academic_year, 'exam_fee',     setting_text('kafalat_default_exam_fee', '3000')::decimal);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION kafalat_package_total(p_child_id uuid, p_academic_year varchar DEFAULT NULL)
RETURNS decimal AS $$
  SELECT COALESCE(SUM(annual_amount_pkr), 0) FROM kafalat_package_lines
   WHERE child_id = p_child_id
     AND (p_academic_year IS NULL OR academic_year = p_academic_year);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ── Shares ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kafalat_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id uuid NOT NULL REFERENCES kafalat_children(id) ON DELETE CASCADE,

  sponsor_name varchar NOT NULL,
  sponsor_name_ur varchar,
  sponsor_phone varchar,
  portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  is_anonymous boolean NOT NULL DEFAULT false,

  share_percent decimal NOT NULL CHECK (share_percent > 0 AND share_percent <= 100),
  annual_amount_pkr decimal NOT NULL DEFAULT 0,

  -- Zakat-funded kafalat has to reach the guardian rather than the school,
  -- because the committee paying a school on the child's behalf is the
  -- committee spending the money and not the child owning it. Recorded here
  -- because it changes how the payment is physically made.
  funded_by varchar NOT NULL DEFAULT 'sadqa'
    CHECK (funded_by IN ('sadqa', 'zakat', 'general')),

  duration varchar NOT NULL DEFAULT 'one_year'
    CHECK (duration IN ('one_year', 'two_years', 'till_matric', 'open_ended')),
  starts_on date NOT NULL DEFAULT current_date,
  ends_on date,
  recurring_schedule_id uuid REFERENCES recurring_schedules(id) ON DELETE SET NULL,

  status varchar NOT NULL DEFAULT 'pledged'
    CHECK (status IN ('pledged', 'active', 'lapsed', 'completed', 'cancelled')),
  lapsed_at timestamptz,
  cancelled_reason text,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kafalat_shares_child_idx ON kafalat_shares(child_id, status);

CREATE OR REPLACE FUNCTION kafalat_committed_percent(p_child_id uuid) RETURNS decimal AS $$
  SELECT COALESCE(SUM(share_percent), 0) FROM kafalat_shares
   WHERE child_id = p_child_id AND status IN ('pledged', 'active');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_kafalat_share_guard() RETURNS trigger AS $$
DECLARE
  v_min decimal;
  v_committed decimal;
  v_total decimal;
BEGIN
  v_min := COALESCE(nullif(setting_text('kafalat_min_share_percent', '10'), '')::decimal, 10);
  IF NEW.share_percent < v_min THEN
    RAISE EXCEPTION 'The smallest share is %%%. A child split into smaller pieces than that cannot be administered.', v_min
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(share_percent), 0) INTO v_committed
    FROM kafalat_shares
   WHERE child_id = NEW.child_id AND status IN ('pledged', 'active')
     AND id IS DISTINCT FROM NEW.id;

  IF v_committed + NEW.share_percent > 100.0001 THEN
    RAISE EXCEPTION 'Only %%% of this child is still unsponsored.', round(100 - v_committed, 2)
      USING ERRCODE = 'P0001';
  END IF;

  -- The rupee value of the share, so a sponsor sees a number and not a
  -- percentage they have to work out themselves.
  v_total := kafalat_package_total(NEW.child_id, NULL);
  NEW.annual_amount_pkr := round(v_total * NEW.share_percent / 100.0);

  IF NEW.ends_on IS NULL THEN
    NEW.ends_on := CASE NEW.duration
      WHEN 'one_year'  THEN NEW.starts_on + interval '1 year'
      WHEN 'two_years' THEN NEW.starts_on + interval '2 years'
      ELSE NULL
    END::date;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS kafalat_share_guard ON kafalat_shares;
CREATE TRIGGER kafalat_share_guard
  BEFORE INSERT OR UPDATE ON kafalat_shares
  FOR EACH ROW EXECUTE FUNCTION trg_kafalat_share_guard();

-- ── What keeps a sponsor renewing ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kafalat_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id uuid NOT NULL REFERENCES kafalat_children(id) ON DELETE CASCADE,
  term varchar NOT NULL,
  attendance_percent decimal CHECK (attendance_percent BETWEEN 0 AND 100),
  result_summary varchar,
  position_in_class varchar,
  teacher_note text,
  teacher_note_ur text,
  photo_url text,
  published boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

-- ── Nominations ──────────────────────────────────────────────────────────
-- Neighbours know things the committee does not. Anyone with a portal login
-- may point at a child; the committee then screens and visits.
CREATE TABLE IF NOT EXISTS kafalat_nominations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_name varchar NOT NULL,
  guardian_name varchar,
  approximate_age int,
  gender varchar CHECK (gender IN ('male', 'female')),
  address_hint varchar,
  reason text NOT NULL,
  nominated_by_portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  nominator_phone varchar,
  status varchar NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'screening', 'accepted', 'declined', 'duplicate')),
  review_note text,
  child_id uuid REFERENCES kafalat_children(id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

-- ═════════════════════════════════════════════════════════════════════════
-- What a sponsor is allowed to see
-- ═════════════════════════════════════════════════════════════════════════
-- First name, class, age band, package — never a family name, never an
-- address, never a school name alongside a photo.
CREATE OR REPLACE FUNCTION kafalat_available_children()
RETURNS TABLE (
  id uuid, code varchar, first_name varchar, first_name_ur varchar,
  gender varchar, age int, current_class varchar, school_location varchar,
  is_orphan boolean, annual_package_pkr decimal,
  committed_percent decimal, remaining_percent decimal,
  photo_url text
) AS $$
  SELECT
    c.id, c.code,
    c.first_name, c.first_name_ur, c.gender,
    CASE WHEN c.date_of_birth IS NULL THEN NULL
         ELSE date_part('year', age(c.date_of_birth))::int END,
    c.current_class, c.school_location, c.is_orphan,
    kafalat_package_total(c.id, NULL),
    kafalat_committed_percent(c.id),
    GREATEST(100 - kafalat_committed_percent(c.id), 0),
    CASE WHEN c.photo_consent AND NOT c.do_not_display THEN c.photo_url ELSE NULL END
  FROM kafalat_children c
  WHERE c.status = 'active'
    AND c.guardian_consent_signed
  ORDER BY kafalat_committed_percent(c.id) DESC, c.created_at;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Signed-in sponsors only. Never anon, and never rendered on a public page.
REVOKE ALL ON FUNCTION kafalat_available_children() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_available_children() TO authenticated;

-- The public gets counts and outcomes, which is all it needs to be moved.
CREATE OR REPLACE FUNCTION public_kafalat_summary() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'active_children', count(*) FILTER (WHERE status = 'active'),
    'fully_sponsored', count(*) FILTER (WHERE status = 'active' AND kafalat_committed_percent(id) >= 100),
    'partly_sponsored', count(*) FILTER (WHERE status = 'active'
                                          AND kafalat_committed_percent(id) > 0
                                          AND kafalat_committed_percent(id) < 100),
    'awaiting_sponsor', count(*) FILTER (WHERE status = 'active' AND kafalat_committed_percent(id) = 0),
    'graduated', count(*) FILTER (WHERE status = 'graduated'),
    'girls', count(*) FILTER (WHERE status = 'active' AND gender = 'female'),
    'boys', count(*) FILTER (WHERE status = 'active' AND gender = 'male'),
    'orphans', count(*) FILTER (WHERE status = 'active' AND is_orphan),
    'annual_need_pkr', COALESCE(SUM(kafalat_package_total(id, NULL)) FILTER (WHERE status = 'active'), 0)
  ) FROM kafalat_children;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public_kafalat_summary() TO anon, authenticated;

-- ── Row level security ───────────────────────────────────────────────────
ALTER TABLE kafalat_children ENABLE ROW LEVEL SECURITY;
ALTER TABLE kafalat_package_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE kafalat_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE kafalat_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE kafalat_nominations ENABLE ROW LEVEL SECURITY;

-- The child's full record is coordinator territory. Ordinary donor-system
-- admins reach the children through the code-only functions above.
DROP POLICY IF EXISTS kafalat_children_admin ON kafalat_children;
CREATE POLICY kafalat_children_admin ON kafalat_children FOR ALL TO authenticated
  USING (current_admin_is_needs_verifier() OR current_admin_is_super_admin())
  WITH CHECK (current_admin_is_needs_verifier() OR current_admin_is_super_admin());

DROP POLICY IF EXISTS kafalat_package_admin ON kafalat_package_lines;
CREATE POLICY kafalat_package_admin ON kafalat_package_lines FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS kafalat_shares_admin ON kafalat_shares;
CREATE POLICY kafalat_shares_admin ON kafalat_shares FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS kafalat_shares_own ON kafalat_shares;
CREATE POLICY kafalat_shares_own ON kafalat_shares FOR SELECT TO authenticated
  USING (portal_user_id IS NOT NULL AND portal_user_id = current_portal_user_id());

DROP POLICY IF EXISTS kafalat_progress_admin ON kafalat_progress;
CREATE POLICY kafalat_progress_admin ON kafalat_progress FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

-- A sponsor sees progress cards only for a child they actually sponsor, and
-- only once the coordinator has published them.
DROP POLICY IF EXISTS kafalat_progress_sponsor ON kafalat_progress;
CREATE POLICY kafalat_progress_sponsor ON kafalat_progress FOR SELECT TO authenticated
  USING (
    published AND EXISTS (
      SELECT 1 FROM kafalat_shares s
       WHERE s.child_id = kafalat_progress.child_id
         AND s.portal_user_id = current_portal_user_id()
         AND s.status IN ('pledged', 'active')
    )
  );

DROP POLICY IF EXISTS kafalat_nominations_admin ON kafalat_nominations;
CREATE POLICY kafalat_nominations_admin ON kafalat_nominations FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS kafalat_nominations_create ON kafalat_nominations;
CREATE POLICY kafalat_nominations_create ON kafalat_nominations FOR INSERT TO authenticated
  WITH CHECK (nominated_by_portal_user_id = current_portal_user_id() AND status = 'new');

DROP POLICY IF EXISTS kafalat_nominations_own ON kafalat_nominations;
CREATE POLICY kafalat_nominations_own ON kafalat_nominations FOR SELECT TO authenticated
  USING (nominated_by_portal_user_id = current_portal_user_id());

REVOKE ALL ON kafalat_children FROM anon;
REVOKE ALL ON kafalat_package_lines FROM anon;
REVOKE ALL ON kafalat_shares FROM anon;
REVOKE ALL ON kafalat_progress FROM anon;
REVOKE ALL ON kafalat_nominations FROM anon;
