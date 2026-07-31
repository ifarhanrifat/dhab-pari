-- Migration 010: Fix ledger_entries_ref_key to allow the two lines a voucher legitimately
-- posts (one to_account debit + one from_account credit, both referencing the same
-- voucher id). The index still enforces exactly one ledger line per bill/payment/donation,
-- which is what it was for — it just needs to exclude vouchers from that rule.

DROP INDEX IF EXISTS ledger_entries_ref_key;
CREATE UNIQUE INDEX ledger_entries_ref_key
  ON ledger_entries(reference_type, reference_id)
  WHERE reference_id IS NOT NULL AND reference_type != 'voucher';
