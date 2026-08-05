-- Migration 087: same draft-voucher gap as migration 086's to_account_id fix.
-- Multi-line Expense and Advance Settlement insert their draft voucher with
-- amount_pkr = 0 as a placeholder (the real total is only known once line
-- items exist), but amount_pkr has had CHECK (amount_pkr > 0) since migration
-- 009 and was never relaxed, so the draft insert itself fails with "violates
-- check constraint vouchers_amount_pkr_check" before finalize_voucher() ever
-- runs. finalize_voucher() already rejects a zero/empty line total
-- (RAISE EXCEPTION 'Add at least one line item first') before letting a
-- voucher leave 'draft', so the real >0 business rule stays enforced there.
ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS vouchers_amount_pkr_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_amount_pkr_check CHECK (amount_pkr >= 0);
