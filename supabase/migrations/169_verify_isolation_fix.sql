-- Migration 169: one-off DO-block verification that 168's changed subqueries
-- actually execute (CREATE FUNCTION only checks plpgsql body syntax, not the
-- embedded SQL — that's exactly how the item_id bug in 164 slipped through).
-- Leaves no database object behind.
DO $$
DECLARE v_a int; v_l int; v_c int;
BEGIN
  SELECT count(*) INTO v_a FROM accounts a WHERE a.is_active = true AND can_access_system(a.system);
  SELECT count(*) INTO v_l FROM ledger_entries l WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = l.account_id AND can_access_system(a.system));
  SELECT count(*) INTO v_c FROM complaints co WHERE can_access_system(co.system);
  RAISE NOTICE 'ISOLATION_SQL_OK accounts=% ledger=% complaints=% (0s expected: no auth.uid() in a migration session)', v_a, v_l, v_c;
END $$;
