-- Migration 058: A live test of the collector settlement trigger (built in
-- migration 056) failed with a CHECK constraint violation — ledger_entries.
-- reference_type only allowed 'bill', 'payment', 'donation', 'manual',
-- 'voucher', 'inventory' (migration 029), not 'collector_settlement'. Extend it.

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_reference_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_reference_type_check
  CHECK (reference_type IN ('bill', 'payment', 'donation', 'manual', 'voucher', 'inventory', 'collector_settlement'));
