-- Migration 024: Account headers are pure categories, never transactable themselves —
-- confirmed the transaction dropdowns already only ever query `accounts` (never
-- `account_headers`), so that principle already held structurally. What was missing
-- was the explicit guarantee: every system header always has at least one working
-- sub-account under it, and neither that default sub-account nor the header itself
-- can ever be deleted (deleting the last account under "Cash-in-hand", for example,
-- would leave nothing for the payment trigger's hardcoded lookup to post against).
--
-- Consumer/donor headers are exempt from needing a single "default" sub-account —
-- every consumer/donor already gets their own individually-provisioned account, so
-- there's no shared placeholder needed there. But the header rows themselves
-- (is_system = true) are still protected from deletion either way.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_protected boolean NOT NULL DEFAULT false;

-- One designated default per non-party header per system — the account each
-- system's ledger-posting triggers already hardcode a lookup for (cash/bank/income),
-- plus the first-created account under expense/asset/liability so every header has
-- a guaranteed, permanent option.
UPDATE accounts SET is_protected = true
WHERE (system, code) IN (
  ('water_supply', 'WS-1001'), ('water_supply', 'WS-1002'), ('water_supply', 'WS-2001'),
  ('water_supply', 'WS-3001'), ('water_supply', 'WS-4001'), ('water_supply', 'WS-5001'),
  ('donors_projects', 'DP-1001'), ('donors_projects', 'DP-1002'), ('donors_projects', 'DP-2001'),
  ('donors_projects', 'DP-3001'), ('donors_projects', 'DP-4001'), ('donors_projects', 'DP-5001')
);

CREATE OR REPLACE FUNCTION trg_protect_account_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.is_protected THEN
    RAISE EXCEPTION 'Account % (%) is a protected default account and cannot be deleted. Disable it instead if it''s no longer used.', OLD.code, OLD.name;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS protect_account_delete_trigger ON accounts;
CREATE TRIGGER protect_account_delete_trigger BEFORE DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION trg_protect_account_delete();

CREATE OR REPLACE FUNCTION trg_protect_header_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.is_system THEN
    RAISE EXCEPTION 'Header "%" is a built-in account header and cannot be deleted.', OLD.label;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS protect_header_delete_trigger ON account_headers;
CREATE TRIGGER protect_header_delete_trigger BEFORE DELETE ON account_headers
  FOR EACH ROW EXECUTE FUNCTION trg_protect_header_delete();
