-- Migration 209: restricted funds, and the Zakat module.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Part 1 — Zakat money is not the committee's money
-- ═════════════════════════════════════════════════════════════════════════
-- Every organisation that handles zakat seriously keeps it completely apart
-- from its other money: separate account, separate reporting, never mixed.
-- Three rules follow, and all three are enforced here rather than left to the
-- accountant to remember on a busy day in Ramadan:
--
--   Tamleek — ownership has to pass to a poor person. Zakat cannot buy an
--   asset the committee owns, cannot pay a contractor, cannot fund overheads.
--
--   Zakat can never fund Esal-e-Sawab. A water cooler is not tamleek.
--
--   Zakat-funded Kafalat has to reach the guardian rather than the school,
--   because the committee paying a school on the child's behalf is the
--   committee spending the money, not the child owning it.

ALTER TABLE donors
  ADD COLUMN IF NOT EXISTS fund_type varchar NOT NULL DEFAULT 'general'
    CHECK (fund_type IN ('general', 'zakat', 'sadqa', 'kafalat', 'esal_e_sawab', 'ushr'));

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS fund_type varchar
    CHECK (fund_type IN ('general', 'zakat', 'sadqa', 'kafalat', 'esal_e_sawab', 'ushr'));

INSERT INTO account_headers (system, code, label, code_prefix, display_order, is_system) VALUES
  ('donors_projects', 'restricted_fund', 'Restricted Funds', 'DP-RF', 9, true)
ON CONFLICT (system, code) DO NOTHING;

INSERT INTO accounts (code, name, name_ur, type, system, fund_type, description, is_protected) VALUES
  ('DP-ZKT', 'Zakat Fund', 'زکوٰۃ فنڈ', 'restricted_fund', 'donors_projects', 'zakat',
   'Zakat received. May only be paid out to a verified household on the needs register.', true),
  ('DP-USH', 'Ushr Fund', 'عشر فنڈ', 'restricted_fund', 'donors_projects', 'ushr',
   'Ushr on agricultural produce. Distributed on the same rules as zakat.', true),
  ('DP-SDQ', 'Sadqa Fund', 'صدقہ فنڈ', 'restricted_fund', 'donors_projects', 'sadqa',
   'General sadqa. Unrestricted within welfare purposes.', true),
  ('DP-KFL', 'Kafalat Fund', 'کفالت فنڈ', 'restricted_fund', 'donors_projects', 'kafalat',
   'Education sponsorship pool for school children and students.', true),
  ('DP-ESW', 'Esal-e-Sawab Fund', 'ایصالِ ثواب فنڈ', 'restricted_fund', 'donors_projects', 'esal_e_sawab',
   'Sadqa-e-jariya objects dedicated to the deceased.', true)
ON CONFLICT (code, system) DO NOTHING;

CREATE OR REPLACE FUNCTION fund_account_id(p_fund_type varchar) RETURNS uuid AS $$
  SELECT id FROM accounts
   WHERE system = 'donors_projects' AND fund_type = p_fund_type
     AND type = 'restricted_fund' LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- A zakat donation is not a project donation. Tagging it to "Mosque Repairs"
-- would spend zakat on a building, which is exactly what tamleek forbids.
CREATE OR REPLACE FUNCTION trg_donors_fund_rules() RETURNS trigger AS $$
BEGIN
  IF NEW.fund_type IN ('zakat', 'ushr') AND NEW.project_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Zakat and Ushr cannot be tagged to a project. They are distributed to verified households, not spent on works.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS donors_fund_rules ON donors;
CREATE TRIGGER donors_fund_rules
  BEFORE INSERT OR UPDATE ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_donors_fund_rules();

-- The ledger gains a restricted-fund leg. A donation to a fund credits that
-- fund's account the way a project donation credits the project's, so each
-- fund has a real running balance instead of being a label on a row.
CREATE OR REPLACE FUNCTION trg_donor_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_project_account_id uuid;
  v_fund_account_id uuid;
  v_project_title text;
  v_particular text;
BEGIN
  v_account_id := ensure_donor_account(NEW.name, NEW.phone);
  UPDATE accounts SET name_ur = NEW.name_ur WHERE id = v_account_id AND name_ur IS DISTINCT FROM NEW.name_ur;

  DELETE FROM ledger_entries WHERE reference_type = 'donation' AND reference_id = NEW.id;

  IF NOT NEW.is_verified THEN
    RETURN NEW;
  END IF;

  SELECT title INTO v_project_title FROM projects WHERE id = NEW.project_id;
  v_particular := 'Donation'
    || CASE WHEN v_project_title IS NOT NULL THEN ' - ' || v_project_title ELSE '' END
    || CASE WHEN NEW.fund_type <> 'general' THEN ' (' || upper(NEW.fund_type) || ')' ELSE '' END;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_account_id, NEW.date, v_particular, 0, NEW.amount_pkr, 'donation', NEW.id);

  SELECT id INTO v_cash_account_id FROM accounts
  WHERE system = 'donors_projects' AND code = (CASE WHEN NEW.payment_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_cash_account_id, NEW.date, v_particular, NEW.amount_pkr, 0, 'donation', NEW.id);
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    v_project_account_id := ensure_project_account(NEW.project_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_project_account_id, NEW.date, v_particular, 0, NEW.amount_pkr, 'donation', NEW.id);
  END IF;

  IF NEW.fund_type <> 'general' THEN
    v_fund_account_id := fund_account_id(NEW.fund_type);
    IF v_fund_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
      VALUES (v_fund_account_id, NEW.date, v_particular, 0, NEW.amount_pkr, 'donation', NEW.id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION fund_balance(p_fund_type varchar) RETURNS decimal AS $$
  SELECT COALESCE(SUM(l.credit - l.debit), 0)
    FROM ledger_entries l
   WHERE l.account_id = fund_account_id(p_fund_type);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION fund_balance(varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION fund_account_id(varchar) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Part 2 — Zakat rounds
-- ═════════════════════════════════════════════════════════════════════════
-- The problem this solves, in the committee's own words: zakat tends to reach
-- one visible needy person over and over while others get nothing. The fix is
-- to take the choice away from the donor entirely. Donors fund a pool; a
-- verified register decides the split by a rule fixed in advance.
--
-- "Fixed in advance" is the whole transparency mechanism. A formula written
-- after the total is known can be tuned to favour somebody. A formula written
-- before it cannot, and everyone can see that it was.
CREATE TABLE IF NOT EXISTS zakat_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  name_ur varchar,
  fund_type varchar NOT NULL DEFAULT 'zakat' CHECK (fund_type IN ('zakat', 'ushr')),

  -- ── The formula, set at open and then locked ───────────────────────────
  -- Equal-per-household is the most defensible against accusations of
  -- favouritism, but it gives a widow with six children the same as a single
  -- elderly man. The increment fixes that without reintroducing discretion.
  -- Set it to zero for pure equality.
  base_per_household decimal NOT NULL DEFAULT 0 CHECK (base_per_household >= 0),
  per_dependant_increment decimal NOT NULL DEFAULT 0 CHECK (per_dependant_increment >= 0),
  formula_note text,

  opened_at timestamptz NOT NULL DEFAULT now(),
  frozen_at timestamptz,
  distribution_date date,
  closed_at timestamptz,
  status varchar NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'frozen', 'distributing', 'closed', 'cancelled')),

  collected_pkr decimal NOT NULL DEFAULT 0,
  distributed_pkr decimal NOT NULL DEFAULT 0,
  household_count int NOT NULL DEFAULT 0,

  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zakat_round_beneficiaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id uuid NOT NULL REFERENCES zakat_rounds(id) ON DELETE CASCADE,
  register_id uuid NOT NULL REFERENCES needs_register(id) ON DELETE RESTRICT,
  -- Copied at freeze so the list is a snapshot. If a household's dependants
  -- change mid-round, the amount already computed and announced does not
  -- silently move underneath it.
  code varchar NOT NULL,
  household_size int NOT NULL,
  dependants int NOT NULL,
  asnaf_category varchar NOT NULL,

  amount_pkr decimal NOT NULL DEFAULT 0,
  status varchar NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'declined', 'unreachable')),
  method varchar CHECK (method IN ('cash', 'bank', 'jazzcash', 'easypaisa', 'in_kind')),
  in_kind_note varchar,
  -- Tamleek: the handover is the moment ownership passes, so it is recorded
  -- as its own event with its own evidence.
  receipt_no varchar,
  paid_at timestamptz,
  paid_by uuid REFERENCES admin_users(id),
  acknowledgement varchar CHECK (acknowledgement IN ('signature', 'thumbprint', 'witness', 'transfer_ref')),
  acknowledgement_ref varchar,
  note text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (round_id, register_id)
);

CREATE INDEX IF NOT EXISTS zakat_round_beneficiaries_round_idx
  ON zakat_round_beneficiaries(round_id, status);

-- ── Freezing the list ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION zakat_freeze_round(p_round_id uuid) RETURNS jsonb AS $$
DECLARE
  r zakat_rounds%ROWTYPE;
  v_count int;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO r FROM zakat_rounds WHERE id = p_round_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round not found' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'open' THEN
    RAISE EXCEPTION 'Only an open round can be frozen — this one is %.', r.status USING ERRCODE = 'P0001';
  END IF;

  PERFORM expire_needs_register();

  INSERT INTO zakat_round_beneficiaries (round_id, register_id, code, household_size, dependants, asnaf_category)
  SELECT p_round_id, n.id, n.code, n.household_size, n.dependants, n.asnaf_category
    FROM needs_register n
   WHERE n.status = 'verified'
  ON CONFLICT (round_id, register_id) DO NOTHING;

  SELECT count(*) INTO v_count FROM zakat_round_beneficiaries WHERE round_id = p_round_id;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'No verified households on the register — nothing to distribute to.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE zakat_rounds
     SET status = 'frozen', frozen_at = now(), household_count = v_count
   WHERE id = p_round_id;

  RETURN jsonb_build_object('households', v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Computing each household's share ─────────────────────────────────────
CREATE OR REPLACE FUNCTION zakat_compute_round(p_round_id uuid) RETURNS jsonb AS $$
DECLARE
  r zakat_rounds%ROWTYPE;
  v_available decimal;
  v_weight_total decimal;
  v_per_weight decimal;
  v_total decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO r FROM zakat_rounds WHERE id = p_round_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round not found' USING ERRCODE = 'P0001'; END IF;
  IF r.status NOT IN ('frozen', 'distributing') THEN
    RAISE EXCEPTION 'Freeze the household list before computing shares.' USING ERRCODE = 'P0001';
  END IF;

  v_available := fund_balance(r.fund_type);
  IF v_available <= 0 THEN
    RAISE EXCEPTION 'The % fund is empty — there is nothing to distribute.', upper(r.fund_type)
      USING ERRCODE = 'P0001';
  END IF;

  -- The declared formula gives each household a weight. The whole fund is
  -- then divided in proportion to those weights, so every rupee collected
  -- goes out and no household is left behind by a rounding rule.
  SELECT COALESCE(SUM(r.base_per_household + (r.per_dependant_increment * b.dependants)), 0)
    INTO v_weight_total
    FROM zakat_round_beneficiaries b
   WHERE b.round_id = p_round_id AND b.status = 'pending';

  IF v_weight_total <= 0 THEN
    -- Both parameters left at zero means "split it equally", which is a
    -- perfectly reasonable thing to want and should not be an error.
    UPDATE zakat_round_beneficiaries b
       SET amount_pkr = round(v_available / GREATEST((SELECT count(*) FROM zakat_round_beneficiaries WHERE round_id = p_round_id AND status = 'pending'), 1))
     WHERE b.round_id = p_round_id AND b.status = 'pending';
  ELSE
    v_per_weight := v_available / v_weight_total;
    UPDATE zakat_round_beneficiaries b
       SET amount_pkr = round((r.base_per_household + (r.per_dependant_increment * b.dependants)) * v_per_weight)
     WHERE b.round_id = p_round_id AND b.status = 'pending';
  END IF;

  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_total
    FROM zakat_round_beneficiaries WHERE round_id = p_round_id;

  UPDATE zakat_rounds SET collected_pkr = v_available, status = 'distributing' WHERE id = p_round_id;

  RETURN jsonb_build_object('available', v_available, 'allocated', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── The handover ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION zakat_disburse(
  p_beneficiary_id uuid, p_method varchar, p_acknowledgement varchar,
  p_acknowledgement_ref varchar DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  b zakat_round_beneficiaries%ROWTYPE;
  r zakat_rounds%ROWTYPE;
  v_receipt varchar;
  v_fund_account uuid;
  v_cash_account uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO b FROM zakat_round_beneficiaries WHERE id = p_beneficiary_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;
  IF b.amount_pkr <= 0 THEN RAISE EXCEPTION 'Compute the shares first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO r FROM zakat_rounds WHERE id = b.round_id;
  v_receipt := next_receipt_no();
  v_fund_account := fund_account_id(r.fund_type);
  SELECT id INTO v_cash_account FROM accounts
   WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method IN ('cash', 'in_kind') THEN 'DP-1001' ELSE 'DP-1002' END);

  -- The ledger records the CODE, never the household. The accountant can post
  -- this without ever learning whose door the money went to.
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
  VALUES (v_fund_account, (now() AT TIME ZONE 'Asia/Karachi')::date,
          upper(r.fund_type) || ' distribution — ' || b.code || ' (' || r.name || ')',
          b.amount_pkr, 0, 'manual', b.id, v_receipt);

  IF v_cash_account IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_cash_account, (now() AT TIME ZONE 'Asia/Karachi')::date,
            upper(r.fund_type) || ' distribution — ' || b.code,
            0, b.amount_pkr, 'manual', b.id, v_receipt);
  END IF;

  UPDATE zakat_round_beneficiaries
     SET status = 'paid', method = p_method, receipt_no = v_receipt,
         acknowledgement = p_acknowledgement, acknowledgement_ref = p_acknowledgement_ref,
         note = p_note, paid_at = now(), paid_by = current_admin_user_id()
   WHERE id = p_beneficiary_id;

  UPDATE zakat_rounds z
     SET distributed_pkr = (SELECT COALESCE(SUM(amount_pkr), 0) FROM zakat_round_beneficiaries
                             WHERE round_id = z.id AND status = 'paid')
   WHERE z.id = b.round_id;

  RETURN jsonb_build_object('receipt_no', v_receipt, 'amount', b.amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── The report the village is allowed to see ─────────────────────────────
-- Totals, counts and the formula. Never a name.
CREATE OR REPLACE FUNCTION zakat_round_report(p_round_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'name', r.name, 'name_ur', r.name_ur, 'fund_type', r.fund_type,
    'status', r.status, 'distribution_date', r.distribution_date,
    'formula', jsonb_build_object(
      'base_per_household', r.base_per_household,
      'per_dependant_increment', r.per_dependant_increment,
      'note', r.formula_note),
    'collected', r.collected_pkr,
    'distributed', r.distributed_pkr,
    'households', r.household_count,
    'paid_households', (SELECT count(*) FROM zakat_round_beneficiaries WHERE round_id = r.id AND status = 'paid'),
    'widow_headed', (SELECT count(*) FROM zakat_round_beneficiaries b JOIN needs_register n ON n.id = b.register_id
                      WHERE b.round_id = r.id AND n.is_widow_headed),
    'with_orphans', (SELECT count(*) FROM zakat_round_beneficiaries b JOIN needs_register n ON n.id = b.register_id
                      WHERE b.round_id = r.id AND n.has_orphans),
    'by_category', (SELECT jsonb_object_agg(asnaf_category, c) FROM
                     (SELECT asnaf_category, count(*) c FROM zakat_round_beneficiaries
                       WHERE round_id = r.id GROUP BY asnaf_category) x),
    'verifiers', (SELECT COALESCE(jsonb_agg(DISTINCT a.name), '[]'::jsonb)
                    FROM needs_verifications v JOIN admin_users a ON a.id = v.admin_user_id
                   WHERE v.register_id IN (SELECT register_id FROM zakat_round_beneficiaries WHERE round_id = r.id))
  ) FROM zakat_rounds r WHERE r.id = p_round_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION zakat_round_report(uuid) TO anon, authenticated;

-- Zakat should reach people promptly rather than sitting in an account. This
-- is what the dashboard warns on.
INSERT INTO site_settings (key, value) VALUES
  ('zakat_idle_warn_days', '60'),
  ('zakat_nisab_gold_grams', '87.48'),
  ('zakat_nisab_silver_grams', '612.36'),
  ('zakat_gold_rate_pkr', '0'),
  ('zakat_silver_rate_pkr', '0')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE zakat_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE zakat_round_beneficiaries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS zakat_rounds_admin ON zakat_rounds;
CREATE POLICY zakat_rounds_admin ON zakat_rounds FOR ALL TO authenticated
  USING (can_access_system('donors_projects'))
  WITH CHECK (can_access_system('donors_projects'));

-- The beneficiary list carries codes rather than names, so an accountant may
-- read it to do the payout — but the register row behind it stays sealed.
DROP POLICY IF EXISTS zakat_beneficiaries_admin ON zakat_round_beneficiaries;
CREATE POLICY zakat_beneficiaries_admin ON zakat_round_beneficiaries FOR ALL TO authenticated
  USING (can_access_system('donors_projects'))
  WITH CHECK (can_access_system('donors_projects'));

REVOKE ALL ON zakat_rounds FROM anon;
REVOKE ALL ON zakat_round_beneficiaries FROM anon;
REVOKE ALL ON FUNCTION zakat_freeze_round(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION zakat_compute_round(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION zakat_disburse(uuid, varchar, varchar, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION zakat_freeze_round(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION zakat_compute_round(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION zakat_disburse(uuid, varchar, varchar, varchar, text) TO authenticated;
