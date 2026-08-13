-- Migration 217: the schools the committee actually pays fees to.
--
-- Until now a child's school was free text and the fee was one number in
-- Settings applied to every child alike. That is wrong in two ways that both
-- cost money:
--
--   A government school in the village charges almost nothing; a private
--   school in Chakwal charges two or three thousand a month, and every
--   private school charges something different. One default cannot describe
--   both, so either the government children are over-budgeted or the private
--   ones are under-funded and somebody has to go back and ask for more.
--
--   Fees climb with class. The same school charging Rs 1,500 for a child in
--   class 2 charges Rs 3,000 for the same child in class 9 — and the child
--   the committee sponsors for six years passes through both.
--
-- So schools are a register the committee maintains, with fee tiers by class,
-- and a child's package is built from the fee their actual school actually
-- charges for the class they are actually in.

CREATE TABLE IF NOT EXISTS schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  name_ur varchar,
  kind varchar NOT NULL DEFAULT 'private'
    CHECK (kind IN ('government', 'private', 'madrassa', 'college', 'vocational', 'other')),
  location varchar NOT NULL DEFAULT 'village'
    CHECK (location IN ('village', 'chakwal', 'other')),
  address varchar,
  distance_km decimal,
  contact_phone varchar,
  principal_name varchar,

  -- The fee when no tier matches the child's class. A government school can
  -- sit at zero and still carry real annual charges below.
  monthly_fee_pkr decimal NOT NULL DEFAULT 0 CHECK (monthly_fee_pkr >= 0),
  -- Pakistani private schools bill twelve months, including the summer break.
  -- Set to 10 or 11 for a school that does not.
  months_charged int NOT NULL DEFAULT 12 CHECK (months_charged BETWEEN 1 AND 12),

  -- Charged once a year rather than monthly, and easy to forget until the
  -- challan arrives in April.
  admission_fee_pkr decimal NOT NULL DEFAULT 0,
  annual_charges_pkr decimal NOT NULL DEFAULT 0,
  exam_fee_pkr decimal NOT NULL DEFAULT 0,
  books_pkr decimal NOT NULL DEFAULT 0,
  uniform_pkr decimal NOT NULL DEFAULT 0,

  -- Whether the school runs its own van, and what it charges. A child at a
  -- school with no transport has to be got there some other way, which is a
  -- cost the committee still bears.
  provides_transport boolean NOT NULL DEFAULT false,
  transport_monthly_pkr decimal NOT NULL DEFAULT 0,

  -- Some private schools waive or halve fees for an orphan or a hafiz. Worth
  -- recording, because it is money the committee does not have to find.
  concession_note varchar,

  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS schools_name_key ON schools(lower(name));
CREATE INDEX IF NOT EXISTS schools_active_idx ON schools(is_active, location);

-- ── Fees by class ────────────────────────────────────────────────────────
-- class_level: 0 for nursery, KG and prep; 1–12 for classes one to twelve.
-- A school with one flat fee simply has no tiers and falls back to
-- monthly_fee_pkr above.
CREATE TABLE IF NOT EXISTS school_fee_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  label varchar,
  class_from int NOT NULL CHECK (class_from BETWEEN 0 AND 12),
  class_to int NOT NULL CHECK (class_to BETWEEN 0 AND 12),
  monthly_fee_pkr decimal NOT NULL DEFAULT 0 CHECK (monthly_fee_pkr >= 0),
  annual_charges_pkr decimal NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  CHECK (class_to >= class_from)
);

CREATE INDEX IF NOT EXISTS school_fee_tiers_school_idx ON school_fee_tiers(school_id, class_from);

-- "Class 9", "9th", "IX", "nursery" — the committee will type whatever is on
-- the challan, so the number has to be dug out rather than demanded.
CREATE OR REPLACE FUNCTION class_to_level(p_class varchar) RETURNS int AS $$
DECLARE v text; n int;
BEGIN
  IF p_class IS NULL THEN RETURN NULL; END IF;
  v := lower(trim(p_class));
  IF v ~ '(nursery|kg|k\.g|prep|montessori|playgroup|pg\b)' THEN RETURN 0; END IF;

  n := NULLIF(regexp_replace(v, '\D', '', 'g'), '')::int;
  IF n IS NOT NULL AND n BETWEEN 1 AND 12 THEN RETURN n; END IF;

  -- Roman numerals turn up on older school records.
  RETURN CASE v
    WHEN 'i' THEN 1 WHEN 'ii' THEN 2 WHEN 'iii' THEN 3 WHEN 'iv' THEN 4
    WHEN 'v' THEN 5 WHEN 'vi' THEN 6 WHEN 'vii' THEN 7 WHEN 'viii' THEN 8
    WHEN 'ix' THEN 9 WHEN 'x' THEN 10 WHEN 'xi' THEN 11 WHEN 'xii' THEN 12
    ELSE NULL END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION school_fee_for_class(p_school_id uuid, p_class varchar)
RETURNS jsonb AS $$
DECLARE
  s schools%ROWTYPE;
  t school_fee_tiers%ROWTYPE;
  v_level int;
  v_monthly decimal;
  v_annual decimal;
BEGIN
  SELECT * INTO s FROM schools WHERE id = p_school_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_level := class_to_level(p_class);
  IF v_level IS NOT NULL THEN
    SELECT * INTO t FROM school_fee_tiers
     WHERE school_id = p_school_id AND v_level BETWEEN class_from AND class_to
     ORDER BY class_from LIMIT 1;
  END IF;

  v_monthly := COALESCE(t.monthly_fee_pkr, s.monthly_fee_pkr);
  v_annual := COALESCE(NULLIF(t.annual_charges_pkr, 0), s.annual_charges_pkr);

  RETURN jsonb_build_object(
    'school', s.name,
    'kind', s.kind,
    'location', s.location,
    'class_level', v_level,
    'tier', t.label,
    'monthly_fee', v_monthly,
    'months_charged', s.months_charged,
    'annual_fee', v_monthly * s.months_charged,
    'annual_charges', v_annual,
    'admission_fee', s.admission_fee_pkr,
    'exam_fee', s.exam_fee_pkr,
    'books', s.books_pkr,
    'uniform', s.uniform_pkr,
    'transport_monthly', CASE WHEN s.provides_transport THEN s.transport_monthly_pkr ELSE 0 END,
    'transport_annual', CASE WHEN s.provides_transport THEN s.transport_monthly_pkr * 12 ELSE 0 END
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION school_fee_for_class(uuid, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION class_to_level(varchar) TO authenticated;

-- ── Children point at a school rather than naming one ────────────────────
ALTER TABLE kafalat_children
  ADD COLUMN IF NOT EXISTS school_id uuid REFERENCES schools(id) ON DELETE SET NULL;

ALTER TABLE wazifa_family_members
  ADD COLUMN IF NOT EXISTS school_id uuid REFERENCES schools(id) ON DELETE SET NULL;

-- ── The package is built from what the school actually charges ───────────
-- The Settings defaults stay as the fallback for a child whose school is not
-- on the register yet, so nothing breaks while the register is being filled
-- in — but a child with a school gets that school's real numbers.
CREATE OR REPLACE FUNCTION kafalat_default_package(p_child_id uuid, p_academic_year varchar)
RETURNS void AS $$
DECLARE
  c kafalat_children%ROWTYPE;
  f jsonb;
  v_transport decimal;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id;
  IF NOT FOUND THEN RETURN; END IF;

  DELETE FROM kafalat_package_lines
   WHERE child_id = p_child_id AND academic_year = p_academic_year;

  IF c.school_id IS NOT NULL THEN
    f := school_fee_for_class(c.school_id, c.current_class);
  END IF;

  IF f IS NOT NULL THEN
    -- The school's own van if it runs one; otherwise the committee's standing
    -- figure for getting a child to Chakwal and back.
    v_transport := (f->>'transport_annual')::decimal;
    IF v_transport = 0 AND (f->>'location') = 'chakwal' THEN
      v_transport := setting_text('kafalat_transport_chakwal', '48000')::decimal;
    END IF;

    INSERT INTO kafalat_package_lines (child_id, academic_year, category, description, annual_amount_pkr) VALUES
      (p_child_id, p_academic_year, 'school_fee',
       (f->>'monthly_fee') || ' x ' || (f->>'months_charged') || ' months',
       (f->>'annual_fee')::decimal + (f->>'annual_charges')::decimal),
      (p_child_id, p_academic_year, 'uniform', NULL,
       COALESCE(NULLIF((f->>'uniform')::decimal, 0), setting_text('kafalat_default_uniform', '8000')::decimal)),
      (p_child_id, p_academic_year, 'books', NULL,
       COALESCE(NULLIF((f->>'books')::decimal, 0), setting_text('kafalat_default_books', '6000')::decimal)),
      (p_child_id, p_academic_year, 'transport', NULL, v_transport),
      (p_child_id, p_academic_year, 'pocket_money', NULL, setting_text('kafalat_default_pocket_money', '12000')::decimal),
      (p_child_id, p_academic_year, 'medical', NULL, setting_text('kafalat_default_medical', '4000')::decimal),
      (p_child_id, p_academic_year, 'exam_fee', NULL,
       COALESCE(NULLIF((f->>'exam_fee')::decimal, 0), setting_text('kafalat_default_exam_fee', '3000')::decimal));
    RETURN;
  END IF;

  -- No school on the register yet: fall back to the committee's defaults.
  v_transport := CASE c.school_location
    WHEN 'village' THEN setting_text('kafalat_transport_village', '0')::decimal
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

-- What the committee is currently paying, per school. The number that answers
-- "why has the kafalat fund gone up?" without anybody opening a ledger.
CREATE OR REPLACE FUNCTION school_cost_summary() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'name'), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'id', s.id, 'name', s.name, 'kind', s.kind, 'location', s.location,
      'children', (SELECT count(*) FROM kafalat_children c
                    WHERE c.school_id = s.id AND c.status = 'active'),
      'annual_cost', (SELECT COALESCE(SUM(kafalat_package_total(c.id, NULL::varchar)), 0)
                        FROM kafalat_children c
                       WHERE c.school_id = s.id AND c.status = 'active')
    ) AS x
    FROM schools s WHERE s.is_active
  ) y;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION school_cost_summary() TO authenticated;

-- Two starting rows so the register is not an empty page. Both are meant to
-- be corrected — the committee knows the real figures and this only shows the
-- shape of what to fill in.
INSERT INTO schools (name, name_ur, kind, location, monthly_fee_pkr, admission_fee_pkr,
                     annual_charges_pkr, exam_fee_pkr, books_pkr, uniform_pkr, notes)
VALUES
  ('Government Boys High School, Dhab Pari', 'گورنمنٹ بوائز ہائی سکول ڈھاب پڑی',
   'government', 'village', 0, 0, 500, 500, 3000, 4000,
   'Example row — correct the figures and add the girls school.'),
  ('Government Girls High School, Dhab Pari', 'گورنمنٹ گرلز ہائی سکول ڈھاب پڑی',
   'government', 'village', 0, 0, 500, 500, 3000, 4000,
   'Example row — correct the figures.')
ON CONFLICT DO NOTHING;

ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_fee_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS schools_admin ON schools;
CREATE POLICY schools_admin ON schools FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

-- A family filling in the wazifa form has to be able to pick their school
-- from the list, so reading it is open to any signed-in user. Fees a school
-- charges are not a secret; they are printed on the challan.
DROP POLICY IF EXISTS schools_read ON schools;
CREATE POLICY schools_read ON schools FOR SELECT TO authenticated USING (is_active);

DROP POLICY IF EXISTS school_tiers_admin ON school_fee_tiers;
CREATE POLICY school_tiers_admin ON school_fee_tiers FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS school_tiers_read ON school_fee_tiers;
CREATE POLICY school_tiers_read ON school_fee_tiers FOR SELECT TO authenticated USING (true);

REVOKE ALL ON schools FROM anon;
REVOKE ALL ON school_fee_tiers FROM anon;
