-- Migration 206: move money from one project's funds to another's.
--
-- The committee decides in a meeting that a project which over-collected — or
-- one that has been abandoned — should hand part of its balance to a project
-- that is short. Until now the only way to record that was two unrelated
-- entries that happened to cancel out, leaving neither project's ledger able to
-- explain where the money went or came from.
--
-- ── Why this is not the ordinary contra voucher ──────────────────────────
-- A contra moves cash between real cash accounts, where a debit means "more
-- money is here". A project account is not cash — it is the fund raised for
-- that project, credited when donations arrive. So the legs run the other way:
-- the project *giving* money is debited, the project *receiving* it is
-- credited. The physical cash never moves at all; the committee holds the same
-- notes before and after. Only the claim on them changes hands.
--
-- Getting this backwards would be invisible on the cash side and wrong on
-- every project report, which is why it gets its own branch rather than being
-- squeezed into the generic one.

ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS vouchers_voucher_type_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_voucher_type_check
  CHECK (voucher_type IN ('expense', 'income', 'contra', 'withdrawal', 'deposit',
    'security_deposit', 'security_deposit_refund', 'advance', 'advance_settlement',
    'complaint_waiver', 'project_transfer'));

-- The source is the existing project_id (already used to tag project expenses);
-- this is where it goes.
ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS transfer_to_project_id uuid REFERENCES projects(id);

-- Which meeting approved it. Optional, because a transfer can predate the
-- Meetings module or be recorded from paper minutes, but it is the whole
-- justification for the entry when it is there.
ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS meeting_id uuid REFERENCES agenda_meetings(id) ON DELETE SET NULL;

INSERT INTO voucher_counters (system, voucher_type, prefix)
VALUES ('donors_projects', 'project_transfer', 'DP-PT-V')
ON CONFLICT (system, voucher_type) DO NOTHING;

-- ── Refuse a transfer that is not there to give ──────────────────────────
-- A project cannot hand over money it never raised. Without this the source
-- project simply goes negative and the error is only noticed at the next
-- report, by which time the receiving project has already spent it.
CREATE OR REPLACE FUNCTION project_fund_balance(p_project_id uuid) RETURNS decimal AS $$
  SELECT COALESCE(SUM(l.credit - l.debit), 0)
    FROM ledger_entries l
    JOIN accounts a ON a.id = l.account_id
   WHERE a.project_id = p_project_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION project_fund_balance(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION trg_vouchers_validate_project_transfer() RETURNS trigger AS $$
DECLARE v_available decimal;
BEGIN
  IF NEW.voucher_type <> 'project_transfer' THEN RETURN NEW; END IF;

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

  -- from_account_id/to_account_id are NOT NULL on this table and every other
  -- voucher type carries real accounts in them. Fill them from the two
  -- projects so a transfer is not a row with two mystery columns — and so it
  -- still reads correctly in any screen or report that joins on them. A
  -- project's account is created on first use, which may be right now.
  -- (Postgres checks NOT NULL after BEFORE triggers have run, so assigning
  -- here is enough; the caller does not have to know about project accounts.)
  NEW.from_account_id := ensure_project_account(NEW.project_id);
  NEW.to_account_id := ensure_project_account(NEW.transfer_to_project_id);

  -- Only on the way in. An already-posted transfer being re-saved would
  -- otherwise be measured against a balance it has itself already reduced.
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

DROP TRIGGER IF EXISTS vouchers_validate_project_transfer ON vouchers;
CREATE TRIGGER vouchers_validate_project_transfer
  BEFORE INSERT OR UPDATE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION trg_vouchers_validate_project_transfer();

-- ── The legs ─────────────────────────────────────────────────────────────
-- Extends the existing choke point rather than adding a second posting path,
-- so a project transfer is numbered, approved, audited and reversed by exactly
-- the same machinery as every other voucher.
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

  -- Handled first and returned from, because a project transfer has no cash
  -- leg at all — falling through to the generic branch would invent one.
  IF p_voucher.voucher_type = 'project_transfer' THEN
    SELECT title INTO v_from_title FROM projects WHERE id = p_voucher.project_id;
    SELECT title INTO v_to_title FROM projects WHERE id = p_voucher.transfer_to_project_id;

    v_project_account_id := ensure_project_account(p_voucher.project_id);
    v_to_project_account_id := ensure_project_account(p_voucher.transfer_to_project_id);

    -- Source: funds leave. Each side's particular names the other project, so
    -- either ledger read on its own explains the entry without cross-referencing.
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_project_account_id, p_voucher.voucher_date,
            COALESCE(p_voucher.particular, '') || ' — transferred to ' || COALESCE(v_to_title, 'another project'),
            p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no);

    -- Destination: funds arrive.
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

-- ── The committee has to have said so ────────────────────────────────────
-- Moving money a village donated for one purpose to a different purpose is
-- exactly the kind of decision that should not rest with one accountant. It
-- joins the same approval bucket as an expense — and, like every other type in
-- that bucket, only actually waits if this system has approvers configured.
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
