-- Migration 119: donors_projects collector accounts — the same "cash held in
-- their name until settled" pattern Water Supply field collectors already
-- have (migration 056), extended to donors_projects viewer/collector staff.
-- Water Supply's own collector flow keeps working unchanged (the added
-- parameter defaults to its existing behavior, and its own admin page,
-- /admin/collectors, is not touched by this migration or this feature).

-- 1. accounts_collector_id_key was a UNIQUE INDEX on collector_id alone, so a
--    person who collects for BOTH systems could only ever get one account
--    row. Widen it to (collector_id, system) — a no-op for existing
--    single-system data, but required before a collector account can exist
--    per system.
DROP INDEX IF EXISTS accounts_collector_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_collector_id_system_key ON accounts(collector_id, system) WHERE collector_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ensure_collector_account(p_admin_user_id uuid, p_system varchar DEFAULT 'water_supply') RETURNS uuid AS $$
DECLARE
  v_account_id uuid;
  v_name varchar;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE collector_id = p_admin_user_id AND system = p_system;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT full_name INTO v_name FROM admin_users WHERE id = p_admin_user_id;
  INSERT INTO accounts (code, name, type, system, collector_id, opening_balance)
  VALUES (
    'COL-' || substr(replace(p_admin_user_id::text, '-', ''), 1, 8) || CASE WHEN p_system = 'donors_projects' THEN '-DP' ELSE '' END,
    v_name, 'collector', p_system, p_admin_user_id, 0
  )
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$ LANGUAGE plpgsql;

-- 2. collector_settlements gains a system column so donors_projects
--    collectors can settle their holdings too, same table/trigger, just
--    system-scoped like recurring_schedules/vouchers already are.
ALTER TABLE collector_settlements ADD COLUMN IF NOT EXISTS system varchar NOT NULL DEFAULT 'water_supply'
  CHECK (system IN ('water_supply', 'donors_projects'));

DROP POLICY IF EXISTS "collector_settlements_read" ON collector_settlements;
DROP POLICY IF EXISTS "collector_settlements_write" ON collector_settlements;
CREATE POLICY "collector_settlements_read" ON collector_settlements FOR SELECT TO authenticated
  USING (can_access_system(system));
CREATE POLICY "collector_settlements_write" ON collector_settlements FOR INSERT TO authenticated
  WITH CHECK (can_access_system(system) AND current_admin_permission('post_transactions'));

CREATE OR REPLACE FUNCTION trg_collector_settlement_ledger() RETURNS trigger AS $$
DECLARE
  v_collector_account_id uuid;
  v_collector_name varchar;
  v_particular text;
BEGIN
  v_collector_account_id := ensure_collector_account(NEW.collector_id, NEW.system);
  SELECT full_name INTO v_collector_name FROM admin_users WHERE id = NEW.collector_id;
  v_particular := 'Cash received from collector ' || COALESCE(v_collector_name, 'Unknown')
    || CASE WHEN NEW.note IS NOT NULL AND trim(NEW.note) != '' THEN ' — ' || NEW.note ELSE '' END;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (NEW.to_account_id, NEW.settled_date, v_particular, NEW.amount_pkr, 0, 'collector_settlement', NEW.id);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_collector_account_id, NEW.settled_date, v_particular, 0, NEW.amount_pkr, 'collector_settlement', NEW.id);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 3. get_field_collectors() (migration 057) is hardcoded to water_supply — a
--    new sibling function rather than parameterizing it, so no PostgREST
--    call-site (which always calls it with zero args) can ever become
--    ambiguous.
CREATE OR REPLACE FUNCTION get_field_collectors_by_system(p_system varchar) RETURNS TABLE (
  id uuid, full_name varchar, mobile varchar, assigned_sectors text[]
) AS $$
  SELECT id, full_name, mobile, assigned_sectors FROM admin_users
  WHERE can_collect_payments = true AND is_active = true AND can_access_system(p_system);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
