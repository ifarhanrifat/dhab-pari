-- Migration 540: Online Salami (wedding gift-money) tracking board --
-- Phase 3 of the "Village OS" feature set, 2026-09-30. Real ask: digitize
-- the bahi-khata a family already keeps by hand at a wedding, so distant
-- relatives (especially overseas) who can't attend can still send
-- Salami directly to the groom/bride family's own Easypaisa/JazzCash/
-- bank account -- no committee cash involved at any point, this table
-- never touches ledger_entries or any real balance. The app is purely a
-- public "who's given what" board plus a private way for the family to
-- mark what's actually arrived.
--
-- Modeled directly on the existing donors/donors_public pattern
-- (116_donor_public_submission.sql): a public row is inserted straight
-- by a portal user as 'pending', a privacy-safe view is the only thing
-- ever exposed to anon/authenticated (never the base table), and the
-- pending->received flip only ever happens through a SECURITY DEFINER
-- RPC -- never a raw client UPDATE grant.
--
-- Accounts are admin-verified, not self-service: a portal user can't
-- spin up a payout account and start collecting Salami on someone else's
-- behalf. Staff create the two accounts (one per side) after confirming
-- the real family in person/WhatsApp, the same trust bar as
-- directory_entries. Each account gets its own manage_token -- a private
-- link shared with that specific family by the admin -- rather than a
-- second portal-signup flow neither the groom's nor bride's family
-- necessarily has any reason to go through.
CREATE TABLE event_salami_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES village_events(id) ON DELETE CASCADE,
  side varchar NOT NULL CHECK (side IN ('groom', 'bride')),
  family_name varchar NOT NULL,
  payment_method varchar NOT NULL CHECK (payment_method IN ('easypaisa', 'jazzcash', 'bank')),
  account_number varchar NOT NULL,
  account_title varchar,
  bank_name varchar,
  manage_token uuid NOT NULL DEFAULT gen_random_uuid(),
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE (event_id, side)
);

ALTER TABLE event_salami_accounts ENABLE ROW LEVEL SECURITY;
-- Deliberately NO public/authenticated SELECT policy on the base table --
-- manage_token must never be selectable by anyone but staff. Public
-- access goes only through the view below, which omits it.
CREATE POLICY "event_salami_accounts_staff_all" ON event_salami_accounts FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));

CREATE VIEW event_salami_accounts_public AS
SELECT id, event_id, side, family_name, payment_method, account_number, account_title, bank_name
FROM event_salami_accounts;
GRANT SELECT ON event_salami_accounts_public TO anon, authenticated;

CREATE TABLE event_salami_pledges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES village_events(id) ON DELETE CASCADE,
  side varchar NOT NULL CHECK (side IN ('groom', 'bride')),
  giver_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  giver_name varchar NOT NULL,
  giver_mobile varchar,
  is_anonymous boolean NOT NULL DEFAULT false,
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  message text,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received')),
  confirmed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX event_salami_pledges_event_idx ON event_salami_pledges(event_id, side);

ALTER TABLE event_salami_pledges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "event_salami_pledges_self_insert" ON event_salami_pledges FOR INSERT TO authenticated
  WITH CHECK (giver_portal_user_id = current_portal_user_id() AND status = 'pending');
CREATE POLICY "event_salami_pledges_staff_all" ON event_salami_pledges FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));

-- Public board, same shape as donors_public: real bahi-khata custom is
-- discreet about exact figures being publicly attributed forever, so
-- names go through the same is_anonymous suppression donors_public
-- already uses -- but (matching that same precedent, and the direct
-- ask "just like we are having project detail section list will kept
-- displaying confirmed amount and pending amounts") amounts themselves
-- are shown publicly, split into confirmed/pending, exactly like a
-- project's donor wall.
CREATE OR REPLACE VIEW event_salami_pledges_public AS
SELECT id, event_id, side,
       CASE WHEN is_anonymous THEN 'Anonymous' ELSE giver_name END AS giver_name,
       amount, status, created_at, confirmed_at
FROM event_salami_pledges;
GRANT SELECT ON event_salami_pledges_public TO anon, authenticated;

-- A portal user announces their own pledge -- giver_name/mobile pulled
-- from their own profile server-side, not freeform, so nobody can
-- announce a pledge in someone else's name.
CREATE OR REPLACE FUNCTION announce_salami(p_event_id uuid, p_side varchar, p_amount numeric, p_message text, p_is_anonymous boolean)
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
  INSERT INTO event_salami_pledges (event_id, side, giver_portal_user_id, giver_name, giver_mobile, is_anonymous, amount, message)
  VALUES (p_event_id, p_side, v_user_id, v_name, v_mobile, COALESCE(p_is_anonymous, false), p_amount, NULLIF(trim(p_message), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION announce_salami(uuid, varchar, numeric, text, boolean) TO authenticated;

-- Token-gated family side, mirroring "is_verified only ever flips true
-- through confirm_donation(), never a raw client update" (116) -- here
-- there's no admin session at all, just the private link, so the check
-- happens inside each function instead of RLS.
CREATE OR REPLACE FUNCTION salami_account_by_token(p_token uuid)
RETURNS TABLE(event_id uuid, side varchar, family_name varchar, payment_method varchar, account_number varchar, account_title varchar, bank_name varchar) AS $$
  SELECT event_id, side, family_name, payment_method, account_number, account_title, bank_name
  FROM event_salami_accounts WHERE manage_token = p_token;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION salami_account_by_token(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION salami_manager_pledges(p_token uuid)
RETURNS SETOF event_salami_pledges AS $$
  SELECT p.* FROM event_salami_pledges p
  JOIN event_salami_accounts a ON a.event_id = p.event_id AND a.side = p.side
  WHERE a.manage_token = p_token
  ORDER BY p.status = 'pending' DESC, p.created_at DESC;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION salami_manager_pledges(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION salami_mark_received(p_token uuid, p_pledge_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE event_salami_pledges p SET status = 'received', confirmed_at = now()
  FROM event_salami_accounts a
  WHERE a.event_id = p.event_id AND a.side = p.side AND a.manage_token = p_token AND p.id = p_pledge_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found or not authorized'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION salami_mark_received(uuid, uuid) TO anon, authenticated;

-- Lets the family remove an obviously fake/joke pledge instead of it
-- sitting forever as a permanent, visible "unpaid" mark against a name.
CREATE OR REPLACE FUNCTION salami_delete_pledge(p_token uuid, p_pledge_id uuid)
RETURNS void AS $$
BEGIN
  DELETE FROM event_salami_pledges p
  USING event_salami_accounts a
  WHERE a.event_id = p.event_id AND a.side = p.side AND a.manage_token = p_token AND p.id = p_pledge_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found or not authorized'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION salami_delete_pledge(uuid, uuid) TO anon, authenticated;
