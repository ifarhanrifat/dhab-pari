-- Migration 311: Badge-gated project proposing.
--
-- Previously any logged-in portal user could propose a project, backed by
-- a self-commitment payment. Now proposing requires at least a Chashma
-- (Spring) badge — real, confirmed giving history, not just a signup — and
-- Darya (River) or above skips the community vote entirely and goes
-- straight to committee review once the self-commitment is confirmed.
-- Self-commitment itself is unchanged for every tier; the badge only ever
-- removes or adds a hurdle around it, never the money.
--
-- Also adds an admin-only "hide from public view" switch, independent of
-- status — for staff to pull ANY donor-submitted proposal (fast-tracked or
-- not) out of public sight while they take a closer look, without having
-- to reject it outright.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS admin_hidden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skip_voting boolean NOT NULL DEFAULT false;

-- 1. Gate proposing itself, and decide skip_voting, at insert time.
CREATE OR REPLACE FUNCTION trg_project_proposal_defaults() RETURNS trigger AS $$
DECLARE
  v_required decimal;
  v_tier varchar;
BEGIN
  IF NEW.proposed_by_portal_user_id IS NOT NULL AND NEW.status = 'announced' THEN
    IF EXISTS (
      SELECT 1 FROM projects
      WHERE proposed_by_portal_user_id = NEW.proposed_by_portal_user_id AND status IN ('announced', 'upcoming')
    ) THEN
      RAISE EXCEPTION 'You already have a proposal awaiting a decision — it must be approved, rejected, or otherwise decided before you can submit another.';
    END IF;

    v_tier := donor_badge_tier(NEW.proposed_by_portal_user_id);
    IF v_tier IS NULL THEN
      RAISE EXCEPTION 'Proposing a project is open to donors who have reached at least the Chashma (Spring) badge. Check your donor badge on the portal dashboard.';
    END IF;
    -- River, Ocean, and the honorary Wellspring tier skip community voting
    -- and go straight to committee review once the self-commitment clears.
    NEW.skip_voting := v_tier IN ('river', 'ocean', 'wellspring');

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

-- 2. confirm_donation(): the announced -> upcoming transition (opens
-- voting) now branches to announced -> reviewing (straight to committee)
-- when the project's own skip_voting flag is set. Full body carried
-- forward from migration 141 with that one branch changed.
CREATE OR REPLACE FUNCTION confirm_donation(p_donor_id uuid, p_edits jsonb) RETURNS jsonb AS $$
DECLARE
  v_donor donors%ROWTYPE;
  v_account_id uuid;
  v_account_no varchar;
  v_voucher_no varchar;
  v_admin_id uuid := current_admin_user_id();
  v_project_budget decimal;
  v_project_verified_total decimal;
  v_skip_voting boolean;
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

    -- Confirming the proposer's own self-commitment is what unlocks voting
    -- (or, for a badge-tier fast-track proposal, sends it straight to
    -- committee review instead).
    IF v_donor.is_proposal_commitment THEN
      SELECT skip_voting INTO v_skip_voting FROM projects WHERE id = v_donor.project_id;
      IF v_skip_voting THEN
        UPDATE projects SET status = 'reviewing' WHERE id = v_donor.project_id AND status = 'announced';
        INSERT INTO project_comments (project_id, comment_type, system_label, content)
        VALUES (v_donor.project_id, 'system', 'Proposal System',
          'The proposer''s self-commitment has been confirmed — as a badge-tier fast-track proposal, this now goes straight to the committee for review.');
      ELSE
        UPDATE projects SET status = 'upcoming' WHERE id = v_donor.project_id AND status = 'announced';
        INSERT INTO project_comments (project_id, comment_type, system_label, content)
        VALUES (v_donor.project_id, 'system', 'Proposal System',
          'The proposer''s self-commitment has been confirmed — this project is now open for voting!');
      END IF;
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

-- 3. admin_hidden: a manual staff switch, independent of status, enforced
-- centrally here rather than trusting every public/portal query site to
-- remember a filter. The proposer can still see their own hidden proposal
-- (so "why can't I find my project" never happens to them), and staff see
-- everything regardless.
DROP POLICY IF EXISTS "public_read_projects" ON projects;
CREATE POLICY "public_read_projects" ON projects FOR SELECT
  USING (
    admin_hidden = false
    OR proposed_by_portal_user_id = current_portal_user_id()
    OR current_admin_role() IS NOT NULL
  );
