-- Migration 357: robust phone matching for linking a portal signup to a
-- pre-existing donor account, plus the confirm/dispute/rematch workflow
-- around it.
--
-- Why a new matching function instead of the plain donor_key = donor_key
-- comparison signup already did: donor_key_for() (migration 007) is just
-- lower(trim(phone)) — a raw string compare. The same real phone number
-- shows up across this app's history as "+923001234567", "923001234567",
-- "03001234567", "0300-1234567", "0300 1234567"... every one of those is a
-- DIFFERENT string, so an exact match silently misses whenever the format
-- doesn't happen to be identical, which is most of the time across years
-- of manual data entry. donor_key itself is left exactly as it's always
-- been (existing accounts, and next_account_code/ensure_donor_account, are
-- unaffected) — this only changes how a candidate phone number gets
-- COMPARED against it.

CREATE OR REPLACE FUNCTION phone_core_digits(p_phone text) RETURNS text AS $$
DECLARE
  d text := regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g');
BEGIN
  -- Strip everything but digits, then drop a leading country code (92) or
  -- trunk prefix (0) so every format of the same Pakistani mobile number
  -- reduces to the same bare 10-digit core — the one thing that's actually
  -- stable regardless of how or when it was typed.
  IF length(d) = 12 AND left(d, 2) = '92' THEN RETURN substr(d, 3);
  ELSIF length(d) = 11 AND left(d, 1) = '0' THEN RETURN substr(d, 2);
  ELSE RETURN d;
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The single place both signup and the portal's own "try a different
-- number" flow go through — one definition of "does this phone number
-- belong to an existing donor," used everywhere instead of drifting.
CREATE OR REPLACE FUNCTION match_donor_account_by_phone(p_phone varchar) RETURNS TABLE(
  account_id uuid, donor_account_no varchar, name varchar, name_ur varchar,
  total_contributed numeric, already_claimed boolean
) AS $$
DECLARE
  v_core text := phone_core_digits(p_phone);
BEGIN
  -- A donor_key with no digits at all is a name-based key (an old cash
  -- donation with no phone ever recorded) — phone_core_digits() of that
  -- would also come back empty, so guard explicitly rather than let two
  -- blanks accidentally "match."
  IF v_core = '' OR length(v_core) < 7 THEN RETURN; END IF;

  RETURN QUERY
  SELECT a.id, a.donor_account_no, a.name, a.name_ur,
    COALESCE((SELECT SUM(le.credit) - SUM(le.debit) FROM ledger_entries le WHERE le.account_id = a.id), 0)::numeric,
    EXISTS (SELECT 1 FROM portal_users pu WHERE pu.donor_account_id = a.id AND pu.auth_user_id IS NOT NULL)
  FROM accounts a
  WHERE a.system = 'donors_projects' AND a.type = 'donor'
    AND phone_core_digits(a.donor_key) = v_core
  ORDER BY (a.donor_account_no IS NOT NULL) DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION phone_core_digits(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION match_donor_account_by_phone(varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION phone_core_digits(text) TO authenticated;
GRANT EXECUTE ON FUNCTION match_donor_account_by_phone(varchar) TO authenticated;

-- Set once a member has actually looked at the total the auto-match found
-- and agreed it's theirs. NULL (donor_account_id set, this still NULL)
-- means "linked automatically, not yet confirmed" — the portal's Welcome
-- page uses exactly that state to show the confirm/dispute prompt once.
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS donor_link_confirmed_at timestamptz;

CREATE OR REPLACE FUNCTION portal_confirm_donor_link() RETURNS void AS $$
BEGIN
  IF current_portal_user_id() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE portal_users SET donor_link_confirmed_at = now()
  WHERE id = current_portal_user_id() AND donor_account_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- A member says the auto-matched account isn't theirs — unlink immediately
-- (so nothing that isn't really theirs keeps showing on their statement)
-- and leave a real record for staff, the same complaints queue every other
-- disputed thing in this app already goes through.
CREATE OR REPLACE FUNCTION portal_dispute_donor_link(p_reason text) RETURNS void AS $$
DECLARE
  v_pu portal_users%ROWTYPE;
  v_account_no varchar;
BEGIN
  SELECT * INTO v_pu FROM portal_users WHERE id = current_portal_user_id();
  IF v_pu.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_pu.donor_account_id IS NULL THEN RAISE EXCEPTION 'No donor account link to dispute'; END IF;

  SELECT donor_account_no INTO v_account_no FROM accounts WHERE id = v_pu.donor_account_id;

  INSERT INTO complaints (system, portal_user_id, complainant_name, phone, complaint_text, source, status)
  VALUES ('donors_projects', v_pu.id, v_pu.full_name, COALESCE(v_pu.whatsapp_number, v_pu.mobile),
    'Donor account link dispute — the system auto-linked this login to donor account ' ||
    COALESCE(v_account_no, '(unnumbered)') || ' by matching phone number, but the member says this is not their donation history.'
    || CASE WHEN p_reason IS NOT NULL AND trim(p_reason) <> '' THEN ' Member''s note: ' || trim(p_reason) ELSE '' END,
    'website', 'open');

  UPDATE portal_users SET donor_account_id = NULL, donor_link_confirmed_at = NULL WHERE id = v_pu.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- "Try a different number" — checks an alternate phone (NOT the login
-- mobile, which stays whatever they signed up with) against donor
-- accounts, and links it immediately if it's a real, unclaimed match, the
-- same way signup itself would have. Returns the match (or none) either
-- way so the UI can show the same confirm step.
CREATE OR REPLACE FUNCTION portal_rematch_donor_by_phone(p_phone varchar) RETURNS TABLE(
  account_id uuid, donor_account_no varchar, name varchar, name_ur varchar,
  total_contributed numeric, already_claimed boolean
) AS $$
DECLARE
  v_pu_id uuid := current_portal_user_id();
  v_match record;
BEGIN
  IF v_pu_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_match FROM match_donor_account_by_phone(p_phone);

  IF v_match.account_id IS NOT NULL AND NOT v_match.already_claimed THEN
    UPDATE portal_users SET donor_account_id = v_match.account_id, donor_link_confirmed_at = NULL WHERE id = v_pu_id;
  END IF;

  RETURN QUERY SELECT v_match.account_id, v_match.donor_account_no, v_match.name, v_match.name_ur, v_match.total_contributed, v_match.already_claimed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION portal_confirm_donor_link() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION portal_dispute_donor_link(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION portal_rematch_donor_by_phone(varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION portal_confirm_donor_link() TO authenticated;
GRANT EXECUTE ON FUNCTION portal_dispute_donor_link(text) TO authenticated;
GRANT EXECUTE ON FUNCTION portal_rematch_donor_by_phone(varchar) TO authenticated;
