-- Migration 012: Complete double-entry postings for bills, payments, and donations.
--
-- Previously each of these posted only one leg — e.g. a bill debited the consumer's
-- receivable but never credited Water Bill Income; a payment credited the consumer
-- but never debited Cash/Bank. That left the Trial Balance permanently unbalanced
-- and the Daily Register (which only looks at Cash/Bank accounts) always empty.
-- This posts both legs going forward and backfills the missing leg for existing data.

-- 1. The old unique index assumed exactly one ledger row per reference. Bills,
--    payments, and donations now post two rows each; the trigger bodies below use
--    delete-then-reinsert (bills/donations) or a second plain insert (payments,
--    which are never updated) instead of relying on ON CONFLICT, so the index is
--    no longer needed (vouchers already worked this way since migration 010).
DROP INDEX IF EXISTS ledger_entries_ref_key;

-- 2. Bills: debit consumer receivable (unchanged), credit Water Bill Income (new).
CREATE OR REPLACE FUNCTION trg_bill_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_income_account_id uuid;
  v_particular text;
BEGIN
  v_account_id := ensure_consumer_account(NEW.consumer_id);
  v_particular := 'Water Bill - ' || to_char(make_date(NEW.year, NEW.month, 1), 'FMMonth YYYY');

  DELETE FROM ledger_entries WHERE reference_type = 'bill' AND reference_id = NEW.id;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_account_id, make_date(NEW.year, NEW.month, 1), v_particular, NEW.amount_pkr, 0, 'bill', NEW.id);

  SELECT id INTO v_income_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-2001';
  IF v_income_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_income_account_id, make_date(NEW.year, NEW.month, 1), v_particular, 0, NEW.amount_pkr, 'bill', NEW.id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Payments: credit consumer receivable (unchanged), debit the Cash/Bank account
--    implied by the payment method (new). jazzcash/easypaisa settle into the bank
--    account (this app has no separate wallet-type accounts).
CREATE OR REPLACE FUNCTION trg_payment_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_bill bills%ROWTYPE;
  v_total_paid decimal;
  v_particular text;
BEGIN
  IF NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;
  v_account_id := ensure_consumer_account(NEW.consumer_id);
  v_particular := 'Payment received (' || NEW.method || ')';

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_account_id, NEW.paid_date, v_particular, 0, NEW.amount_pkr, 'payment', NEW.id);

  SELECT id INTO v_cash_account_id FROM accounts
  WHERE system = 'water_supply' AND code = (CASE WHEN NEW.method = 'cash' THEN 'WS-1001' ELSE 'WS-1002' END);
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_cash_account_id, NEW.paid_date, v_particular, NEW.amount_pkr, 0, 'payment', NEW.id);
  END IF;

  SELECT * INTO v_bill FROM bills WHERE id = NEW.bill_id;
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_total_paid FROM payments WHERE bill_id = NEW.bill_id;

  UPDATE bills SET
    paid_amount = v_total_paid,
    status = CASE WHEN v_total_paid >= v_bill.amount_pkr THEN 'paid'
                  WHEN v_total_paid > 0 THEN 'partial'
                  ELSE v_bill.status END,
    paid_date = NEW.paid_date,
    payment_method = NEW.method
  WHERE id = NEW.bill_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Donations: credit the donor's party account (unchanged), debit the Cash/Bank
--    account implied by the payment method (new).
CREATE OR REPLACE FUNCTION trg_donor_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_project_title text;
  v_particular text;
BEGIN
  v_account_id := ensure_donor_account(NEW.name, NEW.phone);
  UPDATE accounts SET name_ur = NEW.name_ur WHERE id = v_account_id AND name_ur IS DISTINCT FROM NEW.name_ur;
  SELECT title INTO v_project_title FROM projects WHERE id = NEW.project_id;
  v_particular := 'Donation' || CASE WHEN v_project_title IS NOT NULL THEN ' - ' || v_project_title ELSE '' END;

  DELETE FROM ledger_entries WHERE reference_type = 'donation' AND reference_id = NEW.id;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_account_id, NEW.date, v_particular, 0, NEW.amount_pkr, 'donation', NEW.id);

  SELECT id INTO v_cash_account_id FROM accounts
  WHERE system = 'donors_projects' AND code = (CASE WHEN NEW.payment_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_cash_account_id, NEW.date, v_particular, NEW.amount_pkr, 0, 'donation', NEW.id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. Backfill the missing leg for data that predates this fix.

-- 5a. Bills: add the Water Bill Income credit for every bill missing one.
INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
SELECT inc.id, make_date(b.year, b.month, 1),
       'Water Bill - ' || to_char(make_date(b.year, b.month, 1), 'FMMonth YYYY'),
       0, b.amount_pkr, 'bill', b.id
FROM bills b
JOIN accounts inc ON inc.system = 'water_supply' AND inc.code = 'WS-2001'
WHERE NOT EXISTS (
  SELECT 1 FROM ledger_entries le WHERE le.reference_type = 'bill' AND le.reference_id = b.id AND le.account_id = inc.id
);

-- 5b. Payments: add the Cash/Bank debit for every payment missing one.
INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
SELECT cb.id, p.paid_date, 'Payment received (' || p.method || ')', p.amount_pkr, 0, 'payment', p.id
FROM payments p
JOIN accounts cb ON cb.system = 'water_supply' AND cb.code = (CASE WHEN p.method = 'cash' THEN 'WS-1001' ELSE 'WS-1002' END)
WHERE NOT EXISTS (
  SELECT 1 FROM ledger_entries le WHERE le.reference_type = 'payment' AND le.reference_id = p.id AND le.account_id = cb.id
);

-- 5c. Donations: add the Cash/Bank debit for every donation missing one.
INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
SELECT cb.id, d.date,
       'Donation' || CASE WHEN p.title IS NOT NULL THEN ' - ' || p.title ELSE '' END,
       d.amount_pkr, 0, 'donation', d.id
FROM donors d
JOIN accounts cb ON cb.system = 'donors_projects' AND cb.code = (CASE WHEN d.payment_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END)
LEFT JOIN projects p ON p.id = d.project_id
WHERE NOT EXISTS (
  SELECT 1 FROM ledger_entries le WHERE le.reference_type = 'donation' AND le.reference_id = d.id AND le.account_id = cb.id
);
