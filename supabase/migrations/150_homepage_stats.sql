-- Migration 150: Real homepage stats. The homepage's stat cards and Cash
-- Position card were hardcoded placeholder text — this computes the real
-- numbers as one cheap aggregate round-trip (accounts/ledger_entries are
-- already public-readable, so no SECURITY DEFINER needed) instead of
-- pulling every ledger row to the client just to sum them there.
CREATE OR REPLACE FUNCTION homepage_stats() RETURNS TABLE (
  available_funds decimal, active_projects bigint, donations_this_month decimal,
  registered_households bigint, revenue_this_month decimal, expenses_this_month decimal
) AS $$
  SELECT
    (SELECT COALESCE(SUM(a.opening_balance + COALESCE(le.net, 0)), 0) FROM accounts a
       LEFT JOIN (SELECT account_id, SUM(debit) - SUM(credit) AS net FROM ledger_entries GROUP BY account_id) le ON le.account_id = a.id
       WHERE a.type IN ('cash', 'bank')),
    (SELECT COUNT(*) FROM projects WHERE status = 'ongoing'),
    (SELECT COALESCE(SUM(amount_pkr), 0) FROM donors WHERE is_verified = true AND date >= date_trunc('month', current_date)),
    (SELECT COUNT(*) FROM consumers),
    (SELECT COALESCE(SUM(le2.credit), 0) FROM ledger_entries le2 JOIN accounts a2 ON a2.id = le2.account_id
       WHERE a2.type = 'income' AND le2.entry_date >= date_trunc('month', current_date)),
    (SELECT COALESCE(SUM(le3.debit), 0) FROM ledger_entries le3 JOIN accounts a3 ON a3.id = le3.account_id
       WHERE a3.type = 'expense' AND le3.entry_date >= date_trunc('month', current_date));
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION homepage_stats() TO anon, authenticated;
