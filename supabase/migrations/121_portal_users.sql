-- Migration 121: Portal Users — Phase 2 of the Donor Accounts work. Real
-- public authentication doesn't exist anywhere in this app today (only
-- admin_users/staff log in, via auth_user_id). This is the new, entirely
-- separate identity bridge for donors/consumers, with no shared code path to
-- admin_users beyond mirroring its pattern.

CREATE TABLE IF NOT EXISTS portal_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name varchar NOT NULL,
  name_ur varchar,
  mobile varchar NOT NULL,
  whatsapp_number varchar,
  father_husband_name varchar,
  -- Auto-linked at signup (phone/WhatsApp match) — nullable, since a portal
  -- user may be neither yet (a first-time donor with no ledger account until
  -- their first confirmed donation, or someone who isn't a water consumer).
  consumer_id varchar REFERENCES consumers(consumer_id),
  donor_account_id uuid REFERENCES accounts(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS portal_users_mobile_key ON portal_users(mobile);

CREATE OR REPLACE FUNCTION current_portal_user_id() RETURNS uuid AS $$
  SELECT id FROM portal_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

ALTER TABLE portal_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "portal_users_read_own" ON portal_users FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() OR current_admin_role() IN ('super_admin', 'admin'));
CREATE POLICY "portal_users_update_own" ON portal_users FOR UPDATE TO authenticated
  USING (auth_user_id = auth.uid()) WITH CHECK (auth_user_id = auth.uid());
-- No client INSERT policy — rows are only ever created server-side (signup
-- API route, service-role client) alongside the matching auth.users row, so
-- a portal_users row can never exist without a real authenticated identity
-- behind it.
