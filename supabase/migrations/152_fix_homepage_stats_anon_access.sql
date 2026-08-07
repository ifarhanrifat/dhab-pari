-- Migration 152: homepage_stats() (migration 150) joins `accounts`, which
-- is authenticated-only (accounts_read, migration 014) — an anonymous
-- visitor (i.e. most of the public homepage's actual audience) got all
-- zeros back, silently, since the join just returned no rows rather than
-- erroring. SECURITY DEFINER fixes it the same way project_monthly_sponsorship_pkr/
-- project_donation_channels_pkr already do for the same reason: a narrow
-- aggregate-only exposure, never raw account/ledger rows.
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
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION homepage_stats() TO anon, authenticated;
