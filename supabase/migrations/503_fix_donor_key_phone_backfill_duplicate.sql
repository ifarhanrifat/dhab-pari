-- Migration 503: stop ensure_donor_account() from forking a duplicate
-- account the first time a phone number is added to a donor who was
-- originally recorded without one.
--
-- Real incident (2026-09-23): Jamal S/O Haji Gulzar's first-ever donation
-- (Dec 2025) was recorded with no phone on file, so donor_key_for() fell
-- back to his name text as the matching key. His phone/country were added
-- to that account later (directly, e.g. via the Chart of Accounts edit
-- form), but nothing ever recomputed donor_key to match -- it stays
-- whatever it was set to at INSERT time. The next donation entered with
-- his phone number computed a *phone-based* key, found no account with
-- that exact donor_key, and created a brand-new one -- his existing 2,000
-- silently went invisible next to a second account holding just the new
-- 25,000. Fixed live for this donor by hand (merged the ledger entry back
-- onto his original account, deleted the duplicate, updated donor_key to
-- the phone). This migration is the systemic fix so it can't happen again
-- to any other donor whose phone gets added after their first donation.
CREATE OR REPLACE FUNCTION ensure_donor_account(p_name varchar, p_phone varchar) RETURNS uuid AS $$
DECLARE
  v_key varchar := donor_key_for(p_name, p_phone);
  v_name_key varchar := lower(TRIM(p_name));
  v_account_id uuid;
BEGIN
  -- Exact match on today's key (phone if given, else name) -- unchanged
  -- fast path, handles the common case where donor_key was already set
  -- correctly.
  SELECT id INTO v_account_id FROM accounts WHERE donor_key = v_key;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;

  -- A phone was given but didn't match by donor_key -- before creating a
  -- new account, check whether this donor already exists keyed by name
  -- alone (their first donation predates having a phone on file), or
  -- already has this exact phone recorded in their profile column even
  -- though donor_key was never upgraded to match it. Found either way,
  -- adopt the phone-based key on that account now so every future lookup
  -- finds it directly instead of repeating this fork.
  IF NULLIF(TRIM(p_phone), '') IS NOT NULL THEN
    SELECT id INTO v_account_id FROM accounts
    WHERE type = 'donor' AND (donor_key = v_name_key OR phone = TRIM(p_phone))
    ORDER BY (donor_key = v_name_key) DESC
    LIMIT 1;
    IF v_account_id IS NOT NULL THEN
      UPDATE accounts SET donor_key = v_key, phone = COALESCE(phone, TRIM(p_phone)) WHERE id = v_account_id;
      RETURN v_account_id;
    END IF;
  END IF;

  INSERT INTO accounts (code, name, type, system, donor_key, opening_balance)
  VALUES ('DON-' || substr(md5(v_key), 1, 8), p_name, 'donor', 'donors_projects', v_key, 0)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$ LANGUAGE plpgsql;
