-- Migration 541: two real corrections to the Online Salami board (540),
-- 2026-09-30, plus a receipt attachment.
--
-- 1. "we should not display the name list on the salami page for the
--    village website" -- the public event_salami_pledges_public view
--    exposed every giver's name + amount per row. Hiding the list in the
--    React UI alone would NOT actually fix this (anyone opening the
--    network tab still sees the raw rows) -- the real fix is removing
--    public per-row access entirely and replacing it with an
--    aggregate-only view (sums/counts, never a name) so the public page
--    can still show "confirmed vs pending" totals without exposing who
--    gave what. The real name itself stays mandatory in the data (the
--    user's own point: it has to match the family's bank/Easypaisa
--    statement) -- it's just no longer public.
DROP VIEW IF EXISTS event_salami_pledges_public;

CREATE VIEW event_salami_totals AS
SELECT event_id, side, status, COALESCE(SUM(amount), 0) AS total_amount, COUNT(*) AS pledge_count
FROM event_salami_pledges
GROUP BY event_id, side, status;
GRANT SELECT ON event_salami_totals TO anon, authenticated;

-- A giver can still see their OWN past announcements (name/amount/status)
-- -- this is their own data, not "the public list" -- which is what
-- backs the new /portal/my-salami page.
CREATE POLICY "event_salami_pledges_self_read" ON event_salami_pledges FOR SELECT TO authenticated
  USING (giver_portal_user_id = current_portal_user_id());

-- 2. Optional payment receipt attachment -- helps the family match a
-- pledge when the sender's own account name doesn't match the announced
-- giver name (e.g. sent from a spouse's account).
ALTER TABLE event_salami_pledges ADD COLUMN receipt_url text;

CREATE OR REPLACE FUNCTION announce_salami(p_event_id uuid, p_side varchar, p_amount numeric, p_message text, p_is_anonymous boolean, p_receipt_url text DEFAULT NULL)
RETURNS uuid AS $$
DECLARE
  v_user_id uuid := current_portal_user_id();
  v_name varchar; v_mobile varchar; v_id uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Must be signed in'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Invalid amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM event_salami_accounts WHERE event_id = p_event_id AND side = p_side) THEN
    RAISE EXCEPTION 'Salami is not set up for this side of this event';
  END IF;
  SELECT full_name, mobile INTO v_name, v_mobile FROM portal_users WHERE id = v_user_id;
  INSERT INTO event_salami_pledges (event_id, side, giver_portal_user_id, giver_name, giver_mobile, is_anonymous, amount, message, receipt_url)
  VALUES (p_event_id, p_side, v_user_id, v_name, v_mobile, COALESCE(p_is_anonymous, false), p_amount, NULLIF(trim(p_message), ''), p_receipt_url)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION announce_salami(uuid, varchar, numeric, text, boolean, text) TO authenticated;

-- Public bucket (same convenience as the 'images' bucket ImageUpload
-- already uses everywhere) -- a receipt is only discoverable through a
-- path the giver themselves generated and chose to attach, and is shown
-- to the specific family verifying that specific pledge, not browsable.
-- Kept as its own bucket (not mixed into 'images') so it's easy to find/
-- purge separately later if that trust call ever needs revisiting.
INSERT INTO storage.buckets (id, name, public) VALUES ('salami_receipts', 'salami_receipts', true)
ON CONFLICT (id) DO NOTHING;
CREATE POLICY "Authenticated users can upload salami receipts" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'salami_receipts');
