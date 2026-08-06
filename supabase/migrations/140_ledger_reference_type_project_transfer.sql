-- transfer_project_funds() (migration 139) posts ledger_entries with
-- reference_type='project_transfer', but the CHECK constraint was never
-- widened for it — every transfer call fails with a 23514 violation. Same
-- widen-the-CHECK pattern as migrations 029/058.
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_reference_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_reference_type_check
  CHECK (reference_type IN ('bill', 'payment', 'donation', 'manual', 'voucher', 'inventory', 'collector_settlement', 'project_transfer'));
