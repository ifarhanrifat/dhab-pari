-- Migration 038: Fix a pre-existing bug that blocked every non-approval-required
-- voucher (Income, Bank Transfer, Cash Deposit, and any bank-paid Expense) from
-- ever being saved.
--
-- Migration 011 added vouchers.status with DEFAULT 'posted', and
-- trg_voucher_before_insert() explicitly sets NEW.status := 'posted' for any
-- voucher that doesn't require approval — but the CHECK constraint added in that
-- same migration only allowed ('pending', 'approved', 'rejected'). 'posted' was
-- never a legal value, so every insert that reached that branch violated the check
-- constraint (23514) and was silently rejected by Postgres. Caught via live testing
-- of the new security-deposit voucher type, which hits the same "posted" branch.

ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS vouchers_status_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_status_check
  CHECK (status IN ('pending', 'posted', 'approved', 'rejected'));
