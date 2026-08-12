-- Migration 210: Esal-e-Sawab — a lasting object dedicated to the deceased.
--
-- A donor funds something the village keeps using — a water cooler, a solar
-- street light, a hand pump — carrying a plaque in memory of a parent, a
-- brother, a sister. The reward continues for as long as the thing works,
-- which is the whole meaning of sadqa-e-jariya.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Who owns it afterwards
-- ═════════════════════════════════════════════════════════════════════════
-- The instinct is to say the object belongs to the donor. In fiqh it does
-- not: once dedicated for public benefit it is waqf, and cannot be reclaimed,
-- sold, or removed. What the donor keeps is the attribution and the reward.
--
-- This is not a technicality. If the register calls the cooler the donor's
-- property, then the day he emigrates, or dies, or falls out with the
-- committee, the village has a dispute over a public water cooler and no
-- record of who may settle it. So it is recorded as a committee-held waqf
-- asset permanently attributed to the named person, with the committee as
-- mutawalli — trustee, carrying the duty to maintain.
--
-- ═════════════════════════════════════════════════════════════════════════
-- The running cost is the part everyone forgets
-- ═════════════════════════════════════════════════════════════════════════
-- A water cooler needs electricity, filters and repairs. Twenty donated
-- coolers is a five-figure annual bill nobody voted for. Accepting a gift is
-- accepting a liability, so the liability is recorded at the moment of the
-- offer and totalled where the committee has to look at it before saying yes
-- to the twenty-first.

CREATE TABLE IF NOT EXISTS sadqa_catalogue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  name_ur varchar,
  description text,
  description_ur text,
  capital_cost_pkr decimal NOT NULL DEFAULT 0,
  -- Quoted to the donor up front, so "who pays the electricity?" is answered
  -- before the cooler arrives rather than after it stops working.
  annual_running_cost_pkr decimal NOT NULL DEFAULT 0,
  expected_life_years int,
  image_url text,
  display_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sadqa_catalogue_name_key ON sadqa_catalogue(name);

INSERT INTO sadqa_catalogue (name, name_ur, capital_cost_pkr, annual_running_cost_pkr, expected_life_years, display_order) VALUES
  ('Water cooler', 'واٹر کولر', 45000, 8000, 8, 1),
  ('Hand pump', 'ہینڈ پمپ', 25000, 2000, 15, 2),
  ('Submersible pump and tank', 'سبمرسیبل پمپ و ٹینک', 120000, 15000, 10, 3),
  -- No electricity bill, only a battery every few years — the most
  -- sustainable thing on this list for a village.
  ('Solar street light', 'سولر سٹریٹ لائٹ', 35000, 1500, 8, 4),
  ('Bus stop shelter / bench', 'بس سٹاپ شیلٹر / بینچ', 60000, 1000, 20, 5),
  ('Mosque fans and cooling', 'مسجد کے پنکھے و کولنگ', 30000, 4000, 8, 6),
  ('Janaza (funeral) equipment', 'جنازہ کا سامان', 40000, 2000, 15, 7),
  ('Wheelchair and walking aids', 'وہیل چیئر و سہارے', 15000, 500, 8, 8),
  ('School desks (set)', 'سکول ڈیسک (سیٹ)', 25000, 1000, 12, 9),
  ('Graveyard boundary and gate', 'قبرستان کی چاردیواری و گیٹ', 150000, 3000, 30, 10),
  ('Water filtration plant', 'واٹر فلٹریشن پلانٹ', 400000, 40000, 12, 11)
ON CONFLICT (name) DO NOTHING;

CREATE SEQUENCE IF NOT EXISTS sadqa_object_no_seq START 1;
CREATE OR REPLACE FUNCTION next_sadqa_no() RETURNS varchar AS $$
  SELECT 'ESW-' || lpad(nextval('sadqa_object_no_seq')::text, 4, '0');
$$ LANGUAGE sql;

CREATE TABLE IF NOT EXISTS sadqa_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_no varchar NOT NULL UNIQUE DEFAULT next_sadqa_no(),
  catalogue_id uuid REFERENCES sadqa_catalogue(id),
  -- Free text so a donor can offer something not on the list.
  item_name varchar NOT NULL,
  item_name_ur varchar,

  -- ── Who is offering ────────────────────────────────────────────────────
  donor_name varchar NOT NULL,
  donor_name_ur varchar,
  donor_phone varchar,
  portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  donor_is_anonymous boolean NOT NULL DEFAULT false,

  -- ── The dedication ─────────────────────────────────────────────────────
  -- The plaque is the point. Short, because a plaque nobody can read from
  -- two steps away is a plaque that failed.
  dedicated_to varchar NOT NULL,
  dedicated_to_ur varchar,
  relationship varchar CHECK (relationship IN ('father', 'mother', 'brother', 'sister',
                                               'son', 'daughter', 'husband', 'wife',
                                               'grandparent', 'relative', 'friend', 'self', 'other')),
  plaque_text varchar CHECK (plaque_text IS NULL OR char_length(plaque_text) <= 60),
  plaque_text_ur varchar CHECK (plaque_text_ur IS NULL OR char_length(plaque_text_ur) <= 60),
  dedication_note text,

  -- ── Where it goes ──────────────────────────────────────────────────────
  proposed_location varchar,
  approved_location varchar,
  latitude decimal,
  longitude decimal,

  -- ── Money ──────────────────────────────────────────────────────────────
  capital_cost_pkr decimal NOT NULL DEFAULT 0,
  annual_running_cost_pkr decimal NOT NULL DEFAULT 0,
  -- Three honest ways to answer "who keeps it working?".
  --   donor      — the donor commits to a recurring maintenance contribution
  --   committee  — the committee accepts an open-ended liability
  --   endowed    — a lump sum is given whose drawdown funds maintenance,
  --                the classic waqf, and the only one that scales
  maintenance_mode varchar NOT NULL DEFAULT 'committee'
    CHECK (maintenance_mode IN ('donor', 'committee', 'endowed')),
  endowment_pkr decimal NOT NULL DEFAULT 0,
  amount_received_pkr decimal NOT NULL DEFAULT 0,

  -- ── Lifecycle ──────────────────────────────────────────────────────────
  status varchar NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'declined', 'funded', 'procured',
                      'installed', 'in_service', 'needs_repair', 'retired')),
  decline_reason text,
  approved_at timestamptz,
  approved_by uuid REFERENCES admin_users(id),
  installed_on date,
  installed_photo_url text,
  -- What the family will want to show people. Worth insisting on.
  plaque_photo_url text,
  retired_on date,
  retired_reason text,
  -- A replacement inherits the plaque and the dedication. It costs nothing
  -- and it matters enormously to the family.
  replaced_by_object_id uuid REFERENCES sadqa_objects(id),

  last_checked_on date,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sadqa_objects_status_idx ON sadqa_objects(status);

CREATE TABLE IF NOT EXISTS sadqa_maintenance_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES sadqa_objects(id) ON DELETE CASCADE,
  event_date date NOT NULL DEFAULT current_date,
  kind varchar NOT NULL DEFAULT 'service'
    CHECK (kind IN ('check', 'service', 'repair', 'replacement_part', 'utility')),
  description text,
  cost_pkr decimal NOT NULL DEFAULT 0,
  paid_by varchar NOT NULL DEFAULT 'committee' CHECK (paid_by IN ('committee', 'donor', 'endowment')),
  voucher_id uuid REFERENCES vouchers(id) ON DELETE SET NULL,
  photo_url text,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

-- ═════════════════════════════════════════════════════════════════════════
-- Zakat cannot pay for any of this
-- ═════════════════════════════════════════════════════════════════════════
-- Buying a water cooler the committee will own is not transferring ownership
-- to a poor person. The rule belongs in the database, not in a note on the
-- wall behind the accountant.
CREATE OR REPLACE FUNCTION sadqa_object_link_donation(p_object_id uuid, p_donor_id uuid)
RETURNS void AS $$
DECLARE d donors%ROWTYPE;
BEGIN
  SELECT * INTO d FROM donors WHERE id = p_donor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Donation not found' USING ERRCODE = 'P0001'; END IF;
  IF d.fund_type IN ('zakat', 'ushr') THEN
    RAISE EXCEPTION
      'Zakat cannot fund an Esal-e-Sawab object. Zakat must pass into the ownership of a poor person; an object the committee holds does not qualify.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE sadqa_objects
     SET amount_received_pkr = amount_received_pkr + d.amount_pkr,
         status = CASE WHEN status = 'approved' THEN 'funded' ELSE status END,
         updated_at = now()
   WHERE id = p_object_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- The number the committee has to see before accepting another gift
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION sadqa_maintenance_liability() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'committee_annual', COALESCE(SUM(annual_running_cost_pkr) FILTER (
       WHERE maintenance_mode = 'committee' AND status IN ('in_service', 'needs_repair', 'installed')), 0),
    'donor_annual', COALESCE(SUM(annual_running_cost_pkr) FILTER (
       WHERE maintenance_mode = 'donor' AND status IN ('in_service', 'needs_repair', 'installed')), 0),
    'endowed_annual', COALESCE(SUM(annual_running_cost_pkr) FILTER (
       WHERE maintenance_mode = 'endowed' AND status IN ('in_service', 'needs_repair', 'installed')), 0),
    'endowment_held', COALESCE(SUM(endowment_pkr) FILTER (WHERE status <> 'retired'), 0),
    'live_objects', count(*) FILTER (WHERE status IN ('in_service', 'needs_repair', 'installed')),
    'spent_last_12m', COALESCE((SELECT SUM(cost_pkr) FROM sadqa_maintenance_log
                                 WHERE event_date >= current_date - interval '12 months'), 0)
  ) FROM sadqa_objects;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION sadqa_maintenance_liability() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- The board the village sees
-- ═════════════════════════════════════════════════════════════════════════
-- Thirty working objects with thirty family names on them is the most
-- persuasive page this site will ever have. The "still working" column is
-- also what keeps the committee honest about maintenance.
CREATE OR REPLACE FUNCTION public_sadqa_board()
RETURNS TABLE (
  object_no varchar, item_name varchar, item_name_ur varchar,
  dedicated_to varchar, dedicated_to_ur varchar, relationship varchar,
  plaque_text varchar, plaque_text_ur varchar,
  donor_name varchar, donor_name_ur varchar,
  location varchar, installed_on date, status varchar,
  photo_url text, plaque_photo_url text
) AS $$
  SELECT
    o.object_no, o.item_name, o.item_name_ur,
    o.dedicated_to, o.dedicated_to_ur, o.relationship,
    o.plaque_text, o.plaque_text_ur,
    -- The dedication is always shown; the donor's own name only if they
    -- want it. Many people give in a parent's name precisely so that the
    -- parent's name is the one that is read.
    CASE WHEN o.donor_is_anonymous THEN NULL ELSE o.donor_name END,
    CASE WHEN o.donor_is_anonymous THEN NULL ELSE o.donor_name_ur END,
    o.approved_location, o.installed_on, o.status,
    o.installed_photo_url, o.plaque_photo_url
  FROM sadqa_objects o
  WHERE o.status IN ('installed', 'in_service', 'needs_repair', 'retired')
  ORDER BY o.installed_on DESC NULLS LAST, o.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public_sadqa_board() TO anon, authenticated;

ALTER TABLE sadqa_catalogue ENABLE ROW LEVEL SECURITY;
ALTER TABLE sadqa_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE sadqa_maintenance_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sadqa_catalogue_read ON sadqa_catalogue;
CREATE POLICY sadqa_catalogue_read ON sadqa_catalogue FOR SELECT USING (is_active);
DROP POLICY IF EXISTS sadqa_catalogue_admin ON sadqa_catalogue;
CREATE POLICY sadqa_catalogue_admin ON sadqa_catalogue FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS sadqa_objects_admin ON sadqa_objects;
CREATE POLICY sadqa_objects_admin ON sadqa_objects FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

-- A portal user may offer an object and follow their own offers. They cannot
-- approve it, price it, or mark it installed.
DROP POLICY IF EXISTS sadqa_objects_own ON sadqa_objects;
CREATE POLICY sadqa_objects_own ON sadqa_objects FOR SELECT TO authenticated
  USING (portal_user_id IS NOT NULL AND portal_user_id = current_portal_user_id());

DROP POLICY IF EXISTS sadqa_objects_propose ON sadqa_objects;
CREATE POLICY sadqa_objects_propose ON sadqa_objects FOR INSERT TO authenticated
  WITH CHECK (
    portal_user_id = current_portal_user_id()
    AND status = 'proposed'
    AND amount_received_pkr = 0
    AND approved_at IS NULL
  );

DROP POLICY IF EXISTS sadqa_maintenance_admin ON sadqa_maintenance_log;
CREATE POLICY sadqa_maintenance_admin ON sadqa_maintenance_log FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

REVOKE ALL ON sadqa_objects FROM anon;
REVOKE ALL ON sadqa_maintenance_log FROM anon;
GRANT SELECT ON sadqa_catalogue TO anon;
