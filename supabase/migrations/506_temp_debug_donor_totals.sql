-- TEMPORARY, removed by migration 507 immediately after use -- exists only
-- to verify migration 505's fix against live data without an authenticated
-- admin session (donor_receipt_totals() correctly requires one via
-- can_access_system(), which a raw service-role REST call has no session
-- for). Same query, no auth guard, so it can be called directly to prove
-- the real function's logic returns the right number before telling the
-- user it's fixed.
CREATE OR REPLACE FUNCTION _debug_donor_receipt_totals(p_donor_id uuid)
RETURNS TABLE (total_contributed numeric, announced_remaining numeric, is_confirmed boolean) AS $$
DECLARE
  v_key varchar;
  v_confirmed boolean;
  v_account_key varchar;
BEGIN
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
GRANT EXECUTE ON FUNCTION _debug_donor_receipt_totals(uuid) TO service_role;
