-- Migration 342: lets someone actually act on a Talent Showcase entry's
-- "needs" instead of just reading it. Two different shapes of need, two
-- different mechanisms:
--
--   1. Money-shaped ("better paints") — reuses the existing donors/ledger/
--      badge pipeline exactly the way project donations already do,
--      via a new talent_showcase_id column mirroring project_id. No new
--      accounting subsystem; the same confirm-by-staff workflow, the same
--      donor badges, the same everything.
--   2. Connection-shaped ("help me sell online") — a lightweight interest
--      lead (talent_showcase_help_offers) admin follows up on and connects
--      manually. Never a direct contact exchange, same privacy pattern as
--      the rest of this build.
--
-- needs_amount_pkr is set by the talented person themselves at submission
-- (or admin, for a staff-authored entry) — per explicit direction, not an
-- admin-imposed number after the fact.
ALTER TABLE talent_showcases
  ADD COLUMN IF NOT EXISTS needs_amount_pkr numeric,
  ADD COLUMN IF NOT EXISTS support_status varchar NOT NULL DEFAULT 'open'
    CHECK (support_status IN ('open', 'partially_supported', 'fulfilled'));

ALTER TABLE donors ADD COLUMN IF NOT EXISTS talent_showcase_id uuid REFERENCES talent_showcases(id);

CREATE TABLE IF NOT EXISTS talent_showcase_help_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  talent_showcase_id uuid NOT NULL REFERENCES talent_showcases(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  message text NOT NULL,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'contacted', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE talent_showcase_help_offers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "talent_help_offers_own_insert" ON talent_showcase_help_offers FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "talent_help_offers_own_read" ON talent_showcase_help_offers FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id() OR current_admin_role() IN ('super_admin', 'admin'));
CREATE POLICY "talent_help_offers_admin_manage" ON talent_showcase_help_offers FOR UPDATE TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

-- Confirmed-only raised total — same "badges/progress only ever count
-- confirmed money" rule already established for donor badges this session.
CREATE OR REPLACE FUNCTION talent_showcase_raised(p_id uuid) RETURNS numeric AS $$
  SELECT COALESCE(SUM(amount_pkr), 0) FROM donors WHERE talent_showcase_id = p_id AND is_verified = true;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION talent_showcase_raised(uuid) TO anon, authenticated;
