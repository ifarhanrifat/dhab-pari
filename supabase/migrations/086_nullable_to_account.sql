-- Migration 086: migration 083's draft-voucher pattern (multi-line Expense,
-- Advance Settlement) has no single "to" account — the real destinations are
-- the voucher_line_items rows instead — but to_account_id has been NOT NULL
-- since migration 009 and was never relaxed, so those drafts fail at insert
-- with "null value in column to_account_id violates not-null constraint".
-- Simple single-leg vouchers (expense, income, contra, withdrawal, deposit,
-- security_deposit, advance) still supply to_account_id as before — this only
-- allows it to be omitted when line items carry the split instead.
ALTER TABLE vouchers ALTER COLUMN to_account_id DROP NOT NULL;
