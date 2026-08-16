-- Migration 258: three real bugs found from live reports.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Part A — a Kafalat/Wazifa/Sadqa donation was invisible on the donor's own
-- My Giving page the first time they ever gave
-- ═════════════════════════════════════════════════════════════════════════
-- confirm_donation() (migration 129) backfills portal_users.donor_account_id
-- the first time a donor's donation is confirmed, matching by phone/
-- WhatsApp number — that's what lets /portal/statement know which ledger
-- account is theirs. pool_post_confirmed_payment() (the Kafalat/Wazifa/
-- Sadqa confirm path) never got the same backfill, so a donor whose FIRST
-- confirmed donation ever happened to be a pool one (Saeed Azmat: one
-- Kafalat donation, nothing else) had a perfectly correct ledger and a
-- permanently empty-looking statement page — the account link was simply
-- never made.
CREATE OR REPLACE FUNCTION pool_post_confirmed_payment(
  p_pool_id uuid, p_commitment_id uuid, p_donor_name varchar, p_donor_name_ur varchar,
  p_donor_phone varchar, p_is_anonymous boolean, p_amount decimal, p_method varchar,
  p_portal_user_id uuid, p_month date, p_note text,
  p_kafalat_child_id uuid DEFAULT NULL, p_wazifa_student_id uuid DEFAULT NULL,
  p_sadqa_object_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE pl support_pools%ROWTYPE; v_donor_id uuid; v_account_id uuid; v_year varchar; v_named text;
BEGIN
  SELECT * INTO pl FROM support_pools WHERE id = p_pool_id;

  v_named := CASE
    WHEN p_kafalat_child_id IS NOT NULL THEN
      (SELECT ' — for ' || first_name || ' (' || code || ')' FROM kafalat_children WHERE id = p_kafalat_child_id)
    WHEN p_wazifa_student_id IS NOT NULL THEN
      (SELECT ' — for ' || full_name || ' (' || code || ')' FROM wazifa_students WHERE id = p_wazifa_student_id)
    WHEN p_sadqa_object_id IS NOT NULL THEN
      (SELECT ' — for ' || item_name || ' (' || object_no || ')' FROM sadqa_objects WHERE id = p_sadqa_object_id)
    ELSE '' END;

  -- The donor announced and paid this entirely themselves through the
  -- portal — staff only verified it against the bank record, the same
  -- relationship a public web-form donation already has to its confirming
  -- accountant. 'staff' is reserved for a donation an admin actually typed
  -- in on someone's behalf (Add Donor / walk-in cash entry).
  INSERT INTO donors (name, name_ur, phone, amount_pkr, date, is_verified,
                      payment_method, is_anonymous, fund_type, portal_user_id,
                      payment_status, notes, submitted_via)
  VALUES (p_donor_name, p_donor_name_ur, p_donor_phone, p_amount,
          (now() AT TIME ZONE 'Asia/Karachi')::date, true, p_method, p_is_anonymous,
          pl.fund_type, p_portal_user_id, 'paid',
          pl.name || COALESCE(v_named, '') || ' — ' || to_char(p_month, 'Mon YYYY')
            || COALESCE(' · ' || p_note, ''),
          'public')
  RETURNING id INTO v_donor_id;

  -- Same rule every other staff-confirmed donation follows.
  PERFORM assign_donor_numbers_internal(v_donor_id);

  -- The backfill confirm_donation() already does — a portal account not yet
  -- linked to a ledger account gets linked here on its first pool donation,
  -- matched the same way, by phone/WhatsApp.
  IF p_portal_user_id IS NOT NULL THEN
    SELECT a.id INTO v_account_id FROM accounts a
     WHERE a.donor_key = donor_key_for(p_donor_name, p_donor_phone) AND a.system = 'donors_projects' AND a.type = 'donor';
    IF v_account_id IS NOT NULL THEN
      UPDATE portal_users SET donor_account_id = v_account_id
       WHERE id = p_portal_user_id AND donor_account_id IS NULL;
    END IF;
  END IF;

  IF p_commitment_id IS NOT NULL THEN
    UPDATE pool_commitments SET status = 'active', lapsed_at = NULL, updated_at = now()
     WHERE id = p_commitment_id AND status = 'lapsed';
  END IF;

  IF pl.kind = 'kafalat' THEN
    v_year := kafalat_current_year();
    PERFORM kafalat_post_requirement_delta(v_year, -p_amount,
      p_donor_name || ' confirmed — ' || to_char(p_month, 'Mon YYYY'), p_kafalat_child_id);
  ELSIF pl.kind = 'wazifa' THEN
    v_year := kafalat_current_year();
    PERFORM wazifa_post_requirement_delta(v_year, -p_amount,
      p_donor_name || ' confirmed — ' || to_char(p_month, 'Mon YYYY'), p_wazifa_student_id);
  END IF;

  RETURN jsonb_build_object('donor_id', v_donor_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION pool_post_confirmed_payment(uuid, uuid, varchar, varchar, varchar, boolean, decimal, varchar, uuid, date, text, uuid, uuid, uuid) TO authenticated;

-- One-time backfill for the gap this already left behind — links any
-- portal account that's still missing its donor_account_id despite having
-- a real, confirmed donation on file. Matches the exact same way
-- confirm_donation()'s own backfill does; touches nothing that wasn't
-- already true.
UPDATE portal_users pu SET donor_account_id = a.id
FROM accounts a
WHERE pu.donor_account_id IS NULL
  AND a.system = 'donors_projects' AND a.type = 'donor'
  AND EXISTS (SELECT 1 FROM donors d WHERE d.portal_user_id = pu.id AND d.is_verified = true)
  AND a.donor_key = (
    SELECT donor_key_for(d.name, d.phone) FROM donors d
     WHERE d.portal_user_id = pu.id AND d.is_verified = true
     ORDER BY d.date DESC LIMIT 1
  );

-- Correct the mislabel on every already-confirmed pool donation, so the
-- Source badge on /admin/donors stops calling self-service Kafalat/Wazifa/
-- Sadqa giving "Staff".
UPDATE donors SET submitted_via = 'public'
 WHERE submitted_via = 'staff'
   AND id IN (SELECT donor_id FROM pool_payments WHERE donor_id IS NOT NULL);

-- ═════════════════════════════════════════════════════════════════════════
-- Part B — a new water connection could be activated with its charges and
-- security deposit never actually collected
-- ═════════════════════════════════════════════════════════════════════════
-- doActivate() on /admin/connections only ever did a plain client-side
-- UPDATE — nothing stopped an accountant from activating a connection whose
-- "Receive Cash" step had silently failed (as happened live: NCR-00007's
-- payment insert never went through, yet the connection was activated
-- anyway). This makes it structurally impossible from here on: the status
-- flip to 'installed' only happens inside this function, and only once the
-- charges bill is genuinely paid in full and the security deposit (if any)
-- is actually on record.
CREATE OR REPLACE FUNCTION activate_connection(p_request_id uuid, p_recurring_schedule_id uuid DEFAULT NULL) RETURNS void AS $$
DECLARE r connection_requests%ROWTYPE; b bills%ROWTYPE;
BEGIN
  IF NOT COALESCE(can_access_system('water_supply'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO r FROM connection_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found' USING ERRCODE = 'P0001'; END IF;

  IF r.bill_id IS NULL THEN
    RAISE EXCEPTION 'Receive the connection charges first — no bill has been raised yet.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO b FROM bills WHERE id = r.bill_id;
  IF COALESCE(b.paid_amount, 0) < GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0), 0) THEN
    RAISE EXCEPTION 'The connection charges (Rs %) have not been fully paid yet.', trim(to_char(b.amount_pkr, 'FM999,999,990')) USING ERRCODE = 'P0001';
  END IF;
  IF r.security_deposit_amount > 0 AND b.security_deposit_voucher_id IS NULL THEN
    RAISE EXCEPTION 'The security deposit (Rs %) has not been recorded yet.', trim(to_char(r.security_deposit_amount, 'FM999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  UPDATE connection_requests SET status = 'installed', recurring_schedule_id = p_recurring_schedule_id
   WHERE id = p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION activate_connection(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION activate_connection(uuid, uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Part C — the Screening button on Kafalat nominations
-- ═════════════════════════════════════════════════════════════════════════
-- The frontend has always tried to stamp reviewed_at on a nomination —
-- the column just never existed (only reviewed_by does, and nothing ever
-- set that either). Added properly, matching bill_payment_claims/
-- wazifa_applications' own reviewed_by+reviewed_at pattern.
ALTER TABLE kafalat_nominations ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
