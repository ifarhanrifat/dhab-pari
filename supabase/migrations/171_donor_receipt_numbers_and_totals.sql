-- Migration 171: donor receipts were showing a UUID fragment instead of a real
-- document number, and had no way to show the donor's lifetime position.
--
-- Three parts:
--   1. Backfill voucher_no for donations that are already verified (posted to
--      the ledger) but predate 117/157's number assignment — every other
--      document type in this app carries a real number, donations should too.
--   2. donor_receipt_totals() — the cumulative "total donated so far" and the
--      "announced but not yet paid" figure a donor receipt now prints.
--   3. A receipt fund-note setting (shared + donor override), so the committee
--      can tell donors what to do when their own records disagree with ours.

-- 1. Backfill ------------------------------------------------------------
-- Only is_verified rows: an unverified/pledged donation gets its number from
-- confirm_donation() at the moment it is confirmed, and handing one out now
-- would burn a serial on a donation that may never be collected. Ordered by
-- date so the assigned serials follow the chronology a reader expects.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id FROM donors
    WHERE is_verified = true AND voucher_no IS NULL
    ORDER BY date, created_at
  LOOP
    UPDATE donors SET voucher_no = next_voucher_no('donors_projects', 'income') WHERE id = r.id;
  END LOOP;
END $$;

-- 2. Receipt totals ------------------------------------------------------
-- Donor identity is donor_key_for(name, phone) — the same key
-- ensure_donor_account() uses — NOT donors.id, which is per-donation. A donor
-- who gave five times has five donor rows and one identity, and the receipt
-- has to speak about the identity.
--
--   total_contributed  = every verified (collected) donation under this
--                        identity, including the one on this receipt
--   announced_remaining = pledged/announced under this identity that has NOT
--                        been collected yet — the donor-side equivalent of a
--                        water consumer's outstanding amount
CREATE OR REPLACE FUNCTION donor_receipt_totals(p_donor_id uuid)
RETURNS TABLE (total_contributed numeric, announced_remaining numeric) AS $$
DECLARE
  v_key varchar;
BEGIN
  IF NOT can_access_system('donors_projects') THEN
    RAISE EXCEPTION 'Not authorized to read donor totals';
  END IF;

  SELECT donor_key_for(d.name, d.phone) INTO v_key FROM donors d WHERE d.id = p_donor_id;
  IF v_key IS NULL THEN
    RETURN QUERY SELECT 0::numeric, 0::numeric;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(SUM(d.amount_pkr) FILTER (WHERE d.is_verified), 0)::numeric,
    COALESCE(SUM(d.amount_pkr) FILTER (WHERE NOT d.is_verified AND d.payment_status = 'pledged'), 0)::numeric
  FROM donors d
  WHERE donor_key_for(d.name, d.phone) = v_key;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION donor_receipt_totals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donor_receipt_totals(uuid) TO authenticated;

-- 3. Fund-note setting ---------------------------------------------------
-- Shared key seeded empty (water supply can opt in from Settings); the donor
-- override is seeded with real wording so donor receipts carry it immediately
-- without anyone having to type it in first.
INSERT INTO site_settings (key, value, description) VALUES
  ('receipt_fund_note', '',
   'Printed on water supply bills/receipts under the instructions — tell the consumer what to do if their own records disagree with ours.'),
  ('donor_receipt_fund_note',
   'اگر آپ کے ریکارڈ کے مطابق رقم اس رسید یا کل فنڈ سے مطابقت نہیں رکھتی تو براہ کرم ہماری ہیلپ لائن پر کال یا واٹس ایپ کریں۔',
   'Printed on donor receipts under the instructions. Leave blank to fall back to the water supply note.')
ON CONFLICT (key) DO NOTHING;
