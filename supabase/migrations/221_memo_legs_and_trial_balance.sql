-- Migration 221: tell the real double entry apart from the subsidiary ledgers.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Why the trial balance never balanced
-- ═════════════════════════════════════════════════════════════════════════
-- This codebase has always posted two kinds of ledger row and never
-- distinguished them.
--
-- The real double entry: cash out, expense in. Those always balance.
--
-- And subsidiary rows, posted so that a project, a school, a student or a
-- restricted fund has its own readable statement. Migration 118 called them
-- "memo/subsidiary" postings and noted the codebase "doesn't enforce strict
-- balance-to-zero per reference either". True — but the consequence was that
-- total debits never equalled total credits, so a trial balance was
-- meaningless and the balance sheet quietly wrong.
--
-- Measured on a copy of the live schema with a donation, two fee payments to
-- one school, a contribution and a repayment:
--
--   real legs       donor -500,000 · bank +435,000 · cash +3,000
--                   asset +30,000 · expense +32,000        = 0     correct
--   subsidiary      fund -438,000 · student +62,000
--                   institution +75,000                    = -301,000
--
-- Nothing is wrong with the money. The subsidiary rows simply are not part of
-- the balancing pair and have to stop being counted as though they were.

ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS is_memo boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ledger_entries_real_idx ON ledger_entries(account_id) WHERE NOT is_memo;

-- Decided from the account's own type rather than at each of the dozens of
-- insert sites, so no future code path can forget to set it.
CREATE OR REPLACE FUNCTION account_is_subsidiary(p_account_id uuid) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT type IN ('project', 'restricted_fund', 'institution', 'student')
       FROM accounts WHERE id = p_account_id),
    false);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_ledger_entries_mark_memo() RETURNS trigger AS $$
BEGIN
  NEW.is_memo := account_is_subsidiary(NEW.account_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_mark_memo ON ledger_entries;
CREATE TRIGGER ledger_entries_mark_memo
  BEFORE INSERT OR UPDATE OF account_id ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_entries_mark_memo();

-- Everything already posted, brought into line.
UPDATE ledger_entries l SET is_memo = true
  FROM accounts a
 WHERE a.id = l.account_id
   AND a.type IN ('project', 'restricted_fund', 'institution', 'student')
   AND NOT l.is_memo;

-- ═════════════════════════════════════════════════════════════════════════
-- A trial balance that actually balances
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION trial_balance(p_system varchar, p_to date DEFAULT NULL)
RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'as_at', COALESCE(p_to, (now() AT TIME ZONE 'Asia/Karachi')::date),
    'total_debits', COALESCE(SUM(l.debit), 0),
    'total_credits', COALESCE(SUM(l.credit), 0),
    'difference', COALESCE(SUM(l.debit) - SUM(l.credit), 0),
    'balanced', COALESCE(ABS(SUM(l.debit) - SUM(l.credit)) < 0.01, true),
    'accounts', (SELECT COALESCE(jsonb_agg(x ORDER BY x->>'code'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'code', a2.code, 'name', a2.name, 'type', a2.type,
          'debit', SUM(l2.debit), 'credit', SUM(l2.credit),
          'balance', SUM(l2.debit) - SUM(l2.credit)
        ) AS x
        FROM ledger_entries l2 JOIN accounts a2 ON a2.id = l2.account_id
        WHERE a2.system = p_system AND NOT l2.is_memo
          AND (p_to IS NULL OR l2.entry_date <= p_to)
        GROUP BY a2.code, a2.name, a2.type
        HAVING SUM(l2.debit) + SUM(l2.credit) > 0
      ) y)
  )
  FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
  WHERE a.system = p_system AND NOT l.is_memo
    AND (p_to IS NULL OR l.entry_date <= p_to);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION trial_balance(varchar, date) TO authenticated;
GRANT EXECUTE ON FUNCTION account_is_subsidiary(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Where the welfare money stands, in one call
-- ═════════════════════════════════════════════════════════════════════════
-- Restricted funds are not part of the general surplus and must not be added
-- into it — money given for zakat is not income the committee may spend on
-- anything else. This reports them the way a charity reports them: what came
-- in, what went out, and what is still held for each purpose, beside the
-- receivable that the qarz-e-hasana loans represent.
CREATE OR REPLACE FUNCTION welfare_position() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'funds', fund_movement_report(),
    'loans_outstanding', COALESCE((SELECT SUM(awarded_amount_pkr - repaid_pkr - written_off_pkr)
                                     FROM wazifa_awards WHERE is_loan AND status <> 'cancelled'), 0),
    'loans_repaid', COALESCE((SELECT SUM(repaid_pkr) FROM wazifa_awards WHERE is_loan), 0),
    'loans_written_off', COALESCE((SELECT SUM(written_off_pkr) FROM wazifa_awards WHERE is_loan), 0),
    'student_contributions', COALESCE((SELECT SUM(contributed_pkr) FROM wazifa_awards), 0),
    'grants_given', COALESCE((SELECT SUM(awarded_amount_pkr) FROM wazifa_awards WHERE NOT is_loan), 0),
    'owed_to_institutions', COALESCE((SELECT SUM(l.credit - l.debit) FROM ledger_entries l
                                        JOIN accounts a ON a.id = l.account_id
                                       WHERE a.code = 'DP-2020'), 0),
    'paid_to_institutions', COALESCE((SELECT SUM(amount_pkr) FROM vouchers
                                       WHERE school_id IS NOT NULL AND status = 'posted'), 0)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION welfare_position() TO authenticated;
