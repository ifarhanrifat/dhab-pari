-- Migration 039: Two gaps found via live testing of the redesigned Generate Bill:
--
-- 1. Recurring bills carried the ENTIRE line-item total forward (minus discount) —
--    including one-off charges like a new-connection installation fee or a meter
--    that should only ever be billed once. bill_line_items now tracks which lines
--    are genuinely recurring (the monthly service/connection charge) versus one-off,
--    so the recurring schedule amount can be computed from recurring lines only.
--
-- 2. The invoice page had no clean way to show what actually posted for a security
--    deposit (it was only findable by fuzzy-matching the voucher's particular text
--    against the bill number). A direct FK makes that lookup exact.

ALTER TABLE bill_line_items ADD COLUMN IF NOT EXISTS is_recurring boolean NOT NULL DEFAULT true;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS security_deposit_voucher_id uuid REFERENCES vouchers(id) ON DELETE SET NULL;
