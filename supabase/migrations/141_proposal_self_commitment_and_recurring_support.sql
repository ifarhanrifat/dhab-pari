-- Migration 141: Self-commitment gate before a proposal opens for voting,
-- a category naming fix, and the recurring-support (continuous monthly
-- funding) project model.
--
-- Previously a proposal landed straight at status='upcoming' with an
-- unenforced "monthly commitment" text field. Now a proposal must be backed
-- by a real, tiered minimum self-commitment (paid or pledged-monthly by the
-- proposer), lands as a new paused 'announced' stage, and only opens for
-- voting once that commitment is actually paid and staff-confirmed — reusing
-- the exact existing pledge/confirm machinery (migration 133/139) rather
-- than building new payment UI.

-- 1. Category rename: shipped as 'support', should have been 'sports'.
UPDATE projects SET category = 'sports' WHERE category = 'support';
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_category_check;
ALTER TABLE projects ADD CONSTRAINT projects_category_check
  CHECK (category IN ('infrastructure', 'water', 'health', 'education', 'environment', 'welfare', 'sports', 'other'));

-- 2. New pre-voting lifecycle stage.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('announced', 'upcoming', 'ongoing', 'reviewing', 'rejected', 'completed'));

-- 3. Self-commitment + recurring-support (continuous monthly funding, e.g.
-- a computer lab's monthly instructor salary, as opposed to a one-time
-- capital budget) columns.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS self_commitment_type varchar CHECK (self_commitment_type IN ('one_time', 'monthly')),
  ADD COLUMN IF NOT EXISTS self_commitment_amount_pkr decimal,
  ADD COLUMN IF NOT EXISTS funding_model varchar NOT NULL DEFAULT 'one_time' CHECK (funding_model IN ('one_time', 'recurring_support')),
  ADD COLUMN IF NOT EXISTS monthly_operating_cost_pkr decimal;

ALTER TABLE donors ADD COLUMN IF NOT EXISTS is_proposal_commitment boolean NOT NULL DEFAULT false;

-- 4. Donations/pledges only make sense once a project is actually live —
-- widen the existing gate (previously just 'upcoming') to also cover the
-- new pre-voting 'announced' stage.
CREATE OR REPLACE FUNCTION project_accepts_donations(p_project_id uuid) RETURNS boolean AS $$
  SELECT p_project_id IS NULL OR EXISTS (
    SELECT 1 FROM projects WHERE id = p_project_id AND status NOT IN ('upcoming', 'announced')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 5. Votes: DB-level gate to 'upcoming' only. Previously relied on the UI
-- alone to only show the vote button on upcoming proposals — now enforced
-- the same way donations already are.
DROP POLICY IF EXISTS "project_votes_insert_own" ON project_votes;
CREATE POLICY "project_votes_insert_own" ON project_votes FOR INSERT TO authenticated
  WITH CHECK (
    portal_user_id = current_portal_user_id()
    AND EXISTS (SELECT 1 FROM projects WHERE id = project_id AND status = 'upcoming')
  );

-- 6. A portal proposal now lands as 'announced', not 'upcoming'.
DROP POLICY IF EXISTS "projects_portal_propose" ON projects;
CREATE POLICY "projects_portal_propose" ON projects FOR INSERT TO authenticated
  WITH CHECK (proposed_by_portal_user_id = current_portal_user_id() AND status = 'announced');

-- 7. Tiered self-commitment requirement — lower budgets pay a higher
-- percentage of their own cost upfront, higher budgets a lower percentage,
-- always at least Rs. 10,000. Standalone (not inlined) so it can be
-- sanity-checked from SQL directly; the frontend mirrors this exact formula
-- for the live estimate shown while typing, same duplication convention as
-- the vote_target GREATEST/CEIL formula below.
CREATE OR REPLACE FUNCTION project_self_commitment_required_pkr(p_budget decimal) RETURNS decimal AS $$
  SELECT GREATEST(10000, ROUND(COALESCE(p_budget, 0) * CASE
    WHEN p_budget <= 150000 THEN 0.08
    WHEN p_budget <= 300000 THEN 0.05
    ELSE 0.03
  END));
$$ LANGUAGE sql IMMUTABLE;

-- 8. Proposal validation + defaults — carries forward migration 139's
-- vote_target/one-pending-proposal logic, now gated on the new 'announced'
-- insert stage, plus the new self-commitment check.
CREATE OR REPLACE FUNCTION trg_project_proposal_defaults() RETURNS trigger AS $$
DECLARE
  v_required decimal;
BEGIN
  IF NEW.proposed_by_portal_user_id IS NOT NULL AND NEW.status = 'announced' THEN
    IF EXISTS (
      SELECT 1 FROM projects
      WHERE proposed_by_portal_user_id = NEW.proposed_by_portal_user_id AND status IN ('announced', 'upcoming')
    ) THEN
      RAISE EXCEPTION 'You already have a proposal awaiting a decision — it must be approved, rejected, or otherwise decided before you can submit another.';
    END IF;
    NEW.vote_target := GREATEST(50, CEIL(COALESCE(NEW.budget_pkr, 100000) / 100000.0) * 50);

    v_required := project_self_commitment_required_pkr(NEW.budget_pkr);
    IF NEW.self_commitment_type IS NULL OR NEW.self_commitment_amount_pkr IS NULL THEN
      RAISE EXCEPTION 'A self-commitment amount and payment type are required to submit a proposal';
    ELSIF NEW.self_commitment_type = 'one_time' AND NEW.self_commitment_amount_pkr < v_required THEN
      RAISE EXCEPTION 'Your one-time self-commitment must be at least Rs. %', v_required;
    ELSIF NEW.self_commitment_type = 'monthly' AND NEW.self_commitment_amount_pkr * 6 < v_required THEN
      RAISE EXCEPTION 'Your monthly self-commitment must be at least Rs. % (6-month equivalent of the required Rs. %)', ROUND(v_required / 6), v_required;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 9. After a proposal is inserted, create the proposer's own commitment as
-- a real pledge row — same shape as any other "Announce a Pledge" donation
-- (migration 133), so it flows through the exact same existing pay/confirm
-- machinery (submit_pledge_payment(), then staff confirm_donation()), with
-- zero new payment UI. For a monthly commitment, this pledge covers the
-- first month; a recurring_schedules row covers month 2 onward.
CREATE OR REPLACE FUNCTION trg_project_proposal_commitment() RETURNS trigger AS $$
DECLARE
  v_user portal_users%ROWTYPE;
BEGIN
  IF NEW.status <> 'announced' OR NEW.proposed_by_portal_user_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_user FROM portal_users WHERE id = NEW.proposed_by_portal_user_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  INSERT INTO donors (
    name, name_ur, amount_pkr, date, project_id, phone, father_husband_name, whatsapp_number,
    donor_type, payment_method, is_anonymous, is_verified, submitted_via, payment_status,
    portal_user_id, is_proposal_commitment, notes
  ) VALUES (
    v_user.full_name, v_user.name_ur, NEW.self_commitment_amount_pkr, current_date, NEW.id,
    v_user.mobile, v_user.father_husband_name, v_user.whatsapp_number, COALESCE(v_user.donor_type, 'villager'),
    NULL, false, false, 'public', 'pledged', v_user.id, true,
    'Proposer''s own self-commitment for "' || NEW.title || '"'
  );

  IF NEW.self_commitment_type = 'monthly' THEN
    INSERT INTO recurring_schedules (
      system, schedule_type, frequency, next_run_date, is_active,
      donor_name, donor_name_ur, donor_phone, donor_type, project_id,
      amount_pkr, particular, created_by_portal_user_id
    ) VALUES (
      'donors_projects', 'donation', 'monthly', (current_date + interval '1 month')::date, true,
      v_user.full_name, v_user.name_ur, v_user.mobile, COALESCE(v_user.donor_type, 'villager'), NEW.id,
      NEW.self_commitment_amount_pkr, 'Proposer''s ongoing monthly self-commitment', v_user.id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS project_proposal_commitment_trigger ON projects;
CREATE TRIGGER project_proposal_commitment_trigger AFTER INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION trg_project_proposal_commitment();

-- 10. confirm_donation(): confirming the proposer's own self-commitment
-- pledge is what unlocks voting — full body carried forward from migration
-- 139 with one new branch (mirrors the existing ongoing -> reviewing branch
-- right below it).
CREATE OR REPLACE FUNCTION confirm_donation(p_donor_id uuid, p_edits jsonb) RETURNS jsonb AS $$
DECLARE
  v_donor donors%ROWTYPE;
  v_account_id uuid;
  v_account_no varchar;
  v_voucher_no varchar;
  v_admin_id uuid := current_admin_user_id();
  v_project_budget decimal;
  v_project_verified_total decimal;
BEGIN
  IF NOT can_access_system('donors_projects') OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to confirm donations';
  END IF;

  UPDATE donors SET
    name = COALESCE(p_edits->>'name', name),
    name_ur = COALESCE(p_edits->>'name_ur', name_ur),
    phone = COALESCE(p_edits->>'phone', phone),
    father_husband_name = COALESCE(p_edits->>'father_husband_name', father_husband_name),
    whatsapp_number = COALESCE(p_edits->>'whatsapp_number', whatsapp_number),
    donor_type = COALESCE(p_edits->>'donor_type', donor_type),
    amount_pkr = COALESCE((p_edits->>'amount_pkr')::decimal, amount_pkr),
    date = COALESCE((p_edits->>'date')::date, date),
    payment_method = COALESCE(p_edits->>'payment_method', payment_method),
    project_id = CASE WHEN p_edits ? 'project_id' THEN NULLIF(p_edits->>'project_id', '')::uuid ELSE project_id END,
    is_anonymous = COALESCE((p_edits->>'is_anonymous')::boolean, is_anonymous),
    notes = COALESCE(p_edits->>'notes', notes),
    is_verified = true, confirmed_at = now(), confirmed_by = v_admin_id
  WHERE id = p_donor_id
  RETURNING * INTO v_donor;

  IF NOT FOUND THEN RAISE EXCEPTION 'Donor not found'; END IF;

  v_account_id := ensure_donor_account(v_donor.name, v_donor.phone);
  SELECT donor_account_no INTO v_account_no FROM accounts WHERE id = v_account_id;
  IF v_account_no IS NULL THEN
    v_account_no := next_donor_account_no();
    UPDATE accounts SET donor_account_no = v_account_no WHERE id = v_account_id;
  END IF;

  v_voucher_no := v_donor.voucher_no;
  IF v_voucher_no IS NULL THEN
    v_voucher_no := next_voucher_no('donors_projects', 'income');
    UPDATE donors SET voucher_no = v_voucher_no WHERE id = p_donor_id;
  END IF;

  UPDATE portal_users SET donor_account_id = v_account_id
  WHERE donor_account_id IS NULL
    AND (lower(mobile) = lower(COALESCE(v_donor.phone, '')) OR lower(COALESCE(whatsapp_number, '')) = lower(COALESCE(v_donor.phone, '')));

  -- System comment + lifecycle checks.
  IF v_donor.project_id IS NOT NULL THEN
    INSERT INTO project_comments (project_id, comment_type, system_label, content)
    VALUES (v_donor.project_id, 'system', 'Donation System',
      (CASE WHEN v_donor.is_anonymous THEN 'An anonymous donor''s' ELSE v_donor.name || '''s' END) ||
      ' donation of Rs. ' || to_char(v_donor.amount_pkr, 'FM999999999') || ' has been confirmed!');

    -- Confirming the proposer's own self-commitment is what unlocks voting.
    IF v_donor.is_proposal_commitment THEN
      UPDATE projects SET status = 'upcoming' WHERE id = v_donor.project_id AND status = 'announced';
      INSERT INTO project_comments (project_id, comment_type, system_label, content)
      VALUES (v_donor.project_id, 'system', 'Proposal System',
        'The proposer''s self-commitment has been confirmed — this project is now open for voting!');
    END IF;

    SELECT budget_pkr INTO v_project_budget FROM projects WHERE id = v_donor.project_id;
    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_project_verified_total FROM donors WHERE project_id = v_donor.project_id AND is_verified = true;
    IF v_project_budget IS NOT NULL AND v_project_verified_total >= v_project_budget THEN
      UPDATE projects SET status = 'reviewing' WHERE id = v_donor.project_id AND status = 'ongoing';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'donor_id', v_donor.id, 'name', v_donor.name, 'amount_pkr', v_donor.amount_pkr,
    'account_no', v_account_no, 'voucher_no', v_voucher_no
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
