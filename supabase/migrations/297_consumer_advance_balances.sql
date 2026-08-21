-- Migration 297: surface a consumer's unapplied advance/prepayment credit
-- on the Billing page.
--
-- The credit itself was never missing — Cash Receipt (Transactions Workspace)
-- already posts it correctly as a bill_id-less payment/ledger credit, and it
-- shows up correctly on the consumer's own account statement. The gap is
-- that /admin/billing (where an accountant actually looks at a consumer
-- before generating/collecting a bill) had no way to know a credit was
-- sitting there — nothing nets it automatically, so it was easy to forget.
--
-- Computed the same way accounts/[id]/page.tsx computes "Advance Balance":
-- opening_balance + SUM(debit) - SUM(credit) over the consumer's ledger,
-- negative meaning they've paid more than they owe. Returned as a positive
-- amount keyed by consumer_id (only consumers with an actual credit are
-- included), one round trip instead of pulling every consumer's full ledger
-- to the client.
CREATE OR REPLACE FUNCTION get_consumer_advance_balances() RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT COALESCE(can_access_system('water_supply'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_object_agg(t.consumer_id, t.advance), '{}'::jsonb) INTO v_result
  FROM (
    SELECT
      a.consumer_id,
      -(a.opening_balance + COALESCE(SUM(le.debit), 0) - COALESCE(SUM(le.credit), 0)) AS advance
    FROM accounts a
    LEFT JOIN ledger_entries le ON le.account_id = a.id
    WHERE a.type = 'consumer' AND a.consumer_id IS NOT NULL
    GROUP BY a.id, a.consumer_id, a.opening_balance
    HAVING (a.opening_balance + COALESCE(SUM(le.debit), 0) - COALESCE(SUM(le.credit), 0)) < 0
  ) t;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION get_consumer_advance_balances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_consumer_advance_balances() TO authenticated;
