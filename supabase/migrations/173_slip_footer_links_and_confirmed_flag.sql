-- Migration 173:
--   1. Split "join our WhatsApp group" from "chat with us on WhatsApp" — they
--      are different actions and were sharing one footer entry.
--   2. Suggestions + Complaints deep links for the slip footer icon row.
--   3. donor_receipt_totals() now reports whether THIS donation is confirmed,
--      so a receipt can say "not yet confirmed" instead of silently printing a
--      zero lifetime total and a blank document number — which is what an
--      unconfirmed donation legitimately has, and what looked like a bug.

INSERT INTO site_settings (key, value, description) VALUES
  ('footer_whatsapp_chat', '+923335008575',
   'Direct WhatsApp number for one-to-one chat, shown separately from the group invite link.'),
  ('donor_footer_whatsapp_chat', '', 'Donor override for the direct WhatsApp chat number.'),
  ('footer_suggestions_link', 'https://dhabpari.com/suggestions', 'Suggestions page link for the slip footer icon row.'),
  ('donor_footer_suggestions_link', '', 'Donor override for the suggestions link.'),
  ('footer_complaints_link', 'https://dhabpari.com/complaints', 'Complaints page link for the slip footer icon row.'),
  ('donor_footer_complaints_link', '', 'Donor override for the complaints link.')
ON CONFLICT (key) DO NOTHING;

-- CREATE OR REPLACE cannot add a column to an existing RETURNS TABLE signature
-- ("cannot change return type of existing function", SQLSTATE 42P13) — the row
-- type is part of the function's identity, so the old two-column version has to
-- go first. Safe inside this migration's transaction: the drop and the recreate
-- commit together, so no caller ever sees the function missing.
DROP FUNCTION IF EXISTS donor_receipt_totals(uuid);

CREATE FUNCTION donor_receipt_totals(p_donor_id uuid)
RETURNS TABLE (total_contributed numeric, announced_remaining numeric, is_confirmed boolean) AS $$
DECLARE
  v_key varchar;
  v_confirmed boolean;
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

  RETURN QUERY
  SELECT
    COALESCE(SUM(d.amount_pkr) FILTER (WHERE d.is_verified), 0)::numeric,
    COALESCE(SUM(d.amount_pkr) FILTER (WHERE NOT d.is_verified AND d.payment_status = 'pledged'), 0)::numeric,
    COALESCE(v_confirmed, false)
  FROM donors d
  WHERE donor_key_for(d.name, d.phone) = v_key;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION donor_receipt_totals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donor_receipt_totals(uuid) TO authenticated;
