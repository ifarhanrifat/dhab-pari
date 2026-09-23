-- Migration 504: donor_receipt_totals() now follows each donation's real
-- ledger account instead of re-deriving donor identity independently.
--
-- Same incident as migration 503, a second bug in it: after merging Jamal
-- S/O Haji Gulzar's ledger entries onto one account, his Chart of Accounts
-- balance correctly showed 27,000 -- but his receipt for the 25,000
-- donation still printed a lifetime total of 25,000. Root cause: this RPC
-- never looks at accounts/ledger_entries at all. It recomputes
-- donor_key_for(d.name, d.phone) fresh from each `donors` row and sums
-- whichever other donor rows produce the identical key. His Dec 2025
-- donation has phone = NULL (recorded before a phone was on file) --
-- donor_key_for() with a null phone falls back to the name, a *different*
-- key than the Sept 2026 donation's phone-based one. No account merge
-- could ever fix that divergence, because this function doesn't consult
-- accounts at all -- and this is not unique to Jamal: any donor with one
-- donation recorded with a phone and another without will hit the same
-- split, whether or not their accounts row happens to be duplicated too.
--
-- Fix: resolve each donation's *actual* posted-to account via
-- ledger_entries, and group by that account's donor_key -- the same
-- authoritative, self-healing identity ensure_donor_account() now
-- maintains (migration 503 upgrades it the first time a phone is added).
-- A donation with no ledger entry yet (still pledged/unconfirmed) has
-- nothing to follow, so it falls back to the original fresh computation,
-- unchanged from before.
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
  LEFT JOIN ledger_entries le2 ON le2.reference_type = 'donation' AND le2.reference_id = d.id
  LEFT JOIN accounts a2 ON a2.id = le2.account_id AND a2.type = 'donor'
  WHERE COALESCE(a2.donor_key, donor_key_for(d.name, d.phone)) = v_key;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
