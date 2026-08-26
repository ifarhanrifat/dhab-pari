-- Migration 358: a project's chart-of-accounts entry only ever got created
-- lazily — ensure_project_account() (migration 118) is called from
-- trg_donor_ledger()/post_voucher_ledger_legs_base() the first time a
-- donation or expense actually references the project, so a brand-new
-- project sat invisible in Accounts until real money moved against it.
-- This makes it immediate and unconditional at the database level — every
-- project gets its account the moment it's created, regardless of which
-- screen created it (admin's New Project form, a portal-proposed project,
-- any future path) — a DB trigger, not a per-form patch that could be
-- missed if a new creation flow shows up later.

CREATE OR REPLACE FUNCTION trg_project_ensure_account() RETURNS trigger AS $$
BEGIN
  PERFORM ensure_project_account(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS project_ensure_account_trigger ON projects;
CREATE TRIGGER project_ensure_account_trigger AFTER INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION trg_project_ensure_account();

-- Backfill: any existing project that somehow still has no account (all 16
-- legacy-imported ones already do, from the historical import itself, but
-- this covers any other gap without needing to know which ones).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM projects WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE project_id = projects.id)
  LOOP
    PERFORM ensure_project_account(r.id);
  END LOOP;
END $$;
