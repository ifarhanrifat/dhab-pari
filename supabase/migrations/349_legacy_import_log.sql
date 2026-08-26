-- Migration 349: Legacy data import (BookKeeper → Dhab Pari) — the
-- committee's donor/project history from the accounting app used before
-- this system existed, still running in parallel for now. Real money,
-- imported once and safely re-importable as BookKeeper keeps growing.
--
-- One row per source record actually imported, keyed by a stable reference
-- derived from the source app's own voucher number (e.g. "bookkeeper:RCV123")
-- — the importer checks this before writing anything, so running it again
-- after more BookKeeper entries pile up only adds what's new.

CREATE TABLE legacy_import_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref varchar NOT NULL UNIQUE,
  entity_type varchar NOT NULL CHECK (entity_type IN ('project', 'donation', 'expense')),
  entity_id uuid NOT NULL,
  imported_by uuid REFERENCES admin_users(id),
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legacy_import_records_entity_idx ON legacy_import_records(entity_type, entity_id);

ALTER TABLE legacy_import_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "legacy_import_records_super_admin_read" ON legacy_import_records FOR SELECT TO authenticated
  USING (current_admin_role() = 'super_admin');
-- No client INSERT policy — only the import API route (service-role) writes
-- here, same convention as other server-only tables in this app.
