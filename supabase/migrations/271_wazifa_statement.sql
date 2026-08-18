-- Migration 271: the bank-statement view itself.
--
-- Every debit and credit this document promised was already landing in one
-- place before this migration existed: a student's own subsidiary account
-- (accounts.wazifa_student_id, created by ensure_wazifa_student_account()).
-- post_welfare_voucher_legs() (migration 218/224) already posts a debit
-- there for every 'wazifa_payment' disbursement — the committee's own
-- spending on this student — and a credit for every 'wazifa_repayment' or
-- 'wazifa_contribution' the student pays in, which after migration 270 now
-- includes their fixed monthly instalment. wazifa_post_requirement_delta()
-- posts the award itself there too. Nothing here changes what gets posted —
-- it is a read, not a write, over data that already exists.

CREATE OR REPLACE FUNCTION my_wazifa_statement() RETURNS jsonb AS $$
  WITH acct AS (
    SELECT ac.id FROM accounts ac
    JOIN wazifa_students s ON s.id = ac.wazifa_student_id
    WHERE s.portal_user_id = current_portal_user_id()
    LIMIT 1
  ),
  rows AS (
    SELECT le.entry_date, le.created_at, le.particular, le.debit, le.credit,
           SUM(le.debit - le.credit) OVER (ORDER BY le.entry_date, le.created_at) AS running_balance
    FROM ledger_entries le
    WHERE le.account_id = (SELECT id FROM acct)
  )
  SELECT jsonb_build_object(
    'has_account', (SELECT id FROM acct) IS NOT NULL,
    'entries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'date', entry_date, 'particular', particular,
        'debit', debit, 'credit', credit, 'balance', running_balance
      ) ORDER BY entry_date, created_at) FROM rows), '[]'::jsonb),
    'balance', COALESCE((SELECT SUM(debit - credit) FROM rows), 0)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_wazifa_statement() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_wazifa_statement() TO authenticated;
