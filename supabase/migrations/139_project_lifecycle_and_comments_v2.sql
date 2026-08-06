-- Migration 139: Project proposal rules (vote-target scaling, one pending
-- proposal per user, non-retractable votes), a "reviewing" lifecycle stage
-- once a project is fully funded, threaded comment replies, automatic
-- system-generated comments for pledges/confirmations, and cross-project
-- fund transfers approved via committee/agenda decision.

-- 1. New category + lifecycle statuses.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_category_check;
ALTER TABLE projects ADD CONSTRAINT projects_category_check
  CHECK (category IN ('infrastructure', 'water', 'health', 'education', 'environment', 'welfare', 'support', 'other'));

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('upcoming', 'ongoing', 'reviewing', 'rejected', 'completed'));

-- 2. Proposal defaults + guardrails: vote_target auto-scales with the
-- requested budget (50 votes per Rs. 100,000, minimum 50 — e.g. Rs. 100k =
-- 50 votes, Rs. 500k = 250 votes), and a proposer can't have more than one
-- undecided ('upcoming') proposal open at a time.
CREATE OR REPLACE FUNCTION trg_project_proposal_defaults() RETURNS trigger AS $$
BEGIN
  IF NEW.proposed_by_portal_user_id IS NOT NULL AND NEW.status = 'upcoming' THEN
    IF EXISTS (SELECT 1 FROM projects WHERE proposed_by_portal_user_id = NEW.proposed_by_portal_user_id AND status = 'upcoming') THEN
      RAISE EXCEPTION 'You already have a proposal awaiting a decision — it must be approved, rejected, or otherwise decided before you can submit another.';
    END IF;
    NEW.vote_target := GREATEST(50, CEIL(COALESCE(NEW.budget_pkr, 100000) / 100000.0) * 50);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS project_proposal_defaults_trigger ON projects;
CREATE TRIGGER project_proposal_defaults_trigger BEFORE INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION trg_project_proposal_defaults();

-- 3. Votes are permanent — no take-backs.
DROP POLICY IF EXISTS "project_votes_delete_own" ON project_votes;

-- 4. Comments: threaded replies + system-generated event comments (pledge
-- announced, donation confirmed). System comments have no human author, so
-- portal_user_id becomes nullable, with a free-text display label instead.
ALTER TABLE project_comments ALTER COLUMN portal_user_id DROP NOT NULL;
ALTER TABLE project_comments ADD COLUMN IF NOT EXISTS parent_comment_id uuid REFERENCES project_comments(id) ON DELETE CASCADE;
ALTER TABLE project_comments ADD COLUMN IF NOT EXISTS comment_type varchar NOT NULL DEFAULT 'user' CHECK (comment_type IN ('user', 'system'));
ALTER TABLE project_comments ADD COLUMN IF NOT EXISTS system_label varchar;
ALTER TABLE project_comments ADD CONSTRAINT project_comments_author_check
  CHECK (comment_type = 'user' AND portal_user_id IS NOT NULL OR comment_type = 'system');

DROP POLICY IF EXISTS "project_comments_insert_own" ON project_comments;
CREATE POLICY "project_comments_insert_own" ON project_comments FOR INSERT TO authenticated
  WITH CHECK (comment_type = 'user' AND portal_user_id = current_portal_user_id());
-- System comments are only ever inserted by SECURITY DEFINER triggers/RPCs
-- below (which bypass RLS) — no policy grants a client that path directly.

DROP VIEW IF EXISTS project_comments_public;
CREATE VIEW project_comments_public AS
SELECT c.id, c.project_id, c.content, c.created_at, c.portal_user_id, c.parent_comment_id, c.comment_type,
       CASE WHEN c.comment_type = 'system' THEN c.system_label ELSE p.username END AS username,
       CASE WHEN c.comment_type = 'system' THEN NULL ELSE p.avatar_url END AS avatar_url,
       CASE WHEN c.comment_type = 'system' THEN NULL ELSE donor_badge_tier(p.id) END AS badge_tier,
       (SELECT COUNT(*) FROM project_comment_likes l WHERE l.comment_id = c.id) AS like_count
FROM project_comments c LEFT JOIN portal_users p ON p.id = c.portal_user_id
WHERE c.is_hidden = false;

GRANT SELECT ON project_comments_public TO anon, authenticated;

-- 5. System comment on a pledge/donation submission for a project.
CREATE OR REPLACE FUNCTION trg_donor_project_comment() RETURNS trigger AS $$
DECLARE
  v_display_name text;
  v_body text;
BEGIN
  IF NEW.project_id IS NULL THEN RETURN NEW; END IF;
  v_display_name := CASE WHEN NEW.is_anonymous THEN 'An anonymous donor' ELSE NEW.name END;
  IF NEW.payment_status = 'pledged' THEN
    v_body := v_display_name || ' announced a pledge of Rs. ' || to_char(NEW.amount_pkr, 'FM999999999') || '.';
  ELSE
    v_body := v_display_name || ' submitted a donation of Rs. ' || to_char(NEW.amount_pkr, 'FM999999999') || ', pending verification.';
  END IF;
  INSERT INTO project_comments (project_id, comment_type, system_label, content)
  VALUES (NEW.project_id, 'system', 'Donation System', v_body);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS donor_project_comment_trigger ON donors;
CREATE TRIGGER donor_project_comment_trigger AFTER INSERT ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_donor_project_comment();

-- 6. confirm_donation() now also posts a system comment on confirmation and
-- flips a fully-funded project to 'reviewing' — full body carried forward
-- from migration 129 (the last version) with these two additions at the end.
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

  -- System comment + fully-funded lifecycle check.
  IF v_donor.project_id IS NOT NULL THEN
    INSERT INTO project_comments (project_id, comment_type, system_label, content)
    VALUES (v_donor.project_id, 'system', 'Donation System',
      (CASE WHEN v_donor.is_anonymous THEN 'An anonymous donor''s' ELSE v_donor.name || '''s' END) ||
      ' donation of Rs. ' || to_char(v_donor.amount_pkr, 'FM999999999') || ' has been confirmed!');

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

-- 7. Cross-project fund transfer — donor accountant only, requires an
-- agenda-approval reference to be recorded (committee decides this outside
-- the system; this just requires and logs the reference rather than
-- building a full blocking workflow gate). Posts a debit/credit pair
-- between the two project accounts, same ledger shape as any other voucher.
CREATE OR REPLACE FUNCTION transfer_project_funds(p_from_project_id uuid, p_to_project_id uuid, p_amount decimal, p_agenda_reference text) RETURNS void AS $$
DECLARE
  v_from_account_id uuid;
  v_to_account_id uuid;
  v_particular text;
  v_reference_id uuid := gen_random_uuid();
BEGIN
  IF NOT can_access_system('donors_projects') OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to transfer project funds';
  END IF;
  IF p_agenda_reference IS NULL OR trim(p_agenda_reference) = '' THEN
    RAISE EXCEPTION 'An agenda/committee approval reference is required for a fund transfer';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Enter a valid amount'; END IF;

  v_from_account_id := ensure_project_account(p_from_project_id);
  v_to_account_id := ensure_project_account(p_to_project_id);
  v_particular := 'Fund transfer between projects — committee approval: ' || p_agenda_reference;

  -- Same reference_id on both legs — the established pairing convention
  -- (matches trg_donor_ledger()'s use of NEW.id for both its legs).
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_from_account_id, current_date, v_particular, p_amount, 0, 'project_transfer', v_reference_id);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_to_account_id, current_date, v_particular, 0, p_amount, 'project_transfer', v_reference_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION transfer_project_funds(uuid, uuid, decimal, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION transfer_project_funds(uuid, uuid, decimal, text) TO authenticated;
