-- Migration 351: The admin dashboard fetched *every* ledger_entries row
-- unbounded (`select('account_id, entry_date, debit, credit')`, no range)
-- and summed debit/credit per account in JavaScript. That was always a
-- ticking time bomb — PostgREST silently caps an unbounded select at 1000
-- rows by default, with no error, no warning, just quietly wrong numbers
-- past that point. The legacy import (migration 350) pushed ledger_entries
-- from a couple hundred rows to 2,148 in one shot and tripped it — Cash in
-- Hand and Total Expenses both went wrong on the live dashboard because
-- roughly half the entries never made it into the client's aggregation at
-- all. The underlying ledger itself was always complete and correct; only
-- this one dashboard query's assumption ("the whole table always fits in
-- one page") broke.
--
-- Fix: aggregate in Postgres, not in the browser. These two views return
-- one row per account (and per account-month for the trend chart) —
-- bounded by the number of accounts the app will ever have, not by how
-- many transactions have ever been posted. Not security_invoker
-- (deliberately, matching donors_public's own precedent) — every admin
-- who reaches the dashboard already sees every system's raw numbers today
-- via the same unbounded query this replaces, so this changes nothing
-- about who can see what, only whether the sums are actually correct.

CREATE VIEW ledger_account_balances AS
SELECT account_id, SUM(debit) AS total_debit, SUM(credit) AS total_credit
FROM ledger_entries
GROUP BY account_id;

GRANT SELECT ON ledger_account_balances TO authenticated;

CREATE VIEW ledger_monthly_by_account AS
SELECT account_id, date_trunc('month', entry_date)::date AS month, SUM(debit) AS total_debit, SUM(credit) AS total_credit
FROM ledger_entries
GROUP BY account_id, date_trunc('month', entry_date);

GRANT SELECT ON ledger_monthly_by_account TO authenticated;
