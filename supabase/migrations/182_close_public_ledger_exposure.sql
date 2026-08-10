-- Migration 182: the whole ledger was readable by anybody.
--
-- Measured against the live database with the anon key — the key that ships in
-- every browser bundle and is readable by anyone who opens dev tools:
--
--   ledger_entries   244 of 244 rows
--   bills             38 of 38
--   payments          34 of 34
--   vouchers          10 of 10
--   consumers         12 of 12   (names, mobiles, addresses, sectors)
--
-- Cause: migrations 002/007/009 created permissive `FOR SELECT USING (true)`
-- policies, and the RBAC work in 014 added restrictive ones alongside them.
-- Postgres OR's policies together, so adding a strict policy next to an open
-- one restricts nothing. Migration 116 spotted this for `donors` and dropped
-- `public_read_donors`, replacing it with the narrow `donors_public` view —
-- which is why donors was the only table not exposed. This applies that same
-- treatment to the other five.
--
-- Two genuine public features depended on the open policies and are preserved
-- deliberately, each through a narrow surface rather than blanket table access:
--   * /water — look up your own bill by consumer number, without logging in
--   * /projects/[id] — see what a project actually spent
--
-- Portal users lost nothing either: they get explicit own-row policies, which
-- they never actually had. That absence is why a confirmed donation showed
-- nothing on the donor's own statement — the page reads accounts.donor_account_no
-- first, that read returned zero rows, and the whole statement fell back to
-- "no confirmed donations yet" even though the ledger entry was right there.

-- ── 1. Remove the blanket public reads ───────────────────────────────────
DROP POLICY IF EXISTS "public_read_bills" ON bills;
DROP POLICY IF EXISTS "public_read_consumers" ON consumers;
DROP POLICY IF EXISTS "public_read_payments" ON payments;
DROP POLICY IF EXISTS "public_read_ledger_entries" ON ledger_entries;
DROP POLICY IF EXISTS "public_read_vouchers" ON vouchers;

-- 002_rls.sql named these differently; drop by the names it used too.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname, tablename FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('bills', 'consumers', 'payments', 'ledger_entries', 'vouchers')
       AND cmd = 'SELECT'
       AND qual = 'true'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I', r.policyname, r.tablename);
    RAISE NOTICE 'dropped open SELECT policy %.%', r.tablename, r.policyname;
  END LOOP;
END $$;

-- ── 2. Portal users can read their own records ───────────────────────────
-- None of these existed. A portal user could read everything (via the open
-- policies) or, once those are gone, nothing — so each needs saying explicitly.
CREATE POLICY "accounts_portal_read_own" ON accounts FOR SELECT TO authenticated
  USING (id = (SELECT donor_account_id FROM portal_users WHERE id = current_portal_user_id()));

CREATE POLICY "ledger_portal_read_own" ON ledger_entries FOR SELECT TO authenticated
  USING (account_id = (SELECT donor_account_id FROM portal_users WHERE id = current_portal_user_id()));

CREATE POLICY "bills_portal_read_own" ON bills FOR SELECT TO authenticated
  USING (consumer_id = (SELECT consumer_id FROM portal_users WHERE id = current_portal_user_id()));

CREATE POLICY "payments_portal_read_own" ON payments FOR SELECT TO authenticated
  USING (consumer_id = (SELECT consumer_id FROM portal_users WHERE id = current_portal_user_id()));

CREATE POLICY "consumers_portal_read_own" ON consumers FOR SELECT TO authenticated
  USING (consumer_id = (SELECT consumer_id FROM portal_users WHERE id = current_portal_user_id()));

-- ── 3. Public bill lookup, without exposing the consumer list ────────────
-- Two factors, because consumer numbers are sequential (DP-1001…DP-1017) and a
-- lookup keyed on that alone is an enumeration oracle: walk the range and you
-- have every household's name, address and bills. The caller must also know
-- something only the household knows — the last four digits of the registered
-- mobile, or the house number.
--
-- A failed verifier returns no rows, exactly like an unknown consumer number.
-- That is deliberate: distinguishing "wrong code" from "no such consumer" would
-- hand back the enumeration this is meant to prevent.
--
-- Mobiles are stored inconsistently ('0312-9876543' and '03333022794' both
-- appear), so both sides are reduced to digits before comparing.
CREATE OR REPLACE FUNCTION public_bill_lookup(p_consumer_id varchar, p_verify varchar)
RETURNS TABLE (
  consumer_id text, name text, name_ur text,
  address text, house_no text, sector text, area text,
  bill_id uuid, month int, year int, amount_pkr numeric, status text, paid_date date
) AS $$
  SELECT c.consumer_id::text, c.name::text, c.name_ur::text,
         c.address::text, c.house_no::text, c.sector::text, c.area::text,
         b.id, b.month::int, b.year::int, b.amount_pkr::numeric, b.status::text, b.paid_date
    FROM consumers c
    LEFT JOIN LATERAL (
      SELECT * FROM bills WHERE bills.consumer_id = c.consumer_id
       ORDER BY year DESC, month DESC LIMIT 6
    ) b ON true
   WHERE c.consumer_id = trim(p_consumer_id)
     AND (
       -- last four digits of the registered mobile
       (c.mobile IS NOT NULL
        AND length(regexp_replace(p_verify, '\D', '', 'g')) >= 4
        AND right(regexp_replace(c.mobile,  '\D', '', 'g'), 4)
          = right(regexp_replace(p_verify, '\D', '', 'g'), 4))
       -- or the house number
       OR (c.house_no IS NOT NULL AND lower(trim(c.house_no)) = lower(trim(p_verify)))
     );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- The single-argument version would still be an open door; make sure no old
-- copy survives.
DROP FUNCTION IF EXISTS public_bill_lookup(varchar);
GRANT EXECUTE ON FUNCTION public_bill_lookup(varchar, varchar) TO anon, authenticated;

-- ── 4. Project spending stays public ─────────────────────────────────────
-- What a project spent is exactly the sort of thing a committee should publish.
-- Same narrow-view pattern as donors_public: only the expense legs of accounts
-- tied to a project, nothing else in the ledger.
CREATE OR REPLACE VIEW project_expenses_public AS
SELECT a.project_id, le.id, le.entry_date, le.particular, le.debit
  FROM ledger_entries le
  JOIN accounts a ON a.id = le.account_id
 WHERE a.project_id IS NOT NULL AND le.debit > 0;

GRANT SELECT ON project_expenses_public TO anon, authenticated;

-- The public project page also looks up the project's account id. It only ever
-- needs to know one exists, so expose that narrowly too rather than reopening
-- the accounts table.
CREATE OR REPLACE VIEW project_accounts_public AS
SELECT id, project_id FROM accounts WHERE project_id IS NOT NULL;

GRANT SELECT ON project_accounts_public TO anon, authenticated;
