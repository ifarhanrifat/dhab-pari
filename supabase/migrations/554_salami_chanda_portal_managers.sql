-- Migration 554: link a Salami/Chanda account to a real portal account
-- instead of a bearer link -- real security concern, 2026-10-01: "this
-- link part is unsecure what if it get leaked and that man delete
-- everything from that?" A manage_token link is a bearer credential --
-- anyone who gets hold of the URL (forwarded in a group by mistake,
-- intercepted) can mark pledges received or delete them, with zero
-- identity check. Linking to an actual portal account means the real
-- person logs in with their own credentials, and the tab only ever shows
-- up for that specific account.
--
-- manage_token / the token-gated RPCs (540/541/548) are left in place,
-- not removed -- harmless if unused, and a real fallback for an account
-- nobody has linked to a portal user yet -- but the admin UI stops
-- surfacing the link going forward in favour of this.
ALTER TABLE event_salami_accounts ADD COLUMN manager_portal_user_id uuid REFERENCES portal_users(id);
ALTER TABLE chanda_campaigns ADD COLUMN manager_portal_user_id uuid REFERENCES portal_users(id);

-- The linked manager can see their own account/campaign row directly
-- (name, payment details) -- read-only, the payment account itself stays
-- admin-controlled for integrity.
CREATE POLICY "event_salami_accounts_manager_read" ON event_salami_accounts FOR SELECT TO authenticated
  USING (manager_portal_user_id = current_portal_user_id());
CREATE POLICY "chanda_campaigns_manager_read" ON chanda_campaigns FOR SELECT TO authenticated
  USING (manager_portal_user_id = current_portal_user_id());

-- Full access (view, mark received, delete a fake one) to the pledges
-- under an account/campaign they manage -- this replaces the token-gated
-- RPCs for anyone who's actually linked, via plain RLS instead of a
-- SECURITY DEFINER function.
CREATE POLICY "event_salami_pledges_manager_all" ON event_salami_pledges FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM event_salami_accounts a
    WHERE a.event_id = event_salami_pledges.event_id AND a.side = event_salami_pledges.side
      AND a.manager_portal_user_id = current_portal_user_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM event_salami_accounts a
    WHERE a.event_id = event_salami_pledges.event_id AND a.side = event_salami_pledges.side
      AND a.manager_portal_user_id = current_portal_user_id()
  ));

CREATE POLICY "chanda_pledges_manager_all" ON chanda_pledges FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM chanda_campaigns c
    WHERE c.id = chanda_pledges.campaign_id AND c.manager_portal_user_id = current_portal_user_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM chanda_campaigns c
    WHERE c.id = chanda_pledges.campaign_id AND c.manager_portal_user_id = current_portal_user_id()
  ));
