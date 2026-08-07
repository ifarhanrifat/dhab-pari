-- Migration 143: JazzCash/EasyPaisa as their own real accounts (previously
-- both collapsed into "Bank Account"), plus a per-project payment-channel
-- breakdown report. No new step for staff — payment_method is already
-- captured on every donation; this just routes it more precisely.
--
-- Typed as 'cash' (not 'bank') so they group naturally with Cash in Hand
-- everywhere this app already treats type IN ('cash','bank') as "a real
-- settlement account" (expense/advance/collector pickers) — and, crucially,
-- so the existing "Cash Deposit" voucher (From Cash Account -> To Bank
-- Account) already works, unmodified, as the "sweep a wallet into the bank"
-- action: From = JazzCash/EasyPaisa, To = Bank Account. No new UI needed.

INSERT INTO accounts (code, name, name_ur, type, system, description) VALUES
  ('DP-1003', 'JazzCash', 'جاز کیش', 'cash', 'donors_projects', 'JazzCash wallet balance for donor and project funds'),
  ('DP-1004', 'EasyPaisa', 'ایزی پیسہ', 'cash', 'donors_projects', 'EasyPaisa wallet balance for donor and project funds')
ON CONFLICT DO NOTHING;

UPDATE accounts SET is_protected = true WHERE system = 'donors_projects' AND code IN ('DP-1003', 'DP-1004');

-- trg_donor_ledger() (migration 118): widen the 2-way cash/bank routing to
-- 4-way. Same function otherwise, unchanged.
CREATE OR REPLACE FUNCTION trg_donor_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_project_account_id uuid;
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
  v_particular := 'Donation' || CASE WHEN v_project_title IS NOT NULL THEN ' - ' || v_project_title ELSE '' END;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_account_id, NEW.date, v_particular, 0, NEW.amount_pkr, 'donation', NEW.id);

  SELECT id INTO v_cash_account_id FROM accounts
  WHERE system = 'donors_projects' AND code = (CASE NEW.payment_method
    WHEN 'cash' THEN 'DP-1001' WHEN 'jazzcash' THEN 'DP-1003' WHEN 'easypaisa' THEN 'DP-1004' ELSE 'DP-1002' END);
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_cash_account_id, NEW.date, v_particular, NEW.amount_pkr, 0, 'donation', NEW.id);
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    v_project_account_id := ensure_project_account(NEW.project_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_project_account_id, NEW.date, v_particular, 0, NEW.amount_pkr, 'donation', NEW.id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill: existing verified jazzcash/easypaisa donations already posted
-- their real-money leg to the old shared "Bank Account" (DP-1002) under the
-- 2-way mapping — re-point those specific legs to the correct wallet
-- account now that one exists, so Bank Account's balance isn't overstated
-- with money that's actually still sitting in a wallet.
UPDATE ledger_entries le
SET account_id = correct.id
FROM donors d
JOIN accounts old_acct ON old_acct.system = 'donors_projects' AND old_acct.code = 'DP-1002'
JOIN accounts correct ON correct.system = 'donors_projects'
  AND correct.code = (CASE d.payment_method WHEN 'jazzcash' THEN 'DP-1003' WHEN 'easypaisa' THEN 'DP-1004' END)
WHERE le.reference_type = 'donation' AND le.reference_id = d.id AND le.account_id = old_acct.id
  AND d.is_verified = true AND d.payment_method IN ('jazzcash', 'easypaisa');

-- Per-project payment-channel breakdown — a read-only aggregate (amounts
-- and payment method only, no donor identity), so "how much of this
-- project's money came via which channel" is answerable without exposing
-- anything new. SECURITY DEFINER since `donors` itself isn't public — only
-- the donors_public view and this narrow aggregate are.
CREATE OR REPLACE FUNCTION project_donation_channels_pkr(p_project_id uuid)
RETURNS TABLE(payment_method varchar, total_pkr decimal) AS $$
  SELECT d.payment_method, SUM(d.amount_pkr)
  FROM donors d
  WHERE d.project_id = p_project_id AND d.is_verified = true
  GROUP BY d.payment_method;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION project_donation_channels_pkr(uuid) TO anon, authenticated;
