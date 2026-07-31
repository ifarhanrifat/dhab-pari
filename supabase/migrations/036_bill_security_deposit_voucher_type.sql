-- Migration 036: Support recording a security/advance deposit collected alongside
-- a generated bill, as its own transaction — it's a liability (money owed back to
-- the consumer later), not part of the bill's receivable/income, so it must never
-- be summed into bills.amount_pkr. A dedicated voucher_type keeps it distinguishable
-- from ordinary income in reports even though it posts through the same generic
-- voucher ledger mechanism (debit the cash/bank account received into, credit the
-- Security Deposits Payable liability).

ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS vouchers_voucher_type_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_voucher_type_check
  CHECK (voucher_type IN ('expense', 'income', 'contra', 'withdrawal', 'deposit', 'security_deposit'));

-- Informational only — the real double-entry posting is the voucher above. Kept on
-- the bill so the invoice document can display "Security Deposit Collected" next to
-- the itemized charges without joining back to a voucher.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS security_deposit_amount decimal NOT NULL DEFAULT 0 CHECK (security_deposit_amount >= 0);
