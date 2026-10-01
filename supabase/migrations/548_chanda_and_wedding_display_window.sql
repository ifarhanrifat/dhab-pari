-- Migration 548: wedding display window + Chanda (Mosque/Janaza Gah fund
-- collection) -- 2026-10-01.
--
-- 1. Wedding display window -- real ask: "the end date of displaying
-- which should be no more [than] 1 month for shadi". Previously a wedding
-- (and its Salami board) stayed visible purely by riding the Events
-- page's generic "last 10 past events" window -- fuzzy and unbounded.
-- display_until makes it explicit and capped: admin sets how many days
-- after the wedding's last function it keeps showing (UI caps this at
-- 30), and the public /events query filters on it directly.
ALTER TABLE village_events ADD COLUMN display_until timestamptz;
-- Backfill for the one real wedding row already live -- same 1-month cap,
-- measured from its end_datetime (already set to its one carried-forward
-- function's datetime, migration 542).
UPDATE village_events SET display_until = end_datetime + interval '30 days'
WHERE category = 'wedding' AND display_until IS NULL AND end_datetime IS NOT NULL;

-- 2. Chanda -- standing fund collection for a mosque or a Janaza Gah
-- (graveyard) construction project. Deliberately NOT a village_events row
-- -- a mosque's fund isn't a one-off dated event, it's a campaign with its
-- own 1-6 month display window (chosen by the admin, same real ask).
-- Same pledge/manage-link mechanics as wedding Salami (540/541), but with
-- one real difference the user was explicit about: donor names ARE shown
-- publicly here (matching the existing Projects donor-wall convention,
-- donors_public, 116) -- Salami's privacy fix does not apply to Chanda.
CREATE TABLE chanda_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type varchar NOT NULL CHECK (type IN ('mosque', 'janaza_gah')),
  directory_entry_id uuid REFERENCES directory_entries(id),
  title varchar NOT NULL,
  title_ur varchar,
  description text,
  description_ur text,
  target_amount numeric(12,2),
  payment_method varchar NOT NULL CHECK (payment_method IN ('easypaisa', 'jazzcash', 'bank')),
  account_number varchar NOT NULL,
  account_title varchar,
  bank_name varchar,
  manage_token uuid NOT NULL DEFAULT gen_random_uuid(),
  display_until timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE chanda_campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chanda_campaigns_staff_all" ON chanda_campaigns FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));

CREATE VIEW chanda_campaigns_public AS
SELECT id, type, directory_entry_id, title, title_ur, description, description_ur,
       target_amount, payment_method, account_number, account_title, bank_name, display_until
FROM chanda_campaigns WHERE is_active = true AND display_until > now();
GRANT SELECT ON chanda_campaigns_public TO anon, authenticated;

CREATE TABLE chanda_pledges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES chanda_campaigns(id) ON DELETE CASCADE,
  giver_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  giver_name varchar NOT NULL,
  giver_mobile varchar,
  is_anonymous boolean NOT NULL DEFAULT false,
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  message text,
  receipt_url text,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received')),
  confirmed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX chanda_pledges_campaign_idx ON chanda_pledges(campaign_id);

ALTER TABLE chanda_pledges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chanda_pledges_self_insert" ON chanda_pledges FOR INSERT TO authenticated
  WITH CHECK (giver_portal_user_id = current_portal_user_id() AND status = 'pending');
CREATE POLICY "chanda_pledges_self_read" ON chanda_pledges FOR SELECT TO authenticated
  USING (giver_portal_user_id = current_portal_user_id());
CREATE POLICY "chanda_pledges_staff_all" ON chanda_pledges FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));

-- Public donor wall -- same is_anonymous suppression as donors_public,
-- but (unlike event_salami_pledges_public, which was replaced by an
-- aggregate-only view in 541) real names+amounts are intentionally public
-- here, per the direct ask.
CREATE VIEW chanda_pledges_public AS
SELECT id, campaign_id,
       CASE WHEN is_anonymous THEN 'Anonymous' ELSE giver_name END AS giver_name,
       amount, status, created_at, confirmed_at
FROM chanda_pledges;
GRANT SELECT ON chanda_pledges_public TO anon, authenticated;

CREATE OR REPLACE FUNCTION announce_chanda(p_campaign_id uuid, p_amount numeric, p_message text, p_is_anonymous boolean, p_receipt_url text DEFAULT NULL)
RETURNS uuid AS $$
DECLARE
  v_user_id uuid := current_portal_user_id();
  v_name varchar; v_mobile varchar; v_id uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Must be signed in'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Invalid amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM chanda_campaigns WHERE id = p_campaign_id AND is_active = true AND display_until > now()) THEN
    RAISE EXCEPTION 'This Chanda campaign is not currently open';
  END IF;
  SELECT full_name, mobile INTO v_name, v_mobile FROM portal_users WHERE id = v_user_id;
  INSERT INTO chanda_pledges (campaign_id, giver_portal_user_id, giver_name, giver_mobile, is_anonymous, amount, message, receipt_url)
  VALUES (p_campaign_id, v_user_id, v_name, v_mobile, COALESCE(p_is_anonymous, false), p_amount, NULLIF(trim(p_message), ''), p_receipt_url)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION announce_chanda(uuid, numeric, text, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION chanda_campaign_by_token(p_token uuid)
RETURNS TABLE(id uuid, type varchar, title varchar, payment_method varchar, account_number varchar, account_title varchar, bank_name varchar) AS $$
  SELECT id, type, title, payment_method, account_number, account_title, bank_name
  FROM chanda_campaigns WHERE manage_token = p_token;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION chanda_campaign_by_token(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION chanda_manager_pledges(p_token uuid)
RETURNS SETOF chanda_pledges AS $$
  SELECT p.* FROM chanda_pledges p
  JOIN chanda_campaigns c ON c.id = p.campaign_id
  WHERE c.manage_token = p_token
  ORDER BY p.status = 'pending' DESC, p.created_at DESC;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION chanda_manager_pledges(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION chanda_mark_received(p_token uuid, p_pledge_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE chanda_pledges p SET status = 'received', confirmed_at = now()
  FROM chanda_campaigns c
  WHERE c.id = p.campaign_id AND c.manage_token = p_token AND p.id = p_pledge_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found or not authorized'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION chanda_mark_received(uuid, uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION chanda_delete_pledge(p_token uuid, p_pledge_id uuid)
RETURNS void AS $$
BEGIN
  DELETE FROM chanda_pledges p
  USING chanda_campaigns c
  WHERE c.id = p.campaign_id AND c.manage_token = p_token AND p.id = p_pledge_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found or not authorized'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION chanda_delete_pledge(uuid, uuid) TO anon, authenticated;
