-- Migration 505: fix a real overcount migration 504 just introduced.
--
-- Reported live (2026-09-23): Jamal S/O Haji Gulzar's receipt jumped from
-- 25,000 to 77,000 (should be 27,000) right after migration 504 shipped.
-- Cause: every donation posts THREE ledger_entries legs (donor credit,
-- bank/cash debit, project memo credit), not one. Migration 504's fix
-- joined ledger_entries directly into the SUM query -- for a donation's
-- two non-donor legs (bank, project), the join's `a2.type = 'donor'`
-- condition fails, a2 comes back NULL, and the query falls back to the
-- old per-row donor_key_for(name, phone) computation for THAT LEG, which
-- still matches v_key whenever the donation itself has a phone on file.
-- Net effect: a donation with a phone got summed once per matching leg
-- (3x for a normal 3-leg voucher) instead of once total -- his new 25,000
-- counted 3 times (75,000) plus the old 2,000 counted once = 77,000,
-- exactly the reported number.
--
-- Fix: resolve each donor row's account key with a correlated scalar
-- subquery (LIMIT 1, filtered to the donor leg specifically) instead of a
-- table JOIN in the aggregate -- this can only ever contribute one row per
-- donation, however many ledger legs it actually has.
CREATE OR REPLACE FUNCTION donor_receipt_totals(p_donor_id uuid)
RETURNS TABLE (total_contributed numeric, announced_remaining numeric, is_confirmed boolean) AS $$
DECLARE
  v_key varchar;
  v_confirmed boolean;
  v_account_key varchar;
BEGIN
  IF NOT can_access_system('donors_projects') THEN
    RAISE EXCEPTION 'Not authorized to read donor totals';
  END IF;

  SELECT donor_key_for(d.name, d.phone), d.is_verified
    INTO v_key, v_confirmed
  FROM donors d WHERE d.id = p_donor_id;

  IF v_key IS NULL THEN
    RETURN QUERY SELECT 0::numeric, 0::numeric, false;
    RETURN;
  END IF;

  SELECT a.donor_key INTO v_account_key
  FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
  WHERE le.reference_type = 'donation' AND le.reference_id = p_donor_id AND a.type = 'donor'
  LIMIT 1;

  v_key := COALESCE(v_account_key, v_key);

  RETURN QUERY
  SELECT
    COALESCE(SUM(d.amount_pkr) FILTER (WHERE d.is_verified), 0)::numeric,
    COALESCE(SUM(d.amount_pkr) FILTER (WHERE NOT d.is_verified AND d.payment_status = 'pledged'), 0)::numeric,
    COALESCE(v_confirmed, false)
  FROM donors d
  WHERE COALESCE(
    (SELECT a2.donor_key FROM ledger_entries le2 JOIN accounts a2 ON a2.id = le2.account_id
     WHERE le2.reference_type = 'donation' AND le2.reference_id = d.id AND a2.type = 'donor'
     LIMIT 1),
    donor_key_for(d.name, d.phone)
  ) = v_key;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
