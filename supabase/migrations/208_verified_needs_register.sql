-- Migration 208: the Verified Needs Register.
--
-- The single list of who in the village genuinely needs help, and who checked.
-- Zakat, Kafalat, Taleemi Wazifa, Fitrana, Qurbani meat and ration
-- distribution all read from this one register. Built three times over it
-- would end up disagreeing with itself, and the first public disagreement is
-- the one that costs the committee the village's trust.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Identity is the hard part
-- ═════════════════════════════════════════════════════════════════════════
-- People register on a promise that their name is never revealed — not on the
-- website, not to a donor, not in a report. A promise like that has to be
-- structural or it leaks the first time somebody exports a spreadsheet.
--
-- So the register is split in two:
--
--   needs_register        names, CNIC, address, survey photos.
--                         Readable only by a verifier.
--   needs_register_safe   code, category, household size, status.
--                         Readable by any admin, and by nothing else.
--
-- Every other table in every other module references the CODE (MST-00042),
-- never the row. The accountant can hand out money to MST-00042 without ever
-- learning whose door it went to.

ALTER TABLE admin_users
  -- Deliberately its own permission and not implied by admin or super_admin.
  -- Running the system should not mean being able to read the poverty list.
  ADD COLUMN IF NOT EXISTS can_verify_needs boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION current_admin_is_needs_verifier() RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT can_verify_needs FROM admin_users
      WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION current_admin_is_needs_verifier() TO authenticated;

CREATE SEQUENCE IF NOT EXISTS needs_code_seq START 1;

CREATE OR REPLACE FUNCTION next_needs_code() RETURNS varchar AS $$
  SELECT 'MST-' || lpad(nextval('needs_code_seq')::text, 5, '0');
$$ LANGUAGE sql;

CREATE TABLE IF NOT EXISTS needs_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar NOT NULL UNIQUE DEFAULT next_needs_code(),

  -- ── Identity (verifier-only) ───────────────────────────────────────────
  head_name varchar NOT NULL,
  head_name_ur varchar,
  father_husband_name varchar,
  cnic varchar,
  phone varchar,
  address text,
  sector varchar,

  -- ── The eight asnaf (Qur'an 9:60) ──────────────────────────────────────
  -- Recorded because "poor" is not the only door. A man with a house and a
  -- job but Rs 400,000 of hospital debt is gharim and eligible; a stranded
  -- traveller is ibn-us-sabil. A register that only knows "poor" turns those
  -- people away wrongly.
  asnaf_category varchar NOT NULL DEFAULT 'faqir'
    CHECK (asnaf_category IN ('faqir', 'miskin', 'amil', 'muallaf',
                              'riqab', 'gharim', 'fi_sabilillah', 'ibn_us_sabil')),

  -- ── Circumstances (safe to expose in aggregate) ────────────────────────
  household_size int NOT NULL DEFAULT 1 CHECK (household_size > 0),
  dependants int NOT NULL DEFAULT 0 CHECK (dependants >= 0),
  earning_members int NOT NULL DEFAULT 0,
  monthly_income_pkr decimal DEFAULT 0,
  is_widow_headed boolean NOT NULL DEFAULT false,
  has_orphans boolean NOT NULL DEFAULT false,
  orphan_count int NOT NULL DEFAULT 0,
  has_disabled_member boolean NOT NULL DEFAULT false,
  school_age_children int NOT NULL DEFAULT 0,
  housing varchar CHECK (housing IN ('owned', 'rented', 'shared', 'kacha', 'homeless')),
  owns_land boolean NOT NULL DEFAULT false,
  livestock_note varchar,
  outstanding_debt_pkr decimal DEFAULT 0,
  -- Recorded so the committee can see, not so it can refuse: someone on the
  -- Rahmat Card may still be eligible. It just should not be invisible.
  receives_bisp boolean NOT NULL DEFAULT false,
  receives_govt_zakat boolean NOT NULL DEFAULT false,
  notes text,

  -- ── Status ─────────────────────────────────────────────────────────────
  status varchar NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'surveying', 'verified', 'rejected', 'expired', 'withdrawn')),
  rejection_reason text,

  -- Eligibility expires. Circumstances change, and a register that never
  -- expires quietly becomes fiction — which is worse than no register,
  -- because everyone still believes it.
  verified_at timestamptz,
  verified_until date,

  -- How they got here. Self-registration alone under-collects badly: the
  -- people most in need are the least likely to fill in a form, and in a
  -- village of a few hundred families, applying publicly is humiliating.
  source varchar NOT NULL DEFAULT 'survey'
    CHECK (source IN ('self', 'survey', 'nomination')),
  portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  nominated_by_portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  -- A neighbour can flag a household, but nobody gets put on a poverty list
  -- without knowing. Verification does not start until this is true.
  family_consented boolean NOT NULL DEFAULT false,
  consented_at timestamptz,

  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS needs_register_status_idx ON needs_register(status, verified_until);
CREATE INDEX IF NOT EXISTS needs_register_code_idx ON needs_register(code);

-- ═════════════════════════════════════════════════════════════════════════
-- Verification: two people, never one
-- ═════════════════════════════════════════════════════════════════════════
-- One gatekeeper is bad for the household (who has no appeal) and bad for the
-- gatekeeper (who has no witness when accused). The rule is at least two.
CREATE TABLE IF NOT EXISTS needs_surveys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id uuid NOT NULL REFERENCES needs_register(id) ON DELETE CASCADE,
  visited_on date NOT NULL DEFAULT current_date,
  -- The house, never the people. It is sufficient evidence and it leaves the
  -- family their dignity.
  house_photo_urls text[],
  findings text,
  recommended_status varchar CHECK (recommended_status IN ('verified', 'rejected')),
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS needs_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id uuid NOT NULL REFERENCES needs_register(id) ON DELETE CASCADE,
  admin_user_id uuid NOT NULL REFERENCES admin_users(id),
  decision varchar NOT NULL CHECK (decision IN ('verify', 'reject')),
  reason text,

  -- ── Conflict of interest ───────────────────────────────────────────────
  -- Zakat cannot go to the giver's own parents, grandparents, children,
  -- grandchildren or spouse. Beyond the fiqh, the fastest way for a village
  -- committee to lose its reputation is for the zakat to visibly land on
  -- committee members' relatives. Every verifier declares, every time, and
  -- the declaration is stored where the report can print it. Built in from
  -- the start on purpose — added later it looks like a response to an
  -- accusation.
  relationship varchar NOT NULL DEFAULT 'none'
    CHECK (relationship IN ('none', 'parent', 'child', 'spouse', 'sibling',
                            'close_relative', 'other')),
  relationship_note varchar,
  created_at timestamptz DEFAULT now(),
  UNIQUE (register_id, admin_user_id)
);

CREATE OR REPLACE FUNCTION trg_needs_verification_guard() RETURNS trigger AS $$
DECLARE v_rel varchar;
BEGIN
  IF NOT COALESCE(current_admin_is_needs_verifier(), false) THEN
    RAISE EXCEPTION 'Only a needs verifier can record a verification' USING ERRCODE = 'P0001';
  END IF;

  -- A declared relationship in the prohibited class blocks the vote outright
  -- rather than merely noting it. A stored declaration nobody acts on is
  -- paperwork, not a safeguard.
  IF NEW.decision = 'verify'
     AND NEW.relationship IN ('parent', 'child', 'spouse') THEN
    RAISE EXCEPTION
      'You have declared a % relationship with this household. Zakat cannot be approved by a close relative — another verifier must decide this one.',
      NEW.relationship USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS needs_verification_guard ON needs_verifications;
CREATE TRIGGER needs_verification_guard
  BEFORE INSERT OR UPDATE ON needs_verifications
  FOR EACH ROW EXECUTE FUNCTION trg_needs_verification_guard();

-- How many independent verifiers a household needs. Settable, because a
-- committee of three cannot always field two for every visit.
INSERT INTO site_settings (key, value) VALUES
  ('needs_min_verifiers', '2'),
  ('needs_verification_months', '12')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION needs_apply_verification(p_register_id uuid) RETURNS jsonb AS $$
DECLARE
  v_min int;
  v_months int;
  v_verify int;
  v_reject int;
  v_status varchar;
BEGIN
  SELECT COALESCE(nullif(value, '')::int, 2) INTO v_min
    FROM site_settings WHERE key = 'needs_min_verifiers';
  v_min := COALESCE(v_min, 2);
  SELECT COALESCE(nullif(value, '')::int, 12) INTO v_months
    FROM site_settings WHERE key = 'needs_verification_months';
  v_months := COALESCE(v_months, 12);

  SELECT count(*) FILTER (WHERE decision = 'verify'),
         count(*) FILTER (WHERE decision = 'reject')
    INTO v_verify, v_reject
    FROM needs_verifications WHERE register_id = p_register_id;

  -- A rejection by anyone stops it: if one verifier who stood in the
  -- courtyard says no, that is a finding, not a vote to be outnumbered.
  IF v_reject > 0 THEN
    v_status := 'rejected';
    UPDATE needs_register SET status = 'rejected', updated_at = now()
     WHERE id = p_register_id;
  ELSIF v_verify >= v_min THEN
    v_status := 'verified';
    UPDATE needs_register
       SET status = 'verified', verified_at = now(),
           verified_until = ((now() AT TIME ZONE 'Asia/Karachi')::date + make_interval(months => v_months))::date,
           updated_at = now()
     WHERE id = p_register_id;
  ELSE
    v_status := 'surveying';
    UPDATE needs_register SET status = 'surveying', updated_at = now()
     WHERE id = p_register_id AND status = 'pending';
  END IF;

  RETURN jsonb_build_object('status', v_status, 'verifications', v_verify, 'required', v_min);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION needs_apply_verification(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION needs_apply_verification(uuid) TO authenticated;

-- Sweeps out eligibility that has run its course. Called by the register
-- screen, so it works without pg_cron.
CREATE OR REPLACE FUNCTION expire_needs_register() RETURNS void AS $$
  UPDATE needs_register SET status = 'expired', updated_at = now()
   WHERE status = 'verified'
     AND verified_until IS NOT NULL
     AND verified_until < (now() AT TIME ZONE 'Asia/Karachi')::date;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION expire_needs_register() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION expire_needs_register() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- The safe view — everything except who they are
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW needs_register_safe AS
  SELECT
    r.id, r.code, r.asnaf_category, r.status,
    r.household_size, r.dependants, r.earning_members,
    r.is_widow_headed, r.has_orphans, r.orphan_count, r.has_disabled_member,
    r.school_age_children, r.housing, r.owns_land,
    r.receives_bisp, r.receives_govt_zakat,
    r.verified_at, r.verified_until, r.source, r.created_at,
    (SELECT count(*) FROM needs_verifications v WHERE v.register_id = r.id AND v.decision = 'verify') AS verify_count
  FROM needs_register r;

-- ── Row level security ───────────────────────────────────────────────────
ALTER TABLE needs_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE needs_surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE needs_verifications ENABLE ROW LEVEL SECURITY;

-- Identity: verifiers only. Not admins, not super admins by default — a
-- super admin who needs to read it can grant themselves the permission, and
-- that grant is itself logged.
DROP POLICY IF EXISTS needs_register_verifier_all ON needs_register;
CREATE POLICY needs_register_verifier_all ON needs_register FOR ALL TO authenticated
  USING (current_admin_is_needs_verifier())
  WITH CHECK (current_admin_is_needs_verifier());

-- A household may read and withdraw its own entry.
DROP POLICY IF EXISTS needs_register_own_read ON needs_register;
CREATE POLICY needs_register_own_read ON needs_register FOR SELECT TO authenticated
  USING (portal_user_id IS NOT NULL AND portal_user_id = current_portal_user_id());

DROP POLICY IF EXISTS needs_register_self_insert ON needs_register;
CREATE POLICY needs_register_self_insert ON needs_register FOR INSERT TO authenticated
  WITH CHECK (
    portal_user_id = current_portal_user_id()
    AND status = 'pending' AND source = 'self'
    AND verified_at IS NULL AND verified_until IS NULL
  );

DROP POLICY IF EXISTS needs_surveys_verifier_all ON needs_surveys;
CREATE POLICY needs_surveys_verifier_all ON needs_surveys FOR ALL TO authenticated
  USING (current_admin_is_needs_verifier())
  WITH CHECK (current_admin_is_needs_verifier());

DROP POLICY IF EXISTS needs_verifications_verifier_all ON needs_verifications;
CREATE POLICY needs_verifications_verifier_all ON needs_verifications FOR ALL TO authenticated
  USING (current_admin_is_needs_verifier())
  WITH CHECK (current_admin_is_needs_verifier());

-- The safe view is what every other screen reads. SECURITY INVOKER would run
-- it under the caller's RLS and return nothing, so it is definer-owned and
-- deliberately exposes no identifying column.
--
-- A view cannot carry RLS of its own, so it is not granted to `authenticated`
-- directly: that role includes every villager with a portal login, and
-- "MST-00042 is a widow-headed household of six" is not a thing the village
-- should be able to browse. It is reached through the function below, which
-- can check who is asking.
ALTER VIEW needs_register_safe SET (security_invoker = off);
REVOKE ALL ON needs_register_safe FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION needs_register_list()
RETURNS SETOF needs_register_safe AS $$
  SELECT * FROM needs_register_safe
   WHERE can_access_system('donors_projects')
   ORDER BY code;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION needs_register_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION needs_register_list() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- What the public and donors are allowed to know: counts, never people
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION needs_register_summary() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'verified_households', count(*) FILTER (WHERE status = 'verified'),
    'pending', count(*) FILTER (WHERE status IN ('pending', 'surveying')),
    'widow_headed', count(*) FILTER (WHERE status = 'verified' AND is_widow_headed),
    'with_orphans', count(*) FILTER (WHERE status = 'verified' AND has_orphans),
    'with_disabled', count(*) FILTER (WHERE status = 'verified' AND has_disabled_member),
    'school_age_children', COALESCE(sum(school_age_children) FILTER (WHERE status = 'verified'), 0),
    'total_dependants', COALESCE(sum(dependants) FILTER (WHERE status = 'verified'), 0)
  ) FROM needs_register;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION needs_register_summary() TO anon, authenticated;
