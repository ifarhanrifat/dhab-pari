-- Migration 207: correct a closed month by reversing, not by rewriting.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Journal voucher or reversal — why this system uses reversal
-- ═════════════════════════════════════════════════════════════════════════
-- The two ways to fix an entry in a month that has already been closed:
--
--   A journal voucher: one new entry in the current month debiting and
--   crediting whatever accounts the accountant picks, to nudge the balances
--   back to where they should be.
--
--   A reversal: an exact mirror of the original entry, posted in the current
--   month, followed by re-entering it correctly.
--
-- For this system a journal voucher is the more dangerous of the two, and the
-- reason is specific rather than a matter of taste. A consumer's outstanding
-- balance is not computed from ledger_entries — it comes from `bills` and
-- `payments`. A donor's contribution total comes from `donors`. A project's
-- fund balance comes from that project's own account. A journal voucher moves
-- the general ledger and touches none of them. The books would balance, the
-- monthly report would look right, and the consumer would still be shown as
-- owing money he had already paid — with nothing anywhere to explain the
-- difference. That gap between the ledger and the sub-ledgers is the failure
-- mode that makes small accounting systems untrustworthy, and it does not
-- announce itself; it is found months later by a member who insists he paid.
--
-- A reversal cannot drift, because it is not a judgement about which accounts
-- to move. It replays the original entry's own legs with debit and credit
-- exchanged, so every account the original touched — including the project and
-- donor sub-ledgers — is returned to where it was. Nobody chooses anything, so
-- nobody can choose wrongly.
--
-- It also reads better a year later. Three documents that say "this was
-- entered, this was undone on this date by this person for this reason, this
-- replaced it" is a better answer to an auditor, or to a member at a meeting,
-- than one adjusting entry that requires the person who wrote it to explain
-- what it was for.
--
-- The original is never edited, never deleted, and keeps its number.

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS reverses_voucher_id uuid REFERENCES vouchers(id),
  ADD COLUMN IF NOT EXISTS reversed_by_voucher_id uuid REFERENCES vouchers(id),
  ADD COLUMN IF NOT EXISTS reversal_reason text;

CREATE INDEX IF NOT EXISTS vouchers_reverses_idx ON vouchers(reverses_voucher_id)
  WHERE reverses_voucher_id IS NOT NULL;

-- The audit log gains its own word for this. A reversal is not an edit and not
-- a deletion, and the register is far easier to read when it is not disguised
-- as either.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('insert', 'update', 'delete', 'reverse'));

-- ═════════════════════════════════════════════════════════════════════════
-- Marking the original as reversed is not "editing a closed month"
-- ═════════════════════════════════════════════════════════════════════════
-- The period lock from migration 204 refuses any update to a voucher dated in
-- a closed month — which would include the one-word link back to its reversal,
-- making reversal impossible in exactly the months that need it. The figures
-- stay locked; only the pointer is allowed through.
CREATE OR REPLACE FUNCTION trg_period_lock_vouchers() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_period_open(OLD.voucher_date, 'This voucher');
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Nothing that affects the books has changed: this is a reversal being
    -- linked back to the entry it undoes.
    IF NEW.voucher_date IS NOT DISTINCT FROM OLD.voucher_date
       AND NEW.amount_pkr IS NOT DISTINCT FROM OLD.amount_pkr
       AND NEW.from_account_id IS NOT DISTINCT FROM OLD.from_account_id
       AND NEW.to_account_id IS NOT DISTINCT FROM OLD.to_account_id
       AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.reversed_by_voucher_id IS DISTINCT FROM OLD.reversed_by_voucher_id THEN
      RETURN NEW;
    END IF;
    PERFORM assert_period_open(OLD.voucher_date, 'This voucher');
  END IF;

  PERFORM assert_period_open(NEW.voucher_date, 'This voucher');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ═════════════════════════════════════════════════════════════════════════
-- The legs of a reversal
-- ═════════════════════════════════════════════════════════════════════════
-- Handled inside the one posting choke point, so a reversal is numbered,
-- approved, audited and reported by the same machinery as everything else.
-- The mirror is taken from the original's actual ledger rows rather than
-- rebuilt from its fields, which is what makes it correct for multi-line
-- expenses, advance settlements and project transfers without a branch per
-- type — whatever those posted, this un-posts.
CREATE OR REPLACE FUNCTION post_voucher_ledger_legs(p_voucher vouchers) RETURNS void AS $$
DECLARE
  v_bill_number varchar;
  v_line_total decimal;
  v_advance_amount decimal;
  v_diff decimal;
  v_advance_account_id uuid;
  v_project_account_id uuid;
  v_to_project_account_id uuid;
  v_project_amount decimal;
  v_from_title text;
  v_to_title text;
  r RECORD;
BEGIN
  IF p_voucher.bill_id IS NOT NULL THEN
    SELECT bill_number INTO v_bill_number FROM bills WHERE id = p_voucher.bill_id;
  END IF;

  IF p_voucher.reverses_voucher_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    SELECT l.account_id, p_voucher.voucher_date, p_voucher.particular,
           l.credit, l.debit,                       -- the mirror
           'voucher', p_voucher.id, p_voucher.receipt_no, l.bill_number
      FROM ledger_entries l
     WHERE l.reference_type = 'voucher' AND l.reference_id = p_voucher.reverses_voucher_id;
    RETURN;
  END IF;

  -- A project transfer has no cash leg at all (migration 206); falling through
  -- to the generic branch would invent one.
  IF p_voucher.voucher_type = 'project_transfer' THEN
    SELECT title INTO v_from_title FROM projects WHERE id = p_voucher.project_id;
    SELECT title INTO v_to_title FROM projects WHERE id = p_voucher.transfer_to_project_id;

    v_project_account_id := ensure_project_account(p_voucher.project_id);
    v_to_project_account_id := ensure_project_account(p_voucher.transfer_to_project_id);

    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_project_account_id, p_voucher.voucher_date,
            COALESCE(p_voucher.particular, '') || ' — transferred to ' || COALESCE(v_to_title, 'another project'),
            p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no);

    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_to_project_account_id, p_voucher.voucher_date,
            COALESCE(p_voucher.particular, '') || ' — received from ' || COALESCE(v_from_title, 'another project'),
            0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no);

    RETURN;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_line_total FROM voucher_line_items WHERE voucher_id = p_voucher.id;

  IF p_voucher.voucher_type = 'advance_settlement' THEN
    FOR r IN SELECT account_id, amount, description FROM voucher_line_items WHERE voucher_id = p_voucher.id LOOP
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (r.account_id, p_voucher.voucher_date, COALESCE(r.description, p_voucher.particular), r.amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END LOOP;

    SELECT amount_pkr INTO v_advance_amount FROM vouchers WHERE id = p_voucher.settles_voucher_id;
    v_diff := v_advance_amount - v_line_total; -- > 0: refund received; < 0: extra paid

    SELECT id INTO v_advance_account_id FROM accounts WHERE system = p_voucher.system AND code = 'WS-4003';
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (v_advance_account_id, p_voucher.voucher_date, p_voucher.particular, 0, v_advance_amount, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);

    IF v_diff > 0 THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, v_diff, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    ELSIF v_diff < 0 THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, -v_diff, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END IF;

    UPDATE vouchers SET settled_at = now() WHERE id = p_voucher.settles_voucher_id;
    v_project_amount := v_line_total;

  ELSIF v_line_total > 0 THEN
    FOR r IN SELECT account_id, amount, description FROM voucher_line_items WHERE voucher_id = p_voucher.id LOOP
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (r.account_id, p_voucher.voucher_date, COALESCE(r.description, p_voucher.particular), r.amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END LOOP;
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, v_line_total, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    v_project_amount := v_line_total;

  ELSE
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.to_account_id, p_voucher.voucher_date, p_voucher.particular, p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    v_project_amount := p_voucher.amount_pkr;
  END IF;

  IF p_voucher.system = 'donors_projects' AND p_voucher.voucher_type = 'expense' AND p_voucher.project_id IS NOT NULL THEN
    v_project_account_id := ensure_project_account(p_voucher.project_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (v_project_account_id, p_voucher.voucher_date, p_voucher.particular, v_project_amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- A reversal is never itself held for approval. The committee approved the
-- original; undoing a mistake must not sit in a queue while the books are
-- wrong, and there is no discretion in it to approve.
CREATE OR REPLACE FUNCTION voucher_requires_approval(p_system varchar, p_voucher_type varchar) RETURNS boolean AS $$
DECLARE
  v_requires boolean;
  v_has_approvers boolean;
BEGIN
  v_requires := p_voucher_type IN ('withdrawal', 'expense', 'advance', 'advance_settlement',
                                   'complaint_waiver', 'project_transfer')
    AND approval_type_enabled(p_system, CASE WHEN p_voucher_type = 'withdrawal' THEN 'withdrawal' ELSE 'expense' END);
  IF v_requires THEN
    SELECT EXISTS(SELECT 1 FROM approval_approvers WHERE system = p_system AND is_active = true) INTO v_has_approvers;
    v_requires := v_has_approvers;
  END IF;
  RETURN COALESCE(v_requires, false);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_voucher_before_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.reverses_voucher_id IS NULL AND voucher_requires_approval(NEW.system, NEW.voucher_type) THEN
    NEW.status := 'pending';
    NEW.voucher_no := NULL;
  ELSE
    NEW.status := 'posted';
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, CASE WHEN NEW.voucher_type = 'advance_settlement' THEN 'expense' ELSE NEW.voucher_type END));
  END IF;

  IF NEW.voucher_type IN ('security_deposit', 'security_deposit_refund') AND NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- A project transfer being reversed must skip the "does the source project
-- hold this much?" check — the money is going back the way it came, and the
-- destination project's balance is the one being drawn down.
CREATE OR REPLACE FUNCTION trg_vouchers_validate_project_transfer() RETURNS trigger AS $$
DECLARE v_available decimal;
BEGIN
  IF NEW.voucher_type <> 'project_transfer' THEN RETURN NEW; END IF;
  IF NEW.reverses_voucher_id IS NOT NULL THEN RETURN NEW; END IF;

  IF NEW.system <> 'donors_projects' THEN
    RAISE EXCEPTION 'Project fund transfers belong to the Donors & Projects system'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.project_id IS NULL OR NEW.transfer_to_project_id IS NULL THEN
    RAISE EXCEPTION 'A project transfer needs both a source project and a destination project'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.project_id = NEW.transfer_to_project_id THEN
    RAISE EXCEPTION 'The source and destination projects must be different'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.from_account_id := ensure_project_account(NEW.project_id);
  NEW.to_account_id := ensure_project_account(NEW.transfer_to_project_id);

  IF TG_OP = 'INSERT' THEN
    v_available := project_fund_balance(NEW.project_id);
    IF NEW.amount_pkr > v_available THEN
      RAISE EXCEPTION
        'This project holds Rs. % — it cannot transfer Rs. %.',
        trim(to_char(v_available, 'FM999,999,999,990.00')),
        trim(to_char(NEW.amount_pkr, 'FM999,999,999,990.00'))
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ═════════════════════════════════════════════════════════════════════════
-- The one entry point
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reverse_voucher(p_voucher_id uuid, p_reason text)
RETURNS jsonb AS $$
DECLARE
  v vouchers%ROWTYPE;
  v_new_id uuid;
  v_new_no varchar;
  v_today date;
BEGIN
  -- COALESCE, not a bare NOT: current_admin_permission() returns NULL for a
  -- session that is not an admin at all, and `IF NOT NULL` is not true, so the
  -- guard would wave through exactly the people it exists to stop.
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized to reverse a transaction' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v FROM vouchers WHERE id = p_voucher_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Voucher not found' USING ERRCODE = 'P0001'; END IF;

  IF v.status <> 'posted' THEN
    RAISE EXCEPTION 'Only a posted voucher can be reversed — this one is %.', v.status
      USING ERRCODE = 'P0001';
  END IF;
  IF v.reversed_by_voucher_id IS NOT NULL THEN
    RAISE EXCEPTION 'This voucher has already been reversed.' USING ERRCODE = 'P0001';
  END IF;
  IF v.reverses_voucher_id IS NOT NULL THEN
    RAISE EXCEPTION 'A reversal cannot itself be reversed — re-enter the original instead.'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Give a reason for the reversal — it is the only record of why the books changed.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Dated today, in the open month. That is the whole point: the closed month
  -- keeps the figures that were reported, and the correction is visible in the
  -- month it was actually made.
  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;

  INSERT INTO vouchers (
    system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, project_id, transfer_to_project_id,
    bill_id, reverses_voucher_id, reversal_reason
  ) VALUES (
    v.system, v.voucher_type, v_today,
    'Reversal of ' || COALESCE(v.voucher_no, 'voucher') || ' — ' || trim(p_reason),
    v.amount_pkr,
    -- Swapped, so the row reads the way the money actually moved this time.
    v.to_account_id, v.from_account_id, v.party_name,
    v.transfer_to_project_id, v.project_id,
    v.bill_id, v.id, trim(p_reason)
  ) RETURNING id, voucher_no INTO v_new_id, v_new_no;

  UPDATE vouchers SET reversed_by_voucher_id = v_new_id WHERE id = p_voucher_id;

  INSERT INTO audit_log (table_name, record_id, action, record_data, related_data, system, summary, actor_id, actor_name)
  VALUES (
    'vouchers', v.id, 'reverse', to_jsonb(v),
    jsonb_build_object('reversal_voucher_id', v_new_id, 'reversal_voucher_no', v_new_no, 'reason', trim(p_reason)),
    v.system,
    COALESCE(v.voucher_no, 'Voucher') || ' (' || to_char(v.voucher_date, 'DD Mon YYYY') || ', Rs. '
      || trim(to_char(v.amount_pkr, 'FM999,999,999,990.00')) || ') reversed by '
      || COALESCE(v_new_no, 'a new voucher') || ' — ' || trim(p_reason),
    current_admin_user_id(), current_admin_name()
  );

  RETURN jsonb_build_object('id', v_new_id, 'voucher_no', v_new_no);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION reverse_voucher(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reverse_voucher(uuid, text) TO authenticated;
